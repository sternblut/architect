// "Without asking" rules: a button on the card says yes in advance to the same kind of action in the same project.
import { expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ARCH_STATE_DIR = mkdtempSync(join(tmpdir(), "arch-rules-"));
process.env.ARCH_LOGS_DIR = process.env.ARCH_STATE_DIR;
let project = "Маяк";
const real = await import("../src/brief");
mock.module("../src/brief", () => ({
  ...real,
  decisionBrief: async () => ({ head: `Выложить ${project}`, lines: ["Прежнюю версию можно вернуть"], advice: "Советую выложить: автопроверка прошла", lean: "allow", deploy: true, rule: { kind: "deploy", project } }),
}));
const { ensureDirs } = await import("../src/config");
ensureDirs();
const { Telegram, createPairCode } = await import("../src/telegram");
const { Approvals, rules } = await import("../src/approvals");

const OWNER = 111111;
const tg = new Telegram("123456:TEST_TOKEN_TEST_TOKEN_TEST_TOKEN_TEST");
const calls: { method: string; payload: Record<string, any> }[] = [];
let n = 1000;
tg.bot.botInfo = { id: 42, is_bot: true, first_name: "arch", username: "test_bot" } as never;
tg.bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, payload: payload as Record<string, any> });
  if (method.startsWith("send")) return { ok: true, result: method.endsWith("Draft") ? true : { message_id: ++n, date: 0, chat: { id: OWNER, type: "private" } } } as any;
  return { ok: true, result: true } as any;
});
tg.lastOwnerAt = Date.now();
await tg.bot.handleUpdate({ update_id: 0, message: { message_id: 1, date: 0, chat: { id: OWNER, type: "private" }, from: { id: OWNER, is_bot: false, first_name: "X" }, text: createPairCode() } } as any);
const approvals = new Approvals(tg);
const action = "git push origin main";
const ask = () => approvals.confirm({ source: "«Маяк»", action, tool: "Bash", input: { command: action }, cwd: "/nonexistent", timeoutMs: 30_000 });
const cards = () => calls.filter((c) => c.method === "sendRichMessage" && String(c.payload.rich_message?.markdown).includes("Выложить"));
const until = async (f: () => boolean) => {
  for (let i = 0; i < 100 && !f(); i++) await Bun.sleep(50);
};
let upd = 1; // the bot drops a repeated update_id as a Telegram resend
const press = (data: string) => tg.bot.handleUpdate({ update_id: ++upd, callback_query: { id: String(upd), from: { id: OWNER, is_bot: false, first_name: "X" }, chat_instance: "1", data, message: { message_id: 5, date: 0, chat: { id: OWNER, type: "private" } } } } as any);
const label = () => calls.filter((c) => c.method === "editMessageText").at(-1)!.payload.reply_markup.inline_keyboard[0][0].text as string;

test("the deploy-without-asking button allows and records the rule", async () => {
  const p = ask();
  await until(() => cards().length === 1);
  const btn = cards()[0].payload.reply_markup.inline_keyboard.flat().find((b: any) => b.text === "Выкладывать Маяк без вопросов");
  expect(btn).toBeDefined();
  await press(btn.callback_data);
  expect(await p).toBe("yes");
  expect(label()).toMatch(/^Разрешено в \d{1,2}:\d{2} и дальше без вопросов — жду выкладку$/);
  expect(rules.list().map((r) => `${r.kind}:${r.project}`)).toEqual(["deploy:Маяк"]);
});

test("the same deploy later needs no question: the card arrives decided and silent, then shows the pipeline result", async () => {
  expect(await ask()).toBe("yes"); // nobody tapped anything
  const card = cards().at(-1)!;
  expect(card.payload.disable_notification).toBe(true);
  expect(card.payload.reply_markup.inline_keyboard[0][0].text).toMatch(/^Разрешено вашим правилом от \d{2}\.\d{2} — жду выкладку$/);
  approvals.settleDeploy(action, "выложено в 11:51");
  expect(label()).toMatch(/^Разрешено вашим правилом от \d{2}\.\d{2} — выложено в 11:51$/);
});

test("another project, or a removed rule, asks again", { timeout: 30_000 }, async () => {
  project = "Регламенты";
  let settled = false;
  const other = ask().then((v) => ((settled = true), v));
  await until(() => cards().some((c) => String(c.payload.rich_message.markdown).includes("Выложить Регламенты")));
  await Bun.sleep(50);
  expect(settled).toBe(false); // waiting for a tap
  const card = cards().at(-1)!;
  await press(card.payload.reply_markup.inline_keyboard[0][1].callback_data); // Decline
  expect(await other).toBe("no");
  project = "Маяк";
  rules.remove({ kind: "deploy", project: "Маяк" });
  let again = false;
  const p = ask().then((v) => ((again = true), v));
  await until(() => cards().filter((c) => String(c.payload.rich_message.markdown).includes("Выложить Маяк")).length === 3);
  await Bun.sleep(50);
  expect(again).toBe(false);
  await press(cards().at(-1)!.payload.reply_markup.inline_keyboard[0][1].callback_data);
  expect(await p).toBe("no");
});

test("after a host restart open cards get an honest caption, decided ones stay", { timeout: 30_000 }, async () => {
  const before = calls.length;
  void approvals.confirm({ source: "«Маяк»", action: "Удалить черновики", reason: "удаление файлов", timeoutMs: 30_000 });
  await until(() => calls.slice(before).some((c) => c.method === "sendRichMessage"));
  const open = calls.slice(before).find((c) => c.method === "sendRichMessage")!;
  const { readFileSync } = await import("node:fs");
  const saved = JSON.parse(readFileSync(join(process.env.ARCH_STATE_DIR!, "open-cards.json"), "utf8"));
  expect(Object.keys(saved).length).toBe(1); // the cards decided above are off the list
  void new Approvals(tg).expireOld(); // as a new host process does at startup
  await until(() => calls.slice(before).some((c) => c.method === "editMessageText"));
  const edit = calls.slice(before).find((c) => c.method === "editMessageText")!;
  expect(edit.payload.reply_markup.inline_keyboard[0][0].text).toBe("Бот перезапускался — этот запрос больше не действует");
  expect(edit.payload.rich_message.markdown).toBe(open.payload.rich_message.markdown);
  expect(JSON.parse(readFileSync(join(process.env.ARCH_STATE_DIR!, "open-cards.json"), "utf8"))).toEqual({});
});
