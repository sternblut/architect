// How sessions look to the owner: a topic per session in the private chat (with Threaded Mode on) with a card of its
// state and buttons. Without topics everything goes to the main chat, with replies tied to sessions.
import { basename, join } from "node:path";
import { ARCH_HOME, HOME, STATE, config, tr } from "./config";
import { mdEsc, stripMd } from "./md";
import { conversationRows, deliver, listAgents, readTail, sessionDigest, stopSession, transcriptPath, workers, type AgentRow, type ConvRow } from "./sessions";
import type { Button, Telegram } from "./telegram";
import { clip, hhmm, log, readJson, writeJson } from "./util";
import { understood } from "./understand";

type View = { threadId?: number; cardId?: number; name: string; cwd: string; cardMd?: string; cardButtons?: string; cardState?: string; cardAt?: number; lastTurnAt?: number };
type Store = { views: Record<string, View>; msgs: Record<string, string> };
const FILE = join(STATE, "ui.json");

// State in words, no icons or emoji. Claude Code's "done" means the turn ended, not "paused".
const WORD: Record<string, string> = { starting: "запускается", working: "работает", blocked: "ждёт вас", done: "закончила", failed: "остановилась на ошибке", stopped: "остановлена" };
const WORD_EN: Record<string, string> = { starting: "starting", working: "working", blocked: "waiting for you", done: "finished", failed: "stopped on an error", stopped: "stopped" };
// The pinned message's words, from the session judgment in src/understand.ts when there is one
const UNDERSTOOD: Record<string, string> = { needs_owner: "ждёт вашего решения", accept: "закончила, ждёт вашей проверки", paused: "на паузе", working: "работает" };
const UNDERSTOOD_EN: Record<string, string> = { needs_owner: "needs your decision", accept: "finished, ready for your review", paused: "paused", working: "working" };
const LOG = () => tr("Последние шаги", "Recent steps");

// Names that mean nothing to the owner: "claude-7f", "user-99", a background session id like "c3a758b4", and Claude
// Code's generic names such as "continue previous session"
const autoName = (n?: string) => !n || /^[\w.-]+-[0-9a-f]{2,4}$/i.test(n) || /^[0-9a-f]{6,}(-[0-9a-f-]+)?$/i.test(n) || /^(continue( the)? previous session|new session|untitled( session)?)$/i.test(n);
// A session's words without paths and file names: "Excel lock file ~$Report.xlsx" → "Excel lock file"
export const clean = (t: string) =>
  t
    // a path or file name goes with the preposition before it ("saved to a/b.md"); a file dragged into the terminal
    // has "\ " for spaces
    .replace(
      tr(
        /(?:\s(?:в|во|на|из|к|по|от)(?=\s))?(?:(^|\s)[~/](?:\\\s|\S)*[^\s,.;:!?»)]|\s?\S+\/\S+\.\w{1,5}\b|\s?\S+\.(xlsx?|docx?|md|json|jsonl|ts|js|py|html|csv|pdf|png|jpe?g|txt)\b)/gi,
        /(?:\s(?:in|into|to|at|from|on)(?=\s))?(?:(^|\s)[~/](?:\\\s|\S)*[^\s,.;:!?»”)]|\s?\S+\/\S+\.\w{1,5}\b|\s?\S+\.(xlsx?|docx?|md|json|jsonl|ts|js|py|html|csv|pdf|png|jpe?g|txt)\b)/gi,
      ),
      "$1",
    )
    .replace(/\s+([?.,!])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
// A site URL in the session's goal gives its name; longer URLs first, as one site can live under another's URL
const SITES = config.sites
  .map((s) => ({ name: s.name, re: new RegExp(`(?<![\\w.-])${s.url.replace(/^https?:\/\//, "").replace(/\/$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i"), len: s.url.length }))
  .sort((a, b) => b.len - a.len);

// A session's name for the owner: the architect's name or /rename → a site from the goal → its own folder → the start
// of the goal → Claude's title. A name the owner already knows sticks: Claude's auto-title follows the conversation
// and would keep renaming it. Only the owner renames (/rename).
const NAMES_FILE = join(STATE, "names.json");
// The bot's own folder or a checkout of it (architect, architect-dev): a session that builds the bot
const OWN = new RegExp(`^${basename(ARCH_HOME).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(-[\\w]+)?$`, "i");
const BUILD = () => tr("Сборка бота", "Bot build");
// A remembered id-like name ("c3a758b4") or the bot's folder name ("Architect") is dropped, so a real name is found again
const known = Object.fromEntries(Object.entries(readJson<Record<string, string>>(NAMES_FILE, {})).filter(([, v]) => !autoName(v) && !OWN.test(v)));
const keep = (sessionId: string, name: string) => {
  if (known[sessionId] !== name) {
    known[sessionId] = name;
    writeJson(NAMES_FILE, known);
  }
  return name;
};

// A name the owner gave through the architect ("call it Blog") beats any guess by the host
const GIVEN_FILE = join(STATE, "given-names.json");
const given = readJson<Record<string, string>>(GIVEN_FILE, {});
export function giveName(sessionId: string, name: string) {
  given[sessionId] = name;
  writeJson(GIVEN_FILE, given);
}

export function displayName(sessionId: string, cwd: string, rows: AgentRow[] = []): string {
  if (given[sessionId]) return given[sessionId];
  const w = workers.get(sessionId);
  if (w?.name) return w.name;
  // the remembered name comes before the process name: after /bg Claude Code calls the session "continue previous
  // session". Only the owner renames (name_session).
  if (known[sessionId]) return known[sessionId];
  const row = rows.find((r) => r.sessionId === sessionId);
  if (row?.name && !autoName(row.name)) return keep(sessionId, row.name);
  const d = sessionDigest({ sessionId, cwd } as AgentRow);
  if (d.named && d.title) return keep(sessionId, clip(d.title, 40));
  return named(sessionId, cwd, rows, d);
}

function named(sessionId: string, cwd: string, rows: AgentRow[], d: ReturnType<typeof sessionDigest>): string {
  const site = d.goal ? SITES.find((s) => s.re.test(d.goal!)) : undefined;
  if (site) return keep(sessionId, site.name);
  const folder = basename(cwd).replace(/[^\p{L}\p{N}]+$/u, "");
  const alone = rows.length > 0 && rows.filter((r) => r.cwd === cwd && (r.pid || r.state === "working" || r.state === "blocked")).length <= 1;
  if (folder && alone && cwd !== HOME && !config.roots.includes(cwd)) return keep(sessionId, cap1(folder));
  const clause = d.goal?.replace(/^ЦЕЛЬ\s*—\s*/i, "").split(/[,.:;(]|\s—\s/)[0].trim();
  const bySite = clause && config.sites.find((s) => clause.toLowerCase().startsWith(s.name.toLowerCase() + " ")); // "blog redesign" → "Blog"
  if (bySite) return keep(sessionId, bySite.name);
  if (clause && clause.length <= 40) return keep(sessionId, cap1(clause));
  // In a shared folder, the subfolder it works in ("projects/landing" → site "Landing"). The transcript tail can be
  // short (large tool results), so the subfolder is remembered and the name doesn't jump.
  const sub = workDir(d.tools ?? [], cwd) ?? workDirs.get(sessionId);
  if (sub) {
    workDirs.set(sessionId, sub);
    // the bot's own folder is "Bot build": "Architect" would read as the bot itself
    if (OWN.test(sub)) return keep(sessionId, BUILD());
    return keep(sessionId, config.sites.find((s) => s.repo === sub || s.repo?.endsWith(`-${sub}`))?.name ?? cap1(sub));
  }
  return clip(d.title ?? clause ?? (cap1(folder) || `${tr("сессия", "session")} ${sessionId.slice(0, 6)}`), 40);
}

const workDirs = new Map<string, string>(); // session → subfolder it works in

// The cwd subfolder that recent commands and files point into: at least two of them, and 60% of those inside cwd
function workDir(tools: string[], cwd: string): string | undefined {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const base = cwd.startsWith(`${HOME}/`) ? `(?:${esc(HOME)}|~)${esc(cwd.slice(HOME.length))}` : esc(cwd);
  const re = new RegExp(`${base}/([^/\\s"'\`]+)`);
  const count = new Map<string, number>();
  for (const t of tools) {
    const sub = t.match(re)?.[1];
    if (sub && !sub.startsWith(".")) count.set(sub, (count.get(sub) ?? 0) + 1);
  }
  const all = [...count.values()].reduce((a, b) => a + b, 0);
  const [top, n] = [...count].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  return n >= 2 && n >= all * 0.6 ? top : undefined;
}

// A session's words in short: no paths or markup, whole sentences up to 170 characters
function short(t: string): string {
  const s = clean(stripMd(t))
    .replace(/\.?\s+-\s+/g, ". ")
    .replace(/\s+/g, " ")
    .trim();
  let out = "";
  for (const x of s.split(/(?<=[.!?…])\s+/)) {
    if (`${out} ${x}`.trim().length > 170) break;
    out = `${out} ${x}`.trim();
  }
  return out || `${s.slice(0, s.lastIndexOf(" ", 165))}…`;
}

const SYSTEM_TEXT = /^\s*(You've hit your|API Error|Claude Code returned an error|Request interrupted|\[Request interrupted|Prompt is too long|Credit balance)/i;

// The session's last meaningful messages: no commands, no repeated "Waiting…", no service chatter about other sessions.
// One per minute, the longest, since a turn comes in pieces.
function talk(sessionId: string, cwd: string): ConvRow[] {
  const rows: ConvRow[] = [];
  for (const r of conversationRows(readTail(transcriptPath(cwd, sessionId)), 400)) {
    if (r.who === "tool" || (r.who === "claude" && /^(жду(?!\p{L})|waiting\b)/iu.test(r.text.trim())) || /\b[a-z]+-[0-9a-f]{2,4}\b/.test(r.text) || !short(r.text)) continue;
    // a limit or API error is not the session's words
    if (r.who === "claude" && SYSTEM_TEXT.test(r.text)) continue;
    const prev = rows.at(-1);
    if (prev && prev.ts === r.ts && prev.who === r.who) {
      if (r.text.length > prev.text.length) rows[rows.length - 1] = r;
    } else rows.push(r);
  }
  return rows;
}

// "14:08" today, "Oct 16, 14:08" before
const day = (t: number) =>
  tr(new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "long" }), new Date(t).toLocaleDateString("en-US", { day: "numeric", month: "short" }));
const when = (r: ConvRow) => (day(r.at) === day(Date.now()) ? r.ts : `${day(r.at)}, ${r.ts}`);

export class SessionUI {
  private s: Store = readJson<Store>(FILE, { views: {}, msgs: {} });
  rows = new Map<string, AgentRow>();
  private hooked = new Set<string>(); // sessions with the shared hook: their turns come from hooks, not the transcript

  markHooked(sessionId: string) {
    this.hooked.add(sessionId);
  }
  isHooked(sessionId: string) {
    return this.hooked.has(sessionId);
  }

  constructor(private tg: Telegram) {
    tg.onCallback("s", async ({ id, value, answer }) => {
      const view = this.s.views[id];
      if (!view) return answer(tr("Сессия не найдена", "Session not found"));
      const row = this.rows.get(id);
      if (value === "log") {
        await this.post(id, view.cwd, this.logMd(id, view), { silent: true, bare: true, buttons: [[{ text: tr("Ответить", "Reply"), data: `s:${id}:reply` }]] });
        return answer();
      }
      if (value === "reply") {
        await answer(tr("Напишите ответ", "Type your reply"));
        return this.askReply(id, view.cwd);
      }
      if (value === "stop") {
        await this.tg.edit(view.cardId!, (view.cardMd ?? "") + tr("\n\n**Остановить её?** Разговор сохранится, её можно будет продолжить.", "\n\n**Stop it?** The conversation is kept, so you can resume it later."), {
          buttons: [[{ text: tr("Остановить", "Stop"), data: `s:${id}:stop!`, style: "danger" }, { text: tr("Отмена", "Cancel"), data: `s:${id}:back` }]],
        });
        return answer();
      }
      if (value === "back") {
        view.cardMd = undefined;
        await this.renderCard(id);
        return answer();
      }
      if (value === "stop!") {
        if (!row?.id) return answer(tr("Она открыта на Mac — остановить можно только там", "It’s open on the Mac — you can only stop it there"));
        await answer(tr("Останавливаю", "Stopping")); // answer the tap now: claude stop takes up to 30 s
        const out = await stopSession(row.id);
        if (!/stopped/i.test(out)) log("ui", "остановить не вышло", clip(out, 300));
        await this.post(id, view.cwd, /stopped/i.test(out) ? tr("Остановлена.", "Stopped.") : tr("Остановить не вышло. Попробуйте ещё раз или остановите её на Mac.", "Couldn’t stop it. Try again or stop it on the Mac."), { silent: true });
        view.cardMd = undefined;
        await this.renderCard(id);
        return;
      }
      // "Resume" after a failure or stop: wake the session the same way as an owner's reply
      if (value === "go") {
        const r = row ?? (await listAgents(true)).find((x) => x.sessionId === id); // a failed session isn't among the live rows
        if (!r) return answer(tr("Сессия не найдена", "Session not found"));
        await answer(tr("Продолжает", "Resuming"));
        // sent as the owner's message, so in the owner's language
        const res = await deliver(r, tr("Продолжай с того места, где остановилась.", "Continue from where you left off."));
        if (!res.ok) await this.post(id, view.cwd, `${tr("не продолжила", "didn’t resume")}: ${mdEsc(clip(res.note, 200))}`, { silent: true, inline: true });
        return;
      }
      return answer();
    });
  }

  private save() {
    const keys = Object.keys(this.s.msgs);
    if (keys.length > 1500) for (const k of keys.slice(0, keys.length - 1500)) delete this.s.msgs[k];
    writeJson(FILE, this.s);
  }

  // The name the owner sees, without quotes or folder
  nameOf(sessionId: string, cwd: string) {
    return displayName(sessionId, cwd, [...this.rows.values()]);
  }

  // The name in quotes, for use inside a sentence
  label(sessionId: string, cwd: string) {
    return `«${this.nameOf(sessionId, cwd)}»`;
  }

  sessionForThread(threadId: number) {
    return Object.entries(this.s.views).find(([, v]) => v.threadId === threadId)?.[0];
  }
  sessionForMessage(messageId: number) {
    return this.s.msgs[String(messageId)];
  }

  private ensure(sessionId: string, cwd: string): View {
    return (this.s.views[sessionId] ??= { name: this.nameOf(sessionId, cwd), cwd });
  }

  async threadFor(sessionId: string, cwd: string): Promise<number | undefined> {
    const v = this.ensure(sessionId, cwd);
    if (v.threadId || !this.tg.topicsOn) return v.threadId;
    v.threadId = await this.tg.createTopic(`${v.name} · ${basename(cwd)}`);
    if (v.threadId) {
      v.cardId = undefined; // the card moves into the topic
      v.cardMd = undefined;
      this.save();
      await this.renderCard(sessionId);
    }
    return v.threadId;
  }

  // Posts to the session's topic. Without topics, to the main chat with the session's name on the line above, or at the
  // start of the first line with inline ("**Name** — …"); with bare the text names the session itself.
  async post(sessionId: string, cwd: string, md: string, opts: { silent?: boolean; buttons?: Button[][]; forceReply?: string; inline?: boolean; bare?: boolean } = {}) {
    const threadId = await this.threadFor(sessionId, cwd);
    const name = `**${mdEsc(this.nameOf(sessionId, cwd))}**`;
    const text = threadId || opts.bare ? cap1(md) : opts.inline ? `${name} — ${md}` : `${name}\n${cap1(md)}`;
    const ids = await this.tg.send(text, { threadId, silent: opts.silent, buttons: opts.buttons, forceReply: opts.forceReply });
    for (const id of ids) this.s.msgs[String(id)] = sessionId;
    this.save();
    return ids;
  }

  // "Reply" on the dashboard: the input field becomes a reply to this message, and the answer goes to the session as
  // usual. While the owner types, the session's question (or else its last words) stays in view.
  async askReply(sessionId: string, cwd: string, what?: string) {
    const name = this.nameOf(sessionId, cwd);
    const question = !!what?.endsWith("?");
    const waits = question ? tr(`спрашивает: ${mdEsc(what!)}`, `asks: ${mdEsc(what!)}`) : tr("ждёт вашего ответа.", "is waiting for your reply.");
    const head = `**${mdEsc(name)}** ${waits} ${tr("Напишите — передам как есть.", "Type it and I’ll pass it on as is.")}`;
    const last = question ? undefined : talk(sessionId, cwd).filter((r) => r.who === "claude").at(-1);
    await this.post(sessionId, cwd, [head, last ? `**${when(last)}**  \n${mdEsc(short(last.text))}` : ""].filter(Boolean).join("\n\n"), { bare: true, forceReply: tr("Ваш ответ", "Your reply") }); // the line above names the session
  }

  onTurn?: (sessionId: string, cwd: string, text: string) => void; // the dashboard tracks who finished recently

  async album(sessionId: string, cwd: string, items: { path: string; caption?: string }[], replyTo?: number, silent = true) {
    const threadId = await this.threadFor(sessionId, cwd);
    const ids = await this.tg.sendAlbum(items, { threadId, replyTo, silent });
    for (const id of ids) this.s.msgs[String(id)] = sessionId;
    this.save();
  }

  // A worker's turn ended: the card and dashboard update; the architect writes to the owner after reading it
  noteTurn(sessionId: string, cwd: string, text: string) {
    this.onTurn?.(sessionId, cwd, text);
    const v = this.ensure(sessionId, cwd);
    v.lastTurnAt = Date.now();
    this.save();
  }

  // An alert: what happened in bold on the first line, details below, then what can be done. The text continues the
  // phrase "Session X …" ("stopped on an error at 13:40"). The running host replaces it (main.ts): alerts go to the
  // architect.
  async alert(sessionId: string, cwd: string, text: string, opts: { silent?: boolean } = {}) {
    const [first, ...rest] = text.trim().replace(/^сессия\s+/i, "").split(/(?<=\.)\s+/);
    const news = first.replace(/\.$/, "").replace(/ в (?=\d)/g, ` в${String.fromCharCode(0xa0)}`); // keep "в 13:40" on one line
    const who = tr(`Сессия «${this.nameOf(sessionId, cwd)}»`, `Session “${this.nameOf(sessionId, cwd)}”`);
    // a Russian verb continues the phrase; anything else follows a colon
    const head = /^[а-яё]+(?:ла|лась|ёт|ет|ит)(?![а-яё])/.test(news) ? `${who} ${news}` : `${who}: ${news}`;
    const rc = sessionDigest({ sessionId, cwd } as AgentRow).rcUrl;
    // as on a failed card: "Resume" first, then "Recent steps" and "Open in Claude", one per row
    const buttons: Button[][] = [[{ text: tr("Продолжить", "Resume"), data: `s:${sessionId}:go` }], [{ text: LOG(), data: `s:${sessionId}:log` }], ...(rc ? [[{ text: tr("Открыть в Claude", "Open in Claude"), url: rc }]] : [])];
    // a period ends the heading, which otherwise runs into the next line on the lock screen
    await this.post(sessionId, cwd, [`**${mdEsc(head)}.**`, ...rest].join("\n"), { ...opts, bare: true, buttons });
  }

  // "Recent steps": the last two messages, newest first, a sentence or two each, with the time on its own line
  private logMd(sessionId: string, v: View) {
    const lines = talk(sessionId, v.cwd)
      .slice(-2)
      .reverse()
      .map((r) => `**${when(r)}**  \n${r.who === "owner" ? tr("Вы: ", "You: ") : r.who === "session" ? tr("Другая сессия: ", "Another session: ") : ""}${mdEsc(short(r.text))}`);
    return [
      `**${mdEsc(this.nameOf(sessionId, v.cwd))}** — ${tr("последние шаги", "recent steps")}`,
      ...(lines.length ? lines : [tr("Пояснений в последних шагах нет — только служебные команды.", "No explanations in the recent steps, only internal commands.")]),
    ].join("\n\n");
  }

  stateOf(sessionId: string): string {
    const row = this.rows.get(sessionId);
    const w = workers.get(sessionId);
    if (row?.state) return row.state;
    if (row) return row.status === "busy" ? "working" : row.status === "waiting" ? "blocked" : "done";
    return w && Date.now() - w.startedAt < 90_000 ? "starting" : "stopped";
  }

  cardMd(sessionId: string): { md: string; buttons: Button[][] } {
    const v = this.s.views[sessionId];
    const row = this.rows.get(sessionId);
    const w = workers.get(sessionId);
    const d = sessionDigest(row ?? ({ sessionId, cwd: v.cwd } as AgentRow));
    const state = this.stateOf(sessionId);
    // the name in bold, then the state and since when (no task recap: the name says it)
    const NB = String.fromCharCode(0xa0);
    const day = (x: Date) => tr(x.toLocaleDateString("ru-RU", { day: "numeric", month: "long" }), x.toLocaleDateString("en-US", { day: "numeric", month: "short" })).replace(" ", NB);
    const today = (t: number) => day(new Date(t)) === day(new Date());
    const at = (t: number) => (today(t) ? `${NB}${hhmm(new Date(t))}` : `${NB}${day(new Date(t))}`);
    const started = w?.startedAt ?? row?.startedAt ?? Date.now();
    // a background session gets the decision here as a button, a Terminal one only in its window on the Mac
    const blocked =
      row?.waitingFor === "input needed" ? tr("ждёт ответа", "waiting for a reply") : row?.kind === "background" ? tr("ждёт вашего решения", "needs your decision") : tr("ждёт вас на Mac", "waiting for you on the Mac");
    const now = state === "working" ? `${tr(" с", " since")}${at(started)}` : state === "done" && v.lastTurnAt ? `${tr(today(v.lastTurnAt) ? " в" : "", today(v.lastTurnAt) ? " at" : " on")}${at(v.lastTurnAt)}` : ""; // Russian puts no "в" before a date
    const u = state === "done" ? understood(sessionId) : undefined;
    const md = [
      `**${mdEsc(this.nameOf(sessionId, v.cwd))}**  \n${cap1(state === "blocked" ? blocked : u ? tr(UNDERSTOOD, UNDERSTOOD_EN)[u.state] : (tr(WORD, WORD_EN)[state] ?? state))}${now}`,
      row?.kind === "interactive" && !d.rcUrl ? tr("Идёт в терминале на Mac: с iPhone её не открыть.", "Running in Terminal on the Mac: it can’t be opened from iPhone.") : "",
    ]
      .filter(Boolean)
      .join("\n\n"); // separate paragraphs; richSafe keeps the blank line visible
    // One button per row, so labels fit. The main action first: "Resume" after a failure; "Stop" comes after "Recent
    // steps" and is not red (red is for the confirmation, where the decision is made).
    const log = [{ text: LOG(), data: `s:${sessionId}:log` }];
    const buttons: Button[][] =
      state === "failed" || state === "stopped"
        ? [[{ text: tr("Продолжить", "Resume"), data: `s:${sessionId}:go` }], log]
        : row?.id && row.pid
          ? [log, [{ text: tr("Остановить", "Stop"), data: `s:${sessionId}:stop` }]]
          : [log];
    if (d.rcUrl) buttons.push([{ text: tr("Открыть в Claude", "Open in Claude"), url: d.rcUrl }]);
    return { md, buttons };
  }

  // While a card is being sent, a second call (start and a watcher pass at once) must not send another, or the first
  // would stay on "starting"
  private cardBusy = new Set<string>();
  async renderCard(sessionId: string) {
    if (this.cardBusy.has(sessionId)) return;
    this.cardBusy.add(sessionId);
    try {
      await this.drawCard(sessionId);
    } finally {
      this.cardBusy.delete(sessionId);
    }
  }

  private async drawCard(sessionId: string) {
    const v = this.s.views[sessionId];
    if (!v) return;
    const { md, buttons } = this.cardMd(sessionId);
    const bkey = JSON.stringify(buttons);
    const state = this.stateOf(sessionId);
    if (md === v.cardMd && bkey === v.cardButtons && v.cardId) return;
    if (!v.cardId && !workers.get(sessionId)) return; // cards only for the architect's sessions; the rest are on the dashboard
    // without a state change, edit the card at most every 30 s
    if (v.cardId && state === v.cardState && bkey === v.cardButtons && Date.now() - (v.cardAt ?? 0) < 30_000) return;
    v.cardMd = md;
    v.cardButtons = bkey;
    v.cardState = state;
    v.cardAt = Date.now();
    if (v.cardId) await this.tg.edit(v.cardId, md, { buttons });
    else {
      const [id] = await this.tg.send(md, { buttons, threadId: v.threadId, silent: true });
      v.cardId = id;
      if (id) this.s.msgs[String(id)] = sessionId;
    }
    this.save();
  }

  // Called on every watcher pass: refreshes the cards of live sessions, and once more for those gone (they become "stopped")
  async refresh(rows: AgentRow[]) {
    this.rows = new Map(rows.filter((r) => r.sessionId && (r.pid || r.state === "working" || r.state === "blocked" || r.state === "done")).map((r) => [r.sessionId!, r]));
    for (const id of Object.keys(this.s.views)) {
      const v = this.s.views[id];
      if (!this.rows.has(id) && (v.cardState === "stopped" || v.cardState === "failed")) continue;
      if (!workers.get(id)) continue;
      try {
        await this.renderCard(id);
      } catch (e) {
        log("ui", "карточка не обновилась", String(e));
      }
    }
  }

  async adopt(sessionId: string, cwd: string) {
    this.ensure(sessionId, cwd);
    await this.threadFor(sessionId, cwd);
    await this.renderCard(sessionId);
  }
}
