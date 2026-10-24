// The owner's decisions: yes/no on irreversible steps and answers to sessions' questions. Buttons work once and then
// turn into a caption in place. A permission request is a decision brief (brief.ts): what changes, whether it can be
// undone, a recommendation; the command itself goes under "Details".
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { decisionBrief, sessionName, type Brief, type More } from "./brief";
import { ARCH_HOME, LOGS, STATE, tr } from "./config";
import { mdEsc } from "./md";
import type { Button, Incoming, Telegram } from "./telegram";
import { clip, hhmm, log, randomId, readJson, scrub, writeJson } from "./util";

export type Question = { question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean };
// { tell }: "Show me first" / "Explain first" withdraws the request; the session gets tell and asks again
export type Decision = "yes" | "no" | "timeout" | { tell: string };

type Pending =
  | { kind: "confirm"; resolve: (v: Decision) => void; messageId: number; md: string; more?: More; deploy?: boolean; rule?: Brief["rule"]; action: string; source: string; summary: string; since: number }
  | { kind: "question"; resolve: (v: string | null) => void; messageId: number; md: string; q: Question; picked: Set<number>; source: string; summary: string; since: number };

const done = (label: string): Button[][] => [[{ text: label, disabled: true }]]; // a disabled caption replaces the buttons
const plain = (md: string) => md.replace(/\\(.)/g, "$1"); // unescaped, for the dashboard
const RECOMMENDED = /\s*\((recommended|рекомендую|рекомендуется|советую)\)\s*$/i; // how AskUserQuestion marks a recommendation
const quote = (s: string) => tr(`«${s}»`, `“${s}”`);

// Only the button the advice leans to is colored; without advice all stay neutral, since a red "Decline" reads as an
// alarm. "Yes" takes the verb of the first line ("Deploy", "Delete"), so the owner sees what the tap does; otherwise it
// is "Allow". English verbs come from a list, so a description like "Running tests" never becomes a button.
const VERBS_EN =
  /^(Add|Apply|Approve|Archive|Build|Change|Clean|Clear|Clone|Commit|Copy|Create|Delete|Deploy|Download|Edit|Execute|Export|Fetch|Import|Install|Kill|Launch|Merge|Move|Open|Overwrite|Publish|Pull|Push|Release|Reload|Remove|Rename|Reset|Restart|Restore|Revert|Run|Send|Set|Spend|Start|Stop|Sync|Tag|Trust|Update|Upload|Write)(?=\s|$)/;
const yesVerb = (head: string) => tr(head.match(/^(\p{Lu}\p{Ll}+(?:ть|ти|чь)(?:ся)?)(?=\s|$)/u)?.[1], head.match(VERBS_EN)?.[1]);
// The owner's "without asking" rules: a button on the card says yes in advance to the same kind of action in the
// same project
export type Rule = NonNullable<Brief["rule"]> & { at: number };
const RULES = () => join(STATE, "rules.json");
export const rules = {
  list: (): Rule[] => readJson<Rule[]>(RULES(), []),
  match: (r: NonNullable<Brief["rule"]>) => rules.list().find((x) => x.kind === r.kind && x.project === r.project),
  add(r: NonNullable<Brief["rule"]>) {
    if (!rules.match(r)) writeJson(RULES(), [...rules.list(), { kind: r.kind, project: r.project, at: Date.now() }]);
  },
  remove(r: NonNullable<Brief["rule"]>) {
    writeJson(RULES(), rules.list().filter((x) => !(x.kind === r.kind && x.project === r.project)));
  },
};
const day = (t: number) => new Date(t).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
export const ruleText = (r: NonNullable<Brief["rule"]>) =>
  r.kind === "deploy" ? tr(`выкладка ${r.project}`, `deploying ${r.project}`) : r.kind === "delete" ? tr(`удаление в ${quote(r.project)}`, `deleting in ${quote(r.project)}`) : tr(`обновление ${quote(r.project)}`, `updating ${quote(r.project)}`);
const always = (r: NonNullable<Brief["rule"]>) =>
  r.kind === "deploy" ? tr(`Выкладывать ${r.project} без вопросов`, `Deploy ${r.project} without asking`) : r.kind === "delete" ? tr(`Удалять в ${quote(r.project)} без вопросов`, `Delete in ${quote(r.project)} without asking`) : tr(`Обновлять ${quote(r.project)} без вопросов`, `Update ${quote(r.project)} without asking`);

// own: the verb of an action already in words (the architect's own tools): "Stop “X”?" gets "Stop", not "Allow"
function confirmButtons(id: string, b?: Brief, own?: string): Button[][] {
  const lean = b?.lean;
  const verb = (b && yesVerb(b.head)) || own;
  const rows: Button[][] = [
    [
      { text: verb ?? tr("Разрешить", "Allow"), data: `a:${id}:y`, ...(lean === "allow" ? { style: "success" as const } : {}) },
      { text: tr("Отклонить", "Decline"), data: `a:${id}:n`, ...(lean === "reject" ? { style: "danger" as const } : {}) },
    ],
  ];
  if (b?.more) rows.push([{ text: b.more.label, data: `a:${id}:m`, ...(lean === "look" ? { style: "primary" as const } : {}) }]);
  if (b?.rule) rows.push([{ text: always(b.rule), data: `a:${id}:A` }]);
  return rows;
}

// A collapsible block titled by what is inside
const more = (parts: string[], title = tr("Подробнее", "Details")) => (parts.length ? `\n\n<details><summary>${title}</summary>\n\n${parts.join("\n\n")}\n\n</details>` : "");

// The first line says what changes and is the only bold one; below it where, what and whether it can be undone; the
// advice is its own paragraph. The first line ends with "?", the rest with a period: the iOS lock screen joins lines.
const ask = (x: string) => (!x || /[.?!…:]$/.test(x) ? x : `${x}?`);
const dot = (x: string) => (!x || /[.?!…:]$/.test(x) ? x : `${x}.`);
export function briefMd(b: Brief) {
  // the advice uses the button's verb: "I'd deploy it" under [Deploy], not "allow"
  const verb = yesVerb(b.head);
  const advice = b.advice && verb ? b.advice.replace(tr(/^Советую разрешить/, /^I’d allow it/), tr(`Советую ${verb.toLowerCase()}`, `I’d ${verb.toLowerCase()} it`)) : b.advice;
  // "?" only after a request with a verb ("Deploy Beacon?"); a description ("Running tests") gets a period
  return `${[`**${verb ? ask(b.head) : dot(b.head)}**`, ...b.lines.map(dot)].join("\n")}${advice ? `\n\n${dot(advice)}` : ""}${more(b.details ?? [], b.deploy ? tr("Что изменится", "What changes") : tr("Подробнее", "Details"))}`;
}

// An action already in words (the architect's own tools, `archi ask`, folder trust): the first line says what, then why.
// A long remainder (a session's task, a goal) goes under "Details".
function wordsMd(source: string, action: string, reason?: string) {
  const [first, ...rest] = scrub(action).trim().split("\n");
  const tail = mdEsc(clip(rest.join("\n").trim(), 1500));
  const why = reason ? mdEsc(clip(scrub(reason).replace(/^./, (c) => c.toUpperCase()), 600)) : "";
  const who = source === "Архитектор" ? "" : tr(`Просит ${sessionName(source)}`, `Requested by ${sessionName(source)}`);
  const head = mdEsc(clip(first, 300));
  return [`**${yesVerb(head) ? ask(head) : dot(head)}**`, tail.length <= 300 ? tail : "", why && dot(why), who && dot(who)].filter(Boolean).join("\n\n") + (tail.length > 300 ? more([tail]) : "");
}

export class Approvals {
  private pending = new Map<string, Pending>();

  constructor(private tg: Telegram) {
    tg.onCallback("a", async ({ id, value, answer }) => {
      const p = this.pending.get(id);
      if (!p || p.kind !== "confirm") return answer(tr("Уже решено или устарело", "Already decided or expired"));
      const v = value === "y" || (value === "A" && p.rule) ? "yes" : value === "m" && p.more ? "more" : "no";
      if (value === "A" && p.rule) rules.add(p.rule);
      this.finishConfirm(id, v, undefined, value === "A" && !!p.rule);
      await answer(v === "yes" ? tr("Разрешено", "Allowed") : v === "more" ? p.more!.next : tr("Отклонено", "Declined"));
    });
    tg.onCallback("q", async ({ id, value, answer }) => {
      const p = this.pending.get(id);
      if (!p || p.kind !== "question") return answer(tr("Уже отвечено или устарело", "Already answered or expired"));
      const opts = p.q.options ?? [];
      if (value === "done") {
        const labels = [...p.picked].map((k) => opts[k]?.label).filter(Boolean);
        if (!labels.length) return answer(tr("Выберите хотя бы один вариант", "Pick at least one option"));
        this.finishQuestion(id, labels.join(", "), undefined, true);
        return answer(tr("Отправлено", "Sent"));
      }
      const k = Number(value);
      if (!(k in opts)) return answer(tr("Нет такого варианта", "No such option"));
      if (p.q.multiSelect) {
        p.picked.has(k) ? p.picked.delete(k) : p.picked.add(k);
        await this.tg.edit(p.messageId, p.md, { buttons: this.questionButtons(id, p.q, p.picked) });
        return answer();
      }
      this.finishQuestion(id, opts[k].label, undefined, true);
      await answer(tr("Отправлено", "Sent"));
    });
  }

  // The owner's text as an answer: a free-form answer to a question, or the fallback "yes abc123" / "no abc123"
  takeText(m: Incoming): boolean {
    if (m.forwardedFrom) return false; // forwarded text is someone else's words, never a decision
    const t = m.text.trim();
    const fallback = t.match(/^(да|нет|yes|no)\s+([a-z0-9]{6,10})$/i);
    // "yes <id>" queued by the cloud relay allows nothing: decisions come only through the host's own Telegram polling
    if (fallback && !m.relayed) {
      const p = this.pending.get(fallback[2]);
      if (p?.kind === "confirm") {
        this.finishConfirm(fallback[2], /^(да|yes)$/i.test(fallback[1]) ? "yes" : "no");
        return true;
      }
    }
    // a free-form answer only as a reply (swipe) to the question itself; a message next to it doesn't count
    if (!t || !m.replyToId) return false;
    for (const [id, p] of this.pending)
      if (p.kind === "question" && m.replyToId === p.messageId) {
        this.finishQuestion(id, t);
        return true;
      }
    return false;
  }

  // What waits for the owner's decision, for the dashboard. final: irreversible ("Can’t be undone" in the brief), so it
  // is decided only from the brief itself, never with one tap on the dashboard.
  list(): { kind: "confirm" | "question"; source: string; summary: string; since: number; messageId: number; final: boolean }[] {
    const final = tr(/Вернуть (нельзя|можно не всё)/, /Can’t be undone|Only partly reversible/);
    return [...this.pending.values()].map((p) => ({ kind: p.kind, source: p.source, summary: p.summary, since: p.since, messageId: p.messageId, final: p.kind === "confirm" && final.test(p.md) }));
  }

  // tool/input/cwd: the session's tool request, the brief is built from it; without them action is already words (the
  // architect's own tools, archi ask). shots: the session's candidate shots, sent above a deploy brief. worker: one of
  // the architect's sessions, which can be asked for shots.
  async confirm(o: {
    source: string;
    action: string;
    reason?: string;
    tool?: string;
    input?: Record<string, unknown>;
    cwd?: string;
    shots?: string[];
    worker?: boolean;
    timeoutMs: number;
    signal?: AbortSignal;
    threadId?: number;
    abortNote?: string;
  }): Promise<Decision> {
    const id = randomId();
    const brief = o.tool
      ? await decisionBrief({ tool: o.tool, input: o.input ?? {}, cwd: o.cwd ?? ARCH_HOME, source: o.source, shots: o.shots?.length, worker: o.worker, inTopic: !!o.threadId }).catch((e) => void log("approvals", "бриф не собрался — шлю словами", String(e)))
      : undefined;
    if (o.signal?.aborted) return "timeout"; // withdrawn while the brief was built
    // a verified no-op (a push to a branch that already has everything) doesn't bother the owner; a push to main never gets here
    if (brief?.noop) {
      audit({ id, type: "auto", source: o.source, action: o.action, brief: brief.head, decision: "yes" });
      return "yes";
    }
    // candidate shots go above the brief, so its buttons stay at the bottom
    if (brief?.deploy && o.shots?.length)
      await this.tg.sendAlbum(o.shots.map((path, i) => ({ path, caption: i ? undefined : tr("Так станет после выкладки — снимки сессии", "How it will look after the deploy — the session’s screenshots") })), { threadId: o.threadId });
    const md = brief ? briefMd(brief) : wordsMd(o.source, o.action, o.reason);
    // "waiting for the deploy" only where the watcher really waits for a pipeline (watcher.onApproved)
    const deploy = !!brief?.deploy && /git\b.*\bpush\b|gh\s+(pr\s+merge|workflow\s+run|run\s+rerun)/.test(o.action);
    // a "without asking" rule for this kind of action in this project: the card arrives decided, silently
    const standing = brief?.rule && rules.match(brief.rule);
    if (standing) {
      const label = tr(`Разрешено вашим правилом от ${day(standing.at)}`, `Allowed by your rule from ${day(standing.at)}`);
      const [card] = await this.tg.send(md, { threadId: o.threadId, silent: true, buttons: done(deploy ? `${label} — ${tr("жду выкладку", "waiting for the deploy")}` : label) });
      if (deploy) this.deployCards.set(o.action, { messageId: card, md, label });
      audit({ id, type: "auto", source: o.source, action: o.action, brief: brief!.head, decision: "yes", rule: `${standing.kind}:${standing.project}` });
      return "yes";
    }
    const [messageId] = await this.tg.send(md, { threadId: o.threadId, buttons: confirmButtons(id, brief, brief ? undefined : yesVerb(o.action.trim().split("\n")[0])) });
    return new Promise((resolve) => {
      const summary = brief ? clip(plain(brief.head), 120) : clip(o.action.replace(/\s+/g, " "), 120);
      this.pending.set(id, { kind: "confirm", resolve, messageId, md, more: brief?.more, deploy, rule: brief?.rule, action: o.action, source: o.source, summary, since: Date.now() });
      this.keepOpen(messageId, md);
      const timer = setTimeout(() => this.finishConfirm(id, "timeout"), o.timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        this.finishConfirm(id, "timeout", typeof o.signal?.reason === "string" ? o.signal.reason : (o.abortNote ?? tr("Сессия сняла запрос", "The session withdrew the request")));
      };
      o.signal?.addEventListener("abort", onAbort);
      if (o.signal?.aborted) onAbort();
      audit({ id, type: "asked", source: o.source, action: o.action, reason: o.reason, brief: brief?.head });
    });
  }

  // Cards still open from before a host restart belong to nobody: the old process was waiting for them. They get an
  // honest caption instead of buttons that look alive.
  private openCards = (): Record<string, string> => readJson<Record<string, string>>(join(STATE, "open-cards.json"), {});
  private keepOpen(messageId: number, md?: string) {
    const all = this.openCards();
    if (md === undefined) delete all[messageId];
    else all[messageId] = md;
    writeJson(join(STATE, "open-cards.json"), all);
  }
  // Called once at startup (src/main.ts)
  async expireOld() {
    const old = Object.entries(this.openCards());
    if (!old.length) return;
    writeJson(join(STATE, "open-cards.json"), {});
    for (const [id, md] of old) await this.tg.edit(Number(id), md, { buttons: done(tr("Бот перезапускался — этот запрос больше не действует", "The bot restarted — this request no longer applies")) }).catch(() => {});
  }

  // When the deploy ends the card says how ("Allowed at 11:43 — deployed at 11:51") rather than "waiting for the
  // deploy" forever. An empty tail means the watcher isn't following it.
  private deployCards = new Map<string, { messageId: number; md: string; label: string }>();
  settleDeploy(action: string, tail: string) {
    const c = this.deployCards.get(action);
    if (!c) return;
    this.deployCards.delete(action);
    this.tg.edit(c.messageId, c.md, { buttons: done(tail ? `${c.label} — ${tail}` : c.label) });
  }

  private finishConfirm(id: string, v: "yes" | "no" | "timeout" | "more", note?: string, forever = false) {
    const p = this.pending.get(id);
    if (!p || p.kind !== "confirm") return;
    this.pending.delete(id);
    this.keepOpen(p.messageId);
    // for a deploy the caption says what comes next: the watcher waits for the pipeline and sends a screenshot
    const at = tr(`в ${hhmm()}`, `at ${hhmm()}`);
    const said = v === "yes" ? tr("Разрешено", "Allowed") : v === "no" ? tr("Отклонено", "Declined") : tr("Время вышло", "Timed out");
    const base = `${said} ${at}${forever ? tr(" и дальше без вопросов", ", and from now on without asking") : ""}`;
    const label = note ?? (v === "more" ? `${p.more!.note} ${at}` : `${base}${v === "yes" && p.deploy ? tr(" — жду выкладку", " — waiting for the deploy") : ""}`);
    this.tg.edit(p.messageId, p.md, { buttons: done(label) });
    if (v === "yes" && p.deploy && !note) this.deployCards.set(p.action, { messageId: p.messageId, md: p.md, label: base });
    audit({ id, type: "decided", decision: v });
    p.resolve(v === "more" ? { tell: p.more!.tell } : v);
  }

  // Asks the questions one by one; returns {question: answer}, or null when one went unanswered
  async ask(o: { source: string; questions: Question[]; timeoutMs: number; signal?: AbortSignal; threadId?: number; abortNote?: string }): Promise<Record<string, string> | null> {
    const answers: Record<string, string> = {};
    for (const q of o.questions) {
      const a = await this.askOne(o.source, q, o.timeoutMs, o.signal, o.threadId, o.abortNote);
      if (a === null) return null;
      answers[q.question] = a;
    }
    return answers;
  }

  // The question in bold, then the session's advice and who asks. Options are buttons only; their descriptions go
  // under "Details".
  private async askOne(source: string, q: Question, timeoutMs: number, signal?: AbortSignal, threadId?: number, abortNote?: string): Promise<string | null> {
    const id = randomId();
    const opts = q.options ?? [];
    const rec = opts.find((o) => RECOMMENDED.test(o.label));
    const label = (o: { label: string }) => mdEsc(o.label.replace(RECOMMENDED, ""));
    // the recommended option's description is the advice's reason, lowercased after the colon
    const low = (x: string) => (tr(/^\p{Lu}\p{Ll}/u, /^[A-Z][a-z]+\b/).test(x) ? x.charAt(0).toLowerCase() + x.slice(1) : x);
    const advice = rec && `${quote(label(rec))}${rec.description ? `: ${mdEsc(low(rec.description))}` : ""}`;
    const about = opts.filter((o) => o.description && o !== rec).map((o) => `${label(o)} — ${mdEsc(low(o.description!))}`);
    const who = sessionName(source);
    const from =
      source === "Архитектор"
        ? advice
          ? tr(`Советую ${advice}`, `I’d pick ${advice}`)
          : ""
        : advice
          ? tr(`Сессия ${who} советует ${advice}`, `${who.charAt(0).toUpperCase()}${who.slice(1)} recommends ${advice}`)
          : tr(`Спрашивает сессия ${who}`, `Asked by ${who}`);
    const md = [
      `**${mdEsc(scrub(q.question))}**`,
      [dot(from.replace(/\s+/g, " ").trim()), q.multiSelect ? tr("Можно выбрать несколько, потом «Отправить».", "You can pick several, then tap “Send”.") : ""].filter(Boolean).join("\n"), // free-text replies (swipe the question) are in the guide
      about.length ? `<details><summary>${tr("Подробнее", "Details")}</summary>\n\n${about.join("\n\n")}\n\n</details>` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const [messageId] = await this.tg.send(md, { threadId, buttons: this.questionButtons(id, q, new Set()) });
    return new Promise((resolve) => {
      // the whole question: the dashboard picks its sentence with "?"
      this.pending.set(id, { kind: "question", resolve, messageId, md, q, picked: new Set(), source, summary: q.question.replace(/\s+/g, " ").trim(), since: Date.now() });
      this.keepOpen(messageId, md);
      const timer = setTimeout(() => this.finishQuestion(id, null), timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        this.finishQuestion(id, null, typeof signal?.reason === "string" ? signal.reason : abortNote);
      };
      signal?.addEventListener("abort", onAbort);
      if (signal?.aborted) onAbort();
    });
  }

  // The session's recommendation and the picked options are blue
  private questionButtons(id: string, q: Question, picked: Set<number>): Button[][] {
    const rows: Button[][] = (q.options ?? []).map((o, k) => [
      { text: clip(o.label.replace(RECOMMENDED, ""), 60), data: `q:${id}:${k}`, ...(picked.has(k) || (!q.multiSelect && RECOMMENDED.test(o.label)) ? { style: "primary" as const } : {}) },
    ]);
    if (q.multiSelect) rows.push([{ text: picked.size ? `${tr("Отправить", "Send")} (${picked.size})` : tr("Отправить", "Send"), data: `q:${id}:done`, style: "success" as const }]);
    return rows;
  }

  private finishQuestion(id: string, answer: string | null, note?: string, picked = false) {
    const p = this.pending.get(id);
    if (!p || p.kind !== "question") return;
    this.pending.delete(id);
    this.keepOpen(p.messageId);
    const label =
      answer === null
        ? (note ?? tr("Без ответа", "No answer"))
        : picked
          ? tr(`Выбрано «${clip(answer.replace(RECOMMENDED, ""), 28)}» в ${hhmm()}`, `Picked “${clip(answer.replace(RECOMMENDED, ""), 28)}” at ${hhmm()}`)
          : tr(`Ответ получен в ${hhmm()}`, `Answer received at ${hhmm()}`);
    this.tg.edit(p.messageId, p.md, { buttons: done(label) });
    audit({ id, type: "answered", answer });
    p.resolve(answer);
  }
}

function audit(rec: Record<string, unknown>) {
  try {
    appendFileSync(join(LOGS, "decisions.jsonl"), scrub(JSON.stringify({ at: new Date().toISOString(), ...rec })) + "\n");
  } catch (e) {
    log("approvals", "не записал журнал решений", String(e));
  }
}
