// Live check of the cloud relay, locally: the Worker under wrangler dev (workerd, SQLite Durable Object), a mock Telegram,
// a mock host on the real src/relay.ts and src/telegram.ts, and a mock sleep helper. No real bot or token needed.
// Flow: the Mac sleeps → the owner writes three messages → gets replies → the Mac wakes → takes the queue → answers.
// Then a "Telegram for iOS" mockup (dark theme, 393 pt) renders screenshots of what the owner would see.
// bun test/e2e-relay.ts <screenshot folder>
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = process.argv[2] ?? join(tmpdir(), "relay-e2e-look");
mkdirSync(OUT, { recursive: true });
const TMP = mkdtempSync(join(tmpdir(), "relay-e2e-"));
process.env.ARCH_STATE_DIR = join(TMP, "state");
process.env.ARCH_LOGS_DIR = join(TMP, "state");
const { ARCH_HOME, LOGS, STATE, ensureDirs } = await import("../src/config");
ensureDirs();
const OWNER = 111111;
writeFileSync(join(STATE, "owner.json"), JSON.stringify({ id: OWNER }));
const { Relay, watchPower } = await import("../src/relay");
const { Telegram } = await import("../src/telegram");
const { Approvals } = await import("../src/approvals");
const { collect, render } = await import("../src/status");
const { hhmm } = await import("../src/util");

const checks: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, note?: string) => (checks.push([name, ok, note]), ok);
const until = async (what: string, fn: () => boolean | Promise<boolean>, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(25)) if (await fn()) return true;
  throw new Error(`timed out waiting for: ${what}`);
};

// ── cloud: the Worker, locally ───────────────────────────────────────────────
const keys = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
const MAC_KEY = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("base64url");
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const RELAY_DIR = join(ARCH_HOME, "relay");
const wrangler = Bun.spawn(
  [join(RELAY_DIR, "node_modules/.bin/wrangler"), "dev", "--ip", "127.0.0.1", "--port", String(PORT), "--inspector-port", String(PORT + 1), "--var", `MAC_KEY:${MAC_KEY}`, "--persist-to", join(TMP, "wrangler"), "--show-interactive-dev-session=false", "--log-level", "warn"],
  { cwd: RELAY_DIR, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdout: "pipe", stderr: "pipe" },
);
const wranglerLog = Promise.all([new Response(wrangler.stdout).text(), new Response(wrangler.stderr).text()]).then((x) => x.join("\n"));
await until("wrangler dev", async () => (await fetch(BASE + "/").catch(() => null))?.status === 404, 90_000);

// ── mock Telegram: Bot API for the host, webhook delivery to the relay ───────
type Line = { from: "owner" | "bot"; text: string; at: number; id: number; replyTo?: number; via?: "дежурный" | "Mac"; phase: "awake" | "asleep" | "woke" };
const chat: Line[] = [];
let phase: Line["phase"] = "awake";
let nextId = 2000;
let webhook = "";
const polled: unknown[] = [];
const calls: { method: string; at: number; payload: any }[] = [];
const tg = new Telegram("123456:TEST_TOKEN_TEST_TOKEN_TEST_TOKEN_TEST");
tg.bot.botInfo = { id: 42, is_bot: true, first_name: "Архитектор", username: "test_bot" } as any;
tg.bot.api.config.use(async (_prev, method, payload: any, signal) => {
  calls.push({ method, at: performance.now(), payload });
  if (method === "setWebhook") webhook = payload.url;
  if (method === "deleteWebhook") webhook = "";
  if (method === "getMe") return { ok: true, result: { ...tg.bot.botInfo, has_topics_enabled: false } } as any;
  if (method === "getUpdates") {
    if (payload.limit === 1) return { ok: true, result: [] } as any;
    if (webhook) return { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active" } as any;
    await new Promise((res, rej) => {
      const t = setTimeout(res, 40);
      signal?.addEventListener("abort", () => (clearTimeout(t), rej(new Error("aborted"))));
    });
    return { ok: true, result: polled.splice(0) } as any;
  }
  if (method === "sendRichMessage" || method === "sendMessage") {
    const id = ++nextId;
    chat.push({ from: "bot", text: payload.rich_message?.markdown ?? payload.text, at: Date.now(), id, replyTo: payload.reply_parameters?.message_id, via: "Mac", phase });
    return { ok: true, result: { message_id: id, date: 0, chat: { id: OWNER, type: "private" } } } as any;
  }
  return { ok: true, result: true } as any;
});

let uid = 7000;
const ownerMsg = (text: string, show = true) => {
  const id = ++nextId;
  if (show) chat.push({ from: "owner", text, at: Date.now(), id, phase });
  return { update_id: ++uid, message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: OWNER, type: "private" }, from: { id: OWNER, is_bot: false, first_name: "Владелец" }, text } };
};
// Telegram posts the update to the webhook and executes the method in the response body
async function deliver(u: any, url = webhook, show = true) {
  const t = performance.now();
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(u) });
  const body = res.status === 200 ? await res.text() : "";
  const call = body ? JSON.parse(body) : null;
  if (show && call?.method === "sendMessage") chat.push({ from: "bot", text: call.text, at: Date.now(), id: ++nextId, replyTo: call.reply_parameters?.message_id, via: "дежурный", phase });
  return { status: res.status, call, ms: Math.round(performance.now() - t) };
}
const signedPull = async (o: { key?: CryptoKey; sign?: boolean } = {}) => {
  const ts = Date.now() + 1000; // after the host's last request, or the Worker takes it for a replay
  const body = JSON.stringify({ ack: 0 });
  const sig = await crypto.subtle.sign("Ed25519", o.key ?? keys.privateKey, new TextEncoder().encode(`/pull\n${ts}\n${body}`));
  const headers: Record<string, string> = o.sign === false ? {} : { "x-relay-ts": String(ts), "x-relay-sig": Buffer.from(sig).toString("base64url") };
  return fetch(BASE + "/pull", { method: "POST", headers, body });
};

// ── mock host: the real Relay and Telegram, a canned architect ───────────────
const approvals = new Approvals(tg);
const got: { text: string; relayed?: boolean }[] = [];
const ANSWERS: [RegExp, string][] = [
  [/маяк/i, "Беру. Запускаю сессию в папке маяка — разберётся с прогоном на main и напишет в своей теме, что нашла."],
  [/арен/i, "Сниму арену на iPhone, когда сессия маяка закончит, и пришлю сюда."],
];
tg.onIncoming(async (m) => {
  got.push({ text: m.text, relayed: m.relayed });
  if (approvals.takeText(m)) return;
  const a = ANSWERS.find(([re]) => re.test(m.text));
  if (a) await tg.send(a[1], { replyTo: m.messageId });
});

let summary = "";
try {
  const o = await collect(false); // this Mac's real overview: sessions, sites, load (no GitHub)
  summary = `Сводка на ${hhmm(new Date(o.at))}:\n\n${render(o)}`;
} catch (e) {
  summary = "Сводка на 12:00:\n\n**Сессии** — живых 2, работают 1";
}
const relay = new Relay({ tg, url: BASE, key: keys.privateKey, summary: () => summary });

const HELPER_LOG = join(TMP, "helper.jsonl");
const helperSrc = join(TMP, "fake-powerwatch.ts");
writeFileSync(
  helperSrc,
  `// mock sleep helper: SIGUSR1 means going to sleep, SIGUSR2 awake; it measures how long sleep waits for the host
import { appendFileSync } from "node:fs";
let seq = 0, t0 = 0;
appendFileSync(${JSON.stringify(HELPER_LOG)}, JSON.stringify({ ready: true }) + "\\n");
process.on("SIGUSR1", () => { seq++; t0 = performance.now(); process.stdout.write("sleep " + seq + "\\n"); });
process.on("SIGUSR2", () => { process.stdout.write("wake\\n"); });
for await (const line of console) if (line.startsWith("ok ")) appendFileSync(${JSON.stringify(HELPER_LOG)}, JSON.stringify({ ok: Number(line.slice(3)), ms: Math.round(performance.now() - t0) }) + "\\n");
process.exit(0);
`,
);

await tg.start();
await relay.drain(); // as at host start
const helper = watchPower(relay, [process.execPath, helperSrc]);
await until("the helper to start", () => existsSync(HELPER_LOG));

// ── 1. the Mac goes to sleep ─────────────────────────────────────────────────
phase = "asleep";
const sleptAt = Date.now();
helper.kill("SIGUSR1");
await until("ok from the host", () => existsSync(HELPER_LOG) && readFileSync(HELPER_LOG, "utf8").includes('"ok":1'));
const handoffMs = JSON.parse(readFileSync(HELPER_LOG, "utf8").trim().split("\n").find((l) => l.includes('"ok":1'))!).ms as number;
const set = calls.find((c) => c.method === "setWebhook");
const stopCall = calls.find((c) => c.method === "getUpdates" && c.payload.limit === 1);
check("sleep: polling stopped before the webhook was set", !!set && !!stopCall && stopCall.at < set.at);
check("the webhook points to the Worker under a random 43-character path", /^http:\/\/127\.0\.0\.1:8791\/u\/[A-Za-z0-9_-]{43}$/.test(webhook));
check("the path stayed out of the host log", !readFileSync(join(LOGS, "host.log"), "utf8").includes(webhook.split("/u/")[1]));
check("sleep waited for the host less than 20 s", handoffMs < 20_000, `${handoffMs} ms`);

// ── 2. the owner writes while the Mac sleeps ─────────────────────────────────
const m1 = ownerMsg("В маяке упал прогон на main, разберись");
const r1 = await deliver(m1);
const retry = await deliver(m1, webhook, false); // Telegram got no 200 and resends the same update
const r2 = await deliver(ownerMsg("Что у нас?"));
const m3 = ownerMsg("И потом сними арену на телефоне");
const r3 = await deliver(m3);
check("a task gets its reply in the webhook body, without a token", r1.call?.method === "sendMessage" && /^Mac спит с \d\d:\d\d\. Запомнил — начну, когда проснётся\.$/.test(r1.call.text), r1.call?.text);
check("a redelivery gets the same reply and the queue doesn't grow", retry.call?.text === r1.call?.text && r3.call?.text === "Запомнил — в очереди 2. Начну, когда Mac проснётся.", r3.call?.text);
check(
  "what's up gets the pre-sleep summary, without markup or emoji",
  r2.call?.text?.startsWith("Mac спит с ") && /Сводка на \d\d:\d\d:\n\n/.test(r2.call.text) && /\nMac — нагрузка/.test(r2.call.text) && !/\p{Extended_Pictographic}/u.test(r2.call.text),
);
check("nothing reached the host during sleep", got.length === 0);
const wrong = await deliver(ownerMsg("чужой путь", false), webhook.replace(/\/u\/.+$/, "/u/" + "x".repeat(43)), false);
check("a wrong path gets 404", wrong.status === 404);
const stranger = await deliver({ update_id: ++uid, message: { message_id: ++nextId, date: 0, chat: { id: 5, type: "private" }, from: { id: 5, is_bot: false, first_name: "Чужой" }, text: "удали всё" } }, webhook, false);
check("a stranger gets no reply and isn't queued", stranger.status === 200 && stranger.call === null);
const pressed = await deliver({ update_id: ++uid, callback_query: { id: "cb1", from: { id: OWNER, is_bot: false, first_name: "Владелец" }, chat_instance: "1", data: "a:abcd1234:y" } }, webhook, false);
check("a tap during sleep gets a toast and no decision", pressed.call?.method === "answerCallbackQuery" && pressed.call.text === "Mac спит — нажмите, когда проснётся.");
check("no signature gets 401", (await signedPull({ sign: false })).status === 401);
const otherKey = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
check("another key gets 401", (await signedPull({ key: otherKey.privateKey })).status === 401);

// ── 3. the Mac wakes up ──────────────────────────────────────────────────────
phase = "woke";
const wakeAt = performance.now();
helper.kill("SIGUSR2");
await until("real answers", () => chat.filter((l) => l.via === "Mac" && l.phase === "woke").length >= 2);
const del = calls.find((c) => c.method === "deleteWebhook" && c.at > wakeAt);
await until("polling again", () => calls.some((c) => c.method === "getUpdates" && c.payload.limit !== 1 && c.at > (del?.at ?? Infinity)));
const resumed = calls.find((c) => c.method === "getUpdates" && c.payload.limit !== 1 && c.at > (del?.at ?? Infinity))!;
const wakeMs = Math.round(resumed.at - wakeAt);
check("the host didn't poll Telegram while the webhook was set", !calls.some((c) => c.method === "getUpdates" && c.payload.limit !== 1 && c.at > set!.at && c.at < (del?.at ?? 0)));
check("awake: the webhook is removed and the queue arrives in order, once, marked as relayed", !!del && JSON.stringify(got) === JSON.stringify([{ text: m1.message.text, relayed: true }, { text: m3.message.text, relayed: true }]), JSON.stringify(got));
const after = (await (await signedPull()).json()) as { updates: unknown[] };
check("the cloud queue is empty", after.updates.length === 0);
check("the old path is no longer accepted", (await deliver(ownerMsg("после", false), set!.payload.url, false)).status === 404);
polled.push(m1, ownerMsg("Понял, спасибо", false));
await until("a message through polling", () => got.length === 3);
await Bun.sleep(200);
check("polling works again and a Telegram resend isn't handled twice", got.length === 3 && got[2].text === "Понял, спасибо" && !got[2].relayed);

// ── result ───────────────────────────────────────────────────────────────────
helper.stdin.end();
await tg.stop();
wrangler.kill("SIGTERM");
await wrangler.exited;
const timings = { handoffMs, wakeMs, webhookReplyMs: [r1.ms, r2.ms, r3.ms] };
writeFileSync(join(OUT, "transcript.json"), JSON.stringify({ chat, checks, timings }, null, 1));
for (const [name, ok, note] of checks) console.log(`${ok ? "ok   " : "FAIL "} ${name}${note ? ` — ${note}` : ""}`);
console.log(JSON.stringify(timings));
if (checks.some(([, ok]) => !ok)) {
  console.log(await wranglerLog);
  process.exit(1);
}

// ── "Telegram for iOS" mockup: what the owner would see ──────────────────────
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const md = (s: string) => esc(s).replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
const at = (ms: number) => hhmm(new Date(ms));
function bubble(l: Line) {
  const q = l.replyTo ? chat.find((x) => x.id === l.replyTo) : undefined;
  const quote = q ? `<div class="quote"><b>Вы</b><span>${esc(q.text.split("\n")[0])}</span></div>` : "";
  const ticks = l.from === "owner" ? `<svg class="ticks" viewBox="0 0 18 10"><path d="M1 5.5l3 3 6-7M7 8.5l1 0.5 7-8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>` : "";
  return `<div class="msg ${l.from === "owner" ? "out" : "in"}">${quote}<div class="body">${md(l.text)}<span class="time">${at(l.at)}${ticks}</span></div></div>`;
}
function page(lines: Line[], opts: { full?: boolean; top?: boolean; clock: string; pinned: string }) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Архитектор</title><style>
:root{--bg:#000;--bar:rgba(18,18,20,.94);--in:#262628;--out:#3a6aa4;--text:#fff;--muted:#8e8e93;--accent:#64a8f0}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg)}
body{font:17px/22px -apple-system,"SF Pro Text",system-ui,sans-serif;color:var(--text);-webkit-font-smoothing:antialiased;letter-spacing:-.2px}
.phone{width:393px;${opts.full ? "min-height:852px" : "height:852px"};position:relative;overflow:hidden;background:radial-gradient(120% 70% at 80% 10%,#16213a 0,#0b0f19 45%,#050608 100%)}
.top{position:${opts.full ? "relative" : "absolute"};top:0;left:0;right:0;z-index:2;background:var(--bar);-webkit-backdrop-filter:blur(20px)}
.status{height:54px;display:flex;justify-content:space-between;align-items:center;padding:4px 30px 0 46px;font:600 17px/1 -apple-system,system-ui}
.status svg{height:12px;margin-left:6px;fill:#fff}
.nav{height:52px;display:grid;grid-template-columns:90px 1fr 90px;align-items:center;padding:0 10px 4px}
.back{color:var(--accent);display:flex;align-items:center;gap:2px;font-size:17px}
.back svg{width:12px;height:20px}
.title{text-align:center;line-height:20px}.title b{display:block;font-weight:600;font-size:17px}.title span{font-size:13px;color:var(--muted)}
.ava{justify-self:end;width:38px;height:38px;border-radius:50%;background:linear-gradient(160deg,#6aa9ff,#3d5fd6);display:grid;place-items:center;font-weight:600;font-size:17px}
.pin{height:42px;border-top:.5px solid #2c2c2e;border-bottom:.5px solid #2c2c2e;display:flex;align-items:center;gap:10px;padding:0 14px;font-size:14px;line-height:18px}
.pin i{width:2px;height:28px;background:var(--accent);border-radius:1px}.pin b{display:block;color:var(--accent);font-weight:600;font-size:13px}.pin span{color:#d0d0d4}
.chat{${opts.full ? "padding:8px 0 96px" : "position:absolute;top:148px;bottom:84px;left:0;right:0;padding:8px 0"};display:flex;flex-direction:column;justify-content:${opts.top ? "flex-start" : "flex-end"};overflow:hidden}
.day{align-self:center;font-size:13px;line-height:18px;padding:2px 9px;border-radius:10px;background:rgba(36,38,44,.85);margin:6px 0 8px;font-weight:500}
.msg{max-width:308px;margin:3px 10px;padding:6px 11px 7px 12px;border-radius:17px;white-space:pre-wrap;word-wrap:break-word}
.msg.in{align-self:flex-start;background:var(--in);border-bottom-left-radius:5px}
.msg.out{align-self:flex-end;background:var(--out);border-bottom-right-radius:5px}
.msg + .msg.in, .msg + .msg.out{margin-top:3px}
.quote{display:flex;flex-direction:column;border-left:3px solid var(--accent);background:rgba(100,168,240,.13);border-radius:5px;padding:3px 8px 4px;margin:2px 0 5px;font-size:14px;line-height:18px;max-width:100%}
.quote b{color:var(--accent);font-weight:600}.quote span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#dcdce0}
.out .quote{border-color:#cfe3ff;background:rgba(255,255,255,.14)}.out .quote b{color:#e6f0ff}
.time{float:right;display:inline-flex;align-items:center;gap:3px;font-size:11px;line-height:12px;color:rgba(235,235,245,.5);margin:9px -3px -5px 10px}
.out .time{color:rgba(255,255,255,.62)}.ticks{width:16px;height:10px;color:rgba(255,255,255,.75)}
.bottom{position:absolute;bottom:0;left:0;right:0;height:84px;background:var(--bar);border-top:.5px solid #2c2c2e;z-index:2}
.bar{display:flex;align-items:center;gap:10px;padding:7px 10px}
.bar svg{width:28px;height:28px;stroke:#8e8e93;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}
.field{flex:1;height:36px;border-radius:18px;border:.5px solid #3a3a3c;background:#0f0f10;color:#6d6d72;display:flex;align-items:center;padding:0 14px}
.home{position:absolute;bottom:8px;left:50%;width:134px;height:5px;margin-left:-67px;border-radius:3px;background:#fff}
</style></head><body><div class="phone">
<div class="top"><div class="status"><span>${opts.clock}</span><span><svg viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg><svg viewBox="0 0 16 12"><path d="M8 11.5l2.3-2.6a3.3 3.3 0 00-4.6 0zM8 6.3c1.7 0 3.2.6 4.3 1.7l1.4-1.6A8.1 8.1 0 008 4.1a8.1 8.1 0 00-5.7 2.3L3.7 8A6 6 0 018 6.3zm0-4.2c2.9 0 5.5 1.1 7.4 3l1.3-1.5A12.2 12.2 0 008 0 12.2 12.2 0 00-.7 3.6L.6 5.1A10.4 10.4 0 018 2.1z"/></svg><svg viewBox="0 0 27 12"><rect x=".5" y=".5" width="23" height="11" rx="3" fill="none" stroke="#fff" opacity=".4"/><rect x="2" y="2" width="16" height="8" rx="1.6"/><rect x="24.5" y="4" width="1.6" height="4" rx=".8" opacity=".4"/></svg></span></div>
<div class="nav"><span class="back"><svg viewBox="0 0 12 20"><path d="M10 2L2 10l8 8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>Чаты</span><span class="title"><b>Архитектор</b><span>бот</span></span><span class="ava">А</span></div>
<div class="pin"><i></i><div><b>Закреплённое сообщение</b><span>Пульт · ${opts.pinned}</span></div></div></div>
<div class="chat"><div class="day">Сегодня</div>${lines.map(bubble).join("")}</div>
<div class="bottom"><div class="bar"><svg viewBox="0 0 28 28"><path d="M17.5 8.5l-7.3 7.3a2.2 2.2 0 003.1 3.1l8-8a4.2 4.2 0 00-6-6l-8.4 8.4a6.2 6.2 0 008.8 8.8l6.5-6.5"/></svg><div class="field">Сообщение</div><svg viewBox="0 0 28 28"><rect x="10" y="3.5" width="8" height="14" rx="4"/><path d="M6.5 13.5a7.5 7.5 0 0015 0M14 21v3.5"/></svg></div><div class="home"></div></div>
</div></body></html>`;
}

const visible = chat.filter((l) => l.text);
const asleepLines = visible.filter((l) => l.phase !== "woke");
const shots: [string, string, boolean][] = [
  ["1-mac-spit-nachalo.png", page(asleepLines, { clock: at(asleepLines.at(-1)!.at), pinned: at(sleptAt), top: true }), false],
  ["2-mac-spit-konec.png", page(asleepLines, { clock: at(asleepLines.at(-1)!.at), pinned: at(sleptAt) }), false],
  ["3-mac-prosnulsya.png", page(visible, { clock: at(visible.at(-1)!.at), pinned: at(sleptAt) }), false],
  ["4-vsya-perepiska.png", page(visible, { clock: at(visible.at(-1)!.at), pinned: at(sleptAt), full: true }), true],
];
const { webkit } = await import("playwright-core");
const browser = await webkit.launch({ headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "ru-RU", colorScheme: "dark" });
  const page_ = await ctx.newPage();
  for (const [file, html, full] of shots) {
    writeFileSync(join(OUT, file.replace(".png", ".html")), html);
    await page_.setContent(html, { waitUntil: "load" });
    await page_.screenshot({ path: join(OUT, file), fullPage: full });
  }
} finally {
  await browser.close();
}
console.log(`mockup and screenshots: ${OUT}`);
process.exit(0);
