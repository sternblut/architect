// Владелец за Mac? Судим по простою клавиатуры и мыши (HIDIdleTime): пока он за экраном, телефон не дёргаем тем, что он и так видит.
// Вернулся к Mac — всё, что ждало его ответа в Telegram, отпускается обратно в терминал.
import { run } from "./util";

let cache = { at: 0, idle: 0 };

export async function idleSeconds(): Promise<number> {
  if (Date.now() - cache.at < 4000) return cache.idle;
  const r = await run(["/bin/sh", "-c", "ioreg -c IOHIDSystem -d 4 | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}'"], { timeoutMs: 5000 });
  const idle = Number(r.stdout.trim());
  cache = { at: Date.now(), idle: Number.isFinite(idle) ? idle : 0 };
  return cache.idle;
}

export const AWAY_AFTER_S = 180;

export async function ownerAway(): Promise<boolean> {
  if (process.env.ARCH_FORCE_PRESENCE) return process.env.ARCH_FORCE_PRESENCE === "away"; // только для тестов
  return (await idleSeconds()) >= AWAY_AFTER_S;
}

const returnCbs: (() => void)[] = [];
let wasAway = false;

export function onReturn(cb: () => void) {
  returnCbs.push(cb);
}

export function fireReturn() {
  for (const cb of returnCbs) cb();
}

export function startPresenceWatch() {
  setInterval(async () => {
    const idle = await idleSeconds();
    if (idle >= AWAY_AFTER_S) wasAway = true;
    else if (wasAway && idle < 20) {
      wasAway = false;
      fireReturn();
    }
  }, 5000);
}
