// The dashboard: one pinned message with the current state. Its first line, visible in the pinned bar, answers
// directly; then who waits and for what, problems, who works, who finished; one-tap decisions below. Edited in place
// without notifications; a new one is sent only if the old one was deleted. "What's up" gets the same view.
import { join } from "node:path";
import type { Approvals } from "./approvals";
import { STATE, tr } from "./config";
import { stopHolds } from "./holds";
import type { AgentRow } from "./sessions";
import { renderView, view, type Ask, type Overview, type View } from "./status";
import type { Button, Telegram } from "./telegram";
import { clean, type SessionUI } from "./ui";
import { clip, hhmm, log, readJson, writeJson } from "./util";

const FILE = join(STATE, "board.json");
type Pending = Ask & { messageId: number; kind: "confirm" | "question"; final: boolean };
const EMPTY: Overview = { at: 0, rows: [], sites: [], repos: [], machine: { load5: 0, cpus: 0, diskFreeGb: 0 }, flags: [] };

// What is being asked, as a verb phrase ("push code to main"); the command itself stays in the request
export function deed(action: string): string {
  const a = action.replace(/\s+/g, " ").trim();
  // already words: Cyrillic in Russian; in English a capitalized phrase with no flags or shell characters
  const words = tr(/[а-яё]/i.test(a), /^[A-Z][a-z]/.test(a) && !/(^|\s)--?\w/.test(a)) && !/[|&;$`=]|\b(cd|ls|cat|python3?|bun|node|bash|sh)\s/.test(a);
  const said = () => clip(tr(a.charAt(0).toLowerCase(), /^[A-Z][a-z]+\b/.test(a) ? a.charAt(0).toLowerCase() : a.charAt(0)) + a.slice(1).split(/[:\n]/)[0], 60);
  // in English the brief's first line starts with a verb: "Deploy Beacon" is words, not the deploy command
  if (words && tr(false, true)) return said();
  if (/\bgit\b.*\bpush\b/.test(a)) return /\b(main|master)\b/.test(a) ? tr(`отправить код в${String.fromCharCode(0xa0)}main`, "push code to main") : tr("отправить код на GitHub", "push code to GitHub"); // keep "в main" on one line
  if (/\bgh\s+pr\s+merge\b/.test(a)) return tr("слить PR", "merge the PR");
  if (/\bgh\s+(workflow\s+run|run\s+rerun)\b|\b(deploy|publish|release)\b/i.test(a)) return tr("выложить", "deploy");
  if (/(^|[\s;&|])(rm|rmdir|trash)\s|\bunlink\b/.test(a)) return tr("удалить файлы", "delete files");
  if (words) return said();
  return tr("выполнить команду", "run a command");
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
// The first words within n characters, without a dangling preposition or conjunction
const words = (s: string, n: number) => {
  let out = "";
  for (const w of s.split(" ")) {
    if (`${out} ${w}`.trim().length > n) break;
    out = `${out} ${w}`.trim();
  }
  return out.replace(tr(/(\s+(в|во|на|с|со|к|ко|и|а|по|за|из|у|о|об|для|от|до))+$/i, /(\s+(to|in|into|on|at|of|for|from|with|by|and|or|the|a|an))+$/i), "");
};

// A question in short, without paths or file names; a long one is cut around its question, in whole sentences
export function shortQuestion(q: string): string {
  const s = clean(q.replace(/\s+/g, " ").trim());
  if (s.length <= 90) return s.replace(/^./, (c) => c.toLowerCase());
  // Keep the question, not the start of the story: the last sentence with "?", then what fits after it
  // ("About an hour of work"), then before it.
  const parts = s.split(/(?<=[.!?])\s+(?=[А-ЯЁA-Z«])/); // "fig. 2" is not a sentence end
  let i = parts.findLastIndex((p) => p.includes("?"));
  if (i < 0) i = parts.length - 1;
  let out = parts[i].length <= 90 ? parts[i] : "";
  for (let j = i + 1; out && j < parts.length && `${out} ${parts[j]}`.length <= 90; j++) out = `${out} ${parts[j]}`;
  for (let j = i - 1; out && j >= 0 && `${parts[j]} ${out}`.length <= 90; j--) out = `${parts[j]} ${out}`;
  // a short question ("How to fix?") needs its subject: the first sentence up to a dash goes in front
  // ("Beacon: the v15 run failed on link checks. How to fix?")
  if (i > 0 && parts[i].length < 40 && !out.startsWith(parts[0])) {
    const subject = parts[0].split(/\s+[—–]\s+/)[0].replace(/[.!…:;,]+$/, "");
    if (`${subject}. ${parts[i]}`.length <= 100) out = `${subject}. ${parts[i]}`;
  }
  return (out || clip(parts[i], 90)).replace(/^./, (c) => c.toLowerCase());
}

export class Board {
  private st = readJson<{ messageId?: number }>(FILE, {});
  private flagIds = new Map<string, string>(); // short button id → flag text
  private replyIds = new Map<string, { sessionId: string; cwd: string; what?: string }>(); // short "Reply" id → session
  onFix?: (flag: string, messageId: number) => void;
  private lastMd = "";
  private lastAt = 0;
  overview?: Overview;

  constructor(private d: { tg: Telegram; ui: SessionUI; approvals: Approvals }) {
    d.tg.onCallback("f", async ({ id, messageId, answer }) => {
      const flag = this.flagIds.get(id);
      if (!flag) return answer(tr("Это уже не актуально", "This is no longer relevant"));
      await answer(tr("Беру в работу", "On it"));
      this.onFix?.(flag, messageId);
    });
    // "Refresh" from older dashboards: their buttons are still under old messages
    d.tg.onCallback("b", async ({ answer }) => {
      this.lastMd = "";
      await answer(tr("Обновляю", "Refreshing"));
      await this.render(this.rows, true);
    });
    d.tg.onCallback("r", async ({ id, answer }) => {
      const r = this.replyIds.get(id);
      if (!r) return answer(tr("Это уже не актуально", "This is no longer relevant"));
      await answer(tr("Напишите ответ", "Type your reply"));
      await this.d.ui.askReply(r.sessionId, r.cwd, r.what);
    });
    // "Check for me: …" asks the architect to prepare acceptance: check the work and send a brief
    d.tg.onCallback("p", async ({ id, messageId, answer }) => {
      const name = this.prepareIds.get(id);
      if (!name || !this.onPrepare) return answer(tr("Это уже не актуально", "This is no longer relevant"));
      await answer(tr("Проверю и пришлю отчёт; «принято» — за вами", "I’ll check and send a report; the final sign-off is yours"));
      this.onPrepare(`Подготовь приёмку «${name}»`, messageId);
    });
  }

  private prepareIds = new Map<string, string>(); // short "Check for me" id → session name
  onPrepare?: (text: string, messageId: number) => void;
  architectDown?: () => boolean; // the architect can't reply (Claude limit)

  private rows: AgentRow[] = [];

  // Permission requests and questions waiting on buttons come first among decisions, phrased as questions. A brief's
  // first line already reads as words ("Deploy “Beacon”"); the session name starts the line, so it is cut from the brief.
  private pending(): Pending[] {
    return this.d.approvals.list().map((p) => {
      const name = p.source.replace(/^«(.+)»$/, "$1");
      let what = p.kind === "confirm" ? `${deed(p.summary)}?` : shortQuestion(p.summary);
      // "in project “Beacon”" is redundant for Beacon's own session but needed for another project's
      const quoted = tr(` «${name}»`, ` “${name}”`);
      const own = what.includes(quoted);
      if (what.toLowerCase().startsWith(`${name.toLowerCase()} `) || what.toLowerCase().startsWith(`${name.toLowerCase()}: `)) what = what.slice(name.length).replace(/^:?\s+/, ""); // no "Blog — blog asks to delete…"
      return { name, what: own ? what.replace(quoted, "").replace(tr(/ (проекта|в проекте)(?=[ ?])/, / (of project|in project)(?=[ ?])/), "") : what, messageId: p.messageId, kind: p.kind, final: p.final };
    });
  }

  // "Look into" buttons for problems one can act on (a site, disk space; not the limit)
  fixButtons(flags = this.overview?.flags ?? []): Button[][] {
    const rows: Button[][] = [];
    for (const f of flags.filter((x) => !tr(/лимита? Claude/i, /Claude limit/i).test(x))) {
      const id = Bun.hash(f).toString(36).slice(0, 10);
      this.flagIds.set(id, f);
      const site = f.match(tr(/^Сайт (.+?) не открывается/, /^(.+?) site is down/))?.[1];
      const text = site
        ? tr(`Разобраться с сайтом ${site}`, `Look into the ${site} site`)
        : tr(/диске/, /disk/).test(f)
          ? tr("Разобраться с местом на диске", "Look into disk space")
          : tr(`Разобраться: ${clip(f.split(":")[0], 26)}`, `Look into: ${clip(f.split(":")[0], 26)}`);
      rows.push([{ text, data: `f:${id}` }]);
    }
    return rows.slice(0, 3);
  }

  // One button per decision, in line order: a verb and its object, the same under the dashboard and "what's up".
  // "Reply: …" opens a reply to that session; a reversible request gets its "yes" here, last. For acceptance,
  // "Check for me: …": the architect checks the work and sends a brief; the owner still writes "accepted" in the session.
  // At most four, plus one "Look into".
  private buttons(v: View, asks: Pending[]): Button[][] {
    const rows: Button[][] = [];
    const decide: Button[][] = [];
    for (const i of v.waiting) {
      const a = asks.find((x) => x.name === i.name && x.what === i.what);
      if (a) {
        const all = this.d.tg.buttonsOf(a.messageId)?.flat() ?? [];
        const yes = all.find((b) => b.data?.endsWith(":y"));
        const free = all.find((b) => b.data?.endsWith(":free"));
        const verb = cap(i.what.replace(/\?$/, ""));
        // no name for the architect's own request, or when the verb already names the session
        const stem = a.name.split(/[\s:]+/)[0].toLowerCase().slice(0, 4);
        const who = a.name === "Архитектор" || (stem.length >= 3 && verb.toLowerCase().includes(stem)) ? "" : `: ${a.name}`;
        // the first label within 40 characters: "Push code to main: Docs", the verb alone, then cut by words
        const label = [`${verb}${who}`, verb, words(verb, 40 - who.length) + who, words(verb, 40)].find((t) => t.length <= 40 && t.length > who.length) ?? clip(verb.split(" ")[0], 40);
        // reversible: one tap here, the brief with screenshots has arrived; irreversible: only from the brief itself
        if (a.kind === "confirm" && yes && !a.final) decide.push([{ text: label, data: yes.data }]);
        if (a.kind === "question" && free) rows.push([{ text: clip(`${tr("Ответить", "Reply")}: ${a.name}`, 40), data: free.data }]);
        continue;
      }
      if (!i.reply || !i.sessionId) continue;
      const id = Bun.hash(i.sessionId).toString(36).slice(0, 10);
      this.replyIds.set(id, { sessionId: i.sessionId, cwd: i.cwd!, what: i.what });
      rows.push([{ text: clip(`${tr("Ответить", "Reply")}: ${i.name}`, 40), data: `r:${id}` }]);
    }
    // One label for all: "Check for me: …", or "Check: …" for all if one doesn't fit. Without the architect (Claude
    // limit out) neither these nor "Look into" would work, so they are hidden.
    const down = this.architectDown?.() ?? false;
    const accept = down ? [] : v.accept.slice(0, 2);
    // "for me": the button starts a checking session, the owner doesn't check it themselves
    const full = tr("Проверить за меня", "Check for me");
    const long = accept.some((i) => `${full}: ${i.name}`.length > 32); // an iPhone button fits about 32 characters
    for (const i of accept) {
      const id = Bun.hash(i.name).toString(36).slice(0, 10);
      this.prepareIds.set(id, i.name);
      rows.push([{ text: clip(`${long ? tr("Проверить", "Check") : full}: ${i.name}`, 40), data: `p:${id}` }]);
    }
    return [...rows.slice(0, 4 - Math.min(decide.length, 2)), ...(down ? [] : this.fixButtons().slice(0, 1)), ...decide.slice(0, 2)];
  }

  // The same overview for the architect (overview tool), with the names and states the owner sees; full lists all names
  summary(o: Overview, full = false): string {
    return renderView(view(o, { asks: this.pending(), holds: stopHolds.all() }), false, full);
  }

  // The dashboard's state, for the host's short answers
  snapshot(o: Overview): View {
    return view(o, { asks: this.pending(), holds: stopHolds.all() });
  }

  // The dashboard (board) or the "what's up" answer: the text, the same without the update time (for comparison),
  // and the buttons
  compose(o: Overview, board = true): { md: string; body: string; buttons: Button[][] } {
    const asks = this.pending();
    const v = view(o, { asks, holds: stopHolds.all() });
    const body = renderView(v, board);
    return { md: board ? renderView(v, true, false, [tr(`Обновлено в ${hhmm()}`, `Updated at ${hhmm()}`)]) : body, body, buttons: this.buttons(v, asks) };
  }

  // Called on every watcher pass
  async render(rows: AgentRow[], force = false) {
    this.rows = rows;
    if (!this.d.tg.owner) return;
    const { md, body, buttons } = this.compose({ ...(this.overview ?? EMPTY), rows });
    if (!force && body === this.lastMd && Date.now() - this.lastAt < 5 * 60_000) return; // a new update time alone is no reason to edit
    if (!force && Date.now() - this.lastAt < 15_000) return;
    this.lastMd = body;
    this.lastAt = Date.now();
    if (this.st.messageId) {
      const r = await this.d.tg.editStrict(this.st.messageId, md, { buttons });
      if (r === "ok") return;
      if (r === "error") {
        this.lastMd = ""; // retry on the next pass rather than post a new dashboard
        return;
      }
    }
    const [id] = await this.d.tg.send(md, { buttons, silent: true });
    if (!id) return;
    this.st.messageId = id;
    writeJson(FILE, this.st);
    await this.d.tg.unpinAll(); // only one dashboard is ever pinned
    await this.d.tg.pin(id);
    log("board", "пульт создан и закреплён");
  }
}
