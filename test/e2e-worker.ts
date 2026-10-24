// Живая проверка рабочих хуков на настоящей фоновой сессии Claude Code.
// Запуск: ARCH_STATE_DIR=<пустая папка> ARCH_HOOK_PORT=47391 bun test/e2e-worker.ts
// Telegram не нужен: решения владельца отвечает заглушка, всё остальное — настоящие модули хоста.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARCH_HOME, STATE, TEST_HOME, ensureDirs } from "../src/config";
import { startHookServer } from "../src/hookserver";
import { deliver, listAgents, outbox, readTail, setClaudeBin, startWorker, stopSession, transcriptPath, writeWorkerSettings } from "../src/sessions";
import { run } from "../src/util";

if (!process.env.ARCH_STATE_DIR) throw new Error("задайте ARCH_STATE_DIR — тест не трогает настоящее состояние");
ensureDirs();
const secret = "e2e-" + crypto.randomUUID();
writeFileSync(join(STATE, "hook-secret"), secret, { mode: 0o600 });
const claude = Bun.which("claude")!;
setClaudeBin(claude);
writeWorkerSettings(secret, process.execPath);

const events: string[] = [];
const approvals = {
  confirm: async (o: { action: string }) => {
    events.push(`confirm:${o.action}`);
    return "yes" as const;
  },
  ask: async (o: { questions: { question: string; options?: { label: string }[] }[] }) => {
    events.push(`ask:${o.questions.map((q) => q.question).join("|")}`);
    return Object.fromEntries(o.questions.map((q) => [q.question, q.options?.[1]?.label ?? "B"]));
  },
};
const turns: string[] = [];
const server = startHookServer(secret, approvals as never, {
  label: (s) => `test ${s.slice(0, 6)}`,
  threadFor: async () => undefined,
  turnEnded: async (_s, _c, t) => void turns.push(t),
  sessionQuestion: async () => {},
  workerTurn: async (_s, _c, t) => void turns.push(t),
  alert: async (_s, _c, t) => void events.push(`alert:${t}`),
  post: async () => [],
  markHooked: () => {},
  permissionDecided: () => {},
});

const task = [
  "Это автоматическая проверка связи хоста. Выполни строго по шагам, каждый шаг — отдельным вызовом инструмента:",
  "1) Bash: echo arch-e2e-ok",
  "2) Bash: rm -f ./arch-e2e-no-such-file.txt",
  "3) Bash: scp ./README.md test@example.com:/tmp/  (если команда будет запрещена — это ожидаемо, просто переходи дальше)",
  "4) Задай мне вопрос инструментом AskUserQuestion: вопрос «Какой вариант?», варианты A и B.",
  "5) Bash: echo arch-e2e-final",
  "6) Ответь одной строкой: какой вариант я выбрал и какие сообщения владельца ты получил по ходу (дословно).",
].join("\n");

const w = await startWorker({ folder: TEST_HOME, task, name: "arch-e2e", model: "sonnet", effort: "high", remote: false });
console.log("запущена", w.id, w.sessionId);
outbox.push(w.sessionId, "ЛИМОН");

const deadline = Date.now() + 240_000;
let row;
while (Date.now() < deadline) {
  await Bun.sleep(4000);
  row = (await listAgents(true)).find((r) => r.id === w.id);
  if (turns.length && (row?.state === "done" || row?.state === "blocked") && row?.status !== "busy") break;
}
// Второй ход: владелец отвечает простаивающей сессии — хост будит её. Шлагбаум обязан остаться после пробуждения.
const turnsBefore = turns.length;
const res = row ? await deliver(row, "Второй ход. Выполни Bash: rm -f ./arch-e2e-second.txt — и ответь одной строкой: ВТОРОЙ-ХОД-ОК") : { ok: false, how: "failed", note: "нет строки" };
console.log("доставка второго хода:", res);
const deadline2 = Date.now() + 180_000;
while (Date.now() < deadline2) {
  await Bun.sleep(4000);
  row = (await listAgents(true)).find((r) => r.sessionId === w.sessionId);
  if (turns.length > turnsBefore && row?.status !== "busy") break;
}
const tr = readTail(transcriptPath(w.cwd, w.sessionId));
const flat = JSON.stringify(tr);
const checks: [string, boolean][] = [
  ["безобидная команда прошла без вопроса", !events.some((e) => e.includes("echo arch-e2e-ok"))],
  ["удаление спросило владельца", events.some((e) => e.startsWith("confirm:") && e.includes("rm -f"))],
  ["хостинг запрещён шлагбаумом", flat.includes("Шлагбаум архитектора")],
  ["вопрос с вариантами дошёл до владельца", events.some((e) => e.startsWith("ask:") && e.includes("Какой вариант"))],
  ["ответ «B» вернулся в сессию", turns.join("\n").includes("B")],
  ["сообщение владельца «ЛИМОН» доставлено", turns.join("\n").includes("ЛИМОН") || flat.includes("ЛИМОН")],
  ["итог хода пришёл хуком Stop", turns.length > 0],
  ["ответ владельца разбудил простаивающую сессию", res.ok && res.how === "resumed"],
  ["после пробуждения шлагбаум на месте: удаление снова спросило", events.some((e) => e.startsWith("confirm:") && e.includes("arch-e2e-second"))],
  ["второй ход дошёл до владельца", turns.slice(turnsBefore).join("\n").includes("ВТОРОЙ-ХОД-ОК")],
];
for (const [name, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${name}`);
console.log("события:", events);
console.log("итоги ходов:", turns.map((t) => t.slice(0, 200)));
// уборка: все сессии этого теста (после пробуждения у разговора мог смениться короткий id)
for (const r of (await listAgents(true)).filter((x) => x.name === "arch-e2e" && x.id)) {
  await stopSession(r.id!);
  await run([claude, "rm", r.id!]);
}
server.stop(true);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
