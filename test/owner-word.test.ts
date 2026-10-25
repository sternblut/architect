import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
process.env.ARCH_STATE_DIR = mkdtempSync(join(tmpdir(), "arch-word-"));
const { saidByOwner } = await import("../src/architect");

// The owner's "stop X" or "set a goal" is consent in itself, with no second question, but only when the code verifies
// it: a paraphrased goal, a negation or another session still get a button.
test("a goal must be the owner's text verbatim; a paraphrase gets a button", () => {
  const said = ["Поставь A* цель: мобильная версия 10 из 10 на iPhone, условие — я написал «принято»"];
  expect(saidByOwner("mcp__arch__set_goal", { condition: "мобильная версия 10 из 10 на iPhone, условие — я написал «принято»" }, said)).toBe(true);
  expect(saidByOwner("mcp__arch__set_goal", { condition: "мобильная версия 10 из 10 на iPhone и Android, условие — я написал «принято»" }, said)).toBe(false);
  expect(saidByOwner("mcp__arch__start_session", { goal: "мобильная версия 10 из 10 на iPhone" }, said)).toBe(true);
  expect(saidByOwner("mcp__arch__set_goal", { condition: "10 из 10" }, said)).toBe(false); // too short to count as the owner's wording
});

test("stop needs a verb and this session's name in the owner's message, without a negation", () => {
  expect(saidByOwner("mcp__arch__stop_session", { session: "x" }, ["Останови маяк"], "Маяк")).toBe(true);
  expect(saidByOwner("mcp__arch__stop_session", { session: "x" }, ["Стоп отзывы, хватит"], "Анализ отзывов")).toBe(true);
  expect(saidByOwner("mcp__arch__stop_session", { session: "x" }, ["Останови маяк"], "Регламенты")).toBe(false);
  expect(saidByOwner("mcp__arch__stop_session", { session: "x" }, ["Маяк не останавливай, пусть работает"], "Маяк")).toBe(false);
  expect(saidByOwner("mcp__arch__stop_session", { session: "x" }, ["что с маяком?"], "Маяк")).toBe(false);
});

test("clearing a goal needs the word goal, a clearing verb and the name", () => {
  expect(saidByOwner("mcp__arch__clear_goal", { session: "x" }, ["Сними цель с регламентов"], "Регламенты")).toBe(true);
  expect(saidByOwner("mcp__arch__clear_goal", { session: "x" }, ["Какая цель у регламентов?"], "Регламенты")).toBe(false);
  expect(saidByOwner("mcp__arch__clear_goal", { session: "x" }, ["Не снимай цель с регламентов"], "Регламенты")).toBe(false);
});

test("the architect doesn't kill session processes through Bash", async () => {
  const { architectVerdict } = await import("../src/architect");
  for (const c of ["kill -TERM 4424", "pkill -f claude", "ps x; kill 77", "claude stop abc", "claude respawn c3a758b4", "/bin/kill -9 123", "sudo kill 5"]) expect(architectVerdict("Bash", { command: c }).decision).toBe("deny"); // "/bin/kill" would slip past a text check
  expect(architectVerdict("Bash", { command: "claude agents --json" }).decision).not.toBe("deny");
});

// The architect's paraphrase is not the owner's word: they may have meant the opposite. Their words go to a session
// verbatim, and the architect's own go as a note the hook never quotes as the owner's.
test("the owner's words go verbatim, in pieces joined by …; a paraphrase doesn't count", async () => {
  const { quotesOwner } = await import("../src/architect");
  const said = ["Зачем ты велел им не выкладывать ночью? Пусть выкладывают сразу, как будет готово.", "Второй"];
  expect(quotesOwner("пусть выкладывают сразу, как будет готово", said)).toBe(true);
  expect(quotesOwner("Зачем ты велел им не выкладывать ночью… выкладывают сразу!", said)).toBe(true); // case, punctuation, a gap
  expect(quotesOwner("второй", said)).toBe(true); // a button answer is the owner's word too
  expect(quotesOwner("Ночью не выкладывать, финал к утру", said)).toBe(false);
  expect(quotesOwner("да", ["Когда выложишь?"])).toBe(false); // whole words: "да" is not found inside "когда"
  expect(quotesOwner("…", said)).toBe(false);
});

test("the architect's note to a session is never quoted as the owner's", async () => {
  const { ARCH_NOTE, ownerWords } = await import("../src/sessions");
  const note = `${ownerWords(["пусть выкладывают сразу"])}\n\n${ARCH_NOTE}он про ночную выкладку`;
  expect(ownerWords([note])).toBe(note);
  expect(ownerWords(["да", note])).toBe(`Сообщение владельца из Telegram: «да»\n\n${note}`);
  expect(ownerWords(["да", "нет"])).toBe("Сообщения владельца из Telegram:\n— «да»\n— «нет»");
});

test("message_session refuses a paraphrase as the owner's message, before looking up the session", async () => {
  const { makeTools } = await import("../src/tools");
  const tg = { ownerSaid: [{ at: Date.now(), text: "Пусть выкладывают сразу, как будет готово" }] };
  const server = makeTools({ tg, approvals: {}, ui: {}, claudePath: "", bunPath: "" } as never) as unknown as { instance: { _registeredTools: Record<string, { handler: (i: object, x: object) => Promise<{ isError?: boolean; content: { text: string }[] }> }> } };
  const send = server.instance._registeredTools.message_session.handler;
  const r = await send({ session: "Регламенты", words: "Ночью не выкладывать, финал к утру" }, {});
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toContain("не его слова дословно");
  expect((await send({ session: "Регламенты" }, {})).content[0].text).toContain("Нечего передать");
});
