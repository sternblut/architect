// The cloud connection mailbox (relay/src/index.ts, class Box) speaks the same protocol as test/mock-relay.ts and works
// with the real client in src/box.ts: the manager posts an envelope, the Mac takes it, opens it and checks the signature.
import { expect, test } from "bun:test";
import worker, { Box } from "../relay/src/index";
import { boxId, deviceKeys, managerKey, newManagerKey, open, postBox, seal, waitBox } from "../src/box";

function memStorage() {
  const m = new Map<string, unknown>();
  let alarm = 0;
  return {
    m,
    alarmAt: () => alarm,
    get: async <T>(k: string) => structuredClone(m.get(k)) as T | undefined,
    put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    deleteAll: async () => m.clear(),
    setAlarm: async (t: number) => void (alarm = t),
  };
}

// One Durable Object per box, as in Cloudflare: idFromName → the same instance
function boxes() {
  const all = new Map<string, Box>();
  const storages = new Map<string, ReturnType<typeof memStorage>>();
  return {
    storages,
    idFromName: (name: string) => name,
    get: (id: unknown) => {
      const k = String(id);
      if (!all.has(k)) storages.set(k, memStorage()), all.set(k, new Box({ storage: storages.get(k)! }));
      return all.get(k)!;
    },
  };
}

test("box: the real client posts and fetches an envelope through the Worker; signature and ciphertext check out", async () => {
  const BOX = boxes();
  const env = { BOX, RELAY: undefined as never, MAC_KEY: "" };
  const server = Bun.serve({ port: 0, fetch: (req) => worker.fetch(req, env) });
  const relay = `http://127.0.0.1:${server.port}`;
  try {
    const mac = await deviceKeys();
    const mgr = await managerKey(await newManagerKey());
    const id = await boxId(mac.pub);
    const waiting = waitBox(relay, id, 5); // the Mac waits before the manager posts
    await Bun.sleep(100);
    const letter = { v: 1 as const, token: "123456789:AAH-test-token-for-the-box-protocol", bot: { id: 7, username: "x_bot" }, owner: { id: 42, name: "Новый человек" }, manager: "sapfirarchitect_bot", at: Date.now() };
    await postBox(relay, id, await seal(letter, mac.pub, mgr.priv));
    const got = await waiting;
    expect(got.length).toBe(1);
    expect(await open(got[0], mac.priv, mac.pub, mgr.pub)).toMatchObject({ token: "123456789:AAH-test-token-for-the-box-protocol", owner: { id: 42 } });
    // the cloud storage holds only ciphertext
    expect(JSON.stringify([...BOX.storages.get(id)!.m.values()])).not.toContain("AAH-test-token");
  } finally {
    server.stop(true);
  }
});

test("box: up to 8 envelopes of 8 KB, erased after 15 minutes; other paths and methods get 404", async () => {
  const storage = memStorage();
  const box = new Box({ storage });
  const put = (body: string) => box.fetch(new Request("https://r/v1/box/abcdefghijklmnop", { method: "POST", body }));
  expect((await put("{}")).status).toBe(201);
  expect(storage.alarmAt() - Date.now()).toBeGreaterThan(14 * 60_000);
  for (let i = 0; i < 7; i++) await put(`{"n":${i}}`);
  expect((await put("{}")).status).toBe(429);
  expect((await put(`{"x":"${"a".repeat(9000)}"}`)).status).toBe(413);
  expect((await put("не json")).status).toBe(400);
  await box.alarm();
  expect(await (await box.fetch(new Request("https://r/v1/box/abcdefghijklmnop"))).json()).toEqual({ messages: [] });
  const env = { BOX: boxes(), RELAY: undefined as never, MAC_KEY: "" };
  expect((await worker.fetch(new Request("https://r/v1/box/short", { method: "POST", body: "{}" }), env)).status).toBe(404);
  expect((await worker.fetch(new Request("https://r/v1/box/abcdefghijklmnop", { method: "DELETE" }), env)).status).toBe(404);
});
