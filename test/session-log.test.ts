// session_log shows Mac local time: Claude Code transcripts store UTC, and the architect would look three hours off.
import { expect, test } from "bun:test";
import { conversation } from "../src/sessions";

const at = (daysAgo: number) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(21, 43, 0, 0); // 21:43 local time (Moscow in tests)
  return d.toISOString(); // UTC in the transcript: …T18:43:00.000Z
};
const said = (ts: string, text: string) => ({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }] } });

test("local times; yesterday's lines carry the date", () => {
  const rows = conversation([said(at(1), "Вчерашний итог"), said(at(0), "Сегодняшний итог")], 10);
  const y = new Date(Date.parse(at(1))).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
  expect(rows).toEqual([`[${y} 21:43] Claude: Вчерашний итог`, "[21:43] Claude: Сегодняшний итог"]);
});
