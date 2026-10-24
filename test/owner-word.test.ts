import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
process.env.ARCH_STATE_DIR = mkdtempSync(join(tmpdir(), "arch-word-"));
const { saidByOwner } = await import("../src/architect");

// Архитектор действует по слову владельца: его «останови», «поставь цель» — уже согласие, второй вопрос кнопкой не нужен.
// Но только его слово, проверенное кодом: пересказ цели, «не останавливай» и чужая сессия — кнопкой, как раньше.
test("цель — его текст дословно; пересказ — кнопкой", () => {
  const said = ["Поставь A* цель: мобильная версия 10 из 10 на iPhone, условие — я написал «принято»"];
  expect(saidByOwner("mcp__arch__set_goal", { condition: "мобильная версия 10 из 10 на iPhone, условие — я написал «принято»" }, said)).toBe(true);
  expect(saidByOwner("mcp__arch__set_goal", { condition: "мобильная версия 10 из 10 на iPhone и Android, условие — я написал «принято»" }, said)).toBe(false);
  expect(saidByOwner("mcp__arch__start_session", { goal: "мобильная версия 10 из 10 на iPhone" }, said)).toBe(true);
  expect(saidByOwner("mcp__arch__set_goal", { condition: "10 из 10" }, said)).toBe(false); // слишком коротко, чтобы быть его формулировкой
});

test("стоп — глагол и имя этой сессии в его сообщении, без «не»", () => {
  expect(saidByOwner("mcp__arch__stop_session", { session: "x" }, ["Останови маяк"], "Маяк")).toBe(true);
  expect(saidByOwner("mcp__arch__stop_session", { session: "x" }, ["Стоп отзывы, хватит"], "Анализ отзывов")).toBe(true);
  expect(saidByOwner("mcp__arch__stop_session", { session: "x" }, ["Останови маяк"], "Регламенты")).toBe(false);
  expect(saidByOwner("mcp__arch__stop_session", { session: "x" }, ["Маяк не останавливай, пусть работает"], "Маяк")).toBe(false);
  expect(saidByOwner("mcp__arch__stop_session", { session: "x" }, ["что с маяком?"], "Маяк")).toBe(false);
});

test("снять цель — «цель», глагол снятия и имя", () => {
  expect(saidByOwner("mcp__arch__clear_goal", { session: "x" }, ["Сними цель с регламентов"], "Регламенты")).toBe(true);
  expect(saidByOwner("mcp__arch__clear_goal", { session: "x" }, ["Какая цель у регламентов?"], "Регламенты")).toBe(false);
  expect(saidByOwner("mcp__arch__clear_goal", { session: "x" }, ["Не снимай цель с регламентов"], "Регламенты")).toBe(false);
});

test("архитектор не завершает процессы сессий через Bash", async () => {
  const { architectVerdict } = await import("../src/architect");
  for (const c of ["kill -TERM 4424", "pkill -f claude", "ps x; kill 77", "claude stop abc", "claude respawn c3a758b4", "/bin/kill -9 123", "sudo kill 5"]) expect(architectVerdict("Bash", { command: c }).decision).toBe("deny"); // «/bin/kill» обходил проверку по тексту
  expect(architectVerdict("Bash", { command: "claude agents --json" }).decision).not.toBe("deny");
});

// Пересказ архитектора («ночью не выкладывать») — не слово владельца: он мог хотеть обратного.
// Его слова сессии — только дословно; своё архитектор передаёт запиской, которую хук не берёт в его кавычки.
test("слова владельца сессии — дословно, кусками через «…»; пересказ — не его слово", async () => {
  const { quotesOwner } = await import("../src/architect");
  const said = ["Зачем ты велел им не выкладывать ночью? Пусть выкладывают сразу, как будет готово.", "Второй"];
  expect(quotesOwner("пусть выкладывают сразу, как будет готово", said)).toBe(true);
  expect(quotesOwner("Зачем ты велел им не выкладывать ночью… выкладывают сразу!", said)).toBe(true); // регистр, знаки, пропуск
  expect(quotesOwner("второй", said)).toBe(true); // ответ кнопкой — тоже его слово
  expect(quotesOwner("Ночью не выкладывать, финал к утру", said)).toBe(false);
  expect(quotesOwner("да", ["Когда выложишь?"])).toBe(false); // целыми словами: «да» не найдётся внутри «когда»
  expect(quotesOwner("…", said)).toBe(false);
});

test("записка архитектора сессии не попадает в кавычки владельца", async () => {
  const { ARCH_NOTE, ownerWords } = await import("../src/hookserver");
  const note = `${ownerWords(["пусть выкладывают сразу"])}\n\n${ARCH_NOTE}он про ночную выкладку`;
  expect(ownerWords([note])).toBe(note);
  expect(ownerWords(["да", note])).toBe(`Сообщение владельца из Telegram: «да»\n\n${note}`);
  expect(ownerWords(["да", "нет"])).toBe("Сообщения владельца из Telegram:\n— «да»\n— «нет»");
});

test("message_session не отдаёт пересказ его репликой: сверка — до поиска сессии", async () => {
  const { makeTools } = await import("../src/tools");
  const tg = { ownerSaid: [{ at: Date.now(), text: "Пусть выкладывают сразу, как будет готово" }] };
  const server = makeTools({ tg, approvals: {}, ui: {}, claudePath: "", bunPath: "" } as never) as unknown as { instance: { _registeredTools: Record<string, { handler: (i: object, x: object) => Promise<{ isError?: boolean; content: { text: string }[] }> }> } };
  const send = server.instance._registeredTools.message_session.handler;
  const r = await send({ session: "Регламенты", words: "Ночью не выкладывать, финал к утру" }, {});
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toContain("не его слова дословно");
  expect((await send({ session: "Регламенты" }, {})).content[0].text).toContain("Нечего передать");
});
