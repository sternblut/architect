// The architect's promises to the owner ("I'll check and send it"). The host keeps them with a due time, so they
// survive a restart, a usage limit and /new.
import { join } from "node:path";
import { STATE } from "./config";
import { readJson, writeJson } from "./util";

export type Promised = {
  id: string;
  what: string; // in the architect's words
  given: number;
  due: number; // reminder time; with session, the deadline
  session?: string; // remind when this session ends its turn
  name?: string;
  told?: boolean; // the owner already knows it is postponed
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
  takeForSession(sessionId: string): Promised[] {
    return take((p) => p.session === sessionId);
  },
  takeDue(now = Date.now()): Promised[] {
    return take((p) => p.due <= now);
  },
  // Nobody can act on them now (usage limit, Claude signed out): they return at `due`
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

// "09:30" → the next 09:30 local time: today if still ahead, otherwise tomorrow
export function nextAt(hm: string, now = Date.now()): number {
  const [h, m] = hm.split(":").map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}
