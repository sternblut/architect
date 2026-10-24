// Суждения о сессиях при кончившемся лимите Claude ждут его сброса: иначе круг каждые 2 минуты поднимает Claude
// на каждую сессию и получает отказ, до 60 раз в час.
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

test("кончился лимит — суждения ждут его сброса: ни другие сессии, ни следующие круги, ни утренний итог Claude не поднимают", async () => {
  await refresh([row("a"), row("b")]);
  expect(calls).toBe(1);
  await refresh([row("a"), row("b")]);
  await judgeNow([row("a"), row("b")]);
  expect(calls).toBe(1);
});
