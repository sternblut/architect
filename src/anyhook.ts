// Shared hook for every Claude Code session on this Mac: `archi on` adds it to ~/.claude/settings.json, a plugin install
// registers it in hooks/hooks.json. While the owner is at the Mac the host answers at once and nothing changes. When they
// are away, permission requests, multiple-choice questions and end-of-turn questions go to Telegram and the answer comes
// back. If the host is off or fails, the hook exits silently.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE, config, isTestCwd } from "./config";
import { readHookSecret } from "./secret";

const done = (o?: unknown) => {
  if (o && typeof o === "object" && Object.keys(o).length) process.stdout.write(JSON.stringify(o));
  process.exit(0);
};

try {
  const input = (await Bun.stdin.json()) as { hook_event_name?: string; session_id?: string; tool_name?: string; cwd?: string };
  const route = input.hook_event_name === "PermissionRequest" ? "permission" : input.hook_event_name === "Stop" ? "stop" : input.hook_event_name === "PreToolUse" && input.tool_name === "AskUserQuestion" ? "question" : "";
  if (!route || !input.session_id || !existsSync(join(STATE, "host.pid"))) done();
  // test sessions never reach the real host; their own test hook sets ARCH_STATE_DIR
  if (!process.env.ARCH_STATE_DIR && isTestCwd(String(input.cwd ?? ""))) done();
  // sessions the architect started have their own hooks, with the policy gate
  let workers: Record<string, unknown> = {};
  try {
    workers = JSON.parse(readFileSync(join(STATE, "workers.json"), "utf8"));
  } catch {}
  if (workers[input.session_id!]) done();
  const secret = readHookSecret();
  if (!secret) done();
  const res = await fetch(`http://127.0.0.1:${config.hookPort}/hook/any/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-arch-secret": secret },
    body: JSON.stringify(input),
  });
  done(res.ok ? await res.json() : undefined);
} catch {
  done();
}
