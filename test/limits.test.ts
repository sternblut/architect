import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
process.env.ARCH_STATE_DIR = mkdtempSync(join(tmpdir(), "arch-limits-"));
const { recentEnd, weekWarning } = await import("../src/limits");
const { forecast } = await import("../src/status");

// About 3% an hour, which won't last until the reset
test("warns once, with the time and the consequence, when the limit runs out before the reset", () => {
  const resets = "2026-10-24T01:59:59Z";
  const t0 = Date.parse("2026-10-20T06:15:00Z");
  expect(weekWarning({ week: 80, weekResets: resets }, t0)).toBeUndefined(); // one sample gives no pace
  const msg = weekWarning({ week: 89, weekResets: resets }, t0 + 3 * 3600_000 - 60_000)!;
  expect(msg).toMatch(/^\*\*Недельный лимит Claude кончится .*в.15:53\.\*\*/); // the time first, from the pace, not the start date
  expect(msg).toContain("Потрачено 89%");
  expect(msg).toContain("до сброса встанет вся работа, и мои ответы тоже");
  expect(msg).not.toContain("сказать мне"); // the host may send it while the architect can't reply
  expect(weekWarning({ week: 89.5, weekResets: resets }, t0 + 3 * 3600_000 + 6 * 60_000)).toBeUndefined(); // same step: silent
});

test("silent when a calm pace lasts until the reset", () => {
  const t0 = Date.parse("2026-11-20T06:00:00Z");
  const resets = new Date(t0 + 20 * 3600_000).toISOString(); // 0.5% an hour: 14% lasts 28 hours, the reset comes first
  weekWarning({ week: 85, weekResets: resets }, t0);
  expect(weekWarning({ week: 86, weekResets: resets }, t0 + 2 * 3600_000)).toBeUndefined();
});

test("a reset time jittering by a fraction of a second is the same week: no second warning", () => {
  const t0 = Date.parse("2026-12-20T06:15:00Z");
  weekWarning({ week: 80, weekResets: "2026-12-24T01:59:59.530Z" }, t0);
  expect(weekWarning({ week: 99, weekResets: "2026-12-24T01:59:59.530Z" }, t0 + 3 * 3600_000 - 60_000)).toContain("99%");
  expect(weekWarning({ week: 99, weekResets: "2026-12-24T02:00:00.382Z" }, t0 + 3 * 3600_000 + 5 * 60_000)).toBeUndefined();
});

// An answer based on the weekly average would name a different time than the warning
test("the warning and the limits answer name the same time", () => {
  const t0 = Date.parse("2027-01-10T12:00:00Z");
  const resets = "2027-01-11T20:00:00Z";
  weekWarning({ week: 80, weekResets: resets }, t0);
  const now = t0 + 2 * 3600_000; // 3% an hour: 100% in 4 hours 40 minutes
  const warn = weekWarning({ week: 86, weekResets: resets }, now)!;
  const answer = forecast(86, Date.parse(resets), 7 * 86400_000, now, recentEnd(86, now));
  const when = warn.match(/кончится (.+?)\.\*\*/)![1];
  expect(answer).toContain(`кончится ${when}`);
});

test("no usage in the last hours lasts until the reset", () => {
  const t0 = Date.parse("2027-02-10T12:00:00Z");
  const resets = "2027-02-11T20:00:00Z";
  weekWarning({ week: 85, weekResets: resets }, t0);
  expect(recentEnd(85, t0 + 3600_000)).toBe(Infinity);
  expect(forecast(85, Date.parse(resets), 7 * 86400_000, t0 + 3600_000, recentEnd(85, t0 + 3600_000))).toMatch(/^При нынешнем темпе хватит до сброса/);
});
