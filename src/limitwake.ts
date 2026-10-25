// After a Claude usage-limit reset, the work that stopped on the limit goes on. Claude Code itself continues a waiting
// session at the reset, but not when the session was relaunched or exited during the wait, and we haven't seen it after
// a weekly reset. Every few minutes the host finds sessions whose last reply is still the limit error ten minutes past
// the reset Claude Code reported, and tells each one to continue, once per reset.
import { join } from "node:path";
import { STATE, tr } from "./config";
import { ARCH_NOTE, deliver, readTail, transcriptPath, workers, type AgentRow, type Delivery, type Entry } from "./sessions";
import { log, readJson, writeJson } from "./util";

const FILE = join(STATE, "limit-wakes.json");
const GRACE = 10 * 60_000; // Claude Code's own continue comes within a minute or two of the reset
const STALE = 6 * 3600_000; // a reset long past: the owner has seen it by now

// The reset in ms when the session's last reply is a usage-limit error, unless its user then cancelled the automatic
// continue in Claude Code
export function limitReset(tail: Entry[]): number | undefined {
  const i = tail.findLastIndex((e) => e.type === "assistant" && !e.isSidechain);
  const e = tail[i];
  if (e?.error !== "rate_limit") return;
  if (tail.slice(i + 1).some((x) => x.type === "system" && /Automatic continue cancelled/.test(String(x.content ?? "")))) return;
  const info = ((e.apiErrorParams as { rate_limit_info?: unknown } | undefined)?.rate_limit_info ?? e.quotaLimits) as { resetsAt?: number } | undefined;
  const at = Number(info?.resetsAt);
  return at > 0 ? (at < 1e12 ? at * 1000 : at) : undefined;
}

// Returns the sessions told to continue
export async function wakeAfterLimit(
  rows: AgentRow[],
  o: { now?: number; tail?: (r: AgentRow) => Entry[]; send?: (r: AgentRow, text: string) => Promise<Delivery> } = {},
): Promise<AgentRow[]> {
  const now = o.now ?? Date.now();
  const tail = o.tail ?? ((r: AgentRow) => readTail(transcriptPath(r.cwd, r.sessionId!), 200_000));
  const send = o.send ?? deliver;
  const told = readJson<Record<string, number>>(FILE, {}); // "<sessionId> <reset>" → when
  const woke: AgentRow[] = [];
  for (const r of rows) {
    if (!r.sessionId || r.status === "busy") continue;
    // a live session waits for the limit; a stopped one only if it is the architect's: the owner may have stopped his own
    if (!r.pid && !workers.get(r.sessionId)) continue;
    const at = limitReset(tail(r));
    const key = `${r.sessionId} ${at}`;
    if (!at || now < at + GRACE || now > at + STALE || told[key]) continue;
    told[key] = now;
    const res = await send(r, `${ARCH_NOTE}${tr("лимит Claude восстановился — продолжай с того места, где остановилась; сделанное не повторяй.", "the Claude usage limit has reset — continue from where you stopped; don't repeat what is done.")}`);
    log("limits", res.ok ? "после сброса лимита продолжила" : "после сброса лимита не продолжила", { sid: r.sessionId.slice(0, 8), how: res.how, note: res.note });
    if (res.ok) woke.push(r);
  }
  for (const [k, at] of Object.entries(told)) if (now - at > 8 * 86400_000) delete told[k];
  writeJson(FILE, told);
  return woke;
}
