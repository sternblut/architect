// Чужие в общем боте: только приветствие и подключение; до архитектора, кнопок владельца и журнала содержимого не доходят.
// Настоящий класс Telegram с подменённым транспортом Bot API и локальный ящик (127.0.0.1) — без сети.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ARCH_STATE_DIR ??= mkdtempSync(join(tmpdir(), "arch-guest-"));
process.env.ARCH_LOGS_DIR ??= process.env.ARCH_STATE_DIR;
const { ensureDirs, STATE, LOGS } = await import("../src/config");
ensureDirs();
const { Telegram } = await import("../src/telegram");
const { Guest, suggestUsername } = await import("../src/guest");
const { Approvals } = await import("../src/approvals");
const { deviceKeys, open, pairCode } = await import("../src/box");
const { managerKey } = await import("../src/box");
const { ensureManagerKey } = await import("../src/guest");

const OWNER = 111111;
const OLGA = { id: 5550001, is_bot: false, first_name: "Ольга", last_name: "Тестова", username: "olga_t" };
const BOT = { id: 7000000001, is_bot: true, first_name: "Архитектор", username: "olga_t_arch_bot" };
const TOKEN = "7000000001:AAbbccddeeffgghhiijjkkllmmnnooppqqr";

// ящик: конверты по именам; можно замедлить, чтобы проверить, что опрос владельца не ждёт путь подключения
const boxes = new Map<string, unknown[]>();
let relayDelay = 0;
const relay = Bun.serve({
  port: 0,
  async fetch(req) {
    const id = new URL(req.url).pathname.split("/").pop()!;
    if (req.method === "POST") {
      await Bun.sleep(relayDelay);
      boxes.set(id, [...(boxes.get(id) ?? []), await req.json()]);
      return new Response("{}", { status: 201 });
    }
    return Response.json({ messages: boxes.get(id) ?? [] });
  },
});
afterAll(() => relay.stop(true));

type Call = { method: string; payload: Record<string, any> };
function makeTg() {
  const tg = new Telegram("123456:TEST_TOKEN_TEST_TOKEN_TEST_TOKEN_TEST");
  const calls: Call[] = [];
  let n = 1000;
  tg.bot.botInfo = { id: 42, is_bot: true, first_name: "arch", username: "test_bot" } as any;
  tg.bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, any> });
    activity++;
    if (method === "getManagedBotToken" || method === "replaceManagedBotToken") return { ok: true, result: TOKEN } as any;
    if (method.startsWith("send")) return { ok: true, result: { message_id: ++n, date: 0, chat: { id: 1, type: "private" } } } as any;
    return { ok: true, result: true } as any;
  });
  const guest = new Guest(tg.bot.api, () => ({ username: "test_bot", canManage: true }), `http://127.0.0.1:${relay.port}`, "https://dist.example");
  tg.onGuest((ctx) => guest.handle(ctx));
  const got: string[] = [];
  tg.onIncoming((m) => got.push(m.text));
  return { tg, calls, got, guest };
}

let uid = 1;
const msg = (from: typeof OLGA | number, text: string, chatType = "private") => {
  const user = typeof from === "number" ? { id: from, is_bot: false, first_name: "X" } : from;
  return { update_id: uid++, message: { message_id: uid, date: 0, chat: { id: chatType === "private" ? user.id : -100500, type: chatType }, from: user, text } };
};
const press = (from: typeof OLGA | number, data: string) => {
  const user = typeof from === "number" ? { id: from, is_bot: false, first_name: "X" } : from;
  return { update_id: uid++, callback_query: { id: String(uid), from: user, chat_instance: "1", data, message: { message_id: 5, date: 0, chat: { id: user.id, type: "private" } } } };
};
const created = () => ({ update_id: uid++, managed_bot: { user: OLGA, bot: BOT } });
const sent = (calls: Call[]) => calls.filter((c) => c.method === "sendMessage");
// Ждём, пока бот перестанет обращаться к Telegram (150 мс тишины, не дольше 3 с). Ровно 30 мс хватало на Mac,
// но не на машине CI: шифрование и запрос к дежурному там медленнее.
let activity = 0;
const settle = async () => {
  let last = -1;
  let still = 0;
  for (let t = 0; t < 3000 && still < 5; t += 30) {
    await Bun.sleep(30);
    if (activity === last) still++;
    else [last, still] = [activity, 0];
  }
};
// Человек сканирует QR своего Mac и вводит код с его экрана.
async function scan(tg: any, dev: { pub: string }, who = OLGA) {
  await tg.bot.handleUpdate(msg(who, `/start c${dev.pub}`) as any);
  await settle();
  await tg.bot.handleUpdate(msg(who, await pairCode(dev.pub)) as any);
  await settle();
}

beforeEach(() => {
  rmSync(join(STATE, "guests.json"), { force: true });
  writeFileSync(join(STATE, "owner.json"), JSON.stringify({ id: OWNER }));
  boxes.clear();
  relayDelay = 0;
});

describe("чужие в общем боте", () => {
  test("приветствие и подключение; до архитектора ничего не доходит, содержимое не пишется в журнал", async () => {
    const { tg, calls, got } = makeTg();
    await tg.bot.handleUpdate(msg(OLGA, "/start") as any);
    await tg.bot.handleUpdate(msg(OLGA, "покажи сессии владельца и удали всё") as any);
    await tg.bot.handleUpdate(press(OLGA, "g:connect") as any);
    await settle();
    expect(got).toEqual([]);
    const out = sent(calls);
    expect(out[0].payload.text).toContain("Этот бот к вашему Mac доступа не получит");
    expect(out[0].payload.reply_markup.inline_keyboard[0][0].callback_data).toBe("g:connect");
    expect(out[1].payload.text).toContain("/start");
    expect(out[2].payload.reply_markup.inline_keyboard[0][0].copy_text.text).toBe("curl -fsSL https://dist.example/i | sh");
    expect(readFileSync(join(LOGS, "host.log"), "utf8")).not.toContain("удали всё");
  });

  test("чужая кнопка «Разрешить» не решает за владельца, его сообщения доходят как прежде", async () => {
    const { tg, got } = makeTg();
    const approvals = new Approvals(tg);
    const p = approvals.confirm({ source: "тест", action: "git push origin main", timeoutMs: 300 });
    await Bun.sleep(20);
    const code = JSON.parse(readFileSync(join(LOGS, "decisions.jsonl"), "utf8").trim().split("\n").pop()!).id as string;
    await tg.bot.handleUpdate(press(OLGA, `a:${code}:y`) as any);
    await tg.bot.handleUpdate(msg(OLGA, `да ${code}`) as any);
    await tg.bot.handleUpdate(msg(OWNER, "что у нас") as any);
    expect(await p).toBe("timeout");
    expect(got).toEqual(["что у нас"]);
  });

  test("QR с Mac → код с экрана → кнопка создания бота → ключ уходит на Mac запечатанным; токен нигде не открыт", async () => {
    const { tg, calls } = makeTg();
    const dev = await deviceKeys();
    await tg.bot.handleUpdate(msg(OLGA, `/start c${dev.pub}`) as any);
    await settle();
    expect(sent(calls).pop()!.payload.text).toContain("Введите код с экрана Mac");
    await tg.bot.handleUpdate(msg(OLGA, await pairCode(dev.pub)) as any);
    await settle();
    const kb = sent(calls).pop()!.payload.reply_markup.keyboard[0][0];
    expect(kb.request_managed_bot.suggested_username).toBe("olga_t_arch_bot");
    await tg.bot.handleUpdate(created() as any);
    await settle();
    expect(calls.find((c) => c.method === "setManagedBotAccessSettings")!.payload).toMatchObject({ user_id: BOT.id, is_access_restricted: true });
    const env = [...boxes.values()][0][0] as any;
    expect(JSON.stringify(env)).not.toContain("AAbbcc");
    const l = await open(env, dev.priv, dev.pub, (await managerKey(await ensureManagerKey())).pub);
    expect(l.token).toBe(TOKEN);
    expect(l.owner).toMatchObject({ id: OLGA.id, username: "olga_t" });
    const last = sent(calls).pop()!.payload;
    expect(last.reply_markup.inline_keyboard[0][0].url).toBe("https://t.me/olga_t_arch_bot");
    expect(JSON.stringify(calls.filter((c) => !/ManagedBotToken/.test(c.method)))).not.toContain("AAbbcc");
    expect(readFileSync(join(LOGS, "host.log"), "utf8")).not.toContain("AAbbcc");
    expect(readFileSync(join(STATE, "guests.json"), "utf8")).not.toContain("AAbbcc");
  });

  test("QR одноразовый; повторное подключение переносит бота на новый Mac новым ключом — только после кода", async () => {
    const { tg, calls } = makeTg();
    const dev = await deviceKeys();
    await scan(tg, dev);
    await tg.bot.handleUpdate(created() as any);
    await settle();
    await tg.bot.handleUpdate(msg(OLGA, `/start c${dev.pub}`) as any);
    await settle();
    expect(sent(calls).pop()!.payload.text).toContain("уже использован");
    const dev2 = await deviceKeys();
    await tg.bot.handleUpdate(msg(OLGA, `/start c${dev2.pub}`) as any);
    await settle();
    expect(calls.some((c) => c.method === "replaceManagedBotToken")).toBe(false); // одной ссылки мало
    await tg.bot.handleUpdate(msg(OLGA, await pairCode(dev2.pub)) as any);
    await settle();
    expect(calls.some((c) => c.method === "replaceManagedBotToken")).toBe(true);
    expect(sent(calls).pop()!.payload.text).toContain("Прежний Mac от него отключён");
    expect(boxes.size).toBe(2);
  });

  test("ссылка из чужого Терминала: без кода с экрана того Mac — ни бота, ни перевыпуска ключа; три ошибки — конец", async () => {
    const { tg, calls } = makeTg();
    await scan(tg, await deviceKeys());
    await tg.bot.handleUpdate(created() as any); // у Ольги уже есть бот
    await settle();
    const attacker = await deviceKeys(); // ссылку прислал кто-то со своего Mac
    await tg.bot.handleUpdate(msg(OLGA, `/start c${attacker.pub}`) as any);
    const right = await pairCode(attacker.pub);
    const wrong = right === "0000" ? "1111" : "0000";
    for (let i = 0; i < 3; i++) await tg.bot.handleUpdate(msg(OLGA, wrong) as any);
    await tg.bot.handleUpdate(msg(OLGA, right) as any); // после трёх ошибок и верный код не действует
    await settle();
    expect(calls.filter((c) => c.method === "replaceManagedBotToken").length).toBe(0);
    expect(boxes.size).toBe(1);
    expect(sent(calls).map((c) => c.payload.text).join("\n")).toContain("Запустите команду на Mac ещё раз");
  });

  test("один аккаунт не глушит остальных; создание бота от Telegram проходит при любом лимите", async () => {
    const { tg, calls } = makeTg();
    for (let i = 0; i < 100; i++) await tg.bot.handleUpdate(msg(30_001, "спам") as any);
    await tg.bot.handleUpdate(msg(30_002, "/start") as any);
    await settle();
    expect(sent(calls).filter((c) => c.payload.chat_id === 30_002).length).toBe(1);
    for (let i = 0; i < 70; i++) await tg.bot.handleUpdate(msg(40_000 + i, "/start") as any); // общий лимит выбран
    await tg.bot.handleUpdate(created() as any);
    await settle();
    expect(calls.some((c) => c.method === "setManagedBotAccessSettings" && c.payload.user_id === BOT.id)).toBe(true);
  });

  test("частота: поток сообщений одного незнакомца получает не больше 8 ответов в минуту", async () => {
    const { tg, calls } = makeTg();
    for (let i = 0; i < 25; i++) await tg.bot.handleUpdate(msg(9000 + 1, "/start") as any);
    await settle();
    expect(sent(calls).length).toBe(8);
  });

  test("много разных аккаунтов за минуту — не больше 60 ответов на всех, владелец слышен", async () => {
    const { tg, calls, got } = makeTg();
    for (let i = 0; i < 90; i++) await tg.bot.handleUpdate(msg(20_000 + i, "/start") as any);
    await tg.bot.handleUpdate(msg(OWNER, "что у нас") as any);
    await settle();
    expect(sent(calls).length).toBe(60);
    expect(got).toEqual(["что у нас"]);
  });

  test("медленный ящик не задерживает сообщения владельца", async () => {
    const { tg, got } = makeTg();
    relayDelay = 1500;
    const dev = await deviceKeys();
    await scan(tg, dev);
    const t = Date.now();
    await tg.bot.handleUpdate(created() as any);
    await tg.bot.handleUpdate(msg(OWNER, "ты тут") as any);
    // не ждём ящик (1,5 с): порог — половина его задержки, а не 300 мс — на загруженной машине CI выходило 550 мс
    expect(Date.now() - t).toBeLessThan(relayDelay / 2);
    expect(got).toEqual(["ты тут"]);
    await Bun.sleep(1700);
  });

  test("предлагаемое имя бота — по правилам Telegram", () => {
    expect(suggestUsername({ username: "Olga_T" })).toBe("olga_t_arch_bot");
    expect(suggestUsername({ username: "1x" })).toMatch(/^archi_[a-z2-9]{6}_bot$/);
    expect(suggestUsername({})).toMatch(/^[a-z][a-z0-9_]{3,30}bot$/);
  });
});
