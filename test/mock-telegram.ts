// Подставной Telegram Bot API для живых проверок: HTTP на 127.0.0.1, grammY ходит сюда через apiRoot (ARCH_TG_API).
// Держит несколько ботов по токенам, очередь апдейтов на каждого, «человека», который пишет и нажимает кнопки,
// и записывает всё, что человек видит в своих чатах.
type User = { id: number; is_bot: boolean; first_name: string; last_name?: string; username?: string };
type Btn = { text: string; kind: "callback" | "url" | "copy"; style?: string; data?: string; url?: string; copy?: string };
type KBtn = { text: string; kind: "text" | "managed_bot"; req?: { suggested_name?: string; suggested_username?: string } };
export type ChatEvent =
  | { t: "bot"; id: number; at: string; text: string; format: "plain" | "html" | "markdown"; inline?: Btn[][]; reply?: { rows: KBtn[][]; oneTime?: boolean } | null }
  | { t: "edit"; id: number; text?: string; format?: "plain" | "html" | "markdown"; inline?: Btn[][] | null }
  | { t: "delete"; id: number }
  | { t: "user"; id: number; at: string; text: string }
  | { t: "service"; at: string; text: string }
  | { t: "press"; id: number; at: string; data: string; toast?: string }
  | { t: "pin"; id: number };

type Bot = { user: User; token: string; canManage: boolean; manager?: string; restricted?: boolean; description?: string; updates: any[]; next: number; wake?: () => void; seq: number };

const hhmm = () => new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });

export class MockTelegram {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  bots = new Map<string, Bot>(); // по имени
  chats = new Map<string, ChatEvent[]>(); // переписка человека с ботом, по имени бота
  calls: { bot: string; method: string; payload: any }[] = [];
  private nextUser = 1;

  constructor(public person: User) {
    this.server = Bun.serve({ port: 0, idleTimeout: 60, fetch: (req) => this.handle(req) });
    this.url = `http://127.0.0.1:${this.server.port}`;
  }

  addBot(username: string, first_name: string, o: { id?: number; canManage?: boolean; manager?: string } = {}): Bot {
    const id = o.id ?? 7000000000 + this.nextUser++;
    const b: Bot = { user: { id, is_bot: true, first_name, username }, token: newToken(id), canManage: !!o.canManage, manager: o.manager, updates: [], next: 1, seq: 0 };
    this.bots.set(username, b);
    this.chats.set(username, []);
    return b;
  }

  stop() {
    for (const b of this.bots.values()) b.wake?.();
    this.server.stop(true);
  }

  private byToken(token: string) {
    return [...this.bots.values()].find((b) => b.token === token);
  }

  private push(b: Bot, u: Record<string, unknown>) {
    b.updates.push({ update_id: b.next++, ...u });
    b.wake?.();
  }

  private log(bot: string, e: ChatEvent) {
    this.chats.get(bot)!.push(e);
  }

  // ── человек ────────────────────────────────────────────────────────────────

  say(bot: string, text: string, from: User = this.person) {
    const b = this.bots.get(bot)!;
    const id = ++b.seq;
    // параметр ссылки t.me/бот?start=… Telegram отправляет боту, но в чате человек видит просто «/start»
    if (from.id === this.person.id) this.log(bot, { t: "user", id, at: hhmm(), text: text.startsWith("/start ") ? "/start" : text });
    const entities = text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0].length }] : undefined;
    this.push(b, { message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: from.id, type: "private", first_name: from.first_name }, from, text, entities } });
  }

  // Нажатие инлайн-кнопки по её тексту в последнем виде сообщения.
  press(bot: string, text: string): Btn {
    const b = this.bots.get(bot)!;
    const { id, btn } = this.findButton(bot, text);
    this.log(bot, { t: "press", id, at: hhmm(), data: btn.data ?? btn.kind, ...(btn.kind === "copy" ? { toast: "Скопировано" } : {}) });
    if (btn.kind === "callback") this.push(b, { callback_query: { id: `cq${b.next}`, from: this.person, chat_instance: "1", data: btn.data, message: { message_id: id, date: 0, chat: { id: this.person.id, type: "private" } } } });
    return btn;
  }

  // Кнопка своей клавиатуры Telegram (под полем ввода). «Создать бота» — как настоящий Telegram: новый бот и апдейты менеджеру.
  pressKeyboard(bot: string, text: string): Bot | undefined {
    const kb = this.activeKeyboard(bot);
    const k = kb?.rows.flat().find((x) => x.text === text);
    if (!k) throw new Error(`нет кнопки «${text}» в клавиатуре @${bot}`);
    if (k.kind === "text") return void this.say(bot, text);
    const name = k.req?.suggested_username ?? "personal_arch_bot";
    const created = this.addBot(name, k.req?.suggested_name ?? "Бот", { manager: bot });
    const b = this.bots.get(bot)!;
    this.log(bot, { t: "service", at: hhmm(), text: `Вы создали бота @${name}` });
    this.push(b, { message: { message_id: ++b.seq, date: 0, chat: { id: this.person.id, type: "private" }, from: this.person, managed_bot_created: { bot: created.user } } });
    this.push(b, { managed_bot: { user: this.person, bot: created.user } });
    return created;
  }

  private activeKeyboard(bot: string) {
    let kb: { rows: KBtn[][]; oneTime?: boolean } | null | undefined;
    for (const e of this.chats.get(bot)!) {
      if (e.t === "bot" && e.reply !== undefined) kb = e.reply;
      if ((e.t === "user" || e.t === "service") && kb?.oneTime) kb = null;
    }
    return kb;
  }

  private findButton(bot: string, text: string) {
    const state = new Map<number, Btn[][] | undefined>();
    for (const e of this.chats.get(bot)!) {
      if (e.t === "bot") state.set(e.id, e.inline);
      if (e.t === "edit" && e.inline !== undefined) state.set(e.id, e.inline ?? undefined);
      if (e.t === "delete") state.delete(e.id);
    }
    for (const [id, rows] of [...state.entries()].reverse()) {
      const btn = rows?.flat().find((x) => x.text === text);
      if (btn) return { id, btn };
    }
    throw new Error(`нет кнопки «${text}» у @${bot}`);
  }

  // Ждать нового сообщения (или правки) бота, подходящего под условие, — не дольше ms.
  async waitFor(bot: string, test: (text: string, e: ChatEvent) => boolean, ms = 20_000): Promise<ChatEvent> {
    const until = Date.now() + ms;
    const from = this.chats.get(bot)!.length;
    while (Date.now() < until) {
      for (const e of this.chats.get(bot)!.slice(from)) if ((e.t === "bot" || e.t === "edit") && test(e.text ?? "", e)) return e;
      await Bun.sleep(50);
    }
    throw new Error(`@${bot} не прислал ожидаемого за ${ms / 1000} с; последнее: ${JSON.stringify(this.chats.get(bot)?.slice(-2))}`);
  }

  // ── Bot API ────────────────────────────────────────────────────────────────

  private async handle(req: Request): Promise<Response> {
    const m = new URL(req.url).pathname.match(/^\/bot([^/]+)\/(\w+)$/);
    const b = m && this.byToken(m[1]);
    if (!m || !b) return Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 });
    const method = m[2];
    const p: any = req.method === "POST" ? await req.json().catch(() => ({})) : Object.fromEntries(new URL(req.url).searchParams);
    if (method !== "getUpdates") this.calls.push({ bot: b.user.username!, method, payload: p });
    const ok = (result: unknown) => Response.json({ ok: true, result });
    const name = b.user.username!;
    const toPerson = Number(p.chat_id) === this.person.id;
    switch (method) {
      case "getMe":
        return ok({ ...b.user, can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, has_topics_enabled: false, can_manage_bots: b.canManage });
      case "getUpdates": {
        const offset = Number(p.offset ?? 0);
        b.updates = b.updates.filter((u) => u.update_id >= offset);
        if (!b.updates.length) await new Promise<void>((r) => ((b.wake = r), setTimeout(r, Math.min(Number(p.timeout ?? 0), 2) * 1000)));
        b.wake = undefined;
        return ok(b.updates.slice(0, 100));
      }
      case "sendMessage":
      case "sendRichMessage": {
        const id = ++b.seq;
        const rich = method === "sendRichMessage";
        const text = rich ? (p.rich_message?.markdown ?? "") : p.text;
        if (toPerson) this.log(name, { t: "bot", id, at: hhmm(), text, format: rich ? "markdown" : p.parse_mode === "HTML" ? "html" : "plain", ...markup(p.reply_markup) });
        return ok({ message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: Number(p.chat_id), type: "private" }, from: b.user, text });
      }
      case "editMessageText": {
        const rich = !!p.rich_message;
        const m2 = markup(p.reply_markup);
        if (toPerson) this.log(name, { t: "edit", id: Number(p.message_id), text: rich ? p.rich_message.markdown : p.text, format: rich ? "markdown" : p.parse_mode === "HTML" ? "html" : "plain", inline: p.reply_markup ? (m2.inline ?? null) : null });
        return ok(true);
      }
      case "editMessageReplyMarkup":
        if (toPerson) this.log(name, { t: "edit", id: Number(p.message_id), inline: markup(p.reply_markup).inline ?? null });
        return ok(true);
      case "deleteMessage":
        if (toPerson) this.log(name, { t: "delete", id: Number(p.message_id) });
        return ok(true);
      case "pinChatMessage":
        if (toPerson) this.log(name, { t: "pin", id: Number(p.message_id) });
        return ok(true);
      case "answerCallbackQuery": {
        const last = [...this.chats.get(name)!].reverse().find((e) => e.t === "press");
        if (last && last.t === "press" && p.text) last.toast = p.text;
        return ok(true);
      }
      case "setMyDescription":
        b.description = p.description;
        return ok(true);
      case "getMyDescription":
        return ok({ description: b.description ?? "" });
      case "getManagedBotToken":
      case "replaceManagedBotToken": {
        const t = [...this.bots.values()].find((x) => x.user.id === Number(p.user_id) && x.manager === name);
        if (!t) return Response.json({ ok: false, error_code: 400, description: "Bad Request: bot is not managed" }, { status: 400 });
        if (method === "replaceManagedBotToken") {
          t.token = newToken(t.user.id);
          this.push(b, { managed_bot: { user: this.person, bot: t.user } });
        }
        return ok(t.token);
      }
      case "setManagedBotAccessSettings": {
        const t = [...this.bots.values()].find((x) => x.user.id === Number(p.user_id) && x.manager === name);
        if (t) t.restricted = !!p.is_access_restricted;
        return ok(true);
      }
      default:
        return ok(true); // setMyCommands, deleteWebhook, sendChatAction, черновики, реакции и прочее — принято
    }
  }
}

function newToken(id: number) {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  return `${id}:AA${Array.from(crypto.getRandomValues(new Uint8Array(33)), (x) => a[x % 64]).join("")}`;
}

function markup(rm: any): { inline?: Btn[][]; reply?: { rows: KBtn[][]; oneTime?: boolean } | null } {
  if (!rm) return {};
  if (rm.inline_keyboard)
    return {
      inline: rm.inline_keyboard.map((row: any[]) =>
        row.map((x) => ({ text: x.text, kind: x.url ? "url" : x.copy_text ? "copy" : "callback", ...(x.style ? { style: x.style } : {}), data: x.callback_data, url: x.url, copy: x.copy_text?.text })),
      ),
    };
  if (rm.keyboard) return { reply: { rows: rm.keyboard.map((row: any[]) => row.map((x) => (x.request_managed_bot ? { text: x.text, kind: "managed_bot", req: x.request_managed_bot } : { text: x.text, kind: "text" }))), oneTime: !!rm.one_time_keyboard } };
  if (rm.remove_keyboard) return { reply: null };
  return {};
}
