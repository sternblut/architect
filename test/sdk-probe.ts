// Разведка: какие инструменты видит SDK-сессия, работает ли auto, доходит ли hook 'ask' до canUseTool.
import { query } from "@anthropic-ai/claude-agent-sdk";

const log: string[] = [];
const q = query({
  prompt: "Run exactly this Bash command and nothing else: echo probe-ok > /dev/null. Then reply with one word: done.",
  options: {
    cwd: process.cwd(),
    model: "sonnet",
    permissionMode: "auto",
    settingSources: ["project"],
    pathToClaudeCodeExecutable: (await Bun.$`which claude`.text()).trim(),
    hooks: {
      PreToolUse: [{ hooks: [async (input: any) => {
        log.push(`hook:${input.tool_name}`);
        if (input.tool_name === "Bash") return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "probe ask" } };
        return {};
      }] }],
    },
    canUseTool: async (name, input, opts) => {
      log.push(`canUseTool:${name}:${JSON.stringify(opts.decisionReason ?? null)}`);
      return { behavior: "allow", updatedInput: input };
    },
  },
});
for await (const m of q) {
  if (m.type === "system" && m.subtype === "init") {
    const t = (m as any).tools as string[];
    console.log("model", (m as any).model, "mode", (m as any).permissionMode, "apiKeySource", (m as any).apiKeySource);
    console.log("tools", t.join(","));
  }
  if (m.type === "result") console.log("result", m.subtype, (m as any).result?.slice?.(0, 80));
}
console.log(log.join("\n"));
