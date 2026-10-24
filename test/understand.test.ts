// With the Claude limit out, session judgments wait for the reset instead of calling Claude for every session every
// two minutes only to be refused.
import { expect, mock, test } from "bun:test";
import type { AgentRow } from "../src/sessions";

let calls = 0;
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => {
    calls++;
    return (async function* () {
      yield { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600 } };
      yield { type: "result", subtype: "success", is_error: true, result: "You've hit your session limit" };
      throw new Error("Claude Code returned an error result: You've hit your session limit");
    })();
  },
}));
const { refresh, judgeNow } = await import("../src/understand");

const row = (id: string) => ({ sessionId: id, pid: 1, cwd: "/nonexistent", status: "idle", kind: "background" }) as unknown as AgentRow;

test("with the limit out no further session, pass or morning summary calls Claude until the reset", async () => {
  await refresh([row("a"), row("b")]);
  expect(calls).toBe(1);
  await refresh([row("a"), row("b")]);
  await judgeNow([row("a"), row("b")]);
  expect(calls).toBe(1);
});
