// The hook server for all sessions on the Mac (/hook/any/*), without Claude: presence, holds, return to the Mac, queued answers.
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
config.hookPort = 47397; // set explicitly, away from the real host (47300)
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
  sessionQuestion: async (_s, _c, t) => void posts.push(`question:${t}`),
  workerTurn: async (_s, _c, t) => void posts.push(`worker:${t}`),
  alert: async (_s, _c, t) => void alerts.push(t),
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

describe("access", () => {
  test("no secret or a foreign Host header: 403", async () => {
    expect((await call("/hook/any/permission", base, { secret: "x" })).status).toBe(403);
    expect((await call("/hook/any/permission", base, { host: "evil.example:47397" })).status).toBe(403);
  });
});

describe("permissions of any session", () => {
  test("owner at the Mac: the terminal decides at once, nothing in Telegram", async () => {
    process.env.ARCH_FORCE_PRESENCE = "present";
    const r: any = await (await call("/hook/any/permission", { ...base, tool_name: "Bash", tool_input: { command: "rm -rf build-old" } })).json();
    expect(r).toEqual({});
    expect(asked.length).toBe(0);
  });

  test("owner away: a button in Telegram, Allow → allow", async () => {
    const r: any = await (await call("/hook/any/permission", { ...base, tool_name: "Bash", tool_input: { command: "rm -rf build-old" } })).json();
    expect(asked).toEqual(["rm -rf build-old"]);
    expect(r.hookSpecificOutput.decision.behavior).toBe("allow");
  });

  test("back at the Mac while waiting: the request returns to the terminal", async () => {
    confirmReply = "wait";
    const p = call("/hook/any/permission", { ...base, tool_name: "Bash", tool_input: { command: "git push origin main" } }).then((x) => x.json());
    await Bun.sleep(100);
    fireReturn();
    expect(await p).toEqual({});
  });
});

describe("a question at the end of a turn", () => {
  test("a plain session waits: the turn is held and the owner's answer goes back as a message", async () => {
    const p = call("/hook/any/stop", { ...base, session_id: "s2", last_assistant_message: "Какой вариант шапки выбрать?" }).then((x) => x.json());
    await Bun.sleep(150);
    expect(stopHolds.has("s2")).toBe(true);
    expect(posts.some((x) => x.startsWith("question:Какой вариант шапки"))).toBe(true); // to the architect, not raw to the owner
    stopHolds.answer("s2", "второй");
    const r: any = await p;
    expect(r.decision).toBe("block");
    expect(r.reason).toContain("второй");
  });

  test("a report without a question: not held, not forwarded", async () => {
    const r: any = await (await call("/hook/any/stop", { ...base, session_id: "s3", last_assistant_message: "Проверено: тесты проходят, ветка запушена." })).json();
    expect(r).toEqual({});
    expect(posts.some((x) => x.includes("Проверено"))).toBe(false);
  });

  test("a limit or API error stays silent even when it looks like a question", async () => {
    const r: any = await (await call("/hook/any/stop", { ...base, session_id: "s3b", last_assistant_message: "You've hit your weekly limit · resets Oct 24, 3am. Continue?" })).json();
    expect(r).toEqual({});
    expect(stopHolds.has("s3b")).toBe(false);
    expect(posts.some((x) => x.includes("weekly limit"))).toBe(false);
  });

  test("an answer for a busy session waits in the queue and goes at its stop", async () => {
    outbox.push("s4", "сделай вариант Б");
    const r: any = await (await call("/hook/any/stop", { ...base, session_id: "s4", last_assistant_message: "Шаг 3 сделан." })).json();
    expect(r.decision).toBe("block");
    expect(r.reason).toContain("сделай вариант Б");
  });

  test("a goal session: the first question isn't held, the same question again (spinning) is held until answered", async () => {
    const q = { ...base, session_id: "s5", stop_hook_active: true, last_assistant_message: "Жду вашего «принято»?" };
    expect(await (await call("/hook/any/stop", q)).json()).toEqual({});
    const p = call("/hook/any/stop", q).then((x) => x.json());
    await Bun.sleep(150);
    expect(stopHolds.has("s5")).toBe(true);
    fireReturn(); // back at the Mac: release
    expect(await p).toEqual({});
  });
});

describe("brief and alerts", () => {
  test("a permission request carries the tool, input and folder the brief is built from", async () => {
    await (await call("/hook/any/permission", { ...base, tool_name: "Bash", tool_input: { command: "rm -rf build-old", description: "Remove old build" } })).json();
    expect(briefs[0]).toEqual({ tool: "Bash", cwd: dir, input: { command: "rm -rf build-old", description: "Remove old build" } });
  });

  test("Show me first withdraws the request with a note for the session, not a refusal", async () => {
    confirmReply = { tell: "сначала сними кандидата" };
    const r: any = await (await call("/hook/any/permission", { ...base, tool_name: "Bash", tool_input: { command: "git push origin main" } })).json();
    expect(r.hookSpecificOutput.decision).toEqual({ behavior: "deny", message: "сначала сними кандидата" });
  });

  test("a turn cut by an API error alerts the architect with the error type; a rate limit alerts nobody", async () => {
    writeFileSync(join(STATE, "workers.json"), JSON.stringify({ w1: { id: "w1", sessionId: "w1", name: "w", cwd: dir, task: "t", model: "opus", startedAt: 0 } }));
    await (await call("/hook/stopfail", { ...base, session_id: "w1", error: "rate_limit", last_assistant_message: "API Error: Rate limit reached" })).json();
    expect(alerts).toEqual([]);
    await (await call("/hook/stopfail", { ...base, session_id: "w1", error: "overloaded", error_details: "529" })).json();
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain("overloaded");
  });
});

describe("archi ask", () => {
  test("asks the owner with a button and returns the answer in the body", async () => {
    confirmReply = "no";
    const r: any = await (await call("/hook/ask", { source: "скрипт", action: "git push origin build:main" })).json();
    expect(r.decision).toBe("no");
  });
});
