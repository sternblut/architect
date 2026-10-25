// Work that stopped on the Claude limit continues after the reset, once, and only where Claude Code itself didn't.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRow, Delivery, Entry } from "../src/sessions";

const dir = mkdtempSync(join(tmpdir(), "arch-limitwake-"));
process.env.ARCH_STATE_DIR = dir;
process.env.ARCH_LOGS_DIR = dir;
const { limitReset, wakeAfterLimit } = await import("../src/limitwake");
const { ARCH_NOTE } = await import("../src/sessions");

const RESET = 1791817200; // seconds, as Claude Code records it
const T = RESET * 1000;
const MIN = 60_000;
// the shape Claude Code 2.1.3xx writes when a turn hits the limit
const hit: Entry = {
  type: "assistant",
  error: "rate_limit",
  isApiErrorMessage: true,
  apiError: "usage_limit_reached",
  apiErrorParams: { rate_limit_info: { status: "rejected", resetsAt: RESET, rateLimitType: "five_hour" } },
  message: { role: "assistant", content: [{ type: "text", text: "You've hit your session limit · resets 6pm (Europe/Moscow)" }] },
};
const work: Entry = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Готово: тесты зелёные" }] } };
const paused: Entry = { type: "system", subtype: "informational", content: "Goal paused · usage limit reached · continues automatically when it resets" };

describe("the reset of a session stopped on the limit", () => {
  test("its last reply is the limit error: the reset Claude Code reported", () => {
    expect(limitReset([work, hit, paused])).toBe(T);
    expect(limitReset([work, { ...hit, apiErrorParams: undefined, quotaLimits: { resetsAt: RESET } }])).toBe(T);
  });

  test("it replied again since, or its user cancelled the automatic continue: nothing to do", () => {
    expect(limitReset([hit, { type: "user", message: { role: "user", content: "дальше" } }, work])).toBeUndefined();
    expect(limitReset([hit, { type: "system", subtype: "informational", content: "Automatic continue cancelled · /rate-limit-options to re-arm" }])).toBeUndefined();
    expect(limitReset([work])).toBeUndefined();
  });
});

describe("telling sessions to continue", () => {
  const live: AgentRow = { id: "a1", sessionId: "s-live", name: "Маяк", cwd: dir, kind: "background", startedAt: 0, status: "idle", pid: 7000 };
  let sent: [string, string][] = [];
  const send = async (r: AgentRow, text: string): Promise<Delivery> => {
    sent.push([r.sessionId!, text]);
    return { ok: true, how: "sent", note: "" };
  };
  const tails: Record<string, Entry[]> = {};
  const run = (rows: AgentRow[], now: number) => wakeAfterLimit(rows, { now, send, tail: (r) => tails[r.sessionId!] ?? [] });

  beforeEach(() => {
    writeFileSync(join(dir, "limit-wakes.json"), "{}");
    sent = [];
    tails["s-live"] = [work, hit, paused];
  });

  test("ten minutes after the reset it is told once, in a note that isn't the owner's words", async () => {
    expect(await run([live], T + 5 * MIN)).toEqual([]); // Claude Code's own continue still has time
    expect((await run([live], T + 11 * MIN)).map((r) => r.sessionId)).toEqual(["s-live"]);
    expect(sent).toEqual([["s-live", expect.stringContaining(ARCH_NOTE)]]);
    await run([live], T + 16 * MIN);
    expect(sent.length).toBe(1); // once per reset
  });

  test("a later limit hit is a new reset: told again after that one", async () => {
    await run([live], T + 11 * MIN);
    tails["s-live"] = [hit, { ...hit, apiErrorParams: { rate_limit_info: { resetsAt: RESET + 18_000 } } }];
    await run([live], T + 18_000_000 + 11 * MIN);
    expect(sent.length).toBe(2);
  });

  test("busy, long past, or the owner's stopped session: left alone", async () => {
    await run([{ ...live, status: "busy" }], T + 11 * MIN);
    await run([live], T + 7 * 3600_000);
    tails["s-own"] = [hit];
    await run([{ ...live, sessionId: "s-own", pid: undefined, state: "stopped" }], T + 11 * MIN);
    expect(sent).toEqual([]);
  });

  test("the architect's own stopped session is resumed", async () => {
    writeFileSync(join(dir, "workers.json"), JSON.stringify({ "s-worker": { id: "w1", sessionId: "s-worker", name: "Маяк", cwd: dir } }));
    tails["s-worker"] = [hit];
    await run([{ ...live, sessionId: "s-worker", pid: undefined, state: "stopped" }], T + 11 * MIN);
    expect(sent.map(([s]) => s)).toEqual(["s-worker"]);
  });
});
