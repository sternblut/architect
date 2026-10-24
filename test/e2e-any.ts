// Живая проверка общего хука на настоящей интерактивной сессии Claude Code в tmux — как сессия, которую владелец запустил сам.
// Запуск: bun test/e2e-any.ts   (нужен tmux; Telegram заглушён, «владелец отошёл» — принудительно)
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
writeFileSync(join(dir, "owner.json"), JSON.stringify({ id: 1 })); // хук молчит, пока Telegram не привязан к владельцу

const events: string[] = [];
let confirms = 0;
const approvals = {
  confirm: (o: { action: string; signal?: AbortSignal }) =>
    new Promise<"yes" | "no" | "timeout">((resolve) => {
      confirms++;
      events.push(`confirm:${o.action}`);
      if (confirms === 1) return setTimeout(() => resolve("yes"), 500); // «Разрешить» с телефона
      o.signal?.addEventListener("abort", () => (events.push(`released:${o.signal?.reason}`), resolve("timeout"))); // второй — ждём, пока «владелец вернётся»
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
  turnEnded: async (_s, _c, t) => void posts.push(`turn:${t}`),
  sessionQuestion: async (_s, _c, t) => void posts.push(`question:${t}`),
  workerTurn: async (_s, _c, t) => void posts.push(`worker:${t}`),
  alert: async (_s, _c, t) => void posts.push(`alert:${t}`),
  post: async (_s, _c, md) => (posts.push(`post:${md}`), [1]),
  markHooked: () => {},
  permissionDecided: () => {},
});

// «Шлагбаум» опыта: команды с any-ask требуют разрешения — так в терминале появляется запрос, который надо решить
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
// окружение — явно в команде: если tmux уже запущен с чужим окружением, общий хук из ~/.claude/settings.json пошёл бы в настоящий хост
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

// шаг 3: сессия спрашивает — держим ход, отвечаем «с телефона»
const held = await until(() => stopHolds.all().length > 0, 150_000);
if (held) {
  await Bun.sleep(1500);
  stopHolds.answer(stopHolds.all()[0], "Напиши одно слово: СЛИВА, затем выполни Bash: echo any-ask-2");
}
// второй запрос разрешения ждёт «телефона», владелец «возвращается к Mac» — запрос должен уйти в терминал
await until(() => confirms >= 2, 90_000);
await Bun.sleep(2000);
fireReturn();
const dialog = await until(async () => /Do you want to proceed/.test(await pane()), 30_000);
if (dialog) await run(["tmux", "send-keys", "-t", "arch-any", "Enter"]);
await until(async () => /СЛИВА/.test(await pane()), 60_000);
await Bun.sleep(3000);
const screen = await pane();

const checks: [string, boolean][] = [
  ["разрешение терминальной сессии пришло «на телефон» и разрешено оттуда", events.some((e) => e === "confirm:echo any-ask-1") && /Allowed by PermissionRequest hook/.test(screen + (await run(["tmux", "capture-pane", "-t", "arch-any", "-p", "-S", "-200"])).stdout)],
  ["вопрос с вариантами отвечен «с телефона»", events.some((e) => e.startsWith("ask:Какой цвет"))],
  ["вопрос в конце хода ушёл архитектору на суждение и ход удержан", held && posts.some((p) => p.startsWith("question:") && p.includes("Какое слово"))],
  ["отчёты сессии владельцу не пересылаются", !posts.some((p) => p.startsWith("turn:"))],
  ["ответ «с телефона» дошёл как реплика — сессия написала СЛИВА", /СЛИВА/.test(screen)],
  ["вернулся к Mac — запрос ушёл в терминал", events.some((e) => e.startsWith("released:Решите на Mac")) && dialog],
];
for (const [name, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${name}`);
console.log("события:", events);
console.log("сообщения владельцу:", posts.map((p) => p.slice(0, 120)));
await run(["tmux", "kill-session", "-t", "arch-any"]);
server.stop(true);
gate.stop(true);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
