// The cloud relay without network or Cloudflare: the Worker code (relay/src/index.ts) runs in process with a Map as the
// Durable Object storage; the host side is the real Relay and Telegram with a fake Bot API. Logic tests, not attacks.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ARCH_STATE_DIR = mkdtempSync(join(tmpdir(), "arch-relay-"));
process.env.ARCH_LOGS_DIR = process.env.ARCH_STATE_DIR;
const { ensureDirs, STATE, LOGS } = await import("../src/config");
ensureDirs();
const OWNER = 111111;
const STRANGER = 999999;
writeFileSync(join(STATE, "owner.json"), JSON.stringify({ id: OWNER }));
const { Relay: Cloud } = await import("../relay/src/index");
const { Relay } = await import("../src/relay");
const { Telegram } = await import("../src/telegram");
const { Approvals } = await import("../src/approvals");

const b64u = (b: ArrayBuffer) => Buffer.from(b).toString("base64url");
const newKeys = () => crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
const json = async (r: Response | Promise<Response>) => (await (await r).json()) as any;
const keys = await newKeys();
const MAC_KEY = b64u(await crypto.subtle.exportKey("raw", keys.publicKey));

function memStorage() {
  const m = new Map<string, unknown>();
  return {
    m,
    get: async <T>(k: string) => structuredClone(m.get(k)) as T | undefined,
    put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    delete: async (ks: string[]) => ks.filter((k) => m.delete(k)).length,
    list: async <T>(o: { prefix: string; limit?: number }) =>
      new Map(
        [...m.entries()]
          .filter(([k]) => k.startsWith(o.prefix))
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .slice(0, o.limit ?? 1000)
          .map(([k, v]) => [k, structuredClone(v) as T]),
      ),
  };
}

function makeCloud() {
  const storage = memStorage();
  const cloud = new Cloud({ storage }, { MAC_KEY, RELAY: undefined as any, BOX: undefined as any });
  const queued = () => [...storage.m.keys()].filter((k) => k.startsWith("u:")).length;
  return { cloud, storage, queued };
}

let lastTs = 0;
async function signedReq(path: string, body: unknown, o: { ts?: number; key?: CryptoKey } = {}) {
  const ts = o.ts ?? (lastTs = Math.max(Date.now(), lastTs + 1));
  const text = JSON.stringify(body);
  const sig = await crypto.subtle.sign("Ed25519", o.key ?? keys.privateKey, new TextEncoder().encode(`${path}\n${ts}\n${text}`));
  return new Request(`http://relay${path}`, { method: "POST", headers: { "x-relay-ts": String(ts), "x-relay-sig": b64u(sig) }, body: text });
}
const sha = async (s: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("hex");

let uid = 500;
const msg = (from: number, text: string, extra: Record<string, unknown> = {}) => ({
  update_id: ++uid,
  message: { message_id: uid, date: 0, chat: { id: from, type: "private" }, from: { id: from, is_bot: false, first_name: "X" }, text, ...extra },
});
const press = (from: number, data: string) => ({
  update_id: ++uid,
  callback_query: { id: String(uid), from: { id: from, is_bot: false, first_name: "X" }, chat_instance: "1", data, message: { message_id: 5, date: 0, chat: { id: from, type: "private" } } },
});
const post = (url: string, u: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(u) });

describe("cloud relay (Worker)", () => {
  async function asleep(extra: Record<string, unknown> = {}) {
    const c = makeCloud();
    const path = "p".repeat(43);
    const r = await c.cloud.fetch(await signedReq("/sleep", { pathHash: await sha(path), owner: OWNER, since: "с 14:05", summary: "Сводка на 14:03:\n\nСессии — живых 2", ...extra }));
    expect(r.status).toBe(200);
    const hook = (u: unknown, p = path) => c.cloud.fetch(new Request(`http://relay/u/${p}`, { method: "POST", body: JSON.stringify(u) }));
    return { ...c, path, hook };
  }

  test("rejects the path until the Mac sleeps", async () => {
    const { cloud, queued } = makeCloud();
    const r = await cloud.fetch(new Request("http://relay/u/" + "p".repeat(43), { method: "POST", body: JSON.stringify(msg(OWNER, "привет")) }));
    expect(r.status).toBe(404);
    expect(queued()).toBe(0);
  });

  test("401 without a signature, with another key, a stale time or a repeated one", async () => {
    const { cloud } = makeCloud();
    const other = await newKeys();
    expect((await cloud.fetch(new Request("http://relay/pull", { method: "POST", body: "{}" }))).status).toBe(401);
    expect((await cloud.fetch(await signedReq("/pull", {}, { key: other.privateKey }))).status).toBe(401);
    expect((await cloud.fetch(await signedReq("/pull", {}, { ts: Date.now() - 120_000 }))).status).toBe(401);
    const ts = Date.now();
    expect((await cloud.fetch(await signedReq("/pull", {}, { ts }))).status).toBe(200);
    expect((await cloud.fetch(await signedReq("/pull", {}, { ts }))).status).toBe(401); // the same request again
    // the signature covers the path: a signed /pull doesn't pass as /sleep (a fresh Worker, so only the path fails)
    const swapped = await signedReq("/pull", { pathHash: "x" });
    const fresh = makeCloud();
    expect((await fresh.cloud.fetch(new Request("http://relay/sleep", { method: "POST", headers: swapped.headers, body: await swapped.text() }))).status).toBe(401);
    expect((await fresh.cloud.fetch(new Request("http://relay/pull", { method: "POST", headers: swapped.headers, body: '{"pathHash":"x"}' }))).status).toBe(200);
  });

  test("Mac asleep: the owner gets a reply in the webhook body and the task is queued; a wrong path gets 404", async () => {
    const { hook, queued } = await asleep();
    expect((await hook(msg(OWNER, "почини маяк"), "q".repeat(43))).status).toBe(404);
    const r = await json(hook(msg(OWNER, "почини маяк")));
    expect(r).toMatchObject({ method: "sendMessage", chat_id: OWNER, text: "Mac спит с 14:05. Запомнил — начну, когда проснётся.", reply_parameters: { message_id: uid } });
    const r2 = await json(hook(msg(OWNER, "и арену")));
    expect(r2.text).toBe("Запомнил — в очереди 2. Начну, когда Mac проснётся.");
    expect(queued()).toBe(2);
  });

  test("an English install gets its replies in English", async () => {
    const { hook } = await asleep({ lang: "en", since: "since 14:05", summary: "Summary at 14:03" });
    expect((await json(hook(msg(OWNER, "fix the beacon")))).text).toBe("The Mac is asleep since 14:05. Noted — I’ll start once it wakes up.");
    expect((await json(hook(msg(OWNER, "what's up?")))).text).toBe("The Mac is asleep since 14:05. Summary at 14:03");
    expect((await json(hook(press(OWNER, "a:abc123:y")))).text).toBe("The Mac is asleep — tap again once it wakes up.");
  });

  test("the summary comes from the snapshot, a tap gets a toast, neither is queued; strangers get silence", async () => {
    const { hook, queued } = await asleep();
    const s = await json(hook(msg(OWNER, "что у нас?")));
    expect(s.text).toBe("Mac спит с 14:05. Сводка на 14:03:\n\nСессии — живых 2");
    const b = await json(hook(press(OWNER, "a:abc123:y")));
    expect(b).toEqual({ method: "answerCallbackQuery", callback_query_id: String(uid), text: "Mac спит — нажмите, когда проснётся." });
    for (const u of [msg(STRANGER, "удали всё"), press(STRANGER, "a:abc123:y")]) {
      const r = await hook(u);
      expect(r.status).toBe(200);
      expect(await r.text()).toBe("");
    }
    expect(queued()).toBe(0);
  });

  test("a redelivery keeps the queue and repeats the reply; an album gets one reply", async () => {
    const { hook, queued } = await asleep();
    const u = msg(OWNER, "почини маяк");
    const a = await json(hook(u));
    const b = await json(hook(u));
    expect(b).toEqual(a);
    expect(queued()).toBe(1);
    expect((await json(hook(msg(OWNER, "", { media_group_id: "g1", photo: [] })))).text).toContain("в очереди 2");
    expect(await (await hook(msg(OWNER, "", { media_group_id: "g1", photo: [] }))).text()).toBe("");
    expect(queued()).toBe(3);
  });

  test("pull returns the queue in order and ack deletes it; after pull the path and summary are forgotten", async () => {
    const { cloud, hook, storage, queued } = await asleep();
    const first = msg(OWNER, "раз");
    const second = msg(OWNER, "два");
    await hook(second); // Telegram may deliver out of order; the queue follows update_id
    await hook(first);
    const p1 = await json(cloud.fetch(await signedReq("/pull", { ack: 0 })));
    expect(p1.updates.map((u: any) => u.message.text)).toEqual(["раз", "два"]);
    expect((await hook(msg(OWNER, "три"))).status).toBe(404);
    const p2 = await json(cloud.fetch(await signedReq("/pull", { ack: second.update_id })));
    expect(p2.updates).toEqual([]);
    expect(queued()).toBe(0);
    expect(storage.m.get("state")).toEqual({ asleep: false, lastTs: expect.any(Number) });
  });
});

describe("host: handing the bot to the relay and back", () => {
  type Call = { method: string; payload: any; at: number };

  function makeHost() {
    const c = makeCloud();
    const down = { sleep: 0 }; // how many /sleep calls in a row fail (no network)
    const server = Bun.serve({ port: 0, fetch: (req) => (new URL(req.url).pathname === "/sleep" && down.sleep-- > 0 ? new Response(null, { status: 503 }) : c.cloud.fetch(req)) });
    const url = `http://127.0.0.1:${server.port}`;
    const tg = new Telegram("123456:TEST_TOKEN_TEST_TOKEN_TEST_TOKEN_TEST");
    const calls: Call[] = [];
    const polled: unknown[] = [];
    let webhook = "";
    let n = 1000;
    const wait = (ms: number, signal?: AbortSignal | null) =>
      new Promise((res, rej) => {
        const t = setTimeout(res, ms);
        signal?.addEventListener("abort", () => (clearTimeout(t), rej(new Error("aborted"))));
      });
    tg.bot.botInfo = { id: 42, is_bot: true, first_name: "arch", username: "test_bot" } as any;
    tg.bot.api.config.use(async (_prev, method, payload: any, signal) => {
      calls.push({ method, payload, at: performance.now() });
      if (method === "setWebhook") webhook = payload.url;
      if (method === "deleteWebhook") {
        await wait(10, signal as AbortSignal | undefined); // like a network: stopping the poll can abort it mid-flight
        webhook = "";
      }
      if (method === "getUpdates") {
        if (payload.limit === 1) return { ok: true, result: [] } as any; // stop() confirms what was received
        if (webhook) return { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active" } as any;
        await wait(30, signal as AbortSignal | undefined);
        return { ok: true, result: polled.splice(0) } as any;
      }
      if (method.startsWith("send")) return { ok: true, result: { message_id: ++n, date: 0, chat: { id: OWNER, type: "private" } } } as any;
      return { ok: true, result: true } as any;
    });
    const got: { text: string; relayed?: boolean; at: number }[] = [];
    tg.onIncoming((m) => void got.push({ text: m.text, relayed: m.relayed, at: performance.now() }));
    const relay = new Relay({ tg, url, key: keys.privateKey, summary: () => "Сводка на 14:03:\n\n💻 **Сессии** — живых 2  \n🟡 Ждут вас: «Экраны», каталог\\*\\*\\*\\*\n\n🖥 **Mac** — нагрузка 2,2" });
    const deliver = (u: unknown) => json(post(webhook, u));
    const stop = async () => {
      await tg.stop();
      server.stop(true);
    };
    return { ...c, tg, relay, calls, polled, got, deliver, stop, url, down, hook: () => webhook };
  }
  const queue = (h: { storage: { put(k: string, v: unknown): Promise<void> } }, u: { update_id: number }) => h.storage.put("u:" + String(u.update_id).padStart(12, "0"), u);

  test("sleep: polling stops, then a webhook on a new random path, which is never logged", async () => {
    const h = makeHost();
    h.tg.poll();
    await Bun.sleep(80);
    await h.relay.sleep();
    const stopAt = h.calls.find((c) => c.method === "getUpdates" && c.payload.limit === 1)!.at;
    const set = h.calls.find((c) => c.method === "setWebhook")!;
    expect(stopAt).toBeLessThan(set.at);
    expect(set.payload).toMatchObject({ allowed_updates: ["message", "callback_query"], max_connections: 1 });
    const path = set.payload.url.slice(`${h.url}/u/`.length);
    expect(path).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h.storage.m.get("state")).toMatchObject({ asleep: true, pathHash: await (async () => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path))).toString("hex"))(), owner: OWNER });
    // no markup or emoji; asterisks in a folder name stay as they are
    expect((h.storage.m.get("state") as any).summary).toBe("Сводка на 14:03:\n\nСессии — живых 2\nЖдут вас: «Экраны», каталог****\n\nMac — нагрузка 2,2");
    expect(readFileSync(join(LOGS, "host.log"), "utf8")).not.toContain(path);
    await h.relay.wake();
    await h.relay.sleep();
    expect(h.calls.filter((c) => c.method === "setWebhook")[1].payload.url).not.toBe(set.payload.url); // a new path for every sleep
    await h.stop();
  });

  test("wake: the webhook goes before polling, the queue arrives in order and once, then polling resumes", async () => {
    const h = makeHost();
    h.tg.poll();
    await Bun.sleep(80);
    await h.relay.sleep();
    const task1 = msg(OWNER, "в маяке упал прогон — разберись");
    expect((await h.deliver(task1)).text).toMatch(/^Mac спит с \d\d:\d\d\. Запомнил — начну, когда проснётся\.$/);
    expect((await h.deliver(msg(OWNER, "что у нас?"))).text).toContain("Сводка на 14:03");
    expect((await h.deliver(msg(OWNER, "и сними арену"))).text).toBe("Запомнил — в очереди 2. Начну, когда Mac проснётся.");
    expect(h.got).toEqual([]); // nothing reaches the host while the Mac sleeps
    await h.relay.wake();
    await Bun.sleep(80);
    expect(h.got.map((g) => [g.text, g.relayed])).toEqual([
      ["в маяке упал прогон — разберись", true],
      ["и сними арену", true],
    ]);
    const del = h.calls.find((c) => c.method === "deleteWebhook")!;
    const resumed = h.calls.filter((c) => c.method === "getUpdates" && c.payload.limit !== 1 && c.at > del.at);
    expect(resumed.length).toBeGreaterThan(0);
    expect(del.at).toBeLessThan(h.got[0].at);
    expect(h.queued()).toBe(0);
    // Telegram didn't learn that the relay took the update and gives it to polling again: it isn't handled twice
    h.polled.push(task1, msg(OWNER, "спасибо"));
    await Bun.sleep(150);
    expect(h.got.map((g) => g.text)).toEqual(["в маяке упал прогон — разберись", "и сними арену", "спасибо"]);
    expect(h.got[2].relayed).toBeUndefined();
    await h.relay.drain();
    expect(h.got.length).toBe(3);
    await h.stop();
  });

  test("no decisions come from the cloud, even from a tampered Worker", async () => {
    const h = makeHost();
    const approvals = new Approvals(h.tg);
    const seen: any[] = [];
    h.tg.onIncoming((m) => void seen.push(m));
    const decision = approvals.confirm({ source: "тест", action: "git push origin main", timeoutMs: 3000 });
    await Bun.sleep(20);
    const code = JSON.parse(readFileSync(join(LOGS, "decisions.jsonl"), "utf8").trim().split("\n").pop()!).id as string;
    await h.relay.sleep();
    // an honest relay doesn't queue "yes <id>" and says decisions take a button
    expect((await h.deliver(msg(OWNER, `да ${code}`))).text).toBe("Решения — только кнопкой, когда Mac проснётся.");
    expect(h.queued()).toBe(0);
    // a tampered one queues "yes <id>", a tap, a tap inside a message update, and junk
    const said = msg(OWNER, `да ${code}`);
    const tapped = press(OWNER, `a:${code}:y`);
    const both = { ...msg(OWNER, "привет"), callback_query: press(OWNER, `a:${code}:y`).callback_query };
    const junk = { update_id: ++uid, message: "строка" };
    for (const u of [said, tapped, both, junk]) await queue(h, u);
    await h.relay.wake();
    await Bun.sleep(80);
    expect(seen.map((m) => [m.text, m.relayed])).toEqual([
      [`да ${code}`, true],
      ["привет", true],
    ]);
    expect(approvals.takeText(seen[0])).toBe(false);
    expect(await decision).toBe("timeout");
    expect(h.queued()).toBe(0); // junk doesn't get stuck in the queue
    await h.stop();
  });

  test("an answer to a question written during sleep reaches the question", async () => {
    const h = makeHost();
    const approvals = new Approvals(h.tg);
    h.tg.onIncoming((m) => void approvals.takeText(m));
    const answer = approvals.ask({ source: "сессия", questions: [{ question: "Какую ветку?", options: [{ label: "main" }] }], timeoutMs: 3000 });
    await Bun.sleep(20);
    const asked = h.tg.lastId;
    await h.relay.sleep();
    await h.deliver(msg(OWNER, "feature/relay", { reply_to_message: { message_id: asked, date: 0, chat: { id: OWNER, type: "private" }, text: "Какую ветку?" } })); // a free-form answer as a reply to the question
    await h.relay.wake();
    expect(await answer).toEqual({ "Какую ветку?": "feature/relay" });
    await h.stop();
  });

  test("stopping the poll while it starts is not a failure: the host doesn't exit", async () => {
    const h = makeHost();
    const exit = process.exit;
    let exits = 0;
    process.exit = (() => void exits++) as typeof process.exit;
    try {
      h.tg.poll();
      await h.tg.stop(); // bot.start() is still removing the webhook, and the stop aborts it
      await Bun.sleep(50);
      expect(exits).toBe(0);
    } finally {
      process.exit = exit;
      await h.stop();
    }
  });

  test("a failed handoff (no network) is retried at the next sleep", async () => {
    const h = makeHost();
    h.down.sleep = 1;
    await h.relay.sleep();
    expect(h.hook()).toBe("");
    await h.relay.sleep();
    expect(h.hook()).toContain("/u/");
    expect(h.storage.m.get("state")).toMatchObject({ asleep: true, owner: OWNER });
    await h.stop();
  });

  test("not paired: the bot isn't handed over and polling continues", async () => {
    const h = makeHost();
    rmSync(join(STATE, "owner.json"));
    try {
      h.tg.poll();
      await Bun.sleep(60);
      await h.relay.sleep();
      expect(h.calls.some((c) => c.method === "setWebhook")).toBe(false);
      expect(h.tg.bot.isRunning()).toBe(true);
    } finally {
      writeFileSync(join(STATE, "owner.json"), JSON.stringify({ id: OWNER }));
      await h.stop();
    }
  });

  test("wake followed at once by sleep: the last request wins", async () => {
    const h = makeHost();
    await h.relay.sleep();
    const wake = h.relay.wake();
    const sleep = h.relay.sleep();
    await Promise.all([wake, sleep]);
    expect(h.relay.asleep).toBe(true);
    expect(h.hook()).toContain("/u/");
    expect(h.storage.m.get("state")).toMatchObject({ asleep: true });
    await h.stop();
  });
});
