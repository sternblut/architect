// The owner's words into a live session without restarting it. The host is not a Claude session and cannot call
// SendMessage itself, so each delivery runs a one-shot Agent SDK query on a small model whose only action is
// SendMessage to the session's process address. A PreToolUse hook writes the address and the words into that call
// itself: the model never sees the words, so it can neither change them nor be steered by what is forwarded. The
// session receives them in its live process, its window and background agents untouched.
// The courier runs in the default permission mode, the same class as every mode but bypassPermissions: a session
// that runs tools without asking holds messages from it for its user (Claude Code 2.1.3xx).
import { query, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { clip, log } from "./util";

// cwd: the session's own folder, which Claude Code already trusts
export type Courier = (pid: number, text: string, cwd: string) => Promise<boolean>;

// While it delivers, the courier is a session in the owner's folder: the host hides these from his session list, as it
// hides itself. Kept a minute past the delivery, while the process exits.
export const courierIds = new Set<string>();

export function makeCourier(o: { claudePath: string; model?: string }): Courier {
  return async (pid, text, cwd) => {
    const to = `uds:/tmp/cc-socks/${pid}.sock`;
    const gate: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      if (input.tool_name !== "SendMessage") return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "only SendMessage" } };
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { to, message: text, summary: "owner's words" } } };
    };
    const id = crypto.randomUUID();
    courierIds.add(id);
    const q = query({
      prompt: `Call the SendMessage tool exactly once with to = ${JSON.stringify(to)} and message = "-"; the host fills in the text. Do nothing else and write nothing.`,
      // SendMessage as the only tool: listed among others it is deferred, and the model would first try to load it.
      // persistSession: false — no conversation left behind in the owner's folder for /resume to list.
      options: {
        model: o.model ?? "haiku",
        tools: ["SendMessage"],
        thinking: { type: "disabled" },
        cwd,
        sessionId: id,
        persistSession: false,
        pathToClaudeCodeExecutable: o.claudePath,
        settingSources: [],
        maxTurns: 3,
        hooks: { PreToolUse: [{ hooks: [gate] }] },
      },
    });
    let delivered = false;
    let why = "no SendMessage call";
    try {
      for await (const m of q) {
        // the tool result says whether the message reached the session; nothing after it matters
        if (m.type === "user") {
          why = JSON.stringify(m.message?.content ?? "");
          delivered = why.includes('\\"success\\":true');
          break;
        }
        if (m.type === "result") break;
      }
    } catch (e) {
      why = String(e);
    } finally {
      setTimeout(() => courierIds.delete(id), 60_000);
    }
    if (!delivered) log("courier", "not delivered", clip(why, 300));
    return delivered;
  };
}
