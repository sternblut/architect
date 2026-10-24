// Хост для всех сессий Mac (/hook/any/*) без Claude: присутствие владельца, удержание, возврат к Mac, очередь ответов.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "arch-hs-"));
process.env.ARCH_STATE_DIR = dir;
process.env.ARCH_LOGS_DIR = dir;
process.env.ARCH_HOOK_PORT = "47397";
process.env.ARCH_FORCE_PRESENCE = "away";
const { ensureDirs, STATE, config } = await import("../src/config");
config.hookPort = 47397; // файлы тестов делят процесс: порт задаём явно, настоящий хост (47300) не трогаем
ensureDirs();
writeFileSync(join(STATE, "owner.json"), JSON.stringify({ id: 1 }));
const { startHookServer } = await import("../src/hookserver");
const { stopHolds } = await import("../src/holds");
const { fireReturn } = await import("../src/presence");
const { outbox } = await import("../src/sessions");

const SECRET = "hs-" + crypto.randomUUID();
let confirmReply: "yes" | "no" | "wait" | { tell: string } = "yes";
const asked: string[] = [];
const briefs: { tool?: string; cwd?: string; input?: unknown }[] = [];
const posts: string[] = [];
const alerts: string[] = [];
const approvals = {
  confirm: (o: { action: string; tool?: string; cwd?: string; input?: unknown; signal?: AbortSignal }) =>
    new Promise<"yes" | "no" | "timeout" | { tell: string }>((resolve) => {
      asked.push(o.action);
      briefs.push({ tool: o.tool, cwd: o.cwd, input: o.input });
      if (confirmReply !== "wait") return resolve(confirmReply);
      o.signal?.addEventListener("abort", () => resolve("timeout"));
    }),
  ask: async (o: { questions: { question: string; options?: { label: string }[] }[] }) => Object.fromEntries(o.questions.map((q) => [q.question, q.options?.[0]?.label ?? "A"])),
};
const server = startHookServer(SECRET, approvals as never, {
  label: (s) => `«${s}»`,
  threadFor: async () => undefined,
  turnEnded: async (_s, _c, t) => void posts.push(`turn:${t}`),
  sessionQuestion: async (_s, _c, t) => void posts.push(`question:${t}`),
  workerTurn: async (_s, _c, t) => void posts.push(`worker:${t}`),
  alert: async (_s, _c, t) => void alerts.push(t),
  post: async (_s, _c, md) => (posts.push(`post:${md}`), [1]),
  markHooked: () => {},
  permissionDecided: () => {},
});
afterAll(() => server.stop(true));

const call = (path: string, body: Record<string, unknown>, opts: { secret?: string; host?: string } = {}) =>
  fetch(`http://127.0.0.1:47397${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-arch-secret": opts.secret ?? SECRET, ...(opts.host ? { host: opts.host } : {}) },
    body: JSON.stringify(body),
  });
const base = { session_id: "s1", cwd: dir, transcript_path: join(dir, "none.jsonl") };

beforeEach(() => {
  asked.length = 0;
  briefs.length = 0;
  alerts.length = 0;
  posts.length = 0;
  confirmReply = "yes";
  process.env.ARCH_FORCE_PRESENCE = "away";
});

describe("доступ", () => {
  test("без секрета и с чужим Host — 403", async () => {
    expect((await call("/hook/any/permission", base, { secret: "x" })).status).toBe(403);
    expect((await call("/hook/any/permission", base, { host: "evil.example:47397" })).status).toBe(403);
  });
});

describe("разрешения любой сессии", () => {
  test("владелец за Mac — сразу «решай в терминале», в Telegram ничего", async () => {
    process.env.ARCH_FORCE_PRESENCE = "present";
    const r: any = await (await call("/hook/any/permission", { ...base, tool_name: "Bash", tool_input: { command: "rm -rf build-old" } })).json();
    expect(r).toEqual({});
    expect(asked.length).toBe(0);
  });

  test("отошёл — кнопка в Telegram, «Разрешить» → allow", async () => {
    const r: any = await (await call("/hook/any/permission", { ...base, tool_name: "Bash", tool_input: { command: "rm -rf build-old" } })).json();
    expect(asked).toEqual(["rm -rf build-old"]);
    expect(r.hookSpecificOutput.decision.behavior).toBe("allow");
  });

  test("вернулся к Mac, пока ждали — запрос уходит обратно в терминал", async () => {
    confirmReply = "wait";
    const p = call("/hook/any/permission", { ...base, tool_name: "Bash", tool_input: { command: "git push origin main" } }).then((x) => x.json());
    await Bun.sleep(100);
    fireReturn();
    expect(await p).toEqual({});
  });
});

describe("вопрос в конце хода", () => {
  test("обычная сессия ждёт — ход держится, ответ владельца уходит репликой", async () => {
    const p = call("/hook/any/stop", { ...base, session_id: "s2", last_assistant_message: "Какой вариант шапки выбрать?" }).then((x) => x.json());
    await Bun.sleep(150);
    expect(stopHolds.has("s2")).toBe(true);
    expect(posts.some((x) => x.startsWith("question:Какой вариант шапки"))).toBe(true); // вопрос — архитектору на суждение, не сырой текст владельцу
    stopHolds.answer("s2", "второй");
    const r: any = await p;
    expect(r.decision).toBe("block");
    expect(r.reason).toContain("второй");
  });

  test("отчёт без вопроса — тишина: не держим и никуда не пересылаем", async () => {
    const r: any = await (await call("/hook/any/stop", { ...base, session_id: "s3", last_assistant_message: "Проверено: тесты проходят, ветка запушена." })).json();
    expect(r).toEqual({});
    expect(posts.some((x) => x.includes("Проверено"))).toBe(false);
  });

  test("ошибка лимита или API — тишина, даже если похожа на вопрос", async () => {
    const r: any = await (await call("/hook/any/stop", { ...base, session_id: "s3b", last_assistant_message: "You've hit your weekly limit · resets Oct 24, 3am. Continue?" })).json();
    expect(r).toEqual({});
    expect(stopHolds.has("s3b")).toBe(false);
    expect(posts.some((x) => x.includes("weekly limit"))).toBe(false);
  });

  test("ответ для занятой сессии ждёт в очереди и уходит на её остановке", async () => {
    outbox.push("s4", "сделай вариант Б");
    const r: any = await (await call("/hook/any/stop", { ...base, session_id: "s4", last_assistant_message: "Шаг 3 сделан." })).json();
    expect(r.decision).toBe("block");
    expect(r.reason).toContain("сделай вариант Б");
  });

  test("сессия с целью: первый вопрос — не держим; тот же вопрос снова (крутится) — держим до ответа", async () => {
    const q = { ...base, session_id: "s5", stop_hook_active: true, last_assistant_message: "Жду вашего «принято»?" };
    expect(await (await call("/hook/any/stop", q)).json()).toEqual({});
    const p = call("/hook/any/stop", q).then((x) => x.json());
    await Bun.sleep(150);
    expect(stopHolds.has("s5")).toBe(true);
    fireReturn(); // вернулся к Mac — отпускаем
    expect(await p).toEqual({});
  });
});

describe("бриф и один голос", () => {
  test("запрос разрешения уходит с инструментом, входом и папкой — из них собирается бриф", async () => {
    await (await call("/hook/any/permission", { ...base, tool_name: "Bash", tool_input: { command: "rm -rf build-old", description: "Remove old build" } })).json();
    expect(briefs[0]).toEqual({ tool: "Bash", cwd: dir, input: { command: "rm -rf build-old", description: "Remove old build" } });
  });

  test("«Сначала покажи» — запрос снят с просьбой для сессии, а не с отказом", async () => {
    confirmReply = { tell: "сначала сними кандидата" };
    const r: any = await (await call("/hook/any/permission", { ...base, tool_name: "Bash", tool_input: { command: "git push origin main" } })).json();
    expect(r.hookSpecificOutput.decision).toEqual({ behavior: "deny", message: "сначала сними кандидата" });
  });

  test("ход оборвался ошибкой API — тревога архитектору с типом ошибки; упор в лимит — никому", async () => {
    writeFileSync(join(STATE, "workers.json"), JSON.stringify({ w1: { id: "w1", sessionId: "w1", name: "w", cwd: dir, task: "t", model: "opus", startedAt: 0 } }));
    await (await call("/hook/stopfail", { ...base, session_id: "w1", error: "rate_limit", last_assistant_message: "API Error: Rate limit reached" })).json();
    expect(alerts).toEqual([]);
    await (await call("/hook/stopfail", { ...base, session_id: "w1", error: "overloaded", error_details: "529" })).json();
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain("overloaded");
  });
});

describe("archi ask", () => {
  test("кнопка владельцу; ответ — в теле", async () => {
    confirmReply = "no";
    const r: any = await (await call("/hook/ask", { source: "скрипт", action: "git push origin build:main" })).json();
    expect(r.decision).toBe("no");
  });
});
