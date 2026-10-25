// One rule for whether a session's last words ask the owner something, shared by the hook and the watcher.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ARCH_STATE_DIR = mkdtempSync(join(tmpdir(), "arch-question-"));
const { looksLikeQuestion } = await import("../src/hookserver");

test("a question mark at the end, also in bold, quotes or full width, or before a new line", () => {
  for (const t of ["Какой вариант шапки выбрать?", "Выкладывать сейчас?**", "Оставить «старое»?»", "Подойдёт？", "Какой из двух?\n1. А\n2. Б"]) expect(looksLikeQuestion(t)).toBe(true);
});

test("asking in words", () => {
  for (const t of ["Жду вашего решения по шапке.", "Скажите, какой цвет.", "Подтвердите выкладку.", "Ответьте, когда посмотрите.", "Нужно ваше «да» на выкладку."]) expect(looksLikeQuestion(t)).toBe(true);
});

test("a report is not a question", () => {
  for (const t of ["Проверено: тесты проходят, ветка запушена.", "Сделано. Почему так — в описании PR."]) expect(looksLikeQuestion(t)).toBe(false);
});
