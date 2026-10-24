// Live check of the shared hook on a real interactive Claude Code session in tmux, like one the owner started.
// Run: bun test/e2e-any.ts   (needs tmux; Telegram is stubbed and the owner is forced "away")
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "arch-any-"));
const PORT = 47394;
process.env.ARCH_STATE_DIR = dir;
process.env.ARCH_LOGS_DIR = dir;
process.env.ARCH_HOOK_PORT = String(PORT);
process.env.ARCH_FORCE_PRESENCE = "away";
const { ARCH_HOME, ensureDirs } = await import("../src/config");
ensureDirs();
const { startHookServer } = await import("../src/hookserver");
const { stopHolds } = await import("../src/holds");
const { fireReturn } = await import("../src/presence");
const { run } = await import("../src/util");

const secret = "any-" + crypto.randomUUID();
writeFileSync(join(dir, "hook-secret"), secret, { mode: 0o600 });
writeFileSync(join(dir, "host.pid"), String(process.pid));
writeFileSync(join(dir, "owner.json"), JSON.stringify({ id: 1 })); // the hook stays silent until an owner is paired

const events: string[] = [];
let confirms = 0;
const approvals = {
  confirm: (o: { action: string; signal?: AbortSignal }) =>
    new Promise<"yes" | "no" | "timeout">((resolve) => {
      confirms++;
      events.push(`confirm:${o.action}`);
      if (confirms === 1) return setTimeout(() => resolve("yes"), 500); // "Allow" from the phone
      o.signal?.addEventListener("abort", () => (events.push(`released:${o.signal?.reason}`), resolve("timeout"))); // the second waits for the owner's return
    }),
  ask: async (o: { questions: { question: string; options?: { label: string }[] }[] }) => {
    events.push(`ask:${o.questions.map((q) => q.question).join("|")}`);
    return Object.fromEntries(o.questions.map((q) => [q.question, q.options?.[1]?.label ?? "B"]));
  },
};
const posts: string[] = [];
const server = startHookServer(secret, approvals as never, {
  label: (s) => `test ${s.slice(0, 6)}`,
  threadFor: async () => undefined,
  sessionQuestion: async (_s, _c, t) => void posts.push(`question:${t}`),
  workerTurn: async (_s, _c, t) => void posts.push(`worker:${t}`),
  alert: async (_s, _c, t) => void posts.push(`alert:${t}`),
  markHooked: () => {},
  permissionDecided: () => {},
});

// A test gate: commands containing any-ask need permission, so the terminal shows a request to decide
const gate = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT + 1,
  async fetch(req) {
    const b = (await req.json()) as { tool_name: string; tool_input: { command?: string } };
    if (b.tool_name === "Bash" && String(b.tool_input?.command).includes("any-ask")) return Response.json({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "опыт" } });
    return Response.json({});
  },
});

const hook = `ARCH_STATE_DIR='${dir}' ARCH_HOOK_PORT=${PORT} '${process.execPath}' '${join(ARCH_HOME, "src", "anyhook.ts")}'`;
const settings = join(dir, "settings.json");
writeFileSync(
  settings,
  JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "http", url: `http://127.0.0.1:${PORT + 1}/`, timeout: 30 }] },
        { matcher: "AskUserQuestion", hooks: [{ type: "command", command: hook, timeout: 600 }] },
      ],
      PermissionRequest: [{ hooks: [{ type: "command", command: hook, timeout: 600 }] }],
      Stop: [{ hooks: [{ type: "command", command: hook, timeout: 600 }] }],
    },
  }),
);

const task =
  "Автоматическая проверка. Строго по шагам, каждый шаг — отдельным вызовом инструмента: " +
  "1) Bash: echo any-ask-1  2) спроси меня AskUserQuestion: вопрос «Какой цвет?», варианты Красный и Синий  " +
  "3) закончи ход одним вопросом мне: «Какое слово написать?» — и остановись.";
const cwd = join(ARCH_HOME, "test");
await run(["tmux", "kill-session", "-t", "arch-any"]);
// The environment goes in the command: a tmux server started with another environment would send the shared hook to the real host
await run(["tmux", "new-session", "-d", "-s", "arch-any", "-x", "160", "-y", "45", "-c", cwd, `ARCH_STATE_DIR='${dir}' ARCH_HOOK_PORT=${PORT} claude --settings '${settings}' --model sonnet -n arch-any-e2e "${task}"`]);
const pane = async () => (await run(["tmux", "capture-pane", "-t", "arch-any", "-p"])).stdout;
const until = async (cond: () => boolean | Promise<boolean>, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await Bun.sleep(1000);
  }
  return false;
};

// Step 3: the session asks; hold the turn and answer "from the phone"
const held = await until(() => stopHolds.all().length > 0, 150_000);
if (held) {
  await Bun.sleep(1500);
  stopHolds.answer(stopHolds.all()[0], "Напиши одно слово: СЛИВА, затем выполни Bash: echo any-ask-2");
}
// The second permission request waits for the phone; the owner "returns to the Mac", so it must go back to the terminal
await until(() => confirms >= 2, 90_000);
await Bun.sleep(2000);
fireReturn();
const dialog = await until(async () => /Do you want to proceed/.test(await pane()), 30_000);
if (dialog) await run(["tmux", "send-keys", "-t", "arch-any", "Enter"]);
await until(async () => /СЛИВА/.test(await pane()), 60_000);
await Bun.sleep(3000);
const screen = await pane();

const checks: [string, boolean][] = [
  ["a Terminal session's permission request reached the phone and was allowed there", events.some((e) => e === "confirm:echo any-ask-1") && /Allowed by PermissionRequest hook/.test(screen + (await run(["tmux", "capture-pane", "-t", "arch-any", "-p", "-S", "-200"])).stdout)],
  ["a multiple-choice question was answered from the phone", events.some((e) => e.startsWith("ask:Какой цвет"))],
  ["the end-of-turn question went to the architect and the turn was held", held && posts.some((p) => p.startsWith("question:") && p.includes("Какое слово"))],
  ["session reports are not forwarded to the owner", !posts.some((p) => p.startsWith("turn:"))],
  ["the answer from the phone arrived as a message: the session wrote СЛИВА", /СЛИВА/.test(screen)],
  ["back at the Mac, the request went to the terminal", events.some((e) => e.startsWith("released:Решите на Mac")) && dialog],
];
for (const [name, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${name}`);
console.log("events:", events);
console.log("messages to the owner:", posts.map((p) => p.slice(0, 120)));
await run(["tmux", "kill-session", "-t", "arch-any"]);
server.stop(true);
gate.stop(true);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
