// The architect's cloud relay (Cloudflare Worker + Durable Object): while the Mac sleeps it answers the owner and keeps
// their messages. It holds no secrets:
// - no bot token: a reply is a Bot API call in the webhook response, which Telegram itself executes;
// - the webhook path is known only to Telegram and the Mac (a new one for every sleep); only its SHA-256 is stored;
// - the Mac signs its requests with its Ed25519 key; only the public key (MAC_KEY) is here.
// It never takes decisions: taps and "yes <id>" aren't queued, and the Mac accepts a yes only from its own polling.

type Namespace = { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } };
type Env = { RELAY: Namespace; BOX: Namespace; MAC_KEY: string };
type Storage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T>(o: { prefix: string; limit?: number }): Promise<Map<string, T>>;
};
type State = { asleep: boolean; pathHash?: string; owner?: number; since?: string; summary?: string; lang?: "ru" | "en"; lastTs: number; group?: string };
type Msg = { message_id: number; from?: { id: number }; chat: { id: number; type: string }; text?: string; media_group_id?: string; is_topic_message?: boolean; message_thread_id?: number };
type Update = { update_id: number; message?: Msg; callback_query?: { id: string; from: { id: number } } };

const STATUS = /^(\/status\b|(что у нас|статус|сводка|what'?s up|status|summary)[\s?!.]*$)/i; // /status or "what's up"
const DECISION = /^(да|нет|yes|no)\s+[a-z0-9]{6,10}$/i; // the "yes <id>" fallback of src/approvals.ts
const QUEUE = "u:";

export default {
  // Reject anything foreign here, without waking the Durable Object
  fetch(req: Request, env: Env) {
    const { pathname } = new URL(req.url);
    // the connection mailbox: one Durable Object per box (class Box below)
    const box = pathname.match(/^\/v1\/box\/([\w-]{16,64})$/);
    if (box) return req.method === "POST" || req.method === "GET" ? env.BOX.get(env.BOX.idFromName(box[1])).fetch(req) : none();
    if (req.method !== "POST" || !(pathname.startsWith("/u/") || pathname === "/sleep" || pathname === "/pull")) return none();
    if (!pathname.startsWith("/u/") && !req.headers.get("x-relay-sig")) return new Response(null, { status: 401 });
    return env.RELAY.get(env.RELAY.idFromName("relay")).fetch(req);
  },
};

export class Relay {
  constructor(
    private ctx: { storage: Storage },
    private env: Env,
  ) {}

  // Everything but storage (body, hash, signature) happens before reading the state; after that only get/put follow,
  // and the Durable Object's input gate keeps other requests from interleaving between them.
  async fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (req.method !== "POST") return none();
    if (pathname.startsWith("/u/")) {
      const [hash, u] = await Promise.all([sha256(pathname.slice(3)), req.json().catch(() => null)]);
      return this.webhook(hash, u as Update | null);
    }
    if (pathname !== "/sleep" && pathname !== "/pull") return none();
    const ts = Number(req.headers.get("x-relay-ts"));
    const body = await req.text();
    if (!(await this.signed(pathname, ts, req.headers.get("x-relay-sig") ?? "", body))) return new Response(null, { status: 401 });
    const st = await this.state();
    if (ts <= st.lastTs) return new Response(null, { status: 401 }); // a replay of an accepted request
    if (pathname === "/sleep") {
      const b = JSON.parse(body) as Pick<State, "pathHash" | "owner" | "since" | "summary" | "lang">;
      await this.save({ asleep: true, pathHash: b.pathHash, owner: b.owner, since: b.since, summary: b.summary, lang: b.lang, lastTs: ts });
      return json({ ok: true });
    }
    // /pull: the Mac is awake; delete what it acknowledged, return the rest, forget the path and summary
    const { ack = 0 } = JSON.parse(body) as { ack?: number };
    const q = await this.ctx.storage.list<Update>({ prefix: QUEUE, limit: 500 });
    const done = [...q.keys()].filter((k) => Number(k.slice(QUEUE.length)) <= ack);
    for (let i = 0; i < done.length; i += 128) await this.ctx.storage.delete(done.slice(i, i + 128));
    await this.save({ asleep: false, lastTs: ts });
    return json({ updates: [...q.values()].filter((u) => u.update_id > ack) });
  }

  private async webhook(hash: string, u: Update | null): Promise<Response> {
    const st = await this.state();
    if (!st.asleep || !st.pathHash || hash !== st.pathHash) return none();
    if (!u) return ok();
    const tr = (ru: string, en: string) => (st.lang === "en" ? en : ru); // the owner's language, from the Mac
    const q = u.callback_query;
    if (q) return q.from.id === st.owner ? json({ method: "answerCallbackQuery", callback_query_id: q.id, text: tr("Mac спит — нажмите, когда проснётся.", "The Mac is asleep — tap again once it wakes up.") }) : ok();
    const m = u.message;
    if (!m || m.from?.id !== st.owner || m.chat.type !== "private") return ok(); // strangers: silently, not queued
    const to = {
      method: "sendMessage",
      chat_id: m.chat.id,
      message_thread_id: m.is_topic_message ? m.message_thread_id : undefined,
      reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true },
    };
    const text = (m.text ?? "").trim();
    if (STATUS.test(text)) return json({ ...to, text: st.summary ? tr(`Mac спит ${st.since}. ${st.summary}`, `The Mac is asleep ${st.since}. ${st.summary}`) : tr(`Mac спит ${st.since}, сводки перед сном нет.`, `The Mac is asleep ${st.since}; no summary from before it slept.`) });
    if (DECISION.test(text)) return json({ ...to, text: tr("Решения — только кнопкой, когда Mac проснётся.", "Decisions only with a button, once the Mac wakes up.") });
    // a redelivered update lands in the same slot; reply again, since Telegram didn't get the last reply
    await this.ctx.storage.put(QUEUE + String(u.update_id).padStart(12, "0"), u);
    if (m.media_group_id && m.media_group_id === st.group) return ok(); // one reply per album
    if (m.media_group_id !== st.group) await this.save({ ...st, group: m.media_group_id });
    const n = (await this.ctx.storage.list({ prefix: QUEUE })).size;
    return json({ ...to, text: n > 1 ? tr(`Запомнил — в очереди ${n}. Начну, когда Mac проснётся.`, `Noted — ${n} in the queue. I’ll start once the Mac wakes up.`) : tr(`Mac спит ${st.since}. Запомнил — начну, когда проснётся.`, `The Mac is asleep ${st.since}. Noted — I’ll start once it wakes up.`) });
  }

  // The Mac's signature: Ed25519 over "path\ntime\nbody" with a fresh time (±60 s); fetch checks that time increases
  private async signed(path: string, ts: number, sig: string, body: string): Promise<boolean> {
    if (!this.env.MAC_KEY || !(Math.abs(Date.now() - ts) <= 60_000)) return false;
    try {
      const key = await crypto.subtle.importKey("raw", unb64(this.env.MAC_KEY), { name: "Ed25519" }, false, ["verify"]);
      return await crypto.subtle.verify("Ed25519", key, unb64(sig), new TextEncoder().encode(`${path}\n${ts}\n${body}`));
    } catch {
      return false;
    }
  }

  private async state() {
    return (await this.ctx.storage.get<State>("state")) ?? { asleep: false, lastTs: 0 };
  }

  private save(st: State) {
    return this.ctx.storage.put("state", st);
  }
}

const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
const ok = () => new Response(null, { status: 200 });
const none = () => new Response(null, { status: 404 });

// The connection mailbox for a new Mac (crypto in src/box.ts; test/mock-relay.ts mimics it). The manager puts an envelope
// in, the Mac takes it out: ciphertext for that Mac's key plus the manager's signature, no tokens, names or ids in the
// clear. The box id is a hash of the Mac's key.
//   POST /v1/box/{id}          put an envelope (JSON up to 8 KB, up to 8 per box) → 201
//   GET  /v1/box/{id}?wait=25  {messages: [...]} right away if any, else after waiting up to wait seconds
// The whole box is erased 15 minutes after the first envelope.
const BOX_TTL = 15 * 60_000;
type BoxStorage = { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void>; deleteAll(): Promise<void>; setAlarm(at: number): Promise<void> };
type Letter = { at: number; m: unknown };

export class Box {
  private waiters: (() => void)[] = [];
  constructor(private ctx: { storage: BoxStorage }) {}

  private async letters(): Promise<Letter[]> {
    return ((await this.ctx.storage.get<Letter[]>("m")) ?? []).filter((x) => Date.now() - x.at < BOX_TTL);
  }

  async fetch(req: Request): Promise<Response> {
    if (req.method === "POST") {
      const raw = await req.text();
      if (raw.length > 8192) return new Response("too large", { status: 413 });
      let m: unknown;
      try {
        m = JSON.parse(raw);
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const all = await this.letters();
      if (all.length >= 8) return new Response("full", { status: 429 });
      all.push({ at: Date.now(), m });
      await this.ctx.storage.put("m", all);
      if (all.length === 1) await this.ctx.storage.setAlarm(Date.now() + BOX_TTL);
      for (const w of this.waiters.splice(0)) w();
      return new Response("{}", { status: 201 });
    }
    const wait = Math.min(Number(new URL(req.url).searchParams.get("wait")) || 0, 25);
    if (wait > 0 && !(await this.letters()).length) await new Promise<void>((r) => (this.waiters.push(r), setTimeout(r, wait * 1000)));
    return Response.json({ messages: (await this.letters()).map((x) => x.m) });
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function sha256(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
