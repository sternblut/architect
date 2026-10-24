// The Telegram layer without network: the real Telegram class with a fake Bot API transport and hand-fed updates.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ARCH_STATE_DIR = mkdtempSync(join(tmpdir(), "arch-tg-"));
process.env.ARCH_LOGS_DIR = process.env.ARCH_STATE_DIR;
const { ensureDirs, STATE, LOGS } = await import("../src/config");
ensureDirs();
const { Telegram, createPairCode, ownerId } = await import("../src/telegram");
const { Approvals } = await import("../src/approvals");

const OWNER = 111111;
const STRANGER = 999999;
type Call = { method: string; payload: Record<string, any> };

function makeTg(opts: { failRich?: boolean; failDraftMarkdown?: boolean } = {}) {
  const tg = new Telegram("123456:TEST_TOKEN_TEST_TOKEN_TEST_TOKEN_TEST");
  const calls: Call[] = [];
  let n = 1000;
  tg.bot.botInfo = { id: 42, is_bot: true, first_name: "arch", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as any;
  tg.bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, any> });
    if (method === "sendRichMessage" && opts.failRich) return { ok: false, error_code: 400, description: "Bad Request: can't parse rich message" } as any;
    if (method === "sendRichMessageDraft" && opts.failDraftMarkdown && (payload as any).rich_message?.markdown !== undefined)
      return { ok: false, error_code: 400, description: "Bad Request: can't parse" } as any;
    if (method === "getMe") return { ok: true, result: { ...tg.bot.botInfo, has_topics_enabled: false } } as any;
    if (method.startsWith("send")) return { ok: true, result: method.endsWith("Draft") ? true : { message_id: ++n, date: 0, chat: { id: OWNER, type: "private" } } } as any;
    return { ok: true, result: true } as any;
  });
  // the owner is "awake": these tests check messages, not quiet hours, and would fail between 0:00 and 8:00
  tg.lastOwnerAt = Date.now();
  return { tg, calls };
}

let uid = 1;
const msg = (from: number, text: string, extra: Record<string, unknown> = {}, chatType = "private") => ({
  update_id: uid++,
  message: { message_id: uid, date: 0, chat: { id: chatType === "private" ? from : -100500, type: chatType }, from: { id: from, is_bot: false, first_name: "X" }, text, ...extra },
});
const press = (from: number, data: string) => ({
  update_id: uid++,
  callback_query: { id: String(uid), from: { id: from, is_bot: false, first_name: "X" }, chat_instance: "1", data, message: { message_id: 5, date: 0, chat: { id: from, type: "private" } } },
});

describe("pairing", () => {
  beforeEach(() => {
    rmSync(join(STATE, "owner.json"), { force: true });
    rmSync(join(STATE, "pair.json"), { force: true });
  });

  test("a correct code via /start makes the sender the owner", async () => {
    const { tg } = makeTg();
    const code = createPairCode();
    await tg.bot.handleUpdate(msg(OWNER, `/start ${code}`) as any);
    expect(ownerId()).toBe(OWNER);
  });

  test("no owner without a code, with a wrong one, or after 5 tries", async () => {
    const { tg } = makeTg();
    const code = createPairCode();
    await tg.bot.handleUpdate(msg(STRANGER, "/start") as any);
    for (let i = 0; i < 5; i++) await tg.bot.handleUpdate(msg(STRANGER, String((Number(code) + 1 + i) % 1000000).padStart(6, "1")) as any);
    expect(ownerId()).toBeUndefined();
    await tg.bot.handleUpdate(msg(STRANGER, code) as any); // the right code after the tries are used up
    expect(ownerId()).toBeUndefined();
  });

  test("re-pairing: a correct code from a new account, the previous one is told, strangers without a code get silence", async () => {
    const { tg, calls } = makeTg();
    await tg.bot.handleUpdate(msg(OWNER, `/start ${createPairCode()}`) as any);
    expect(ownerId()).toBe(OWNER);
    await tg.bot.handleUpdate(msg(STRANGER, "привет") as any); // no code open: silence
    const code = createPairCode();
    await tg.bot.handleUpdate(msg(STRANGER, "что у нас") as any); // a code is open but this isn't one: silence, no hint
    expect(calls.filter((c) => c.method.startsWith("send") && c.payload.chat_id === STRANGER).length).toBe(0);
    await tg.bot.handleUpdate(msg(STRANGER, String((Number(code) + 1) % 1000000).padStart(6, "1")) as any); // a wrong code
    expect(ownerId()).toBe(OWNER);
    await tg.bot.handleUpdate(msg(STRANGER, `/start ${code}`) as any);
    for (let i = 0; i < 50 && ownerId() !== STRANGER; i++) await Bun.sleep(10); // messages are handled in order
    expect(ownerId()).toBe(STRANGER);
    await Bun.sleep(20);
    expect(calls.some((c) => c.method.startsWith("send") && c.payload.chat_id === OWNER && JSON.stringify(c.payload).includes("другому аккаунту"))).toBe(true);
  });

  test("a code from a group doesn't count", async () => {
    const { tg } = makeTg();
    const code = createPairCode();
    await tg.bot.handleUpdate(msg(STRANGER, code, {}, "group") as any);
    expect(ownerId()).toBeUndefined();
  });
});

describe("owner only", () => {
  beforeEach(async () => {
    rmSync(join(STATE, "owner.json"), { force: true });
    const { tg } = makeTg();
    const code = createPairCode();
    await tg.bot.handleUpdate(msg(OWNER, code) as any);
  });

  test("messages from strangers and groups are dropped, the owner's arrive", async () => {
    const { tg } = makeTg();
    const got: string[] = [];
    tg.onIncoming((m) => got.push(m.text));
    await tg.bot.handleUpdate(msg(STRANGER, "удали всё") as any);
    await tg.bot.handleUpdate(msg(OWNER, "из группы", {}, "group") as any);
    await tg.bot.handleUpdate(msg(OWNER, "привет") as any);
    expect(got).toEqual(["привет"]);
  });

  test("a forwarded message is marked and never counts as a decision", async () => {
    const { tg } = makeTg();
    const approvals = new Approvals(tg);
    const got: any[] = [];
    tg.onIncoming((m) => got.push(m));
    const decision = approvals.confirm({ source: "тест", action: "git push origin main", timeoutMs: 2000 });
    await Bun.sleep(20);
    const id = (await import("node:fs")).readFileSync(join(LOGS, "decisions.jsonl"), "utf8").trim().split("\n").pop()!;
    const code = JSON.parse(id).id as string;
    await tg.bot.handleUpdate(msg(OWNER, `да ${code}`, { forward_origin: { type: "hidden_user", sender_user_name: "Злоумышленник", date: 0 } }) as any);
    expect(got[0].forwardedFrom).toBe("Злоумышленник");
    expect(approvals.takeText(got[0])).toBe(false);
    expect(await decision).toBe("timeout");
  });

  test("a stranger's Allow does nothing, the owner's works; without advice the buttons are neutral", async () => {
    const { tg, calls } = makeTg();
    const approvals = new Approvals(tg);
    const p = approvals.confirm({ source: "тест", action: "rm -rf build-old", timeoutMs: 5000 });
    await Bun.sleep(20);
    const sent = calls.find((c) => c.method === "sendRichMessage")!;
    const yes = sent.payload.reply_markup.inline_keyboard[0][0];
    expect(yes.style).toBeUndefined(); // a red Decline without advice would read as an alarm
    expect(sent.payload.reply_markup.inline_keyboard[0][1].style).toBeUndefined();
    await tg.bot.handleUpdate(press(STRANGER, yes.callback_data) as any);
    let settled = false;
    p.then(() => (settled = true));
    await Bun.sleep(20);
    expect(settled).toBe(false);
    await tg.bot.handleUpdate(press(OWNER, yes.callback_data) as any);
    expect(await p).toBe("yes");
  });

  test("after a decision the buttons become one disabled caption and the text stays", async () => {
    const { tg, calls } = makeTg();
    const approvals = new Approvals(tg);
    const p = approvals.confirm({ source: "Сборка", action: "Выложить архитектора", reason: "Тесты зелёные", timeoutMs: 5000 });
    await Bun.sleep(20);
    const sent = calls.find((c) => c.method === "sendRichMessage")!;
    expect(sent.payload.rich_message.markdown).toStartWith("Выложить архитектора"); // under four lines: no bold
    await tg.bot.handleUpdate(press(OWNER, sent.payload.reply_markup.inline_keyboard[0][1].callback_data) as any);
    expect(await p).toBe("no");
    const edit = calls.find((c) => c.method === "editMessageText")!;
    expect(edit.payload.rich_message.markdown).toBe(sent.payload.rich_message.markdown);
    const [[btn]] = edit.payload.reply_markup.inline_keyboard;
    expect(btn.text).toStartWith("Отклонено в ");
    expect(btn.disabled).toEqual({});
    expect(btn.callback_data).toBeUndefined();
  });

  test("an unclear command highlights Explain first, which withdraws the request with a note for the session", async () => {
    const { tg, calls } = makeTg();
    const approvals = new Approvals(tg);
    const p = approvals.confirm({ source: "«Тест»", action: "python3 -c …", tool: "Bash", input: { command: `python3 -c 'import os; os.remove("x")'`, description: "Remove x" }, cwd: STATE, timeoutMs: 5000 });
    let sent: Call | undefined;
    for (let i = 0; i < 100 && !sent; i++) {
      await Bun.sleep(20);
      sent = calls.find((c) => c.method === "sendRichMessage");
    }
    const kb = sent!.payload.reply_markup.inline_keyboard;
    // yes takes the first line's verb, so the owner sees what the tap does
    expect(kb.map((r: any[]) => r.map((b) => [b.text, b.style]))).toEqual([[["Запустить", undefined], ["Отклонить", undefined]], [["Сначала объясни", "primary"]]]);
    expect(sent!.payload.rich_message.markdown).toMatch(/^Запустить скрипт [^\n]+\? *\nСкрипт может удалять файлы\. *\nПросит сессия «Тест»\. *\n/);
    expect(sent!.payload.rich_message.markdown.split("<details>")[0]).not.toContain("python3"); // the command only under Details
    await tg.bot.handleUpdate(press(OWNER, kb[1][0].callback_data) as any);
    const r = await p;
    expect(typeof r === "object" && r.tell).toContain("description");
    expect(calls.find((c) => c.method === "editMessageText")!.payload.reply_markup.inline_keyboard[0][0].text).toStartWith("Объяснение запрошено в ");
  });

  test("question: options without icons, then a disabled caption with the choice", async () => {
    const { tg, calls } = makeTg();
    const approvals = new Approvals(tg);
    const p = approvals.ask({ source: "«Шапка»", questions: [{ question: "Какой вариант?", options: [{ label: "Тёмная" }, { label: "Светлая" }] }], timeoutMs: 5000 });
    await Bun.sleep(20);
    const kb = calls.find((c) => c.method === "sendRichMessage")!.payload.reply_markup.inline_keyboard;
    expect(kb.map((r: any[]) => r.map((b) => b.text))).toEqual([["Тёмная"], ["Светлая"]]);
    await tg.bot.handleUpdate(press(OWNER, kb[1][0].callback_data) as any);
    expect(await p).toEqual({ "Какой вариант?": "Светлая" });
    expect(calls.find((c) => c.method === "editMessageText")!.payload.reply_markup.inline_keyboard[0][0].text).toStartWith("Выбрано «Светлая» в ");
  });

  test("question: options only as buttons, a free-form answer only as a reply (swipe) to the question", async () => {
    const { tg, calls } = makeTg();
    const approvals = new Approvals(tg);
    const q = { question: "Какой вариант?", options: [{ label: "Тёмная", description: "ночью меньше слепит" }, { label: "Светлая" }] };
    const p = approvals.ask({ source: "«Шапка»", questions: [q], timeoutMs: 5000 });
    await Bun.sleep(20);
    const md: string = calls.find((c) => c.method === "sendRichMessage")!.payload.rich_message.markdown;
    expect(md.split("<details>")[0]).not.toContain("Тёмная"); // options aren't repeated in text; descriptions go under Details
    expect(md).not.toContain("Свой вариант"); // no hint about free-form replies
    const qid = tg.lastId;
    const said = (o: Record<string, unknown>) => approvals.takeText({ messageId: qid + 1, text: "Синяя", files: [], ...o });
    expect(said({})).toBe(false); // a message right after the question is no answer
    expect(said({ replyToId: qid - 1 })).toBe(false); // nor is a reply to another message
    expect(said({ replyToId: qid })).toBe(true);
    expect(await p).toEqual({ "Какой вариант?": "Синяя" });
    const edit = calls.find((c) => c.method === "editMessageText")!.payload;
    expect(edit.reply_markup.inline_keyboard[0][0].text).toStartWith("Ответ получен в ");
    expect(edit.rich_message.markdown).not.toContain("Свой вариант");
    expect(said({ messageId: qid + 9, replyToId: qid })).toBe(false); // a decided question takes no more answers
  });

  test("a question with advice takes the reason from the recommended option's description, not repeated under Details", async () => {
    const { tg, calls } = makeTg();
    const approvals = new Approvals(tg);
    void approvals.ask({ source: "«Шапка», beacon", questions: [{ question: "Какой вариант?", options: [{ label: "Тёмная (Recommended)", description: "как на макете" }, { label: "Светлая" }] }], timeoutMs: 300 });
    await Bun.sleep(20);
    const md: string = calls.find((c) => c.method === "sendRichMessage")!.payload.rich_message.markdown;
    expect(md.replace(/\u00a0/g, " ")).toContain("Сессия «Шапка» советует «Тёмная»: как на макете");
    expect(md).not.toContain("<details>");
  });

  test("the architect's question: an unrelated message is no answer, a swipe reply is", async () => {
    const { tg } = makeTg();
    const approvals = new Approvals(tg);
    const p = approvals.ask({ source: "Архитектор", questions: [{ question: "Какую папку?", options: [{ label: "A" }, { label: "B" }] }], timeoutMs: 5000 });
    await Bun.sleep(20);
    const qid = tg.lastId;
    expect(approvals.takeText({ messageId: qid + 1, text: "запусти маяк", files: [] })).toBe(false);
    expect(approvals.takeText({ messageId: qid + 2, replyToId: qid, text: "C", files: [] })).toBe(true);
    expect(await p).toEqual({ "Какую папку?": "C" });
  });

  test("the draft's Stop button works for the owner, not from another chat", async () => {
    const { tg } = makeTg();
    const stops: number[] = [];
    tg.onStop((d) => stops.push(d));
    await tg.bot.handleUpdate({ update_id: uid++, stopped_message_generation: { chat: { id: STRANGER, type: "private" }, draft_id: 7 } } as any);
    await tg.bot.handleUpdate({ update_id: uid++, stopped_message_generation: { chat: { id: OWNER, type: "private" }, draft_id: 8 } } as any);
    expect(stops).toEqual([8]);
  });

  test("replies go as rich Markdown messages, and $ doesn't start math", async () => {
    const { tg, calls } = makeTg();
    await tg.send("**Итог**: стоит $20 и $30\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    const c = calls.find((x) => x.method === "sendRichMessage")!;
    expect(c.payload.rich_message.markdown).toContain("\\$20");
    expect(c.payload.rich_message.markdown).toContain("| a | b |");
  });

  test("a rejected rich message goes as HTML with nothing lost", async () => {
    const { tg, calls } = makeTg({ failRich: true });
    const ids = await tg.send("**Важно: сайт упал**\nМаяк не открывается\nс 14:02\nСессии работают"); // bold needs four lines or more
    expect(ids.length).toBe(1);
    const c = calls.find((x) => x.method === "sendMessage")!;
    expect(c.payload.parse_mode).toBe("HTML");
    expect(c.payload.text).toContain("<b>Важно: сайт упал</b>");
  });

  test("the bot token never goes out in messages", async () => {
    const { tg, calls } = makeTg();
    // a made-up token of the right shape
    const fake = `${"7".repeat(10)}:AAG${"x".repeat(32)}`;
    await tg.send(`вот токен ${fake} лови`);
    const c = calls.find((x) => x.method === "sendRichMessage")!;
    expect(c.payload.rich_message.markdown).not.toContain("AAGxxxx");
  });

  test("draft: Thinking as a block; rejected Markdown makes later frames simpler; at most one frame per 0.7 s", async () => {
    const { tg, calls } = makeTg({ failDraftMarkdown: true });
    tg.resetDraft();
    await tg.draft({ id: 5, thinking: "Смотрю сессии", canStop: true });
    await tg.draft({ id: 5, md: "слишком рано" }); // under 0.7 s: skipped
    await Bun.sleep(750);
    await tg.draft({ id: 5, md: "Пишу ответ" }); // Markdown rejected → blocks from now on
    await Bun.sleep(750);
    await tg.draft({ id: 5, md: "Пишу ответ дальше" });
    const drafts = calls.filter((x) => x.method === "sendRichMessageDraft");
    expect(drafts.length).toBe(3);
    expect(drafts[0].payload.rich_message.blocks[0]).toEqual({ type: "thinking", text: "Смотрю сессии" });
    expect(drafts[0].payload.can_stop).toBe(true);
    expect(drafts[1].payload.rich_message.markdown).toBe("Пишу ответ");
    expect(drafts[2].payload.rich_message.blocks[0].text).toBe("Пишу ответ дальше");
  });
});

// A wrong statement doesn't stay in the chat: the architect fixes its message in place and the buttons stay
test("fix in place: new text, a corrected-at line, the same buttons", async () => {
  const { tg, calls } = makeTg();
  const [id] = await tg.send("Каталог на паузе.", { from: "architect", buttons: [[{ text: "Ответить: Каталог", data: "r:1" }]] });
  expect(await tg.correct(1, "Каталог работает с 20:52.")).toBe(true);
  const edit = calls.find((c) => c.method === "editMessageText")!;
  expect(edit.payload.message_id).toBe(id);
  expect(JSON.stringify(edit.payload)).toMatch(/Каталог работает с.20:52/); // a no-break space after "с"
  expect(JSON.stringify(edit.payload)).toMatch(/Исправлено в.\d\d:\d\d/);
  expect(edit.payload.reply_markup.inline_keyboard[0][0].text).toBe("Ответить: Каталог");
  expect(await tg.correct(5, "нет такого")).toBe(false);
});
