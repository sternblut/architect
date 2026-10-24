// Сессии Claude Code на этом Mac: список, журналы, запуск, остановка, доставка сообщений.
// Всё через штатные команды: claude agents --json, claude --bg, claude stop, claude --resume --bg.
import { existsSync, openSync, readSync, closeSync, fstatSync, realpathSync, statSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARCH_HOME, HOME, STATE, WORK, config, isTestCwd, projectDir, tr } from "./config";
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

// Хуки рабочих сессий. Шлагбаум — командой (работает и без хоста), остальное — в хост по HTTP.
// Все события — одной командой (hook.ts): секрет она берёт из связки ключей, в файле настроек секрета нет.
export function writeWorkerSettings(_secret: string, bunPath: string) {
  const env = process.env.ARCH_STATE_DIR ? `ARCH_STATE_DIR='${process.env.ARCH_STATE_DIR}' ARCH_HOOK_PORT=${config.hookPort} ` : "";
  const cmd = (timeout: number, onFailure?: "block") => ({ hooks: [{ type: "command", command: `${env}'${bunPath}' '${join(ARCH_HOME, "src", "hook.ts")}'`, timeout, ...(onFailure ? { onFailure } : {}) }] });
  writeJson(WORKER_SETTINGS, {
    hooks: {
      PreToolUse: [cmd(21600, "block")],
      PermissionRequest: [cmd(21600)],
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

// Одна доставка или перезапуск на разговор за раз: два слова подряд иначе останавливали и поднимали сессию
// наперегонки, и Claude Code заводил копии. Внутри замка строка сессии читается заново.
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

// Все сессии Claude Code на Mac, кроме самого архитектора (он и так говорит с владельцем напрямую).
export async function listAgents(all = true): Promise<AgentRow[]> {
  const r = await run([claudeBin, "agents", "--json", ...(all ? ["--all"] : [])], { timeoutMs: 20_000 });
  if (r.code !== 0) throw new Error(`claude agents: ${clip(r.stderr || r.stdout, 300)}`);
  const self = readJson<{ sessionId?: string }>(join(STATE, "architect.json"), {}).sessionId;
  // служебные сессии владельцу не показываем: проверки (папка test), копии агентов разработки (.claude/worktrees)
  // временные папки и пробные прогоны в папке самого архитектора; в самих проверках (ARCH_STATE_DIR) — видны
  const dev = (x: AgentRow) => {
    const cwd = String(x.cwd ?? "");
    return isTestCwd(cwd) || cwd.startsWith(join(ARCH_HOME, ".claude")) || /^\/(private\/)?tmp\//.test(cwd) || (cwd === WORK && !workers.get(x.sessionId));
  };
  return oneRowPerSession((JSON.parse(r.stdout) as AgentRow[]).filter((x) => (!self || x.sessionId !== self) && (!!process.env.ARCH_STATE_DIR || !dev(x))));
}

// Один разговор — одна строка. После перевода в фон у разговора остаются две записи: живой процесс во вкладке
// Терминала и фоновая сессия с тем же номером. Перезапуск фоновой даёт «Can't open — this session is running
// in another terminal». Живая запись важнее, у Терминала — первая.
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

// ── рабочие сессии архитектора ───────────────────────────────────────────────

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

// Очередь сообщений владельца для занятых сессий: отдаётся хуком на следующем шаге сессии.
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

// ── журналы ──────────────────────────────────────────────────────────────────

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
// служебные записи журнала (пересказ сжатия, вставки Claude Code, ветки помощников) — не слова владельца (claude-code-viewer)
const service = (e: Entry) => !!(e.isMeta || e.isCompactSummary || e.isSidechain);
const fromSession = (t: string) => t.startsWith("Another Claude session sent a message");

export function toolBrief(name: string, input: Record<string, unknown> = {}): string {
  if (name === "AskUserQuestion") return ((input.questions as { question: string }[]) ?? []).map((q) => q.question).join("; ");
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt ?? "";
  return clip(String(v).replace(/\s+/g, " "), 140);
}

// named — название дал человек (/rename); apiError — ход кончился ошибкой API (лимит, вход) и после неё ничего не было;
// question — последний вопрос сессии владельцу, на который он ещё не ответил; tools — её последние вызовы инструментов коротко
export type Digest = { title?: string; named?: boolean; goal?: string; goalMet?: boolean; lastText?: string; lastTool?: string; lastUser?: string; lastTs?: number; rcUrl?: string; apiError?: string; question?: string; tools?: string[] };

export function digest(entries: Entry[]): Digest {
  const d: Digest = {};
  let custom: string | undefined;
  for (const e of entries) {
    // название: ручное (/rename) важнее придуманного Claude (claudecodeui)
    if (e.type === "custom-title") custom = String(e.customTitle ?? e.title ?? "") || custom;
    if (e.type === "ai-title" || e.type === "summary") d.title = String(e.aiTitle ?? e.title ?? (e as { summary?: string }).summary ?? d.title ?? "");
    // ссылка Remote Control: system/bridge_status с url, а чаще только запись bridge-session (session_ + id без cse_)
    if (e.type === "system" && (e as { subtype?: string }).subtype === "bridge_status" && typeof (e as { url?: unknown }).url === "string") d.rcUrl = String((e as { url: string }).url);
    if (e.type === "bridge-session" && typeof e.bridgeSessionId === "string") d.rcUrl = `https://claude.ai/code/session_${String(e.bridgeSessionId).replace(/^cse_/, "")}`;
    // цель /goal — штатная запись goal_status (happy, ccteam): met без sentinel — достигнута, met с sentinel — снята
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
    // цель целиком повторяется в каждом «Stop hook feedback: [ЦЕЛЬ — …]»: у долгих сессий запись goal_status давно ушла из хвоста
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
          // последняя фраза с вопросом — то, чего сессия ждёт от владельца
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

// Последние реплики сессии: владелец, Claude и вызовы инструментов коротко.
export function conversation(entries: Entry[], n: number): string[] {
  const rows: string[] = [];
  for (const e of entries) {
    if (e.type !== "user" && e.type !== "assistant") continue;
    // время — по часам Mac, а не в UTC, как в журнале; не сегодня — с датой
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

// Что сессия делает сейчас — словами, без сырых команд.
export function doing(lastTool?: string): string {
  const name = (lastTool ?? "").split(":")[0];
  if (!name) return "";
  if (/^(Bash|BashOutput|KillShell|Monitor)$/.test(name)) return "выполняет команду";
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return "правит файлы";
  if (/^(Read|Grep|Glob|LS)$/.test(name)) return "читает код";
  if (/^(WebFetch|WebSearch)$/.test(name)) return "ищет в интернете";
  if (/^(Agent|Task)$/.test(name)) return "поручила работу помощнику";
  if (name === "AskUserQuestion") return "спрашивает вас";
  if (name === "SendMessage") return "пишет другой сессии";
  if (name.startsWith("mcp__")) return "работает с инструментами";
  return "работает";
}

// То же, что conversation(), но по полям — для оформления в Telegram.
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

// Сколько раз за окно сессия получила «Stop hook feedback» (цель /goal не даёт остановиться) — признак холостого хода.
export function spinCount(entries: Entry[], windowMs = 10 * 60_000): number {
  const since = Date.now() - windowMs;
  let n = 0;
  for (const e of entries) {
    if (e.type !== "user" || !e.timestamp || Date.parse(e.timestamp) < since) continue;
    for (const b of blocks(e)) if (b.type === "text" && b.text?.startsWith("Stop hook feedback")) n++;
  }
  return n;
}

// Сколько действий (вызовов инструментов) сессия сделала с момента since и когда последнее: «работала ночью» —
// это действия, а не любая запись в журнале (иначе в «работали ночью» попадают все сессии)
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

// ── поиск сессии по слову владельца ─────────────────────────────────────────

export async function findSession(key: string): Promise<AgentRow | undefined> {
  const rows = await listAgents(true);
  const k = key.trim().toLowerCase();
  return (
    rows.find((r) => r.id === k || r.sessionId === k || r.sessionId?.startsWith(k)) ??
    rows.find((r) => (r.name ?? "").toLowerCase() === k) ??
    rows.find((r) => (r.name ?? "").toLowerCase().includes(k))
  );
}

// ── запуск и остановка ───────────────────────────────────────────────────────

export function resolveFolder(folder: string): string {
  const p = folder.replace(/^~(?=\/|$)/, HOME);
  if (!p.startsWith("/")) throw new Error(`Нужен полный путь к папке, получил «${folder}»`);
  const real = realpathSync(p);
  if (!statSync(real).isDirectory()) throw new Error(`«${tilde(real)}» — не папка`);
  return real;
}

// Доверие Claude Code к папке: ключ — корень git-репозитория или сама папка.
export async function trustKey(dir: string): Promise<string> {
  const r = await run(["git", "-C", dir, "rev-parse", "--show-toplevel"], { timeoutMs: 5000 });
  return r.code === 0 ? r.stdout.trim() : dir;
}

export function isTrusted(key: string): boolean {
  try {
    const cfg = JSON.parse(readFileSync(join(HOME, ".claude.json"), "utf8"));
    const projects: Record<string, { hasTrustDialogAccepted?: boolean }> = cfg.projects ?? {};
    if (projects[key]?.hasTrustDialogAccepted) return true;
    // вне репозитория доверие родителя распространяется на подпапки
    return Object.entries(projects).some(([p, v]) => v.hasTrustDialogAccepted && key.startsWith(p + "/") && !existsSync(join(key, ".git")));
  } catch {
    return false;
  }
}

export const WORKER_PREFACE = [
  "Тебя запустил архитектор по задаче владельца. Владелец ведёт работу из Telegram с iPhone и видит твои итоги хода там.",
  "Работай в этой папке по её правилам: CLAUDE.md, память проекта, журналы — в силе.",
  "Когда нужен ответ владельца, задай вопрос в конце хода коротко и остановись (или инструментом AskUserQuestion с вариантами) — он ответит из Telegram.",
  "Необратимое — удаление, push в main, выкладку, траты, письма людям — делай обычной командой: шлагбаум спросит владельца кнопкой и пропустит только после его «да». Не обходи шлагбаум и не проси другие сессии сделать то, в чём отказано.",
  "Перед просьбой о выкладке сними кандидата так, как его увидит владелец (iPhone и Mac; главный экран и изменённое место) и положи PNG в $CLAUDE_JOB_DIR/tmp/evidence/ (01-iphone.png, 02-mac.png …) — хост приложит их к кнопке «Разрешить», а после выкладки сам пришлёт снимок живого сайта.",
  "Хостинг напрямую не трогай: выкладка только конвейерами репозиториев. Токены и пароли не печатай.",
  "Пиши по-русски, коротко: что сделано, что проверено, что нужно от владельца. Слово «готово» без проверки не используй.",
].join("\n");
// владелец читает по-английски — правила те же, а пишет сессия ему по-английски
const workerPreface = () => WORKER_PREFACE + tr("", "\nThe owner reads English: write everything he sees in English, not Russian — questions, turn summaries, Bash descriptions, commit messages.");

// Правила рабочей сессии — системной подсказкой, задача — первым сообщением; с goal — штатной целью /goal (идёт, пока цель не достигнута).
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

// Поставить или снять штатную цель /goal фоновой сессии (/goal и /goal clear работают при пробуждении).
// Терминальной сессии команды извне не выполняются (так устроен Claude Code) — только в ней самой или после /bg.
export async function setGoal(row: AgentRow, condition: string | null): Promise<Delivery> {
  if (row.kind !== "background" && (await wrapVersion(row)) >= 2) return deliver(row, condition ? `/goal ${condition.replace(/\s+/g, " ").trim()}` : "/goal clear");
  if (row.kind !== "background" || !row.sessionId || !row.id)
    return { ok: false, how: "failed", note: "это сессия из Терминала: цель ставится фоновой сессии. Сначала restart_session — она продолжит в фоне с того же места, — потом цель" };
  if (row.status === "busy" || (row.state === "working" && row.status !== "idle"))
    return { ok: false, how: "failed", note: "сессия сейчас работает: поставить или снять цель значит прервать её ход. Дождись, пока она закончит (SendMessage с notify_when_idle), или спроси владельца, прерывать ли" };
  return deliver(row, condition ? `/goal ${condition.replace(/\s+/g, " ").trim()}` : "/goal clear");
}

// Перезапустить сессию на нынешней версии Claude Code и продолжить с того же места: тот же разговор, та же цель.
// Фоновую — `claude respawn <id>` (тот же номер, новый процесс, история на месте);
// остановленную — `claude --bg --resume <sessionId>` без флагов (с любым флагом Claude Code заводит копию разговора).
// Сессию из Терминала — только свободную: её процесс завершается (SIGTERM; разговор уже на диске), и она продолжается
// фоновой под тем же номером. Дальше ей можно ставить цель и передавать слова владельца его репликами.
export function restartSession(row: AgentRow): Promise<Delivery> {
  return oneAtATime(row, restartNow);
}

async function restartNow(row: AgentRow): Promise<Delivery> {
  if (!row.sessionId) return { ok: false, how: "failed", note: tr("у сессии нет разговора", "the session has no conversation") };
  // вкладку без перезапуска видно сразу — не обещать «перезапущу, когда закончит ход», чтобы потом сказать «не вышло»
  if (row.kind !== "background") {
    const no = await tabWithout(row);
    if (no) return no;
  }
  if (row.status === "busy" || row.state === "working" || (row.waitingFor && row.waitingFor !== "input needed")) return { ok: false, how: "queued", note: tr("занята", "busy") };
  if (row.kind === "background" && row.id) {
    // фоновая, открытая во вкладке Терминала через `claude attach`: respawn закроет вкладку («Session has exited»).
    // Такую — как старую вкладку: его команда `archi adopt` переводит её на место
    if (await attachedInTab(row.id)) return { ok: false, how: "old-tab", note: tr("она открыта во вкладке Терминала через attach: перезапуск закрыл бы вкладку", "it’s open in a Terminal tab through attach: restarting would close the tab") };
    const r = await run([claudeBin, "respawn", row.id], { timeoutMs: 60_000 });
    const out = (r.stdout + r.stderr).trim();
    return /respawned/i.test(out) ? { ok: true, how: "resumed", note: tr("перезапущена", "restarted") } : { ok: false, how: "failed", note: clip(out || tr("claude не ответил", "claude didn’t respond"), 200), raw: !!out };
  }
  // Сессия из Терминала перезапускается только на месте — в её же вкладке: для владельца «то же место» — та же
  // вкладка (перевод в фон закрыл бы её вкладку и оборвал работу). Это умеет обёртка
  // bin/claude-wrap.zsh: она поднимает тот же разговор в той же оболочке. Без обёртки сессию не трогаем.
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

// Перезапуск в той же вкладке: оболочка с обёрткой (метка <pid оболочки>.tab) получает номер разговора и, когда
// процесс claude завершится, сама поднимает `claude --resume <номер>`: тот же разговор, та же оболочка, новая версия.
// Версия обёртки перезапуска у сессии из Терминала: 0 — обёртки нет, 1 — только перезапуск, 2 — и подъём с репликой.
// Вкладки, открытые до установки второй версии обёртки, держат первую, пока их не откроют заново.
export async function wrapVersion(row: AgentRow): Promise<number> {
  if (row.kind === "background" || !row.pid) return 0;
  const shell = Number((await run(["ps", "-o", "ppid=", "-p", String(row.pid)])).stdout.trim());
  const mark = join(RESTART_DIR, `${shell}.tab`);
  if (!shell || !existsSync(mark)) return 0;
  return readFileSync(mark, "utf8").startsWith("v2 ") ? 2 : 1;
}

// Копия — второй процесс того же разговора: обе работали бы наперегонки в одной папке, а владелец видел бы две
// одинаковые сессии. Копию сразу останавливаем, учёт остаётся на исходной.
async function dropCopy(copyId: string, out: string): Promise<Delivery> {
  log("sessions", "Claude Code завёл копию разговора — останавливаю её", clip(out, 300));
  await stopSession(copyId);
  return { ok: false, how: "failed", note: tr("Claude Code завёл копию разговора вместо продолжения — копию остановил, сообщение не передано", "Claude Code started a copy of the conversation instead of continuing it — stopped the copy, the message wasn’t delivered") };
}

// Открыта ли фоновая сессия во вкладке Терминала через `claude attach <id>`
export async function attachedInTab(id: string): Promise<boolean> {
  const r = await run([psBin, "-axo", "tty=,args="], { timeoutMs: 5000 });
  return r.stdout.split("\n").some((l) => !/^\s*\?\?/.test(l) && new RegExp(`claude attach ${id.replace(/[^\w-]/g, "")}(\s|$)`).test(l));
}

// Почему сессию из Терминала не перезапустить в её вкладке; undefined — можно.
async function tabWithout(row: AgentRow): Promise<Delivery | undefined> {
  if (!row.pid || !row.sessionId) return { ok: false, how: "failed", note: tr("процесс сессии не запущен", "the session’s process isn’t running") };
  const shell = Number((await run(["ps", "-o", "ppid=", "-p", String(row.pid)])).stdout.trim());
  if (shell === process.pid) return { ok: false, how: "self", note: tr("это сам архитектор", "that’s the architect itself") }; // его разговор держит хост
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

async function restartInTab(row: AgentRow, prompt?: string): Promise<Delivery> {
  const no = await tabWithout(row);
  if (no || !row.pid || !row.sessionId) return no ?? { ok: false, how: "failed", note: tr("процесс сессии не запущен", "the session’s process isn’t running") };
  const shell = Number((await run(["ps", "-o", "ppid=", "-p", String(row.pid)])).stdout.trim());
  const flag = join(RESTART_DIR, String(shell));
  writeFileSync(flag, prompt ? `${row.sessionId}\n${prompt}` : row.sessionId);
  try {
    process.kill(row.pid, "SIGTERM");
  } catch {
    // процесса уже нет — просьбу убрать, иначе вкладка поднимет сессию при следующем выходе владельца из Claude
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

// Занятую сессию перезапускаем, когда она закончит ход (наблюдатель проверяет каждые 10 с).
const RESTARTS = join(STATE, "restarts.json");
export const pendingRestarts = {
  // у каждой — когда попросили и, если есть, реплика, с которой поднять разговор
  all: () => Object.fromEntries(Object.entries(readJson<Record<string, number | { at: number; prompt?: string }>>(RESTARTS, {})).map(([k, v]) => [k, typeof v === "number" ? { at: v } : v])) as Record<string, { at: number; prompt?: string }>,
  add(sessionId: string, prompt?: string) {
    writeJson(RESTARTS, { ...this.all(), [sessionId]: { at: Date.now(), prompt } });
  },
  remove(sessionId: string) {
    const all = this.all();
    delete all[sessionId];
    writeJson(RESTARTS, all);
  },
};

// raw — note не наши слова, а вывод программы: владельцу его не показываем
export type Delivery = { ok: boolean; how: "queued" | "resumed" | "needs-sendmessage" | "failed" | "old-tab" | "self"; note: string; raw?: boolean };

// Доставляет текст сессии самым прямым штатным путём:
// занятой своей — через хук на её следующем шаге; простаивающей фоновой — пробуждением с этим текстом;
// чужой занятой или терминальной — только через SendMessage архитектора (сессия увидит, что это от другой сессии).
export function deliver(row: AgentRow, text: string): Promise<Delivery> {
  return oneAtATime(row, (r) => deliverNow(r, text));
}

async function deliverNow(row: AgentRow, text: string): Promise<Delivery> {
  // сессия из Терминала с обёрткой: вкладка поднимает тот же разговор сразу с этим текстом — это реплика пользователя
  // («claude --resume <id> "<текст>"» — ответ на текст; «/goal …» — цель поставлена и выполнена)
  if (row.kind !== "background" && (await wrapVersion(row)) >= 2) {
    if (row.status === "busy" || row.state === "working" || (row.waitingFor && row.waitingFor !== "input needed")) {
      pendingRestarts.add(row.sessionId!, text);
      return { ok: true, how: "queued", note: tr("передам ваше сообщение, как только она закончит текущий шаг", "I’ll pass on your message as soon as it finishes the current step") };
    }
    return restartInTab(row, text);
  }
  if (row.kind !== "background" || !row.sessionId || !row.id) return { ok: false, how: "needs-sendmessage", note: "сессия в терминале без обёртки перезапуска — передать можно только сообщением между сессиями" };
  const w = workers.get(row.sessionId);
  const busy = row.status === "busy" || (row.state === "working" && row.status !== "idle" && !!row.pid);
  const onPermission = row.waitingFor === "permission prompt";
  if (busy || onPermission) {
    if (!w) return { ok: false, how: "needs-sendmessage", note: "чужая занятая сессия — передать можно только сообщением между сессиями" };
    outbox.push(row.sessionId, text);
    return {
      ok: true,
      how: "queued",
      note: onPermission
        ? tr("она ждёт вашего решения по кнопке — передам сообщение сразу после него", "it’s waiting for your decision on a button — I’ll pass on your message right after that")
        : tr("передам ваше сообщение, как только она закончит текущий шаг", "I’ll pass on your message as soon as it finishes the current step"),
    };
  }
  if (row.pid) {
    // Открытую во вкладке через `claude attach` не останавливаем: владелец смотрит именно туда, а вкладка покажет
    // «Session has exited». Сообщение между сессиями приходит в живой процесс без перезапуска.
    if (await attachedInTab(row.id)) return { ok: false, how: "needs-sendmessage", note: "она открыта во вкладке Терминала: перезапуск закрыл бы вкладку — передать можно сообщением между сессиями" };
    await stopSession(row.id);
    // ждём, пока процесс действительно уйдёт: иначе --resume поднимет копию разговора вместо продолжения
    let gone = false;
    for (let i = 0; i < 30 && !gone; i++) {
      gone = !(await listAgents(true)).find((x) => x.sessionId === row.sessionId)?.pid;
      if (!gone) await Bun.sleep(500);
    }
    if (!gone) return { ok: false, how: "failed", note: tr("сессия не остановилась за 15 с — не поднимаю её заново, иначе Claude Code заведёт копию", "the session didn’t stop within 15 s — not resuming it, or Claude Code would start a copy") };
  }
  // Флаги процесса (--settings с хуками-шлагбаумом, Remote Control, модель) в журнале не хранятся — у своих сессий передаём их заново,
  // иначе после первого же ответа владельца сессия продолжила бы работу без шлагбаума.
  const flags = w ? ["-n", w.name, "--model", w.model, "--effort", w.effort ?? config.workers.effort, "--settings", WORKER_SETTINGS, "--append-system-prompt", workerPreface(), ...(w.remote !== false ? ["--remote-control", w.name] : [])] : [];
  const r = await run([claudeBin, "--resume", row.sessionId, "--bg", ...flags, text], { cwd: row.cwd, timeoutMs: 60_000 });
  const out = (r.stdout + r.stderr).trim();
  const newId = out.match(/backgrounded\s*·\s*([0-9a-f]{6,})/)?.[1];
  if (!newId && !/woke/i.test(out)) return { ok: false, how: "failed", note: clip(out || tr("нет ответа от claude", "no response from claude"), 300), raw: !!out };
  if (/started a copy/i.test(out) && newId) return dropCopy(newId, out);
  if (w && newId && newId !== w.id) workers.patch(w.sessionId, { id: newId });
  return { ok: true, how: "resumed", note: "сессия продолжила работу с вашим сообщением" };
}
