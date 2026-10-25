// Telegram: one bot, one owner. Anything from other accounts or groups is dropped before any work; when this bot
// connects other Macs (config.connect), strangers reach only the isolated connection path (src/guest.ts). Output uses
// Bot API 10.1+ rich messages, where Telegram renders Claude's Markdown (tables, headings, collapsible blocks). A turn
// streams as a draft (sendRichMessageDraft) with a "Thinking…" line and a Stop button.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Bot, GrammyError, HttpError, InputFile, type Context } from "grammy";
import type { InlineKeyboardButton, Message } from "grammy/types";
import { INBOX, LOGS, STATE, config, tr } from "./config";
import { mdToHtml, richSafe, splitMd, stripMd } from "./md";
import { clip, hhmm, log, readJson, scrub, sleep, writeJson } from "./util";
import { pageTitle } from "./links";
import { lineDots, noFinalDot, tameBold, typograph, urlsToButtons } from "./typo";
import { transcribe } from "./voice";

const LINK_FILE = join(STATE, "link.json");
const NIGHT_FILE = join(STATE, "night-held.json");
// No connection at all (neither Telegram nor Claude answers over HTTPS), not just failed polling: a host restart won't
// help then. A real request, since with a dead VPN names may still resolve while the services don't open.
async function netDown(): Promise<boolean> {
  const ok = (url: string) => fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) }).then(() => true, () => false);
  const [a, b] = await Promise.all([ok("https://api.telegram.org"), ok("https://api.anthropic.com")]);
  return !a && !b;
}

const OWNER_FILE = join(STATE, "owner.json");
const RECEIPTS = join(STATE, "updates.json"); // update_ids seen in the last 24 h: Telegram may resend a batch after a failure
const PAIR_FILE = join(STATE, "pair.json");
const BOT_FILE = join(STATE, "bot.json"); // the bot's username, for archi's hints in Terminal
const API_ROOT = process.env.ARCH_TG_API ?? "https://api.telegram.org"; // tests use a mock Telegram on 127.0.0.1
const RICH_LIMIT = 30_000; // a rich message holds 32,768 characters

export type Button = { text: string; data?: string; url?: string; style?: "success" | "danger" | "primary"; disabled?: boolean }; // disabled: an inert caption button (Bot API 10.3)
export type Incoming = {
  messageId: number;
  threadId?: number;
  text: string;
  voice?: string; // the voice transcript, already part of text
  forwardedFrom?: string;
  replyToId?: number;
  replyToText?: string;
  quote?: string;
  files: { path: string; kind: string; mime?: string; name?: string }[];
  relayed?: boolean; // queued by the cloud relay while the Mac slept (src/relay.ts)
};
type CallbackHandler = (args: { id: string; value: string; messageId: number; answer: (text?: string) => Promise<void> }) => Promise<void> | void;

// Telegram's Bot API serves files up to 20 MB: a larger one is named with its size instead of a failed download
const BOT_FILE_LIMIT = 20 * 1024 * 1024;
function tooBig(m: Message): string | undefined {
  const items: [{ file_size?: number } | undefined, string, string][] = [
    [m.video, "видео", "a video"],
    [m.document, "файл", "a file"],
    [m.audio, "аудио", "an audio file"],
    [m.voice, "голосовое", "a voice message"],
    [m.video_note, "видеосообщение", "a video message"],
    [m.photo?.at(-1), "фото", "a photo"],
  ];
  const hit = items.find(([f]) => (f?.file_size ?? 0) > BOT_FILE_LIMIT);
  return hit ? tr(`${hit[1]} (${Math.round(hit[0]!.file_size! / 1048576)} МБ)`, `${hit[2]} (${Math.round(hit[0]!.file_size! / 1048576)} MB)`) : undefined;
}

export function ownerId(): number | undefined {
  return readJson<{ id?: number }>(OWNER_FILE, {}).id;
}

// Pairing codes are created only in a terminal on the Mac (bin/arch pair); the chat can't change who has access
export function createPairCode(minutes = 30): string {
  const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  writeJson(PAIR_FILE, { hash: sha(code), expires: Date.now() + minutes * 60_000, attempts: 0 });
  return code;
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
// A pairing code in a private chat while an archi pair code is open: "123456" or "/start 123456"
const pairCodeMessage = (ctx: Context) => existsSync(PAIR_FILE) && ctx.chat?.type === "private" && /^(\/(start|pair)(@\w+)?\s*)?\d{6}$/.test((ctx.message?.text ?? "").replace(/\s+/g, " ").trim());

function keyboard(rows: Button[][] | null | undefined): { inline_keyboard: InlineKeyboardButton[][] } | undefined {
  if (rows === undefined) return undefined;
  return {
    inline_keyboard: (rows ?? []).map((row) =>
      row.map((b) => ({ text: b.text, ...(b.disabled ? { disabled: {} } : b.url ? { url: b.url } : { callback_data: b.data ?? "noop" }), ...(b.style ? { style: b.style } : {}) }) as InlineKeyboardButton),
    ),
  };
}

export class Telegram {
  bot: Bot;
  username = "";
  topicsOn: boolean | undefined;
  canManageBots = false; // Bot Management Mode is on in @BotFather: this bot can create personal bots
  private guest?: (ctx: Context) => Promise<unknown>;
  private handlers = new Map<string, CallbackHandler>();
  private onMessage: (m: Incoming) => void = () => {};
  private onStopGeneration: (draftId: number) => void = () => {};
  private albums = new Map<string, { msgs: Message[]; timer: Timer }>();
  private kinds = new Map<number, "rich" | "text">(); // how a message was sent decides how it is edited
  private draftMode: "rich" | "blocks" | "plain" = "rich";
  private seenTimer?: Timer;
  private saveSeen() {
    if (this.seenTimer) return;
    this.seenTimer = setTimeout(() => {
      this.seenTimer = undefined;
      const old = Date.now() - 24 * 3600_000;
      for (const [k, t] of Object.entries(this.seen)) if (t < old) delete this.seen[k];
      const keys = Object.keys(this.seen);
      if (keys.length > 4096) for (const k of keys.slice(0, keys.length - 4096)) delete this.seen[k];
      writeJson(RECEIPTS, this.seen);
    }, 2000);
  }
  private chain: Promise<void> = Promise.resolve(); // messages in order; taps and Stop don't wait for them
  private seen = readJson<Record<string, number>>(RECEIPTS, {});
  relayed = new WeakSet<object>(); // messages from the cloud relay's queue (src/relay.ts)

  constructor(
    private token: string,
    private rich = config.richMessages !== false,
  ) {
    this.bot = new Bot(token, { client: { apiRoot: API_ROOT } });
    this.bot.catch((e) => log("tg", "ошибка обработчика", String(e.error ?? e)));
    this.bot.use(async (ctx, next) => {
      // drop strangers before any work: no memory or disk spent on a flood of messages
      const from = ctx.from?.id ?? (ctx.update as { stopped_message_generation?: { chat: { id: number } } }).stopped_message_generation?.chat.id;
      const owner = this.owner;
      // Strangers and managed-bot updates go only to the connection path, not awaited, so the owner's polling never
      // waits. The exception is a pairing code in a private chat while an archi pair code is open.
      if ((owner && from !== owner && !pairCodeMessage(ctx)) || ctx.update.managed_bot) {
        if (this.guest) void this.guest(ctx).catch((e) => log("guest", "ошибка пути подключения", String(e)));
        return;
      }
      const id = String(ctx.update.update_id);
      if (this.seen[id]) return void log("tg", "Telegram прислал апдейт повторно — пропускаю", { id });
      this.seen[id] = Date.now();
      this.saveSeen();
      return next();
    });
    this.bot.use(async (ctx, next) => {
      const s = (ctx.update as { stopped_message_generation?: { chat: { id: number }; draft_id: number } }).stopped_message_generation;
      if (!s) return next();
      if (s.chat.id === this.owner) this.onStopGeneration(s.draft_id);
    });
    this.bot.on("callback_query:data", (ctx) => this.handleCallback(ctx));
    // transcribing a voice message takes seconds: messages queue apart from polling, so "Allow" and Stop don't wait
    this.bot.on("message", (ctx) => {
      this.chain = this.chain.then(() => this.handleMessage(ctx)).catch((e) => log("tg", "ошибка разбора сообщения", String(e)));
    });
  }

  get owner() {
    return ownerId();
  }

  onIncoming(fn: (m: Incoming) => void) {
    this.onMessage = fn;
  }

  // The handler for strangers gets the raw update and answers by itself; it never reaches the owner's handlers
  onGuest(fn: (ctx: Context) => Promise<unknown>) {
    this.guest = fn;
  }

  onStop(fn: (draftId: number) => void) {
    this.onStopGeneration = fn;
  }

  onCallback(kind: string, fn: CallbackHandler) {
    this.handlers.set(kind, fn);
  }

  private lastPoll = Date.now();
  // The link state (last good poll, whether the link dropped, whether the Mac slept) survives host restarts, or after a
  // long outage with restarts the host would say nothing on return
  private link = readJson<{ okAt: number; down?: { since: number; why: "dns" | "telegram" }; slept?: boolean }>(LINK_FILE, { okAt: Date.now() });
  onReconnect?: (from: number, to: number, why: "dns" | "telegram" | "sleep") => Promise<void>;

  // Report an outage only if the owner wrote meanwhile (their messages arrive in a batch), with the right cause:
  // a sleeping Mac is not "no internet"
  private async linkOk(updates: unknown) {
    const now = Date.now();
    const { okAt, down, slept } = this.link;
    if (!down && !slept && now - okAt < 60_000) return;
    this.link = { okAt: now };
    writeJson(LINK_FILE, this.link);
    const owner = this.owner;
    const asked = Array.isArray(updates) && updates.some((u: { message?: { from?: { id?: number } } }) => !!owner && u.message?.from?.id === owner);
    if (!asked || now - okAt < 3 * 60_000 || (!down && !slept)) return;
    await this.onReconnect?.(okAt, now, slept ? "sleep" : down!.why).catch((e) => log("tg", "не сказал о перерыве связи", String(e)));
  }

  private async linkDown() {
    if (this.link.down) return;
    this.link = { ...this.link, down: { since: Date.now(), why: (await netDown()) ? "dns" : "telegram" } };
    writeJson(LINK_FILE, this.link);
  }

  async start() {
    // Every getUpdates answer is recorded, and the watchdog below catches "alive but deaf". The first good poll after
    // an outage tells the owner what happened before the queued messages are answered.
    this.bot.api.config.use(async (prev, method, payload, signal) => {
      try {
        const r = await prev(method, payload, signal);
        if (method === "getUpdates") {
          this.lastPoll = Date.now();
          await this.linkOk((r as { result?: unknown }).result);
        }
        return r;
      } catch (e) {
        if (e instanceof HttpError) void this.linkDown();
        throw e;
      }
    });
    let lastCheck = Date.now();
    setInterval(() => {
      const now = Date.now();
      const gap = now - lastCheck;
      lastCheck = now;
      if (gap > 60_000) {
        this.link = { ...this.link, slept: true }; // a gap from sleep is not a lost connection
        writeJson(LINK_FILE, this.link);
        this.lastPoll = now; // give polling a chance to recover after sleep
        return;
      }
      if (now - this.lastPoll > 150_000)
        void netDown().then((down) => {
          if (down) return; // no internet: a restart won't help
          log("tg", "опрос Telegram молчит больше 2,5 минут — перезапускаюсь");
          process.exit(3); // launchd restarts the host
        });
    }, 30_000).unref();
    await this.refreshMe();
    await this.bot.api
      .setMyCommands([
        { command: "status", description: tr("что сейчас: кто ждёт вас, кто работает, сайты, лимит", "what’s going on: who needs you, who’s working, sites, limit") },
        { command: "stop", description: tr("остановить мой ответ", "stop my reply") },
        { command: "new", description: tr("начать разговор заново", "start the conversation over") },
        { command: "rules", description: tr("что я делаю без вопросов по вашим правилам", "what I do without asking, by your rules") },
      ])
      .catch(() => {});
    this.poll();
  }

  // Telegram polling. While the Mac sleeps the cloud relay has the bot; on wake the host polls again (src/relay.ts)
  poll() {
    let halted = false;
    this.halt = () => (halted = true);
    this.polling = this.bot
      .start({
        allowed_updates: ["message", "callback_query", "stopped_message_generation", ...(this.guest ? (["managed_bot"] as const) : [])],
        drop_pending_updates: false,
        onStart: (me) => log("tg", `бот @${me.username} слушает`),
      })
      .catch((e) => {
        if (halted) return; // stopped on purpose: handing over to the relay or shutting down
        if (e instanceof GrammyError && e.error_code === 401) {
          // the token was revoked (the bot moved to another Mac or was deleted): a restart won't help, stop for good
          log("tg", "Telegram не принимает ключ бота — бот перенесён на другой Mac или удалён. Хост остановлен");
          process.exit(0);
        }
        log("tg", "опрос Telegram остановился", String(e));
        process.exit(3); // launchd restarts the host
      });
  }
  private polling?: Promise<void>;
  private halt?: () => void;

  // The polling loop finishes its current batch; wait for it briefly so a new loop doesn't run alongside
  async stop() {
    this.halt?.();
    await this.bot.stop().catch(() => {});
    await Promise.race([this.polling, sleep(3000)]);
  }

  // Topics in the private chat are turned on in @BotFather (Threaded Mode); check whether they are on now
  async refreshMe() {
    try {
      const me = (await this.bot.api.getMe()) as { username: string; has_topics_enabled?: boolean; can_manage_bots?: boolean };
      if (me.username !== this.username) writeJson(BOT_FILE, { username: me.username });
      this.username = me.username;
      this.canManageBots = !!me.can_manage_bots;
      if (this.topicsOn !== !!me.has_topics_enabled) log("tg", `темы в личном чате: ${me.has_topics_enabled ? "включены" : "выключены"}`);
      this.topicsOn = !!me.has_topics_enabled;
    } catch (e) {
      log("tg", "getMe не ответил", String(e));
    }
  }

  private isOwner(ctx: Context) {
    const id = this.owner;
    return !!id && ctx.from?.id === id && ctx.chat?.type === "private";
  }

  private async handleCallback(ctx: Context) {
    const q = ctx.callbackQuery!;
    if (!this.isOwner(ctx)) {
      log("tg", "нажатие кнопки с чужого аккаунта отброшено", { from: q.from.id });
      return;
    }
    // a tap means the owner is awake, so at night the replies to it aren't held until morning
    this.lastOwnerAt = Date.now();
    const [kind, id, ...rest] = (q.data ?? "").split(":");
    const h = this.handlers.get(kind);
    const answer = async (text?: string) => {
      await ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {});
    };
    if (!h) return answer(tr("Кнопка устарела", "This button has expired"));
    try {
      await h({ id, value: rest.join(":"), messageId: q.message?.message_id ?? 0, answer });
    } catch (e) {
      log("tg", "ошибка кнопки", String(e));
      await answer(tr("Не вышло — нажмите ещё раз", "That didn’t work — tap again"));
    }
  }

  private async handleMessage(ctx: Context) {
    const msg = ctx.message!;
    if (msg.from?.id === ctx.me.id || msg.pinned_message || msg.managed_bot_created) return; // service messages: a pinned dashboard, a created bot
    if (!this.owner) return this.tryPair(ctx);
    if (!this.isOwner(ctx)) {
      // Re-pairing (a new account or phone): only archi pair on this Mac makes a code, and from another account only a
      // correct open code is accepted; anything else gets the silence any stranger gets.
      if (pairCodeMessage(ctx)) return this.tryPair(ctx, true);
      log("tg", "сообщение с чужого аккаунта отброшено", { from: ctx.from?.id, chat: ctx.chat?.type });
      return;
    }
    if (msg.media_group_id) {
      const a = this.albums.get(msg.media_group_id);
      if (a) {
        a.msgs.push(msg);
        clearTimeout(a.timer);
      }
      const entry = a ?? { msgs: [msg], timer: 0 as unknown as Timer };
      entry.timer = setTimeout(() => {
        this.albums.delete(msg.media_group_id!);
        this.normalize(entry.msgs).then((m) => this.onMessage(m));
      }, 1200);
      this.albums.set(msg.media_group_id, entry);
      return;
    }
    this.onMessage(await this.normalize([msg]));
  }

  // again: there is an owner already; pairing moves to the new account and the previous one is told, so a takeover can't be silent
  private async tryPair(ctx: Context, again = false) {
    const text = ctx.message?.text ?? "";
    log("tg", "сообщение до привязки владельца", { from: ctx.from?.id, chat: ctx.chat?.type, text: text.replace(/\d/g, "#").slice(0, 40) });
    if (ctx.chat?.type !== "private" || !existsSync(PAIR_FILE)) return;
    const p = readJson<{ hash: string; expires: number; attempts: number }>(PAIR_FILE, { hash: "", expires: 0, attempts: 99 });
    const code = text.replace(/^\/(start|pair)(@\w+)?\s*/, "").replace(/\s+/g, "").trim();
    if (!/^\d{6}$/.test(code)) {
      if (again) return;
      // pairing is open but there is no code: give a hint rather than silence
      await ctx.reply(tr("Пришлите сюда шесть цифр кода привязки — его показывает команда archi pair на Mac.", "Send the six-digit pairing code here — archi pair shows it on the Mac.")).catch(() => {});
      return;
    }
    if (Date.now() > p.expires || p.attempts >= 5) {
      unlinkSync(PAIR_FILE);
      log("tg", "сопряжение закрыто: истёк срок или кончились попытки");
      return;
    }
    if (sha(code) !== p.hash) {
      writeJson(PAIR_FILE, { ...p, attempts: p.attempts + 1 });
      log("tg", "неверный код сопряжения", { from: ctx.from?.id });
      return;
    }
    const before = this.owner;
    writeJson(OWNER_FILE, { id: ctx.from!.id, name: ctx.from!.first_name, pairedAt: new Date().toISOString() });
    unlinkSync(PAIR_FILE);
    log("tg", again ? "владелец привязан заново" : "владелец сопряжён", { id: ctx.from!.id });
    if (again && before)
      await this.bot.api
        .sendMessage(before, tr(`Бот привязан к другому аккаунту Telegram${ctx.from?.first_name ? ` (${ctx.from.first_name})` : ""} кодом archi pair с этого Mac. Если это не вы — на Mac: archi pair и откройте ссылку со своего аккаунта.`, `The bot is now linked to another Telegram account${ctx.from?.first_name ? ` (${ctx.from.first_name})` : ""} with an archi pair code from this Mac. If it wasn’t you, run archi pair on the Mac and open the link from your account.`))
        .catch(() => {});
    await this.send(tr("Связь есть. Пишите или говорите, что сделать. «Что у нас» — короткая сводка.", "Connected. Type or say what to do. Ask “what’s up?” for a short summary."));
  }

  private async normalize(msgs: Message[]): Promise<Incoming> {
    const first = msgs[0];
    const texts: string[] = [];
    const files: Incoming["files"] = [];
    const missed: string[] = []; // files the bot couldn't get: the owner and the architect are told, not left to assume
    let voice: string | undefined;
    for (const m of msgs) {
      const t = m.text ?? m.caption ?? "";
      if (t) texts.push(t);
      const big = tooBig(m);
      if (big) {
        missed.push(big);
        continue;
      }
      const f = await this.download(m).catch((e) => {
        log("tg", "не скачал файл", String(e));
        missed.push(tr("файл не скачался", "a file didn’t download"));
        return null;
      });
      if (!f) continue;
      if (f.kind === "voice" || f.kind === "audio" || f.kind === "video_note") {
        this.typing();
        const said = await transcribe(f.path);
        if (said) {
          voice = said;
          texts.push(said);
          // echo the transcript in quotes right under the voice message
          const heard = said.replace(/[_*`]/g, " ").trim();
          const line = `${heard.charAt(0).toUpperCase()}${heard.slice(1)}`;
          await this.send(tr(`«${line}»`, `“${line}”`), { silent: true, threadId: m.is_topic_message ? m.message_thread_id : undefined });
          continue; // the transcript is the message; the architect doesn't need the file
        }
      }
      files.push(f);
    }
    if (missed.length) {
      const what = [...new Set(missed)].join(", ");
      texts.push(tr(`[Бот не смог открыть: ${what}. Telegram отдаёт ботам файлы только до 20 МБ.]`, `[The bot couldn’t open: ${what}. Telegram gives bots files only up to 20 MB.]`));
      await this.send(tr(`Не открыл ${what}: Telegram отдаёт ботам файлы только до 20 МБ. Положите файл на Mac и скажите, где он, — или пришлите поменьше.`, `Couldn’t open ${what}: Telegram gives bots files only up to 20 MB. Put it on the Mac and say where, or send a smaller one.`), { silent: true, threadId: first.is_topic_message ? first.message_thread_id : undefined });
    }
    const r = first.reply_to_message;
    this.lastId = Math.max(this.lastId, ...msgs.map((x) => x.message_id));
    this.lastOwnerAt = Date.now();
    // forwarded text is someone else's words, never the owner's consent
    if (!msgs.some((x) => x.forward_origin)) this.ownerSaid = [...this.ownerSaid.filter((x) => Date.now() - x.at < 30 * 60_000), { at: Date.now(), text: texts.join("\n\n") }].slice(-10);
    return {
      messageId: first.message_id,
      threadId: first.is_topic_message ? first.message_thread_id : undefined,
      text: texts.join("\n\n"),
      voice,
      forwardedFrom: first.forward_origin ? describeOrigin(first.forward_origin) : undefined,
      replyToId: r?.message_id,
      replyToText: r ? (r.text ?? r.caption ?? "") : undefined,
      quote: first.quote?.text,
      files,
      relayed: this.relayed.has(first) || undefined,
    };
  }

  private async download(m: Message) {
    const pick =
      (m.photo && { id: m.photo[m.photo.length - 1].file_id, kind: "photo", name: `photo-${m.message_id}.jpg`, mime: "image/jpeg" }) ||
      (m.document && { id: m.document.file_id, kind: "document", name: m.document.file_name ?? `file-${m.message_id}`, mime: m.document.mime_type }) ||
      (m.voice && { id: m.voice.file_id, kind: "voice", name: `voice-${m.message_id}.ogg`, mime: m.voice.mime_type }) ||
      (m.audio && { id: m.audio.file_id, kind: "audio", name: m.audio.file_name ?? `audio-${m.message_id}`, mime: m.audio.mime_type }) ||
      (m.video && { id: m.video.file_id, kind: "video", name: m.video.file_name ?? `video-${m.message_id}.mp4`, mime: m.video.mime_type }) ||
      (m.video_note && { id: m.video_note.file_id, kind: "video_note", name: `video-${m.message_id}.mp4`, mime: "video/mp4" });
    if (!pick) return null;
    const file = await this.bot.api.getFile(pick.id);
    if (!file.file_path) return null;
    const res = await fetch(`${API_ROOT}/file/bot${this.token}/${file.file_path}`);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const day = new Date().toISOString().slice(0, 10);
    const dir = join(INBOX, day);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${m.message_id}-${basename(pick.name).replace(/[^\p{L}\p{N}._-]+/gu, "_")}`);
    writeFileSync(path, new Uint8Array(await res.arrayBuffer()), { mode: 0o600 });
    return { path, kind: pick.kind, mime: pick.mime, name: pick.name };
  }

  // ── sending ────────────────────────────────────────────────────────────────

  // Pacing, 429 handling and retries without duplicates
  private lastOut = 0; // the last call to the owner's chat: one send slot per second
  private floodUntil = 0; // rate-limited by Telegram: no drafts or interim edits until then
  private deferred: (() => Promise<unknown>)[] = [];
  private flushTimer?: Timer;

  private get flooded() {
    return Date.now() < this.floodUntil;
  }

  // kind "send": a message to the owner (waits for its slot; a network error is retried only if the request surely
  // didn't leave); "edit": edits and service calls
  private async call<T>(fn: () => Promise<T>, kind: "send" | "edit" = "edit"): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      if (kind === "send") {
        const wait = this.lastOut + 1000 - Date.now();
        if (wait > 0) await sleep(wait);
      }
      this.lastOut = Date.now();
      try {
        return await fn();
      } catch (e) {
        if (e instanceof GrammyError && e.error_code === 429) {
          const ra = e.parameters?.retry_after ?? 3;
          this.floodUntil = Date.now() + ra * 1000;
          if (ra <= 5 && attempt < 3) {
            await sleep((ra + 0.5) * 1000);
            continue;
          }
          throw e; // a long penalty: don't sleep; deliver() defers a send, an edit is skipped
        }
        if (!(e instanceof GrammyError) && attempt < 2 && (kind === "edit" || preConnect(e))) {
          await sleep(1500);
          continue;
        }
        throw e;
      }
    }
  }

  // Sends content: unparsable markup returns "parse" (the caller retries simpler); a long 429 defers and resends later;
  // a network failure gets one retry, since a rare duplicate beats a lost reply
  private async deliver<T>(fn: () => Promise<T>): Promise<T | "parse" | "deferred"> {
    try {
      return await this.call(fn, "send");
    } catch (e) {
      if (e instanceof GrammyError && e.error_code === 400 && /parse|entit|too long|rich|markdown|unsupported|can't|tag/i.test(e.description)) return "parse";
      if (e instanceof GrammyError && e.error_code === 429) {
        this.deferred.push(fn);
        this.scheduleFlush();
        log("tg", `Telegram просит паузу ${Math.round((this.floodUntil - Date.now()) / 1000)} с — сообщение отложено и уйдёт после`);
        return "deferred";
      }
      if (!(e instanceof GrammyError)) {
        log("tg", "сбой сети при отправке — повторяю один раз", String(e));
        await sleep(3000);
        return await this.call(fn, "send");
      }
      throw e;
    }
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(async () => {
      this.flushTimer = undefined;
      while (this.deferred.length && !this.flooded) {
        const fn = this.deferred[0];
        try {
          await this.call(fn, "send");
          this.deferred.shift();
        } catch (e) {
          if (!(e instanceof GrammyError && e.error_code === 429)) this.deferred.shift();
          log("tg", "отложенное не ушло", String(e));
          break;
        }
      }
      if (this.deferred.length) this.scheduleFlush();
    }, Math.max(500, this.floodUntil - Date.now() + 500));
  }

  lastId = 0; // the last message in the chat, theirs or ours: a reply to it needs no quote
  private remember(id: number, kind: "rich" | "text") {
    this.lastId = Math.max(this.lastId, id);
    this.kinds.set(id, kind);
    if (this.kinds.size > 2000) this.kinds.delete(this.kinds.keys().next().value!);
  }

  // The buttons now under a message: the dashboard repeats a request's buttons for one-tap decisions
  private keyboards = new Map<number, Button[][]>();
  buttonsOf(messageId: number): Button[][] | undefined {
    return this.keyboards.get(messageId);
  }
  private keep(id: number, buttons: Button[][] | null | undefined) {
    if (buttons === undefined) return;
    if (buttons?.length) this.keyboards.set(id, buttons);
    else this.keyboards.delete(id);
    if (this.keyboards.size > 300) this.keyboards.delete(this.keyboards.keys().next().value!);
  }

  // What the bot sent the owner without the architect (summaries, quick answers, connection notes, links). The architect
  // sees it with the owner's next message; otherwise it would take its own old message for the last one.
  hostSent: { at: number; text: string }[] = [];
  lastOwnerAt = 0;
  // The owner's messages from the last half hour: "stop X" or "set a goal" there is their word, so no second question
  ownerSaid: { at: number; text: string }[] = [];
  // At night (0:00–8:00) the owner sleeps, and even a silent message lights up the screen. What they didn't ask for and
  // what needs no button waits for the morning summary.
  private nightHeld = readJson<{ at: number; text: string }[]>(NIGHT_FILE, []);
  takeNightHeld() {
    const held = this.nightHeld;
    this.nightHeld = [];
    writeJson(NIGHT_FILE, []);
    return held;
  }

  // Sends Markdown to the owner, split into parts if long; returns the message ids. forceReply turns the owner's input
  // field into a reply to this message, with the text as placeholder. skipAtNight drops the message at night instead
  // of holding it, since the morning summary shows it anyway (new pages).
  async send(md: string, opts: { replyTo?: number; buttons?: Button[][]; silent?: boolean; threadId?: number; forceReply?: string; from?: "architect"; asked?: string; skipAtNight?: boolean } = {}): Promise<number[]> {
    const chat = this.owner;
    if (!chat) return [];
    // code shapes the message, not the model: bold, URLs as buttons, typography, no final period
    const shaped = urlsToButtons(tameBold(opts.from === "architect" ? lineDots(md) : md), pageTitle);
    const clean = noFinalDot(typograph(scrub(shaped.md)));
    if (shaped.links.length) opts = { ...opts, buttons: [...(opts.buttons ?? []), ...shaped.links.map((l) => [{ text: l.text, url: l.url }])] };
    const night = new Date().getHours() < 8;
    const awake = Date.now() - this.lastOwnerAt < 15 * 60_000;
    const asks = opts.buttons?.some((row) => row.some((b) => b.data));
    if (night && !awake && opts.silent !== false && !opts.replyTo && !asks) {
      if (opts.skipAtNight) return [];
      this.nightHeld = [...this.nightHeld, { at: Date.now(), text: clean }].slice(-40);
      writeJson(NIGHT_FILE, this.nightHeld);
      log("tg", `ночью отложено до итога: ${clean.replace(/\s+/g, " ").slice(0, 80)}`);
      return [];
    }
    // silent at night (0:00–8:00 Mac time) unless sound was asked for
    opts = { ...opts, silent: opts.silent ?? night };
    log("tg", `→ ${opts.silent ? "(тихо) " : ""}${clean.replace(/\s+/g, " ").slice(0, 80)}`);
    if (opts.from !== "architect") this.hostSent = [...this.hostSent, { at: Date.now(), text: opts.asked ? `на его «${opts.asked}» — ${clean}` : clean }].slice(-12);
    // the full text and buttons go to sent.jsonl, for looking into complaints
    try {
      appendFileSync(join(LOGS, "sent.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), silent: opts.silent, text: clean, buttons: opts.buttons?.map((row) => row.map((b) => b.text)) })}\n`);
    } catch {}
    const ids: number[] = [];
    const parts = this.rich ? splitMd(clean, RICH_LIMIT) : splitMd(clean);
    for (let k = 0; k < parts.length; k++) {
      const last = k === parts.length - 1;
      const base = {
        disable_notification: opts.silent,
        message_thread_id: opts.threadId,
        reply_parameters: k === 0 && opts.replyTo ? { message_id: opts.replyTo, allow_sending_without_reply: true } : undefined,
        reply_markup: !last ? undefined : opts.forceReply ? { force_reply: true as const, input_field_placeholder: clip(opts.forceReply, 64) } : keyboard(opts.buttons),
      };
      if (this.rich) {
        const r = await this.deliver(() => this.bot.api.raw.sendRichMessage({ chat_id: chat, rich_message: { markdown: richSafe(parts[k]) || "…" }, ...base }));
        if (r === "deferred") continue;
        if (r !== "parse") {
          this.remember(r.message_id, "rich");
          ids.push(r.message_id);
          continue;
        }
        log("tg", "rich-разметку Telegram не понял — шлю обычным текстом");
      }
      for (const piece of splitMd(parts[k])) {
        const id = await this.sendText(chat, piece, base);
        if (id) ids.push(id);
      }
    }
    if (ids.length) this.keep(ids[ids.length - 1], opts.buttons);
    if (opts.from === "architect" && ids.length === 1) this.architectSent = [...this.architectSent, { id: ids[0], text: clean }].slice(-20);
    return ids;
  }

  // The architect's recent messages, so a mistake can be fixed in place (fix_message)
  private architectSent: { id: number; text: string }[] = [];
  async correct(which: number, md: string): Promise<boolean> {
    const m = this.architectSent.at(-which);
    if (!m) return false;
    await this.edit(m.id, `${md.trim()}\n\n_${tr("Исправлено в", "Corrected at")} ${hhmm()}_`, { buttons: this.buttonsOf(m.id) ?? null });
    m.text = md;
    return true;
  }

  private async sendText(chat: number, md: string, base: Record<string, unknown>): Promise<number | undefined> {
    let r = await this.deliver(() => this.bot.api.sendMessage(chat, mdToHtml(md) || "…", { ...base, parse_mode: "HTML", link_preview_options: { is_disabled: true } }));
    if (r === "parse") r = await this.deliver(() => this.bot.api.sendMessage(chat, clip(stripMd(md), 4000) || "…", base));
    if (r === "parse" || r === "deferred") return undefined;
    this.remember(r.message_id, "text");
    return r.message_id;
  }

  // buttons: undefined keeps them, null removes them
  async edit(messageId: number, md: string, opts: { buttons?: Button[][] | null } = {}) {
    const chat = this.owner;
    if (!chat || !messageId) return;
    if (this.flooded && opts.buttons === undefined) return; // an interim edit can wait for the next pass
    const clean = noFinalDot(typograph(scrub(tameBold(md))));
    const reply_markup = keyboard(opts.buttons);
    this.keep(messageId, opts.buttons);
    try {
      if (this.kinds.get(messageId) !== "text" && this.rich) {
        await this.call(() => this.bot.api.raw.editMessageText({ chat_id: chat, message_id: messageId, rich_message: { markdown: richSafe(clip(clean, RICH_LIMIT)) || "…" }, reply_markup }));
      } else {
        await this.call(() =>
          this.bot.api.editMessageText(chat, messageId, mdToHtml(clip(clean, 3900)) || "…", { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup }),
        );
      }
    } catch (e) {
      if (!String(e).includes("message is not modified")) log("tg", "не обновил сообщение", String(e));
    }
  }

  // The streaming draft of a reply lasts about 30 s, so it is refreshed while work goes on; the result is a normal send().
  // Before any text it shows a "Thinking…" block, then the reply's Markdown as it is written. A 429 or network error
  // skips the frame; unparsable markup falls back to simpler drafts until the turn ends.
  resetDraft() {
    this.draftMode = "rich";
  }

  async draft(o: { id: number; thinking?: string; md?: string; threadId?: number; canStop?: boolean }): Promise<void> {
    const chat = this.owner;
    if (!chat || this.flooded || Date.now() - this.lastOut < 700) return;
    const body = scrub(o.md ?? "");
    const common = { chat_id: chat, message_thread_id: o.threadId, draft_id: o.id, can_stop: o.canStop };
    this.lastOut = Date.now();
    try {
      if (this.draftMode === "plain") {
        await this.bot.api.raw.sendMessageDraft({ ...common, text: clip(stripMd(body), 4000) });
        return;
      }
      const rich_message =
        body && this.draftMode === "rich"
          ? { markdown: richSafe(body.length > 12_000 ? "…" + body.slice(-12_000) : body) }
          : { blocks: body ? [{ type: "paragraph" as const, text: body.length > 12_000 ? "…" + stripMd(body).slice(-12_000) : stripMd(body) }] : [{ type: "thinking" as const, text: o.thinking || tr("Думаю", "Thinking") }] };
      await this.bot.api.raw.sendRichMessageDraft({ ...common, rich_message });
    } catch (e) {
      if (e instanceof GrammyError && e.error_code === 429) {
        this.floodUntil = Date.now() + (e.parameters?.retry_after ?? 3) * 1000;
        return;
      }
      if (!(e instanceof GrammyError) || e.error_code !== 400) return; // network error: skip the frame
      this.draftMode = this.draftMode === "rich" && body ? "blocks" : "plain";
      log("tg", `черновик: Telegram не принял (${e.description}) — до конца хода проще`);
    }
  }

  // An edit that reports its outcome; "gone" means the message was deleted and a new one is needed
  async editStrict(messageId: number, md: string, opts: { buttons?: Button[][] | null } = {}): Promise<"ok" | "gone" | "error"> {
    const chat = this.owner;
    if (!chat) return "error";
    if (this.flooded) return "error"; // the dashboard updates on the next pass
    try {
      await this.call(() =>
        // shaped like /status: the pinned message is edited all day and must go through the typographer too
        this.bot.api.raw.editMessageText({ chat_id: chat, message_id: messageId, rich_message: { markdown: richSafe(clip(noFinalDot(typograph(scrub(tameBold(md)))), RICH_LIMIT)) }, reply_markup: keyboard(opts.buttons) }),
      );
      return "ok";
    } catch (e) {
      const s = String(e);
      if (s.includes("message is not modified")) return "ok";
      // recreate only when Telegram says the message is gone; network errors, sleep and 429 retry later, or copies of
      // the dashboard would pile up
      if (e instanceof GrammyError && e.error_code === 400 && /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i.test(e.description)) return "gone";
      log("tg", "правка не удалась — повторю позже", s);
      return "error";
    }
  }

  async unpinAll() {
    const chat = this.owner;
    if (chat) await this.bot.api.unpinAllChatMessages(chat).catch((e) => log("tg", "не открепил", String(e)));
  }

  async pin(messageId: number) {
    const chat = this.owner;
    if (chat) await this.bot.api.pinChatMessage(chat, messageId, { disable_notification: true }).catch((e) => log("tg", "не закрепил", String(e)));
  }

  async typing(threadId?: number) {
    const chat = this.owner;
    if (chat) await this.bot.api.sendChatAction(chat, "typing", { message_thread_id: threadId }).catch(() => {});
  }

  async sendFile(path: string, caption?: string, asPhoto = false, threadId?: number, from?: "architect"): Promise<number | undefined> {
    const chat = this.owner;
    if (!chat) return;
    if (from !== "architect") this.hostSent = [...this.hostSent, { at: Date.now(), text: `[${asPhoto ? "снимок" : "файл"}] ${caption ?? ""}`.trim() }].slice(-12);
    const cap = caption ? mdToHtml(clip(noFinalDot(typograph(scrub(caption))), 1000)) : undefined;
    const file = new InputFile(path);
    const o = { caption: cap, parse_mode: "HTML" as const, message_thread_id: threadId };
    const m = asPhoto ? await this.call(() => this.bot.api.sendPhoto(chat, file, o), "send") : await this.call(() => this.bot.api.sendDocument(chat, file, o), "send");
    this.remember(m.message_id, "text");
    return m.message_id;
  }

  // An album of up to 10 screenshots; the first caption serves for all
  async sendAlbum(items: { path: string; caption?: string }[], opts: { threadId?: number; replyTo?: number; silent?: boolean } = {}): Promise<number[]> {
    const chat = this.owner;
    if (!chat || !items.length) return [];
    // the architect must know about the host's screenshots too, or it would send the same ones
    this.hostSent = [...this.hostSent, { at: Date.now(), text: `[снимков: ${Math.min(items.length, 10)}] ${items[0].caption ?? ""}`.trim() }].slice(-12);
    const media = items.slice(0, 10).map((it) => ({ type: "photo" as const, media: new InputFile(it.path), caption: it.caption ? clip(noFinalDot(typograph(scrub(it.caption))), 1000) : undefined }));
    try {
      const ms = await this.call(
        () =>
          this.bot.api.sendMediaGroup(chat, media, {
            message_thread_id: opts.threadId,
            disable_notification: opts.silent ?? true,
            reply_parameters: opts.replyTo ? { message_id: opts.replyTo, allow_sending_without_reply: true } : undefined,
          }),
        "send",
      );
      for (const m of ms) this.remember(m.message_id, "text");
      return ms.map((m) => m.message_id);
    } catch (e) {
      log("tg", "альбом не ушёл", String(e));
      return [];
    }
  }

  async createTopic(name: string): Promise<number | undefined> {
    const chat = this.owner;
    if (!chat || !this.topicsOn) return;
    try {
      const t = await this.call(() => this.bot.api.createForumTopic(chat, clip(name, 128)), "send");
      return t.message_thread_id;
    } catch (e) {
      log("tg", "тему создать не вышло", String(e));
      await this.refreshMe();
    }
  }
}

// An error before connecting: the request surely didn't leave, so a retry can't duplicate it
function preConnect(e: unknown): boolean {
  const pick = (x: any): string => String(x?.code ?? x?.cause?.code ?? x?.error?.code ?? x?.error?.cause?.code ?? "");
  return /^(ECONNREFUSED|ENOTFOUND|ENETDOWN|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN)$/.test(pick(e));
}

function describeOrigin(o: NonNullable<Message["forward_origin"]>): string {
  switch (o.type) {
    case "user":
      return [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(" ") + (o.sender_user.username ? ` (@${o.sender_user.username})` : "");
    case "hidden_user":
      return o.sender_user_name;
    case "chat":
      return o.sender_chat.title ?? "чат";
    case "channel":
      return (o.chat.title ?? "канал") + (o.author_signature ? `, ${o.author_signature}` : "");
  }
}
