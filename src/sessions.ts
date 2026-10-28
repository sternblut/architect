// Claude Code sessions on this Mac: listing, transcripts, start, stop, message delivery.
// Only through the claude CLI: claude agents --json, claude --bg, claude stop, claude --resume --bg.
import { existsSync, openSync, readSync, closeSync, fstatSync, realpathSync, statSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARCH_HOME, HOME, STATE, WORK, config, isTestCwd, projectDir, tr } from "./config";
import { courierIds, type Courier } from "./courier";
import { clip, log, readJson, run, tilde, writeJson } from "./util";

export type AgentRow = {
  id?: string;
  sessionId?: string;
  name?: string;
  cwd: string;
  kind: "interactive" | "background";
  startedAt: number;
  state?: "working" | "blocked" | "done" | "failed" | "stopped";
  status?: "busy" | "waiting" | "idle";
  waitingFor?: string;
  pid?: number;
};

export type Worker = {
  id: string;
  sessionId: string;
  name: string;
  cwd: string;
  task: string;
  model: string;
  effort?: string;
  remote?: boolean;
  startedAt: number;
  threadId?: number;
  cardId?: number;
};

const WORKERS_FILE = join(STATE, "workers.json");
const OUTBOX_FILE = join(STATE, "outbox.json");
export const WORKER_SETTINGS = join(STATE, "worker-settings.json");

// Worker hooks, all one command (hook.ts): the gate runs in it even without the host, the rest goes to the host over
// HTTP. The hook reads the secret from the Keychain, so the settings file holds none.
export function writeWorkerSettings(bunPath: string) {
  const env = process.env.ARCH_STATE_DIR ? `ARCH_STATE_DIR='${process.env.ARCH_STATE_DIR}' ARCH_HOOK_PORT=${config.hookPort} ` : "";
  const cmd = (timeout: number, onFailure?: "block") => ({ hooks: [{ type: "command", command: `${env}'${bunPath}' '${join(ARCH_HOME, "src", "hook.ts")}'`, timeout, ...(onFailure ? { onFailure } : {}) }] });
  writeJson(WORKER_SETTINGS, {
    hooks: {
      PreToolUse: [cmd(21600, "block")],
      PermissionRequest: [cmd(21600)],
      PermissionDenied: [cmd(15)],
      Stop: [cmd(60)],
      StopFailure: [cmd(15)],
      Notification: [cmd(15)],
    },
  });
}

let claudeBin = "claude";
export function setClaudeBin(p: string) {
  claudeBin = p;
}
let psBin = "ps";
export function setPsBin(p: string) {
  psBin = p;
}

// One delivery or restart per conversation at a time: two in a row would race to stop and resume the session, and
// Claude Code would start copies. The session row is read again inside the lock.
const turns = new Map<string, Promise<unknown>>();
async function oneAtATime<T>(row: AgentRow, f: (row: AgentRow) => Promise<T>): Promise<T> {
  const key = row.sessionId ?? row.id ?? "";
  const prev = turns.get(key) ?? Promise.resolve();
  const next = prev.then(async () => {
    const fresh = key ? (await listAgents(true).catch(() => [] as AgentRow[])).find((x) => x.sessionId === key) : undefined;
    return f(fresh ?? row);
  });
  turns.set(key, next.catch(() => {}));
  return next;
}

// All Claude Code sessions on the Mac except the architect itself
export async function listAgents(all = true): Promise<AgentRow[]> {
  const r = await run([claudeBin, "agents", "--json", ...(all ? ["--all"] : [])], { timeoutMs: 20_000 });
  if (r.code !== 0) throw new Error(`claude agents: ${clip(r.stderr || r.stdout, 300)}`);
  const self = readJson<{ sessionId?: string }>(join(STATE, "architect.json"), {}).sessionId;
  // Hidden from the owner: test sessions, dev worktrees (.claude/worktrees), temp folders and trial runs in the
  // architect's own folder. Tests (ARCH_STATE_DIR) see them all.
  const dev = (x: AgentRow) => {
    const cwd = String(x.cwd ?? "");
    return isTestCwd(cwd) || cwd.startsWith(join(ARCH_HOME, ".claude")) || /^\/(private\/)?tmp\//.test(cwd) || (cwd === WORK && !workers.get(x.sessionId));
  };
  return oneRowPerSession((JSON.parse(r.stdout) as AgentRow[]).filter((x) => (!self || x.sessionId !== self) && !courierIds.has(x.sessionId ?? "") && (!!process.env.ARCH_STATE_DIR || !dev(x))));
}

// One row per conversation. After /bg a conversation has two rows, the live process in a Terminal tab and a background
// session with the same id, and respawning the background one fails with "Can't open — this session is running in
// another terminal". Prefer the row with a live process, then the Terminal one.
export function oneRowPerSession(rows: AgentRow[]): AgentRow[] {
  const rank = (r: AgentRow) => (r.pid ? 2 : 0) + (r.kind !== "background" ? 1 : 0);
  const best = new Map<string, AgentRow>();
  const out: AgentRow[] = [];
  for (const r of rows) {
    if (!r.sessionId) {
      out.push(r);
      continue;
    }
    const was = best.get(r.sessionId);
    if (!was || rank(r) > rank(was)) best.set(r.sessionId, r);
  }
  return [...out, ...best.values()];
}

// ── workers ──────────────────────────────────────────────────────────────────

export const workers = {
  all(): Record<string, Worker> {
    return readJson(WORKERS_FILE, {});
  },
  get(sessionId?: string): Worker | undefined {
    return sessionId ? this.all()[sessionId] : undefined;
  },
  put(w: Worker) {
    const all = this.all();
    all[w.sessionId] = w;
    writeJson(WORKERS_FILE, all);
  },
  remove(sessionId: string) {
    const all = this.all();
    delete all[sessionId];
    writeJson(WORKERS_FILE, all);
  },
  patch(sessionId: string, p: Partial<Worker>) {
    const all = this.all();
    if (all[sessionId]) {
      all[sessionId] = { ...all[sessionId], ...p };
      writeJson(WORKERS_FILE, all);
    }
  },
};

// The owner's messages for busy sessions, handed over by the hook at the session's next step
export const outbox = {
  take(sessionId: string): string[] {
    const all = readJson<Record<string, string[]>>(OUTBOX_FILE, {});
    const msgs = all[sessionId] ?? [];
    if (msgs.length) {
      delete all[sessionId];
      writeJson(OUTBOX_FILE, all);
    }
    return msgs;
  },
  push(sessionId: string, text: string) {
    const all = readJson<Record<string, string[]>>(OUTBOX_FILE, {});
    (all[sessionId] ??= []).push(text);
    writeJson(OUTBOX_FILE, all);
  },
  peek(sessionId: string): number {
    return readJson<Record<string, string[]>>(OUTBOX_FILE, {})[sessionId]?.length ?? 0;
  },
};

// ── transcripts ──────────────────────────────────────────────────────────────

export type Entry = { type?: string; timestamp?: string; message?: { role?: string; content?: unknown }; aiTitle?: string; title?: string; [k: string]: unknown };

export function transcriptPath(cwd: string, sessionId: string) {
  return join(projectDir(cwd), `${sessionId}.jsonl`);
}

export function readTail(path: string, bytes = 700_000): Entry[] {
  if (!existsSync(path)) return [];
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    const out: Entry[] = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        out.push(JSON.parse(l));
      } catch {}
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

type Block = { type: string; text?: string; name?: string; input?: Record<string, unknown> };
const blocks = (e: Entry): Block[] => {
  const c = e.message?.content;
  if (typeof c === "string") return [{ type: "text", text: c }];
  return Array.isArray(c) ? (c as Block[]) : [];
};
const isNoise = (t: string) =>
  t.startsWith("<") || t.startsWith("[Request interrupted") || t.startsWith("Caveat:") || t.startsWith("Stop hook feedback") || t.startsWith("This session is being continued") || t.startsWith("[Image");
// Meta entries (compaction summaries, Claude Code insertions, subagent branches) are not the owner's words
const service = (e: Entry) => !!(e.isMeta || e.isCompactSummary || e.isSidechain);
const fromSession = (t: string) => t.startsWith("Another Claude session sent a message");

export function toolBrief(name: string, input: Record<string, unknown> = {}): string {
  if (name === "AskUserQuestion") return ((input.questions as { question: string }[]) ?? []).map((q) => q.question).join("; ");
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt ?? "";
  return clip(String(v).replace(/\s+/g, " "), 140);
}

// named: a person set the title (/rename). apiError: the turn ended in an API error (limit, sign-in) with nothing after it.
// question: the session's last unanswered question to the owner. tools: its recent tool calls in short.
export type Digest = { title?: string; named?: boolean; goal?: string; goalMet?: boolean; lastText?: string; lastTool?: string; lastUser?: string; lastTs?: number; rcUrl?: string; apiError?: string; question?: string; tools?: string[] };

export function digest(entries: Entry[]): Digest {
  const d: Digest = {};
  let custom: string | undefined;
  for (const e of entries) {
    // a title set with /rename beats Claude's own
    if (e.type === "custom-title") custom = String(e.customTitle ?? e.title ?? "") || custom;
    if (e.type === "ai-title" || e.type === "summary") d.title = String(e.aiTitle ?? e.title ?? (e as { summary?: string }).summary ?? d.title ?? "");
    // Remote Control link: system/bridge_status with a url, more often only a bridge-session entry (session_ + id without cse_)
    if (e.type === "system" && (e as { subtype?: string }).subtype === "bridge_status" && typeof (e as { url?: unknown }).url === "string") d.rcUrl = String((e as { url: string }).url);
    if (e.type === "bridge-session" && typeof e.bridgeSessionId === "string") d.rcUrl = `https://claude.ai/code/session_${String(e.bridgeSessionId).replace(/^cse_/, "")}`;
    // /goal state from goal_status entries: met without sentinel means achieved, met with sentinel means cleared
    const att = (e as { attachment?: { type?: string; met?: boolean; sentinel?: boolean; condition?: string } }).attachment;
    if (e.type === "attachment" && att?.type === "goal_status") {
      if (att.met) {
        d.goalMet = !att.sentinel;
        if (att.sentinel) d.goal = undefined;
      } else {
        d.goal = clip(String(att.condition ?? "").trim(), 300) || d.goal;
        d.goalMet = false;
      }
    }
    if (e.timestamp) d.lastTs = Date.parse(e.timestamp) || d.lastTs;
    // every "Stop hook feedback: [ЦЕЛЬ — …]" repeats the goal; in a long session the goal_status entry is long out of the tail
    if (e.type === "user" && !d.goal)
      for (const b of blocks(e)) {
        const g = b.type === "text" ? b.text?.match(/^Stop hook feedback:\s*\[(?:ЦЕЛЬ —\s*)?([\s\S]{10,300})/) : null;
        if (g) d.goal = g[1].trim();
      }
    if (e.type === "user" && !service(e)) {
      for (const b of blocks(e)) {
        if (b.type !== "text" || !b.text?.trim()) continue;
        const t = b.text.trim();
        const goal = t.match(/(?:Goal set:|ЦЕЛЬ —)\s*([\s\S]{0,300})/);
        if (goal && !d.goal) d.goal = goal[1].trim();
        if (!isNoise(t) && !fromSession(t)) {
          d.lastUser = clip(t, 400);
          d.apiError = undefined;
          d.question = undefined;
        }
      }
    }
    if (e.type === "assistant" && !e.isSidechain && e.isApiErrorMessage) d.apiError = blocks(e).find((b) => b.type === "text")?.text;
    if (e.type === "assistant" && !e.isSidechain && !e.isApiErrorMessage) {
      d.apiError = undefined;
      for (const b of blocks(e)) {
        if (b.type === "text" && b.text?.trim()) {
          d.lastText = b.text.trim();
          // the last sentence ending in "?" is what the session waits for
          const q = d.lastText.replace(/[*_`#>]/g, "").split(/(?<=[.!?…])\s+(?=[А-ЯЁA-Z«])|\n+/).filter((s) => /\?\s*[»"]?$/.test(s.trim())).at(-1)?.trim();
          if (q) d.question = clip(q.replace(/^[-–—•\d.)\s]+/, ""), 300);
        }
        if (b.type === "tool_use") {
          d.lastTool = `${b.name}: ${toolBrief(b.name ?? "", b.input)}`;
          (d.tools ??= []).push(d.lastTool);
        }
      }
    }
  }
  if (custom) {
    d.title = custom;
    d.named = true;
  }
  d.tools = d.tools?.slice(-60);
  return d;
}

// The session's last messages: owner, Claude, and tool calls in short
export function conversation(entries: Entry[], n: number): string[] {
  const rows: string[] = [];
  for (const e of entries) {
    if (e.type !== "user" && e.type !== "assistant") continue;
    // local time instead of the transcript's UTC, with the date when not today
    const d = e.timestamp ? new Date(e.timestamp) : undefined;
    const ts = d ? `${d.toDateString() === new Date().toDateString() ? "" : `${d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })} `}${d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}` : "";
    for (const b of blocks(e)) {
      if (service(e)) continue;
      if (b.type === "text" && b.text?.trim() && !(e.type === "user" && isNoise(b.text.trim())))
        rows.push(`[${ts}] ${e.type === "user" ? (fromSession(b.text.trim()) ? "Другая сессия" : "Владелец") : "Claude"}: ${clip(b.text.trim(), 700)}`);
      else if (b.type === "tool_use" && e.type === "assistant") rows.push(`[${ts}]   ↳ ${b.name}: ${toolBrief(b.name ?? "", b.input)}`);
    }
  }
  return rows.slice(-n);
}

export type ConvRow = { ts: string; at: number; who: "owner" | "claude" | "tool" | "session"; text: string };

// conversation() as fields, for Telegram formatting
export function conversationRows(entries: Entry[], n: number): ConvRow[] {
  const rows: ConvRow[] = [];
  for (const e of entries) {
    if (e.type !== "user" && e.type !== "assistant") continue;
    const ts = e.timestamp ? new Date(e.timestamp).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "";
    const at = e.timestamp ? Date.parse(e.timestamp) : 0;
    for (const b of blocks(e)) {
      if (service(e)) continue;
      if (b.type === "text" && b.text?.trim() && !(e.type === "user" && isNoise(b.text.trim())))
        rows.push({ ts, at, who: e.type === "user" ? (fromSession(b.text.trim()) ? "session" : "owner") : "claude", text: b.text.trim().replace(/^Another Claude session sent a message:\s*/, "") });
      else if (b.type === "tool_use" && e.type === "assistant") rows.push({ ts, at, who: "tool", text: `${b.name}: ${toolBrief(b.name ?? "", b.input)}` });
    }
  }
  return rows.slice(-n);
}

// "Stop hook feedback" count within the window (a /goal won't let the session stop): a sign it is spinning
export function spinCount(entries: Entry[], windowMs = 10 * 60_000): number {
  const since = Date.now() - windowMs;
  let n = 0;
  for (const e of entries) {
    if (e.type !== "user" || !e.timestamp || Date.parse(e.timestamp) < since) continue;
    for (const b of blocks(e)) if (b.type === "text" && b.text?.startsWith("Stop hook feedback")) n++;
  }
  return n;
}

// Tool calls since `since` and the time of the last one. "Worked overnight" means actions, not any transcript entry,
// or every session would count.
export function actionsSince(entries: Entry[], since: number): { n: number; last: number } {
  let n = 0;
  let last = 0;
  for (const e of entries) {
    const t = Date.parse(e.timestamp ?? "");
    if (e.type !== "assistant" || !(t >= since)) continue;
    const k = blocks(e).filter((b) => b.type === "tool_use").length;
    if (k) [n, last] = [n + k, Math.max(last, t)];
  }
  return { n, last };
}

const digestCache = new Map<string, { size: number; mtime: number; d: Digest }>();
export function sessionDigest(row: AgentRow): Digest {
  if (!row.sessionId) return {};
  const path = transcriptPath(row.cwd, row.sessionId);
  try {
    const st = statSync(path);
    const c = digestCache.get(path);
    if (c && c.size === st.size && c.mtime === st.mtimeMs) return c.d;
    const d = digest(readTail(path, 400_000));
    digestCache.set(path, { size: st.size, mtime: st.mtimeMs, d });
    if (digestCache.size > 300) digestCache.delete(digestCache.keys().next().value!);
    return d;
  } catch {
    return {};
  }
}

// ── finding a session by the owner's word ────────────────────────────────────

// ── start and stop ───────────────────────────────────────────────────────────

export function resolveFolder(folder: string): string {
  const p = folder.replace(/^~(?=\/|$)/, HOME);
  if (!p.startsWith("/")) throw new Error(`Нужен полный путь к папке, получил «${folder}»`);
  const real = realpathSync(p);
  if (!statSync(real).isDirectory()) throw new Error(`«${tilde(real)}» — не папка`);
  return real;
}

// Claude Code keys folder trust by the git root, or by the folder itself outside a repo
export async function trustKey(dir: string): Promise<string> {
  const r = await run(["git", "-C", dir, "rev-parse", "--show-toplevel"], { timeoutMs: 5000 });
  return r.code === 0 ? r.stdout.trim() : dir;
}

export function isTrusted(key: string): boolean {
  try {
    const cfg = JSON.parse(readFileSync(join(HOME, ".claude.json"), "utf8"));
    const projects: Record<string, { hasTrustDialogAccepted?: boolean }> = cfg.projects ?? {};
    if (projects[key]?.hasTrustDialogAccepted) return true;
    // outside a repo, a trusted parent covers its subfolders
    return Object.entries(projects).some(([p, v]) => v.hasTrustDialogAccepted && key.startsWith(p + "/") && !existsSync(join(key, ".git")));
  } catch {
    return false;
  }
}

export const WORKER_PREFACE = [
  "Тебя запустил архитектор по задаче владельца. Владелец ведёт работу из Telegram с iPhone и видит твои итоги хода там.",
  "Работай в этой папке по её правилам: CLAUDE.md, память проекта, журналы — в силе.",
  "Когда нужен ответ владельца, задай вопрос в конце хода коротко и остановись (или инструментом AskUserQuestion с вариантами) — он ответит из Telegram.",
  "Необратимое — удаление, push в main, выкладку, траты, письма людям — делай обычной командой: шлагбаум спросит владельца кнопкой и пропустит только после его «да». Если его нет у Mac, шлагбаум ответит, что решает он: не жди, делай остальное, а его «да» придёт сообщением — тогда повтори это действие. Не обходи шлагбаум и не проси другие сессии сделать то, в чём отказано.",
  "Перед просьбой о выкладке сними кандидата так, как его увидит владелец (iPhone и Mac; главный экран и изменённое место) и положи PNG в $CLAUDE_JOB_DIR/tmp/evidence/ (01-iphone.png, 02-mac.png …) — хост приложит их к кнопке «Разрешить», а после выкладки сам пришлёт снимок живого сайта.",
  "Хостинг напрямую не трогай: выкладка только конвейерами репозиториев. Токены и пароли не печатай.",
  "Пиши по-русски, коротко: что сделано, что проверено, что нужно от владельца. Слово «готово» без проверки не используй.",
].join("\n");
// The same rules for an English owner, plus: write to them in English
const workerPreface = () => WORKER_PREFACE + tr("", "\nThe owner reads English: write everything he sees in English, not Russian — questions, turn summaries, Bash descriptions, commit messages.");

// Worker rules go in the system prompt, the task in the first message; with goal, as a /goal that runs until it is met
export async function startWorker(o: { folder: string; task: string; name: string; model: string; effort: string; remote: boolean; goal?: boolean }): Promise<Worker> {
  const cwd = resolveFolder(o.folder);
  const args = [claudeBin, "--bg", "-n", o.name, "--model", o.model, "--effort", o.effort, "--settings", WORKER_SETTINGS, "--append-system-prompt", workerPreface()];
  if (o.remote) args.push("--remote-control", o.name);
  args.push(o.goal ? `/goal ${o.task.replace(/\s+/g, " ").trim()}` : o.task);
  const r = await run(args, { cwd, timeoutMs: 60_000 });
  const out = r.stdout + r.stderr;
  const id = out.match(/backgrounded\s*·\s*([0-9a-f]{6,})/)?.[1];
  if (!id) throw new Error(/not trusted/i.test(out) ? "NOT_TRUSTED" : `не запустилась: ${clip(out.trim(), 400)}`);
  let sessionId = "";
  for (let i = 0; i < 20 && !sessionId; i++) {
    const row = (await listAgents(true)).find((x) => x.id === id);
    sessionId = row?.sessionId ?? "";
    if (!sessionId) await Bun.sleep(500);
  }
  const w: Worker = { id, sessionId: sessionId || id, name: o.name, cwd, task: o.task, model: o.model, effort: o.effort, remote: o.remote, startedAt: Date.now() };
  workers.put(w);
  log("sessions", `запущена ${o.name} (${id}) в ${tilde(cwd)}`);
  return w;
}

export async function stopSession(id: string): Promise<string> {
  const r = await run([claudeBin, "stop", id], { timeoutMs: 30_000 });
  return (r.stdout + r.stderr).trim();
}

// Sets or clears a session's /goal. A background session takes it on wake-up; a Terminal session only through the
// restart wrapper (v2), since Claude Code takes no commands from outside.
export async function setGoal(row: AgentRow, condition: string | null): Promise<Delivery> {
  if (row.kind !== "background" && (await wrapVersion(row)) < 2)
    return { ok: false, how: "failed", note: "это сессия из Терминала без обёртки перезапуска: цель ставится фоновой сессии или сессии во вкладке с обёрткой" };
  // a busy session gets it once it has finished its step
  return deliver(row, condition ? `/goal ${condition.replace(/\s+/g, " ").trim()}` : "/goal clear");
}

// Restarts a session on the current Claude Code version and continues where it was: same conversation, same goal.
// A background session: `claude respawn <id>` (same id, new process, history kept). A Terminal session: only in its
// own tab, through bin/claude-wrap.zsh.
export function restartSession(row: AgentRow): Promise<Delivery> {
  return oneAtATime(row, restartNow);
}

async function restartNow(row: AgentRow): Promise<Delivery> {
  if (!row.sessionId) return { ok: false, how: "failed", note: tr("у сессии нет разговора", "the session has no conversation") };
  // check the tab first, so a restart that can't happen is never promised
  if (row.kind !== "background") {
    const no = await tabWithout(row);
    if (no) return no;
  }
  if (row.status === "busy" || row.state === "working" || (row.waitingFor && row.waitingFor !== "input needed")) return { ok: false, how: "queued", note: tr("занята", "busy") };
  if (row.kind === "background" && row.id) {
    const id = row.id;
    return aroundTabs(row, async () => {
      const r = await run([claudeBin, "respawn", id], { timeoutMs: 60_000 });
      const out = (r.stdout + r.stderr).trim();
      return /respawned/i.test(out) ? { ok: true, how: "resumed", note: tr("перезапущена", "restarted") } : { ok: false, how: "failed", note: clip(out || tr("claude не ответил", "claude didn’t respond"), 200), raw: !!out };
    });
  }
  // A Terminal session restarts only in its own tab (moving it to the background would close the tab); that takes
  // bin/claude-wrap.zsh. Without the wrapper it is left alone.
  if (row.kind !== "background") return restartInTab(row);
  if (!row.pid) return { ok: false, how: "failed", note: tr("процесс сессии не запущен", "the session’s process isn’t running") };
  const pid = row.pid;
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 60 && alive(); i++) await Bun.sleep(250);
  if (alive()) return { ok: false, how: "failed", note: tr("процесс не завершился за 15 с — оставил как есть", "the process didn’t exit within 15 s — left it as is") };
  const r = await run([claudeBin, "--bg", "--resume", row.sessionId], { cwd: row.cwd, timeoutMs: 60_000 });
  const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
  const id = out.match(/backgrounded\s*·\s*([0-9a-f]{6,})/)?.[1];
  if (!id) return { ok: false, how: "failed", note: clip(out || tr("claude не ответил", "claude didn’t respond"), 200), raw: !!out };
  if (/started a copy/i.test(out)) return dropCopy(id, out);
  return { ok: true, how: "resumed", note: tr(`идёт в фоне; открыть в Терминале: claude attach ${id}`, `running in the background; to open it in Terminal: claude attach ${id}`) };
}

export const RESTART_DIR = process.env.CLAUDE_RESTART_DIR ?? join(HOME, ".claude", "architect", "restart");

// Restart wrapper version in a Terminal session's shell (mark file <shell pid>.tab): 0 none, 1 restart only,
// 2 restart with a message. Tabs opened before v2 keep v1 until they are reopened.
export async function wrapVersion(row: AgentRow): Promise<number> {
  if (row.kind === "background" || !row.pid) return 0;
  const shell = Number((await run(["ps", "-o", "ppid=", "-p", String(row.pid)])).stdout.trim());
  const mark = join(RESTART_DIR, `${shell}.tab`);
  if (!shell || !existsSync(mark)) return 0;
  return readFileSync(mark, "utf8").startsWith("v2 ") ? 2 : 1;
}

// A copy is a second process of the same conversation, and both would work in the same folder at once.
// Stop the copy and keep the original.
async function dropCopy(copyId: string, out: string): Promise<Delivery> {
  log("sessions", "Claude Code завёл копию разговора — останавливаю её", clip(out, 300));
  await stopSession(copyId);
  return { ok: false, how: "failed", note: tr("Claude Code завёл копию разговора вместо продолжения — копию остановил, сообщение не передано", "Claude Code started a copy of the conversation instead of continuing it — stopped the copy, the message wasn’t delivered") };
}

// The Terminal tabs showing a background session through `claude attach <id>`: the shells of those that attach again
// after a restart (bin/claude-wrap.zsh marks them), and how many others there are
export async function attachTabs(id: string): Promise<{ shells: number[]; old: number }> {
  const r = await run([psBin, "-axo", "pid=,ppid=,tty=,args="], { timeoutMs: 5000 });
  const attach = new RegExp(`claude attach ${id.replace(/[^\w-]/g, "")}(\s|$)`);
  const tabs = { shells: [] as number[], old: 0 };
  for (const l of r.stdout.split("\n")) {
    const m = l.match(/^\s*\d+\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m || m[2].startsWith("??") || !attach.test(m[3])) continue;
    const mark = join(RESTART_DIR, `${m[1]}.attach`);
    if (existsSync(mark) && readFileSync(mark, "utf8").startsWith("v1 ")) tabs.shells.push(Number(m[1]));
    else tabs.old++;
  }
  return tabs;
}

// A restart ends the `claude attach` of the tabs showing the session. A tab with the wrapper attaches again once the
// session is back; a tab without it would stay on "Session has exited", so then nothing restarts. detached() waits
// until those attach clients are gone: while one is still connected, Claude Code takes the session for running and a
// resume would start a copy.
async function aroundTabs(row: AgentRow, restart: (detached: () => Promise<void>) => Promise<Delivery>): Promise<Delivery> {
  const tabs = await attachTabs(row.id!);
  if (tabs.old)
    return {
      ok: false,
      how: "old-tab",
      note: tr(
        `она открыта во вкладке Терминала без обёртки перезапуска: перезапуск оставил бы вкладку пустой. Если открыть её заново в новой вкладке (claude attach ${row.id}), смогу`,
        `it’s open in a Terminal tab without the restart wrapper: a restart would leave the tab empty. If you reopen it in a new tab (claude attach ${row.id}), I can`,
      ),
    };
  const flag = (shell: number) => join(RESTART_DIR, `${shell}.reattach`);
  for (const s of tabs.shells) writeFileSync(flag(s), `${row.id}\nwait\n`);
  const detached = async () => {
    for (let i = 0; i < 30 && (await attachTabs(row.id!)).shells.length; i++) await Bun.sleep(500);
  };
  try {
    return await restart(detached);
  } finally {
    const id = (await listAgents(true).catch(() => [] as AgentRow[])).find((x) => x.sessionId === row.sessionId)?.id ?? row.id;
    for (const s of tabs.shells) writeFileSync(flag(s), `${id}\ngo\n`);
  }
}

// Why a Terminal session can't be restarted in its tab; undefined if it can
async function tabWithout(row: AgentRow): Promise<Delivery | undefined> {
  if (!row.pid || !row.sessionId) return { ok: false, how: "failed", note: tr("процесс сессии не запущен", "the session’s process isn’t running") };
  const shell = Number((await run(["ps", "-o", "ppid=", "-p", String(row.pid)])).stdout.trim());
  if (shell === process.pid) return { ok: false, how: "self", note: tr("это сам архитектор", "that’s the architect itself") };
  if (!shell || !existsSync(join(RESTART_DIR, `${shell}.tab`)))
    return {
      ok: false,
      how: "old-tab",
      note: tr(
        "она открыта во вкладке, где перезапуск не подключён: отсюда её не перезапустить; если открыть её заново в новой вкладке Терминала — смогу",
        "it’s open in a Terminal tab without restart support: I can’t restart it from here; if you reopen it in a new Terminal tab, I can",
      ),
    };
}

// The wrapper's shell gets the session id and, once claude exits, runs `claude --resume <id> [message]` itself
async function restartInTab(row: AgentRow, prompt?: string): Promise<Delivery> {
  const no = await tabWithout(row);
  if (no || !row.pid || !row.sessionId) return no ?? { ok: false, how: "failed", note: tr("процесс сессии не запущен", "the session’s process isn’t running") };
  const shell = Number((await run(["ps", "-o", "ppid=", "-p", String(row.pid)])).stdout.trim());
  const flag = join(RESTART_DIR, String(shell));
  writeFileSync(flag, prompt ? `${row.sessionId}\n${prompt}` : row.sessionId);
  try {
    process.kill(row.pid, "SIGTERM");
  } catch {
    // the process is gone: drop the request, or the tab would resume the session when the owner next quits claude
    try {
      unlinkSync(flag);
    } catch {}
    return { ok: false, how: "failed", note: tr("процесс сессии уже завершился", "the session’s process has already exited") };
  }
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(1000);
    const again = (await listAgents(true)).find((r) => r.sessionId === row.sessionId && r.pid && r.pid !== row.pid);
    if (again)
      return { ok: true, how: "resumed", note: prompt ? tr("получила это в своей вкладке как вашу реплику", "got this in its tab as your message") : tr("перезапущена в своей вкладке, разговор тот же", "restarted in its tab, same conversation") };
  }
  return { ok: false, how: "failed", note: tr("за 40 с сессия в своей вкладке не поднялась — посмотрите Терминал", "the session didn’t come back up in its tab within 40 s — check Terminal") };
}

// Restarts of busy sessions, done once they end their turn (the watcher checks every 10 s)
const RESTARTS = join(STATE, "restarts.json");
export const pendingRestarts = {
  // When it was asked for, an optional message to resume with, and what came after it (then), passed on in order;
  // older state stored only the time
  all: () => Object.fromEntries(Object.entries(readJson<Record<string, number | { at: number; prompt?: string; then?: string[] }>>(RESTARTS, {})).map(([k, v]) => [k, typeof v === "number" ? { at: v } : v])) as Record<string, { at: number; prompt?: string; then?: string[] }>,
  add(sessionId: string, prompt?: string) {
    const all = this.all();
    const was = all[sessionId];
    // a message after one that is still waiting waits behind it
    if (was?.prompt && prompt) was.then = [...(was.then ?? []), prompt];
    else all[sessionId] = { at: Date.now(), prompt, ...(was?.then ? { then: was.then } : {}) };
    writeJson(RESTARTS, all);
  },
  remove(sessionId: string) {
    const all = this.all();
    delete all[sessionId];
    writeJson(RESTARTS, all);
  },
};

// What waited for a session to end its step, once it has: the owner's own message (or a restart), then what came after
// it, in order. Returns what happened, for one line to the owner.
export async function deliverQueued(rows: AgentRow[]): Promise<{ row: AgentRow; prompt?: string; res: Delivery }[]> {
  const done: { row: AgentRow; prompt?: string; res: Delivery }[] = [];
  for (const [sessionId, p] of Object.entries(pendingRestarts.all())) {
    const r = rows.find((x) => x.sessionId === sessionId && x.pid);
    if (!r || Date.now() - p.at > 12 * 3600_000) {
      pendingRestarts.remove(sessionId);
      continue;
    }
    if (r.status === "busy" || r.state === "working" || (r.waitingFor && r.waitingFor !== "input needed")) continue;
    pendingRestarts.remove(sessionId);
    const res = p.prompt ? await deliver(r, p.prompt) : await restartSession(r);
    if (res.how === "queued") {
      for (const t of p.then ?? []) pendingRestarts.add(sessionId, t); // still behind it
      continue;
    }
    for (const t of p.then ?? []) {
      const next = await deliver(r, t);
      if (!next.ok) log("sessions", "следом не передал", { sid: sessionId.slice(0, 8), how: next.how, note: clip(next.note, 200) });
    }
    done.push({ row: r, prompt: p.prompt, res });
  }
  return done;
}

// raw: note is program output, not our words, and is not shown to the owner
export type Delivery = { ok: boolean; how: "queued" | "sent" | "resumed" | "needs-sendmessage" | "failed" | "old-tab" | "self"; note: string; raw?: boolean };

// Delivers text the most direct way: a busy worker gets it from the hook at its next step; any other live session gets
// it in its running process through the courier, marked as the owner's words. What must be his own message (/goal,
// «принято») resumes the conversation with it: in its own tab for a Terminal session with the wrapper. So does a
// stopped session.
export function deliver(row: AgentRow, text: string): Promise<Delivery> {
  return oneAtATime(row, (r) => deliverNow(r, text));
}

async function deliverNow(row: AgentRow, text: string): Promise<Delivery> {
  const w = row.sessionId ? workers.get(row.sessionId) : undefined;
  const busy = row.status === "busy" || (row.state === "working" && row.status !== "idle" && !!row.pid);
  const onPermission = row.waitingFor === "permission prompt";
  const own = ownMessage(text);
  // behind the owner's own message that is still waiting for this session, in order
  if (row.sessionId && pendingRestarts.all()[row.sessionId]?.prompt) {
    pendingRestarts.add(row.sessionId, text);
    return { ok: true, how: "queued", note: tr("передам ваше сообщение, как только она закончит текущий шаг", "I’ll pass on your message as soon as it finishes the current step") };
  }
  // our own busy session gets words at the end of its step, in order with the other answers
  if (!own && (busy || onPermission) && w && row.sessionId) {
    outbox.push(row.sessionId, text);
    return {
      ok: true,
      how: "queued",
      note: onPermission
        ? tr("она ждёт вашего решения по кнопке — передам сообщение сразу после него", "it’s waiting for your decision on a button — I’ll pass on your message right after that")
        : tr("передам ваше сообщение, как только она закончит текущий шаг", "I’ll pass on your message as soon as it finishes the current step"),
    };
  }
  // Words go to the live process through the courier: no restart, so its window, tab and background agents stay.
  if (row.pid && !own) {
    const said = ownerWords([text]);
    if (!(await courier(row.pid, said, row.cwd))) return { ok: false, how: "needs-sendmessage", note: "курьер не достучался до сессии — передать можно сообщением между сессиями" };
    await readBy(row, said);
    return { ok: true, how: "sent", note: tr("передал в работающую сессию", "passed on to the running session") };
  }
  // The owner's own message (a slash command such as /goal, «принято» that closes a goal) goes in by resuming the
  // conversation with it as its user's message: a Terminal session only in its own tab through the wrapper, a busy one
  // once it has finished its step
  const tab = row.kind !== "background";
  if (tab && (await wrapVersion(row)) < 2) return { ok: false, how: "needs-sendmessage", note: "сессия в терминале без обёртки перезапуска — передать можно только сообщением между сессиями" };
  if (!row.sessionId || (!tab && !row.id)) return { ok: false, how: "failed", note: tr("у сессии нет разговора", "the session has no conversation") };
  if (busy || onPermission || (!!row.waitingFor && row.waitingFor !== "input needed")) {
    pendingRestarts.add(row.sessionId, text);
    return { ok: true, how: "queued", note: tr("передам ваше сообщение, как только она закончит текущий шаг", "I’ll pass on your message as soon as it finishes the current step") };
  }
  return tab ? restartInTab(row, text) : resumeWith(row, text, w);
}

// The owner's own message for a stopped session or a slash command: resume the conversation with it.
async function resumeWith(row: AgentRow, text: string, w: Worker | undefined): Promise<Delivery> {
  if (!row.sessionId || !row.id) return { ok: false, how: "failed", note: tr("у сессии нет разговора", "the session has no conversation") };
  if (!row.pid) return resumeStopped(row, text, w);
  const id = row.id;
  return aroundTabs(row, async (detached) => {
    await stopSession(id);
    // wait until the process is really gone, or --resume would start a copy
    let gone = false;
    for (let i = 0; i < 30 && !gone; i++) {
      gone = !(await listAgents(true)).find((x) => x.sessionId === row.sessionId)?.pid;
      if (!gone) await Bun.sleep(500);
    }
    if (!gone) return { ok: false, how: "failed", note: tr("сессия не остановилась за 15 с — не поднимаю её заново, иначе Claude Code заведёт копию", "the session didn’t stop within 15 s — not resuming it, or Claude Code would start a copy") };
    await detached();
    return resumeStopped(row, text, w);
  });
}

async function resumeStopped(row: AgentRow, text: string, w: Worker | undefined): Promise<Delivery> {
  if (!row.sessionId) return { ok: false, how: "failed", note: tr("у сессии нет разговора", "the session has no conversation") };
  // Process flags (--settings with the gate hooks, Remote Control, model) are not in the transcript: pass them again for
  // our own sessions, or the session would carry on without the gate.
  const flags = w ? ["-n", w.name, "--model", w.model, "--effort", w.effort ?? config.workers.effort, "--settings", WORKER_SETTINGS, "--append-system-prompt", workerPreface(), ...(w.remote !== false ? ["--remote-control", w.name] : [])] : [];
  const r = await run([claudeBin, "--resume", row.sessionId, "--bg", ...flags, text], { cwd: row.cwd, timeoutMs: 60_000 });
  const out = (r.stdout + r.stderr).trim();
  const newId = out.match(/backgrounded\s*·\s*([0-9a-f]{6,})/)?.[1];
  if (!newId && !/woke/i.test(out)) return { ok: false, how: "failed", note: clip(out || tr("нет ответа от claude", "no response from claude"), 300), raw: !!out };
  if (/started a copy/i.test(out) && newId) return dropCopy(newId, out);
  if (w && newId && newId !== w.id) workers.patch(w.sessionId, { id: newId });
  return { ok: true, how: "resumed", note: "сессия продолжила работу с вашим сообщением" };
}

// An idle session reads a message between sessions at once. Wait for that (up to 10 s), so that what comes next, such as
// a restart for the owner's own message, can't stop it before it has read this one.
async function readBy(row: AgentRow, said: string) {
  if (row.status !== "idle" || !row.sessionId) return;
  const path = transcriptPath(row.cwd, row.sessionId);
  if (!existsSync(path)) return; // its conversation isn't on this Mac's disk: nothing to watch
  for (let i = 0; i < 20; i++) {
    if (readTail(path, 300_000).some((e) => e.type === "user" && (e.origin as { body?: string } | undefined)?.body === said)) return;
    await Bun.sleep(500);
  }
}

// what must reach the session as the owner's own message: a slash command such as /goal, «принято» that closes a goal
const ownMessage = (t: string) => /^\s*\//.test(t) || /^\s*«?принято»?[.!]?\s*$/i.test(t);

// The architect's own note to a session (message_session with note) is not quoted as the owner's words
export const ARCH_NOTE = "Архитектор от себя — это не слова владельца: ";
export function ownerWords(msgs: string[]) {
  const own = msgs.filter((m) => !m.includes(ARCH_NOTE));
  const said = own.length === 1 ? `Сообщение владельца из Telegram: «${own[0]}»` : own.length ? `Сообщения владельца из Telegram:\n${own.map((m) => `— «${m}»`).join("\n")}` : "";
  return [said, ...msgs.filter((m) => m.includes(ARCH_NOTE))].filter(Boolean).join("\n\n");
}

let courier: Courier = async () => false;
export function setCourier(c: Courier) {
  courier = c;
}
