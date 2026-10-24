// Общий хук для всех сессий Claude Code на этом Mac (ставится в ~/.claude/settings.json командой `archi on`, снимается `archi off`).
// Пока владелец за Mac — хост сразу отвечает «решай в терминале», и сессия ведёт себя как обычно.
// Когда он отошёл — разрешения, вопросы с вариантами и вопросы в конце хода уходят ему в Telegram, его ответ возвращается в сессию.
// Хост выключен, не отвечает или упал — хук молча выходит, и Claude Code продолжает штатно.
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
  // сессии проверок настоящему хосту не пишут (у их собственного тестового хука задан ARCH_STATE_DIR)
  if (!process.env.ARCH_STATE_DIR && isTestCwd(String(input.cwd ?? ""))) done();
  // у сессий, запущенных архитектором, свои хуки (со шлагбаумом) — общий им не нужен
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
