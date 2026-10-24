// Обещания архитектора владельцу («проверю и пришлю») — записи у хоста со сроком: иначе после сброса лимита, обрыва
// связи и /new обещанное теряется. Запись живёт у хоста: переживает и перезапуск, и новую сессию архитектора.
import { join } from "node:path";
import { STATE } from "./config";
import { readJson, writeJson } from "./util";

export type Promised = {
  id: string;
  what: string; // что обещал, его словами
  given: number;
  due: number; // время напоминания; с session — крайний срок
  session?: string; // напомнить, когда эта сессия закончит ход
  name?: string;
  told?: boolean; // владельцу уже сказано, что выполнить пока не могу
};

const FILE = join(STATE, "promises.json");
let all: Promised[] = readJson(FILE, []);
const save = () => writeJson(FILE, all);

export const promises = {
  list: (): readonly Promised[] => all,
  add(p: Pick<Promised, "what" | "due" | "session" | "name">): Promised {
    const x = { ...p, id: Math.random().toString(36).slice(2, 8), given: Date.now() };
    all.push(x);
    save();
    return x;
  },
  // сессия закончила ход — её обещания пора выполнить
  takeForSession(sessionId: string): Promised[] {
    return take((p) => p.session === sessionId);
  },
  takeDue(now = Date.now()): Promised[] {
    return take((p) => p.due <= now);
  },
  // выполнить пока некому (лимит, вход в Claude) — вернутся к сроку
  postpone(ps: Promised[], due: number) {
    all.push(...ps.map((p) => ({ ...p, due, told: true })));
    save();
  },
};

function take(f: (p: Promised) => boolean): Promised[] {
  const out = all.filter(f);
  if (out.length) {
    all = all.filter((p) => !f(p));
    save();
  }
  return out;
}

// «09:30» — ближайшие 09:30 по часам Mac: сегодня, если ещё не наступило, иначе завтра
export function nextAt(hm: string, now = Date.now()): number {
  const [h, m] = hm.split(":").map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}
