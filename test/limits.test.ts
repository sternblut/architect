import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
process.env.ARCH_STATE_DIR = mkdtempSync(join(tmpdir(), "arch-limits-"));
const { recentEnd, weekWarning } = await import("../src/limits");
const { forecast } = await import("../src/status");

// темп около 3% в час: до сброса лимита не хватит
test("лимит кончится раньше сброса — предупреждаем один раз, со сроком и последствием", () => {
  const resets = "2026-10-24T01:59:59Z";
  const t0 = Date.parse("2026-10-20T06:15:00Z");
  expect(weekWarning({ week: 80, weekResets: resets }, t0)).toBeUndefined(); // темп по одной точке не понять
  const msg = weekWarning({ week: 89, weekResets: resets }, t0 + 3 * 3600_000 - 60_000)!;
  expect(msg).toMatch(/^\*\*Недельный лимит Claude кончится .*в.15:53\.\*\*/); // срок — первой строкой; от темпа, не от даты запуска
  expect(msg).toContain("Потрачено 89%");
  expect(msg).toContain("до сброса встанет вся работа, и мои ответы тоже");
  expect(msg).not.toContain("сказать мне"); // хост шлёт это сам, когда архитектор не отвечает
  expect(weekWarning({ week: 89.5, weekResets: resets }, t0 + 3 * 3600_000 + 6 * 60_000)).toBeUndefined(); // та же ступень — молчим
});

test("при спокойном темпе хватит до сброса — молчим", () => {
  const t0 = Date.parse("2026-11-20T06:00:00Z");
  const resets = new Date(t0 + 20 * 3600_000).toISOString(); // полпроцента в час: 14% хватит на 28 часов, сброс раньше
  weekWarning({ week: 85, weekResets: resets }, t0);
  expect(weekWarning({ week: 86, weekResets: resets }, t0 + 2 * 3600_000)).toBeUndefined();
});

test("сдвиг времени сброса на доли секунды — то же окно, второго предупреждения нет", () => {
  const t0 = Date.parse("2026-12-20T06:15:00Z");
  weekWarning({ week: 80, weekResets: "2026-12-24T01:59:59.530Z" }, t0);
  expect(weekWarning({ week: 99, weekResets: "2026-12-24T01:59:59.530Z" }, t0 + 3 * 3600_000 - 60_000)).toContain("99%");
  expect(weekWarning({ week: 99, weekResets: "2026-12-24T02:00:00.382Z" }, t0 + 3 * 3600_000 + 5 * 60_000)).toBeUndefined();
});

// ответ, посчитанный по среднему за неделю, назвал бы другой срок, чем предупреждение
test("предупреждение и ответ на «лимиты?» называют один и тот же срок", () => {
  const t0 = Date.parse("2027-01-10T12:00:00Z");
  const resets = "2027-01-11T20:00:00Z";
  weekWarning({ week: 80, weekResets: resets }, t0);
  const now = t0 + 2 * 3600_000; // 3% в час: до 100% — 4 часа 40 минут
  const warn = weekWarning({ week: 86, weekResets: resets }, now)!;
  const answer = forecast(86, Date.parse(resets), 7 * 86400_000, now, recentEnd(86, now));
  const when = warn.match(/кончится (.+?)\.\*\*/)![1];
  expect(answer).toContain(`кончится ${when}`);
});

test("за последние часы лимит не тратился — хватит до сброса", () => {
  const t0 = Date.parse("2027-02-10T12:00:00Z");
  const resets = "2027-02-11T20:00:00Z";
  weekWarning({ week: 85, weekResets: resets }, t0);
  expect(recentEnd(85, t0 + 3600_000)).toBe(Infinity);
  expect(forecast(85, Date.parse(resets), 7 * 86400_000, t0 + 3600_000, recentEnd(85, t0 + 3600_000))).toMatch(/^При нынешнем темпе хватит до сброса/);
});
