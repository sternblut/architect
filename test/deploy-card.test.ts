// Карта выкладки после «Разрешить»: «жду выкладку», а когда конвейер кончился — чем: иначе «жду выкладку» висит
// и после того, как выкладка прошла.
import { expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ARCH_STATE_DIR = mkdtempSync(join(tmpdir(), "arch-deploy-card-"));
process.env.ARCH_LOGS_DIR = process.env.ARCH_STATE_DIR;
const real = await import("../src/brief");
mock.module("../src/brief", () => ({
  ...real,
  decisionBrief: async () => ({ head: "Выложить Маяк", lines: ["Обновится beacon.example.com", "Прежнюю версию можно вернуть"], advice: "Советую выложить: автопроверка прошла", lean: "allow", deploy: true, details: ["git push origin main"] }),
}));
const { ensureDirs } = await import("../src/config");
ensureDirs();
const { Telegram, createPairCode } = await import("../src/telegram");
const { Approvals } = await import("../src/approvals");

const OWNER = 111111;
function makeTg() {
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
  return { tg, calls };
}

test("после «Разрешить» — «жду выкладку»; итог конвейера — на той же карте", async () => {
  const { tg, calls } = makeTg();
  // владелец сопряжён, как в test/telegram.test.ts: одноразовый код от его аккаунта
  await tg.bot.handleUpdate({ update_id: 0, message: { message_id: 1, date: 0, chat: { id: OWNER, type: "private" }, from: { id: OWNER, is_bot: false, first_name: "X" }, text: createPairCode() } } as any);
  const approvals = new Approvals(tg);
  const action = "git push origin main";
  const p = approvals.confirm({ source: "«Маяк»", action, tool: "Bash", input: { command: action }, cwd: "/nonexistent", timeoutMs: 5000 });
  const card = () => calls.find((c) => c.method === "sendRichMessage" && String(c.payload.rich_message?.markdown).includes("Выложить Маяк"));
  for (let i = 0; i < 100 && !card(); i++) await Bun.sleep(50); // бот выдерживает паузу между сообщениями
  const sent = card()!;
  const yes = sent.payload.reply_markup.inline_keyboard.flat().find((b: any) => /^Выложить/.test(b.text));
  await tg.bot.handleUpdate({ update_id: 1, callback_query: { id: "1", from: { id: OWNER, is_bot: false, first_name: "X" }, chat_instance: "1", data: yes.callback_data, message: { message_id: 5, date: 0, chat: { id: OWNER, type: "private" } } } } as any);
  expect(await p).toBe("yes");
  const label = () => calls.filter((c) => c.method === "editMessageText").at(-1)!.payload.reply_markup.inline_keyboard[0][0].text as string;
  expect(label()).toMatch(/^Разрешено в \d{1,2}:\d{2} — жду выкладку$/);
  approvals.settleDeploy(action, "выложено в 11:51");
  expect(label()).toMatch(/^Разрешено в \d{1,2}:\d{2} — выложено в 11:51$/);
  approvals.settleDeploy(action, "выкладка не прошла"); // второй итог — некуда: карта уже сказала своё
  expect(label()).toEndWith("выложено в 11:51");
});
