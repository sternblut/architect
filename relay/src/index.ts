// Дежурный архитектора в облаке (Cloudflare Worker + Durable Object): пока Mac спит, отвечает владельцу и копит его сообщения.
// Секретов здесь нет:
// — токена бота нет: ответ владельцу — вызов Bot API в теле ответа на webhook, его выполняет сам Telegram;
// — путь webhook знают только Telegram и Mac (новый на каждый сон), здесь лежит лишь его SHA-256;
// — запросы Mac подписаны его ключом Ed25519, здесь только открытый ключ (MAC_KEY).
// Решений здесь не бывает: нажатия кнопок и «да код» во сне не копятся — «да» Mac принимает только из своего опроса Telegram.

type Namespace = { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } };
type Env = { RELAY: Namespace; BOX: Namespace; MAC_KEY: string };
type Storage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T>(o: { prefix: string; limit?: number }): Promise<Map<string, T>>;
};
type State = { asleep: boolean; pathHash?: string; owner?: number; since?: string; summary?: string; lastTs: number; group?: string };
type Msg = { message_id: number; from?: { id: number }; chat: { id: number; type: string }; text?: string; media_group_id?: string; is_topic_message?: boolean; message_thread_id?: number };
type Update = { update_id: number; message?: Msg; callback_query?: { id: string; from: { id: number } } };

const STATUS = /^(\/status\b|(что у нас|статус|сводка)[\s?!.]*$)/i; // как в src/main.ts
const DECISION = /^(да|нет|yes|no)\s+[a-z0-9]{6,10}$/i; // запасное «да код» из src/approvals.ts
const QUEUE = "u:";

export default {
  // чужое отсекается здесь, не будя Durable Object
  fetch(req: Request, env: Env) {
    const { pathname } = new URL(req.url);
    // ящик подключения нового Mac — свой Durable Object на каждый ящик (класс Box ниже)
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

  // Всё, что не хранилище (тело, хеш, подпись), — до чтения состояния: дальше только get/put, и входной шлюз
  // Durable Object не пустит между ними другой запрос — чтение и запись состояния не перемешаются.
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
    if (ts <= st.lastTs) return new Response(null, { status: 401 }); // повтор уже принятого запроса
    if (pathname === "/sleep") {
      const b = JSON.parse(body) as Pick<State, "pathHash" | "owner" | "since" | "summary">;
      await this.save({ asleep: true, pathHash: b.pathHash, owner: b.owner, since: b.since, summary: b.summary, lastTs: ts });
      return json({ ok: true });
    }
    // /pull — Mac проснулся: подтверждённое удалить, остальное отдать; путь и сводка больше не нужны
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
    const q = u.callback_query;
    if (q) return q.from.id === st.owner ? json({ method: "answerCallbackQuery", callback_query_id: q.id, text: "Mac спит — нажмите, когда проснётся." }) : ok();
    const m = u.message;
    if (!m || m.from?.id !== st.owner || m.chat.type !== "private") return ok(); // чужое — молча и мимо очереди
    const to = {
      method: "sendMessage",
      chat_id: m.chat.id,
      message_thread_id: m.is_topic_message ? m.message_thread_id : undefined,
      reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true },
    };
    const text = (m.text ?? "").trim();
    if (STATUS.test(text)) return json({ ...to, text: st.summary ? `Mac спит ${st.since}. ${st.summary}` : `Mac спит ${st.since}, сводки перед сном нет.` });
    if (DECISION.test(text)) return json({ ...to, text: "Решения — только кнопкой, когда Mac проснётся." });
    // повтор доставки того же апдейта ложится на то же место; ответ повторяем — прошлый Telegram не получил
    await this.ctx.storage.put(QUEUE + String(u.update_id).padStart(12, "0"), u);
    if (m.media_group_id && m.media_group_id === st.group) return ok(); // альбом — один ответ на все части
    if (m.media_group_id !== st.group) await this.save({ ...st, group: m.media_group_id });
    const n = (await this.ctx.storage.list({ prefix: QUEUE })).size;
    return json({ ...to, text: n > 1 ? `Запомнил — в очереди ${n}. Начну, когда Mac проснётся.` : `Mac спит ${st.since}. Запомнил — начну, когда проснётся.` });
  }

  // Подпись Mac: Ed25519 над «путь\nвремя\nтело», время свежее (±60 с). Что время растёт, сверяет fetch по состоянию.
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

// Ящик подключения нового Mac (образец протокола — test/mock-relay.ts, шифр — src/box.ts). Конверт кладёт менеджер, забирает
// Mac: внутри шифр на ключ этого Mac и подпись менеджера — ни токенов, ни имён, ни номеров. Имя ящика — хеш ключа Mac.
//   POST /v1/box/{id}          — положить конверт (JSON до 8 КБ, в ящике до 8 конвертов) → 201
//   GET  /v1/box/{id}?wait=25  — {messages: [...]}: сразу, если есть, иначе ждём до wait секунд
// Ящик стирается целиком через 15 минут после первого конверта.
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
