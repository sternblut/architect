// Обещания архитектора («проверю и пришлю») — записи у хоста со сроком: иначе после сброса лимита и /new они теряются.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
process.env.ARCH_STATE_DIR = mkdtempSync(join(tmpdir(), "arch-promises-"));
const { nextAt, promises } = await import("../src/promises");
const { PROMISE } = await import("../src/architect");

test("обещание о сессии — когда она закончит ход; о времени — к сроку; отложенное возвращается к новому сроку", () => {
  const now = Date.now();
  promises.add({ what: "пришлю ссылки Маяка", due: now + 3 * 3600_000, session: "s1", name: "Маяк" });
  promises.add({ what: "напомню про рейтинг", due: now - 1000 });
  expect(promises.takeForSession("s2")).toEqual([]);
  expect(promises.takeForSession("s1").map((p) => p.what)).toEqual(["пришлю ссылки Маяка"]);
  const due = promises.takeDue(now);
  expect(due.map((p) => p.what)).toEqual(["напомню про рейтинг"]);
  expect(promises.list()).toEqual([]);
  promises.postpone(due, now + 60_000); // кончился лимит: владельцу сказано, обещание — к сбросу
  expect(promises.takeDue(now)).toEqual([]);
  expect(promises.takeDue(now + 60_000).map((p) => [p.what, p.told])).toEqual([["напомню про рейтинг", true]]);
});

test("обещания переживают перезапуск хоста", async () => {
  promises.add({ what: "итог приёмки", due: Date.now() + 3600_000 });
  const again = await import(`../src/promises?again=${Date.now()}`);
  expect(again.promises.list().map((p: { what: string }) => p.what)).toContain("итог приёмки");
});

test("«09:30» — ближайшие 09:30 по часам Mac", () => {
  const at = (h: number, m: number) => new Date(2026, 9, 23, h, m).getTime();
  expect(nextAt("09:30", at(8, 0))).toBe(at(9, 30));
  expect(nextAt("09:30", at(20, 20))).toBe(new Date(2026, 9, 24, 9, 30).getTime());
});

test("обещание в ответе видно; обычный ответ — нет", () => {
  for (const t of ["Запустил «Маяк». Итог пришлю сюда.", "Напомню завтра в 9:30.", "Как будут ссылки — дам знать."]) expect(PROMISE().test(t)).toBe(true);
  for (const t of ["Передал.", "Выкладка прошла, снимок выше.", "Пришлите запись встречи."]) expect(PROMISE().test(t)).toBe(false);
});
