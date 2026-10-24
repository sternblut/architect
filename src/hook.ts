// Hook of the sessions the architect starts. On PreToolUse the policy gate runs right here, without the host,
// so irreversible steps still ask while the host is off. From the host come the owner's answers to
// AskUserQuestion and messages for a busy session.
import { ARCH_HOME, config } from "./config";
import { readHookSecret } from "./secret";
import { classifyTool, gitBranchSync } from "./policy";

type HookInput = { session_id: string; cwd: string; tool_name: string; tool_input: Record<string, unknown>; hook_event_name: string };
type HostReply = { additionalContext?: string; answers?: Record<string, string> };

function print(o: unknown) {
  if (o) process.stdout.write(JSON.stringify(o));
  process.exit(0);
}

async function askHost(input: HookInput, waitMs: number): Promise<HostReply> {
  try {
    const secret = readHookSecret();
    const res = await fetch(`http://127.0.0.1:${config.hookPort}/hook/pre`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-arch-secret": secret },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(waitMs),
    });
    return res.ok ? ((await res.json()) as HostReply) : {};
  } catch {
    return {};
  }
}

const input = (await Bun.stdin.json()) as HookInput;

// Other events (permissions, turn ends, failures, notifications) go to the host as they are; no answer, no effect
if (input.hook_event_name !== "PreToolUse") {
  const route = ({ PermissionRequest: "permission", Stop: "stop", StopFailure: "stopfail", Notification: "notify" } as Record<string, string>)[input.hook_event_name];
  if (!route) print(null);
  const wait = route === "permission" ? 6 * 3600_000 - 60_000 : route === "stop" ? 55_000 : 10_000;
  setTimeout(() => print(null), wait + 5000);
  try {
    const res = await fetch(`http://127.0.0.1:${config.hookPort}/hook/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-arch-secret": readHookSecret() },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(wait),
    });
    print(res.ok ? await res.json() : null);
  } catch {
    print(null);
  }
}

const isQuestion = input.tool_name === "AskUserQuestion";
setTimeout(() => print(null), isQuestion ? 6 * 3600_000 : 20_000); // never hang the session

const verdict = classifyTool(input.tool_name, input.tool_input ?? {}, {
  cwd: input.cwd,
  archHome: ARCH_HOME,
  hostingPattern: config.hostingPattern,
  spendPattern: config.spendPattern,
  keychainService: config.keychainService,
  branch: gitBranchSync,
  ask: config.ask,
});
const out = (o: Record<string, unknown>) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", ...o } });

if (verdict.decision === "deny") print(out({ permissionDecision: "deny", permissionDecisionReason: `Шлагбаум архитектора: ${verdict.reason}. Не обходи и не проси других сделать это.` }));

const host = await askHost(input, isQuestion ? 6 * 3600_000 - 60_000 : 5000);

if (isQuestion && host.answers) print(out({ permissionDecision: "allow", updatedInput: { ...input.tool_input, answers: host.answers } }));
if (verdict.decision === "ask")
  print(out({ permissionDecision: "ask", permissionDecisionReason: `Нужно «да» владельца в Telegram: ${verdict.reason}`, ...(host.additionalContext ? { additionalContext: host.additionalContext } : {}) }));
if (host.additionalContext) print(out({ additionalContext: host.additionalContext }));
print(null);
