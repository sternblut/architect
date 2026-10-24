// Что сказать владельцу, когда связь вернулась: бот молчал, его вопросы дошли пачкой, а о том, что стояли и сессии,
// без отчёта он узнает, только придя к Mac.
import { tr } from "./config";
import { listAgents, readTail, transcriptPath } from "./sessions";
import { displayName } from "./ui";

const NB = String.fromCharCode(0xa0);
// минуты отбрасываем, как Telegram у времени сообщения: с округлением отчёт в 22:05 сказал бы «Mac спал … до 22:06»
const hm = (t: number) => new Date(t).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); // по часам Mac, не московским
const FAILED = /API Error|Can't reach the API|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/;

export async function outageReport(from: number, to: number, why: "dns" | "telegram" | "sleep", tail = 400_000): Promise<string> {
  const rows = await listAgents(true).catch(() => []);
  const stood: string[] = [];
  const paused: string[] = [];
  for (const r of rows) {
    if (!r.sessionId) continue;
    const entries = readTail(transcriptPath(r.cwd, r.sessionId), tail);
    const during = entries.filter((e) => {
      const t = Date.parse(e.timestamp ?? "");
      return t >= from && t <= to && FAILED.test(JSON.stringify(e.message?.content ?? (e as { content?: unknown }).content ?? ""));
    });
    if (!during.length) continue;
    const name = displayName(r.sessionId, r.cwd, rows);
    stood.push(name);
    // цель сама не продолжит: «Goal paused after 3 automatic retries · send a message to continue», и после него ничего не было
    const last = entries.filter((e) => e.type === "assistant" || e.type === "system").at(-1);
    if (/Goal paused/i.test(JSON.stringify((last as { content?: unknown })?.content ?? ""))) paused.push(name);
  }
  // Mac спал: стояла вся работа на нём — так и сказать, без выдуманных причин и без «ни я, ни сессии»
  const span = tr(`с${NB}${hm(from)} до${NB}${hm(to)}`, `from${NB}${hm(from)} to${NB}${hm(to)}`);
  if (why === "sleep")
    return tr(
      [`Mac спал ${span} — работа стояла.`, "Что вы писали за это время, дошло только сейчас — отвечаю."],
      [`The Mac was asleep ${span}, so work was paused.`, "What you wrote during that time only just arrived — replying now."],
    ).join("\n");
  const head = why === "dns" ? tr(`**С${NB}${hm(from)} до${NB}${hm(to)} у Mac не было интернета.**`, `**The Mac had no internet ${span}.**`) : tr(`**С${NB}${hm(from)} до${NB}${hm(to)} Telegram был недоступен с Mac.**`, `**Telegram was unreachable from the Mac ${span}.**`);
  const lines = [head, tr("Что вы писали за это время, дошло до меня только сейчас — отвечаю.", "What you wrote during that time only just reached me — replying now.")];
  if (stood.length) lines.push(tr(`Без связи стояли и сессии: ${stood.join(", ")}.`, `Sessions were stuck without a connection too: ${stood.join(", ")}.`));
  if (paused.length) lines.push(tr(`${paused.join(" и ")} после сбоя сами не продолжат — напишите «продолжай», передам.`, `${paused.join(" and ")} won’t resume on their own after the failure — write “continue” and I’ll pass it on.`));
  return lines.join("\n");
}
