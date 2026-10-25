// "What's going on": sessions, sites, GitHub and the Mac, red flags first.
import { looping, understood } from "./understand";
import { config, tr } from "./config";
import { listAgents, sessionDigest, type AgentRow } from "./sessions";
import { mdEsc } from "./md";
import { clean, sessionLabel } from "./ui";
import { recentEnd } from "./limits";
import { clip, hhmm, run } from "./util";

export type SiteState = { name: string; url: string; code: number | null; ok: boolean; err?: string; ms?: number };
export type RunInfo = { workflowName: string; headBranch: string; conclusion: string; status: string; url: string; createdAt: string; displayTitle: string; event: string };
export type RepoState = { repo: string; failing: RunInfo[]; staleFailing: number; botFailing?: number; running: RunInfo[]; prs: { number: number; title: string; isDraft: boolean }[]; error?: string };
export type Limits = { week?: number; weekResets?: string; fiveHour?: number; fiveHourResets?: string; status?: string };
export type Overview = { at: number; rows: AgentRow[]; sites: SiteState[]; repos: RepoState[]; machine: { load5: number; cpus: number; diskFreeGb: number }; flags: string[]; limits?: Limits };

let limitsProvider: () => Promise<Limits | undefined> = async () => undefined;
export function setLimitsProvider(fn: () => Promise<Limits | undefined>) {
  limitsProvider = fn;
}
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const NB = String.fromCharCode(0xa0); // no-break space keeps "Oct 16" and "at 12:10" on one line
// Mac local time, like the quiet hours, so it is right in any time zone
const off = (t: number) => -new Date(t).getTimezoneOffset() * 60_000;
const dayOf = (t: number) => new Date(t + off(t)).toISOString().slice(0, 10);
const hm = (t: number) => new Date(t + 30_000 + off(t)).toISOString().slice(11, 16);
// "20 октября" / "Oct 20"
const date = (t: number) => tr(`${new Date(t + off(t)).getUTCDate()}${NB}${MONTHS[new Date(t + off(t)).getUTCMonth()]}`, `${MONTHS_EN[new Date(t + off(t)).getUTCMonth()]}${NB}${new Date(t + off(t)).getUTCDate()}`);
const rel = (t: number) => (dayOf(t) === dayOf(Date.now()) ? tr("сегодня", "today") : dayOf(t) === dayOf(Date.now() + 86400_000) ? tr("завтра", "tomorrow") : "");
// "until 17:30", "until tomorrow at 23:00", "until Oct 20 at 23:00"
export const untilTime = (t: number) =>
  dayOf(t) === dayOf(Date.now()) ? tr(`до${NB}${hm(t)}`, `until${NB}${hm(t)}`) : tr(`до ${rel(t) || date(t)}, ${hm(t)}`, `until ${rel(t) || date(t)} at${NB}${hm(t)}`);
// "today at 23:00", "tomorrow at 23:00", "Oct 20 at 23:00"
export const whenHuman = (t: number) => tr(`${rel(t) || date(t)} в${NB}${hm(t)}`, `${rel(t) || date(t)} at${NB}${hm(t)}`);
// "since 12:40" today, "since Oct 16" before
const sinceNb = (t: number) => (dayOf(t) === dayOf(Date.now()) ? tr(`с${NB}${hm(t)}`, `since${NB}${hm(t)}`) : tr(`с${NB}${date(t)}`, `since${NB}${date(t)}`));

export async function checkSite(name: string, url: string): Promise<SiteState> {
  const t = Date.now();
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15_000), headers: { "user-agent": "architect/1 (status)" } });
    return { name, url, code: res.status, ok: res.ok || res.status === 401, ms: Date.now() - t };
  } catch (e) {
    return { name, url, code: null, ok: false, err: clip(String(e), 120) };
  }
}

export async function repoState(repo: string): Promise<RepoState> {
  const full = `${config.githubOwner}/${repo}`;
  const [runs, prs] = await Promise.all([
    run(["gh", "run", "list", "-R", full, "--limit", "20", "--json", "workflowName,status,conclusion,createdAt,headBranch,event,displayTitle,url"], { timeoutMs: 40_000 }),
    run(["gh", "pr", "list", "-R", full, "--state", "open", "--json", "number,title,isDraft"], { timeoutMs: 40_000 }),
  ]);
  if (runs.code !== 0) return { repo, failing: [], staleFailing: 0, running: [], prs: [], error: clip(runs.stderr.trim() || "gh не ответил", 160) };
  const list = JSON.parse(runs.stdout || "[]") as RunInfo[];
  const latest = new Map<string, RunInfo>();
  for (const r of list) {
    const k = `${r.workflowName}@${r.headBranch}`;
    if (!latest.has(k)) latest.set(k, r);
  }
  // Failing means main/master or the last day; dependency bot branches and older failures are only counted
  const isMain = (r: RunInfo) => ["main", "master"].includes(r.headBranch);
  const bot = (r: RunInfo) => /^(dependabot|renovate)\//.test(r.headBranch);
  const failed = [...latest.values()].filter((r) => ["failure", "startup_failure", "timed_out"].includes(r.conclusion));
  const failing = failed.filter((r) => !bot(r) && (isMain(r) || Date.now() - Date.parse(r.createdAt) < 86400_000)).sort((a, b) => +isMain(b) - +isMain(a));
  const botFailing = failed.filter(bot).length;
  const running = list.filter((r) => ["in_progress", "queued", "waiting", "pending"].includes(r.status));
  return { repo, failing, staleFailing: failed.length - failing.length - botFailing, botFailing, running, prs: prs.code === 0 ? JSON.parse(prs.stdout || "[]") : [] };
}

async function machine() {
  const [l, c, d] = await Promise.all([run(["sysctl", "-n", "vm.loadavg"]), run(["sysctl", "-n", "hw.ncpu"]), run(["df", "-g", "/System/Volumes/Data"])]);
  const loads = l.stdout.replace(/[{}]/g, "").replace(/,/g, ".").trim().split(/\s+/).map(Number);
  const free = Number(d.stdout.trim().split("\n").pop()?.split(/\s+/)[3] ?? 0);
  return { load5: loads[1] ?? 0, cpus: Number(c.stdout.trim()) || 8, diskFreeGb: free };
}

// A repo under its site's name
const repoName = (repo: string) => config.sites.find((s) => s.repo === repo)?.name ?? repo;

// GitHub in one line, for the architect's facts. A run that never started is marked as a likely GitHub billing
// problem, so the architect can explain it without raising an alarm.
export function githubLine(repos: RepoState[]): string {
  const prs = repos.filter((r) => r.prs.length).map((r) => `${repoName(r.repo)} (${r.prs.length})`);
  const running = repos.filter((r) => r.running.length).map((r) => repoName(r.repo));
  const failing = repos.flatMap((r) => r.failing.map((f) => `${repoName(r.repo)}: ${f.workflowName} в ${f.headBranch}${f.conclusion === "startup_failure" ? " — не стартовала, похоже, из-за оплаты GitHub" : ""}`));
  const parts = [prs.length ? `открыты правки — ${prs.join(", ")}` : "", running.length ? `идут проверки — ${running.join(", ")}` : "", failing.length ? `упали проверки: ${failing.join("; ")}` : "падений проверок нет"].filter(Boolean);
  return parts.length ? `На GitHub: ${parts.join("; ")}.` : "";
}

export async function collect(withGithub = true): Promise<Overview> {
  const [rows, sites, repos, m, limits] = await Promise.all([
    listAgents(true).catch(() => [] as AgentRow[]),
    Promise.all(config.sites.map((s) => checkSite(s.name, s.url))),
    withGithub ? Promise.all(config.repos.map(repoState)) : Promise.resolve([] as RepoState[]),
    machine(),
    Promise.race([limitsProvider().catch(() => undefined), Bun.sleep(5000).then(() => undefined)]),
  ]);
  // Red flags are only what breaks the owner's work right now: the Claude limit running out, a site down, the disk
  // filling up. One sentence each, in plain words. Paused sessions and those waiting for "accepted" are not problems.
  // The board's "Look into" button parses the "Сайт <name> не открывается" start.
  const flags: string[] = [];
  const at = (iso?: string) => (iso ? Date.parse(iso) : Date.now());
  // words an outsider understands: "work stops", not "sessions"
  const limitFlag = (kind: string, used: number, resets?: string, end?: number) =>
    used >= 100
      ? tr(`${kind} лимит Claude кончился: работа стоит ${untilTime(at(resets))}`, `${kind} Claude limit reached: work is paused ${untilTime(at(resets))}`)
      : end !== undefined
        ? tr(`${kind} лимит Claude потрачен на ${Math.round(used)}% и кончится ${whenHuman(end)}: работа встанет ${untilTime(at(resets))}`, `${kind} Claude limit is ${Math.round(used)}% used and will run out ${whenHuman(end)}: work stops ${untilTime(at(resets))}`)
        : tr(`${kind} лимит Claude потрачен на ${Math.round(used)}%: если кончится, работа встанет ${untilTime(at(resets))}`, `${kind} Claude limit is ${Math.round(used)}% used: if it runs out, work stops ${untilTime(at(resets))}`);
  // lasting until the reset is not red; the limit line below says so
  const wEnd = limits?.week !== undefined && limits.weekResets ? weekEnd(limits.week, Date.parse(limits.weekResets)) : undefined;
  if (limits?.week !== undefined && limits.week >= 85 && (limits.week >= 100 || wEnd === undefined || wEnd < at(limits.weekResets)))
    flags.push(limitFlag(tr("Недельный", "Weekly"), limits.week, limits.weekResets, wEnd));
  if (limits?.fiveHour !== undefined && limits.fiveHour >= 90) flags.push(limitFlag(tr("Пятичасовой", "5-hour"), limits.fiveHour, limits.fiveHourResets));
  if (limits?.status === "rejected") flags.push(tr("Лимит Claude кончился: работа стоит до сброса", "Claude limit reached: work is paused until it resets"));
  for (const s of sites)
    if (!s.ok) flags.push(tr(`Сайт ${s.name} не открывается: ${s.code ? `сервер отвечает ошибкой ${s.code}` : "сервер не отвечает"}`, `${s.name} site is down: ${s.code ? `the server returns error ${s.code}` : "the server doesn’t respond"}`));
  // GitHub runs and Mac load are not red: the sites still work
  if (m.diskFreeGb && m.diskFreeGb < 15) flags.push(tr(`На диске Mac осталось ${m.diskFreeGb} ГБ: пора освободить место`, `Only ${m.diskFreeGb} GB left on the Mac’s disk: time to free up space`));
  return { at: Date.now(), rows, sites, repos, machine: m, flags, limits };
}

// ── what the owner sees: the dashboard and "what's up" are one view ──────────
// States are the same words across the bot: needs your decision (on what), waiting for "accepted", paused, working.
// The first line answers directly: how many decisions wait; then one line per decision, the name in bold and what is
// needed. Then red flags, then who waits for acceptance; at the end who works, who is paused, sites and the limit.
// Pauses and waiting for acceptance are deliberate, not alarms. Groups are separated by a blank line.

export type Ask = { name: string; what: string; sessionId?: string }; // a permission request or question waiting on buttons
export type Extra = { asks?: Ask[]; holds?: string[] };
// reply: can be answered in words; accept: waits for "accepted"; pause: paused (what says why, if known); ask: has buttons
export type Item = { name: string; what: string; sessionId?: string; cwd?: string; reply?: boolean; accept?: boolean; pause?: boolean; ask?: boolean };
export type View = { total: number; waiting: Item[]; accept: Item[]; paused: Item[]; working: Item[]; problems: string[]; sites: string; limit: string };

// The reset time in Claude's limit error: "You've hit your weekly limit · resets Oct 20 at 11pm (Europe/Moscow)".
// at is when the error came: "resets 5pm" seen after 5 pm means tomorrow.
export function limitReset(err: string, at = Date.now()): number | undefined {
  const m = err.match(/hit your (?:weekly |session |5-hour |)limit[^·]*·\s*resets\s+(?:(\w{3})\s+(\d{1,2})\s+at\s+)?(\d{1,2})(?::(\d\d))?\s*(am|pm)/i);
  if (!m) return;
  const hour = (Number(m[3]) % 12) + (m[5].toLowerCase() === "pm" ? 12 : 0);
  const base = new Date(at + off(at));
  const month = m[1] ? ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[1].toLowerCase()) : base.getUTCMonth();
  const reset = Date.UTC(base.getUTCFullYear(), month, m[2] ? Number(m[2]) : base.getUTCDate(), hour, Number(m[4] ?? 0)) - off(at);
  return !m[2] && reset < at ? reset + 86400_000 : reset;
}

// What a turn ending in an API error means for the owner: "paused until 15:40: the 5-hour limit ran out"
export function apiStop(err: string, at = Date.now()): string {
  const reset = limitReset(err, at);
  const kind = /weekly/i.test(err) ? tr("недельный", "weekly") : /session|5-hour/i.test(err) ? tr("пятичасовой", "5-hour") : "";
  // already reset: the error no longer applies
  if (reset !== undefined) return reset > Date.now() ? tr(`на паузе ${untilTime(reset)}: кончился ${kind ? `${kind} ` : ""}лимит`, `paused ${untilTime(reset)}: the ${kind ? `${kind} ` : ""}limit ran out`) : "";
  if (/\/login|not logged in|invalid api key/i.test(err)) return tr("нужен вход в Claude на Mac", "needs you to sign in to Claude on the Mac");
  return tr("остановилась на ошибке, можно продолжать", "stopped on an error, you can resume it");
}

// When the weekly limit runs out: the pace of the last hours as in the warning (recentEnd), or else the weekly average
function weekEnd(used: number, resets: number, now = Date.now()): number | undefined {
  const start = resets - 7 * 86400_000;
  return recentEnd(used, now) ?? (used > 0 && now - start >= (7 * 86400_000) / 20 ? start + ((now - start) * 100) / used : undefined);
}

// Whether the limit lasts until the reset at the current pace. window: the limit's length; used: percent used;
// end: the estimate from the last hours when known, otherwise the average since the window began.
export function forecast(used: number, resets: number, window: number, now = Date.now(), end?: number): string {
  const start = resets - window;
  if (end === undefined) {
    if (used <= 0 || now - start < window / 20) return ""; // too early in the window to tell
    end = start + ((now - start) * 100) / used;
  }
  return end >= resets
    ? tr(`При нынешнем темпе хватит до сброса: ${whenHuman(resets)}.`, `At the current pace it will last until the reset, ${whenHuman(resets)}.`)
    : tr(`При нынешнем темпе кончится ${whenHuman(end)}, а сброс — ${whenHuman(resets)}.`, `At the current pace it will run out ${whenHuman(end)}, and it resets ${whenHuman(resets)}.`);
}

// A deadline from the session's goal ("by October 20", "20th of Oct" → "due tomorrow"); a past date is none.
// English dates are read only in an English install.
const EN_MONTH = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:uary|ruary|ch|il|e|y|ust|t|tember|ober|ember)?\\.?";
const EN_DATE = new RegExp(`\\b${EN_MONTH}\\s+(\\d{1,2})\\b|\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${EN_MONTH}(?![a-z])`);
export function deadline(goal?: string): string {
  const m = goal?.match(/(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/i);
  const e = m ? undefined : tr(undefined, goal?.match(EN_DATE) ?? undefined);
  if (!m && !e) return "";
  const year = new Date(Date.now() + off(Date.now())).getUTCFullYear();
  const [month, day] = m ? [MONTHS.indexOf(m[2].toLowerCase()), Number(m[1])] : [MONTHS_EN.indexOf(e![1] ?? e![4]), Number(e![2] ?? e![3])];
  const t = Date.UTC(year, month, day, 12) - off(Date.now());
  if (dayOf(t) < dayOf(Date.now())) return "";
  return tr(`срок ${rel(t) || date(t)}`, `due ${rel(t) || date(t)}`);
}

// What the session waits for from the owner, judged by its state and last words; undefined while it works
function waitsFor(r: AgentRow): Pick<Item, "what" | "reply" | "accept" | "pause"> | undefined {
  const d = sessionDigest(r);
  if (r.state === "blocked" || r.status === "waiting") {
    // a question or a permission request; a Terminal session can only be answered there
    const q = d.question && clean(d.question);
    const since = d.lastTs && Date.now() - d.lastTs > 3600_000 ? ` ${sinceNb(d.lastTs)}` : "";
    const term = r.kind !== "background";
    // for a background session, the judgment over its whole history says what is needed better than a bare "Add it?"
    const u = understood(r.sessionId);
    if (!term && r.waitingFor !== "permission prompt" && u?.state === "needs_owner" && u.needs && u.at >= (d.lastTs ?? 0) - 10 * 60_000)
      return { what: [lower(clean(u.needs)), deadline(d.goal)].filter(Boolean).join(", "), reply: true };
    const asked = term ? tr("вопрос на Mac", "question on the Mac") : tr("вопрос", "question");
    const what =
      r.waitingFor === "input needed"
        ? q ? lower(q) : tr(`ждёт ответа${since}`, `waiting for a reply${since}`)
        : r.waitingFor === "permission prompt"
          ? `${term ? tr("ждёт разрешения на Mac", "waiting for permission on the Mac") : tr("запрос разрешения", "permission request")}${since}`
          : q ? `${asked}: ${tr(`«${q.charAt(0).toUpperCase()}${q.slice(1)}»`, `“${q.charAt(0).toUpperCase()}${q.slice(1)}”`)}` : `${asked}${since}`;
    return { what: [what, deadline(d.goal)].filter(Boolean).join(", "), reply: r.waitingFor === "input needed" };
  }
  // the judgment over the whole history (src/understand.ts) beats the last sentence: a repeated "waiting" after
  // finished work is not a question
  const u = understood(r.sessionId);
  // busy but spinning is not "working" for the owner
  if (r.status === "busy" || r.state === "working") {
    if (!u?.spinning || !looping(r)) return;
    return u.state === "accept" ? { what: tr("ждёт вашей проверки", "ready for your review"), accept: true } : { what: "", pause: true };
  }
  if (u) return u.state === "needs_owner" ? { what: lower(clean(u.needs || u.doing)), reply: true } : u.state === "accept" ? { what: tr("ждёт вашей проверки", "ready for your review"), accept: true } : { what: "", pause: true };
  // an API error that still applies decides; after the reset its last words do
  const stop = d.apiError && apiStop(d.apiError, d.lastTs);
  if (stop) return stop.startsWith(tr("на паузе", "paused")) ? { what: stop.replace(tr(/^на паузе /, /^paused /), ""), pause: true } : { what: stop, reply: tr(/продолжать/, /resume/).test(stop) };
  const t = (d.lastText ?? "").trim().slice(-300);
  if (/«принято»|[“"«]accepted[”"»]/i.test(t)) return { what: tr("ждёт вашей проверки", "ready for your review"), accept: true };
  // a question means the owner decides; otherwise it is paused by choice. Sessions may write English in any install.
  if ((/жду\s+(вашего|ваш[еуй]?|от вас|владельца|вас)(?!\p{L})/iu.test(t) || /\b(waiting for (your|you)|awaiting your|let me know)\b/i.test(t) || /\?[»"*_\s]*$/.test(t)) && d.question && clean(d.question).length <= 90)
    return { what: lower(clean(d.question)), reply: true };
  return { what: "", pause: true };
}
// Lowercase after a dash; in English only a plain capitalized word, so "GitHub", "I" and "OK" stay
const lower = (s: string) => (tr(/^[А-ЯЁ][а-яё]/, /^[A-Z][a-z]+\b/).test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

export function view(o: Overview, x: Extra = {}): View {
  const live = o.rows.filter((r) => r.sessionId && (r.pid || r.state === "working" || r.state === "blocked"));
  const name = (r: AgentRow) => sessionLabel(r.sessionId!, r.cwd, o.rows);
  const asks = x.asks ?? [];
  const asked = (r: AgentRow) => asks.some((a) => a.sessionId === r.sessionId || a.name === name(r));
  const waiting: Item[] = asks.map((a) => ({ ...a, ask: true }));
  const accept: Item[] = [];
  const paused: Item[] = [];
  const working: Item[] = [];
  // with the Claude limit out nobody can work, so working sessions count as paused
  const out = o.limits?.status === "rejected" || (o.limits?.week ?? 0) >= 100 || (o.limits?.fiveHour ?? 0) >= 100;
  for (const r of live) {
    if (asked(r)) continue; // its request is already listed
    const item = { name: name(r), what: "", sessionId: r.sessionId, cwd: r.cwd };
    const w = x.holds?.includes(r.sessionId!) ? { what: tr("ждёт вашего ответа", "waiting for your reply"), reply: true } : waitsFor(r);
    if (!w) (out ? paused : working).push(item);
    else if (w.accept) accept.push({ ...item, ...w });
    else if (w.pause) paused.push({ ...item, ...w });
    else waiting.push({ ...item, ...w });
  }
  const week = o.limits?.week;
  const resets = o.limits?.weekResets ? Date.parse(o.limits.weekResets) : undefined;
  const end = week !== undefined && resets ? weekEnd(week, resets) : undefined;
  const lasts = end !== undefined && resets !== undefined && end >= resets;
  const pace = end === undefined ? "" : lasts ? tr(" — хватит до сброса", " — it will last until the reset") : tr(` — кончится ${whenHuman(end)}`, ` — it will run out ${whenHuman(end)}`);
  return {
    total: waiting.length + accept.length + paused.length + working.length, // matches the names listed
    waiting,
    accept,
    paused,
    working,
    problems: o.flags,
    sites: o.sites.length && o.sites.every((s) => s.ok) ? tr("все сайты открываются", "all sites are up") : "",
    limit: week !== undefined && (week < 85 || (lasts && week < 100)) ? tr(`недельный лимит Claude потрачен на ${Math.round(week)}%${pace}`, `weekly Claude limit: ${Math.round(week)}% used${pace}`) : "", // from 85% without headroom it is a problem instead
  };
}

// A hyphen inside a word becomes non-breaking, so "Online-course" never wraps after "Online-"
const nobr = (s: string) => s.replace(/(?<=[\p{L}\p{N}])-(?=[\p{L}\p{N}])/gu, String.fromCharCode(0x2011));

const plural = (n: number, one: string, few: string, many: string) =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many;
// The first line says what the owner needs to do ("2 tasks need your decision" or "Nothing needs your attention"),
// short enough for one iPhone line and the pinned message bar
export function headline(v: View): string {
  const k = v.waiting.length;
  return k ? tr(`${k} ${plural(k, "задача ждёт", "задачи ждут", "задач ждут")} вашего решения`, `${k} ${k === 1 ? "task needs" : "tasks need"} your decision`) : tr("От вас ничего не нужно", "Nothing needs your attention");
}

// One line per decision, shared ones merged; the architect's own question is shown without a name
export function waitingLines(items: Item[]): string[] {
  const out: { names: string[]; what: string; ask?: boolean }[] = [];
  for (const i of items) {
    const same = !i.ask && i.what.startsWith(tr("ждёт", "waiting")) ? out.find((g) => !g.ask && g.what === i.what) : undefined;
    if (same) same.names.push(i.name);
    else out.push({ names: [i.name], what: i.what, ask: i.ask });
  }
  return out.map((g) => {
    if (g.names.length === 1 && g.names[0] === "Архитектор") return mdEsc(g.what.charAt(0).toUpperCase() + g.what.slice(1));
    const names = g.names.map((n) => `**${mdEsc(nobr(n))}**`);
    const who = names.length > 1 ? `${names.slice(0, -1).join(", ")} ${tr("и", "and")} ${names.at(-1)}` : names[0];
    return `${who} — ${mdEsc(names.length > 1 ? tr(g.what.replace(/^ждёт/, "ждут"), g.what) : g.what)}`; // Russian plural verb
  });
}

// What breaks work (a site down, the Claude limit running out), in the same lines on the dashboard and in the morning
export const problemLines = (v: View) => v.problems.map((p) => mdEsc(nobr(p)));

// "What's up": the dashboard view; full lists every name (for the architect)
export function render(o: Overview, full = false, x: Extra = {}): string {
  return renderView(view(o, x), false, full);
}

// board: the pinned dashboard, with working and paused sessions as counts; tail: lines for the very end
export function renderView(v: View, board = false, full = false, tail: string[] = []): string {
  const br = "  \n";
  const cap = (xs: string[], n: number) => (full || xs.length <= n ? xs : [...xs.slice(0, n), tr(`и ещё ${xs.length - n}`, `and ${xs.length - n} more`)]);
  const up = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  // session names without quotes: five pairs of quotes in a line are noise
  const names = (xs: Item[]) => cap(xs.map((i) => mdEsc(nobr(i.name))), 8).join(", ");
  // A colon puts the list right below. Lines end with a period: iOS joins notification lines with a space
  // ("…due tomorrow 86% used…"). The typographer drops the period at the very end of the message.
  const dot = (x: string) => (!x || /[.?!…:]$/.test(x) ? x : `${x}.`);
  const blocks: string[][] = [[`**${headline(v)}${v.waiting.length ? ":" : ""}**`, ...cap(waitingLines(v.waiting), 10).map(dot)]];
  if (v.problems.length) blocks.push(problemLines(v).map(dot));
  if (v.accept.length) blocks.push([tr(`${v.accept.length === 1 ? "Ждёт" : "Ждут"} вашей проверки: ${names(v.accept)}.`, `Ready for your review: ${names(v.accept)}.`)]);
  const info: string[] = [];
  const quiet = v.paused.filter((i) => !i.what);
  if (board) {
    // "2 tasks in progress, 5 paused" rather than a bare "5 paused"
    const tasks = (k: number) => tr(`${k} ${plural(k, "задача", "задачи", "задач")}`, `${k} ${k === 1 ? "task" : "tasks"}`);
    const w = v.working.length;
    const p = v.paused.length;
    const counts =
      w && p ? tr(`В работе ${tasks(w)}, на паузе ${p}`, `${tasks(w)} in progress, ${p} paused`) : w ? tr(`В работе ${tasks(w)}`, `${tasks(w)} in progress`) : p ? tr(`На паузе ${tasks(p)}`, `${tasks(p)} paused`) : "";
    if (counts) info.push(`${counts}.`);
  } else {
    if (v.working.length) info.push(tr(`${v.working.length === 1 ? "Работает" : "Работают"}: ${names(v.working)}.`, `Working: ${names(v.working)}.`));
    if (quiet.length) info.push(tr(`На паузе: ${names(quiet)}.`, `Paused: ${names(quiet)}.`));
  }
  for (const i of v.paused.filter((x) => x.what)) info.push(tr(`${mdEsc(nobr(i.name))} на паузе ${mdEsc(i.what)}.`, `${mdEsc(nobr(i.name))} is paused ${mdEsc(i.what)}.`)); // "X is paused until 15:40: the limit ran out"
  for (const h of [v.sites, v.limit]) if (h) info.push(`${up(h)}.`);
  if (info.length || tail.length) blocks.push([...info, ...tail]);
  // a blank line between groups that stays visible on iPhone (no-break space and hard breaks)
  return blocks.map((b) => b.join(br)).join(`${br}${NB}${br}`);
}
