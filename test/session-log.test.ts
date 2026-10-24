// Ход сессии для архитектора (session_log): время — по часам Mac. Журнал Claude Code хранит UTC, и без этого архитектор
// искал бы «что делали около 20:59» на три часа раньше.
import { expect, test } from "bun:test";
import { conversation } from "../src/sessions";

const at = (daysAgo: number) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(21, 43, 0, 0); // 21:43 по часам Mac (в тестах — Москва)
  return d.toISOString(); // в журнале — UTC: …T18:43:00.000Z
};
const said = (ts: string, text: string) => ({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }] } });

test("время строк — по часам Mac; вчерашние — с датой", () => {
  const rows = conversation([said(at(1), "Вчерашний итог"), said(at(0), "Сегодняшний итог")], 10);
  const y = new Date(Date.parse(at(1))).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
  expect(rows).toEqual([`[${y} 21:43] Claude: Вчерашний итог`, "[21:43] Claude: Сегодняшний итог"]);
});
