// Telegram: один бот, один владелец. Всё от других аккаунтов и из групп отбрасывается до любой работы;
// если этот бот подключает чужие Mac (config.connect), чужое уходит только в изолированный путь подключения (src/guest.ts).
// Вывод — rich-сообщения Bot API 10.1+ (Markdown Claude рисует сам Telegram: таблицы, заголовки, сворачиваемые блоки).
// Ход ответа — потоковый черновик (sendRichMessageDraft) с блоком «Думаю…» и кнопкой «Стоп».
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
// Нет связи вообще (ни Telegram, ни Claude не отвечают по HTTPS), а не только опрос Telegram: тогда перезапуск хоста бесполезен.
// Проверка настоящим запросом: при упавшем VPN адреса могут узнаваться, а сами сервисы — не открываться.
async function netDown(): Promise<boolean> {
  const ok = (url: string) => fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) }).then(() => true, () => false);
  const [a, b] = await Promise.all([ok("https://api.telegram.org"), ok("https://api.anthropic.com")]);
  return !a && !b;
}

const OWNER_FILE = join(STATE, "owner.json");
const RECEIPTS = join(STATE, "updates.json"); // принятые update_id (24 ч): Telegram может отдать пачку ещё раз после сбоя — Hermes update_admission
const PAIR_FILE = join(STATE, "pair.json");
const BOT_FILE = join(STATE, "bot.json"); // имя бота — для подсказок archi в Терминале
const API_ROOT = process.env.ARCH_TG_API ?? "https://api.telegram.org"; // в проверках — подставной Telegram на 127.0.0.1
const RICH_LIMIT = 30_000; // у rich-сообщения 32 768 знаков

export type Button = { text: string; data?: string; url?: string; style?: "success" | "danger" | "primary"; disabled?: boolean }; // disabled — погасшая кнопка-подпись (Bot API 10.3)
export type Incoming = {
  messageId: number;
  threadId?: number;
  text: string;
  voice?: string; // расшифровка голосового — уже входит в text
  forwardedFrom?: string;
  replyToId?: number;
  replyToText?: string;
  quote?: string;
  files: { path: string; kind: string; mime?: string; name?: string }[];
  relayed?: boolean; // пришло из очереди дежурного в облаке, пока Mac спал (src/relay.ts)
};
type CallbackHandler = (args: { id: string; value: string; messageId: number; answer: (text?: string) => Promise<void> }) => Promise<void> | void;

export function ownerId(): number | undefined {
  return readJson<{ id?: number }>(OWNER_FILE, {}).id;
}

// Код сопряжения создаётся только в терминале Mac (bin/arch pair); в чате доступ не меняется.
export function createPairCode(minutes = 30): string {
  const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  writeJson(PAIR_FILE, { hash: sha(code), expires: Date.now() + minutes * 60_000, attempts: 0 });
  return code;
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
// код привязки в личном чате, пока окно archi pair открыто: «123456» или «/start 123456»
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
  canManageBots = false; // в @BotFather включён Bot Management Mode — можно создавать личных ботов людям
  private guest?: (ctx: Context) => Promise<unknown>;
  private handlers = new Map<string, CallbackHandler>();
  private onMessage: (m: Incoming) => void = () => {};
  private onStopGeneration: (draftId: number) => void = () => {};
  private albums = new Map<string, { msgs: Message[]; timer: Timer }>();
  private kinds = new Map<number, "rich" | "text">(); // как отправлено сообщение — от этого зависит правка
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
  private chain: Promise<void> = Promise.resolve(); // сообщения — по порядку; нажатия и «Стоп» их не ждут
  private seen = readJson<Record<string, number>>(RECEIPTS, {});
  relayed = new WeakSet<object>(); // сообщения из очереди облака (src/relay.ts)

  constructor(
    private token: string,
    private rich = config.richMessages !== false,
  ) {
    this.bot = new Bot(token, { client: { apiRoot: API_ROOT } });
    this.bot.catch((e) => log("tg", "ошибка обработчика", String(e.error ?? e)));
    this.bot.use(async (ctx, next) => {
      // чужое — отбрасываем до всякой работы (ни памяти, ни диска на поток чужих сообщений)
      const from = ctx.from?.id ?? (ctx.update as { stopped_message_generation?: { chat: { id: number } } }).stopped_message_generation?.chat.id;
      const owner = this.owner;
      // чужие и создание личных ботов — только путь подключения, без ожидания: опрос владельца он не задерживает.
      // Кроме кода привязки заново из личного чата, пока archi pair на Mac держит окно открытым
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
    // голосовое распознаётся секунды — по очереди, но мимо опроса: «Разрешить» и «Стоп» не ждут (linuz90, OpenClaw)
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

  // Обработчик чужих: получает сырое обновление и отвечает сам; к обработчикам владельца оно не попадает никогда.
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
  // Связь с Telegram переживает перезапуски хоста: когда был последний удачный опрос, пропадала ли связь, спал ли Mac.
  // Иначе после долгого перерыва с перезапусками хост, вернувшись, ничего не скажет.
  private link = readJson<{ okAt: number; down?: { since: number; why: "dns" | "telegram" }; slept?: boolean }>(LINK_FILE, { okAt: Date.now() });
  onReconnect?: (from: number, to: number, why: "dns" | "telegram" | "sleep") => Promise<void>;

  // О перерыве говорим, только если владелец в это время писал и ждал ответа (его сообщения пришли пачкой),
  // и называем причину верно: сон Mac — это сон, а не «нет интернета».
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
    // отмечаем каждый ответ getUpdates; сторож ниже ловит «бот жив, но глух». Первый удачный опрос после перерыва
    // сначала говорит владельцу, что было, — и только потом бот отвечает на скопившиеся сообщения.
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
        this.link = { ...this.link, slept: true }; // перерыв из-за сна — не обрыв связи
        writeJson(LINK_FILE, this.link);
        this.lastPoll = now; // Mac спал: сначала дать опросу подняться
        return;
      }
      if (now - this.lastPoll > 150_000)
        void netDown().then((down) => {
          if (down) return; // интернета нет — перезапуск не поможет, ждём его
          log("tg", "опрос Telegram молчит больше 2,5 минут — перезапускаюсь");
          process.exit(3); // launchd поднимет заново
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

  // Опрос Telegram. Пока Mac спит, бот у дежурного в облаке; проснувшись, хост запускает опрос заново (src/relay.ts).
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
        if (halted) return; // остановили сами (бот уходит дежурному или хост выключается) — это не сбой
        if (e instanceof GrammyError && e.error_code === 401) {
          // ключ бота отозван (бот перенесён на другой Mac или удалён): перезапуск не поможет — останавливаемся насовсем
          log("tg", "Telegram не принимает ключ бота — бот перенесён на другой Mac или удалён. Хост остановлен");
          process.exit(0);
        }
        log("tg", "опрос Telegram остановился", String(e));
        process.exit(3); // launchd перезапустит
      });
  }
  private polling?: Promise<void>;
  private halt?: () => void;

  // Цикл опроса дорабатывает текущую пачку: ждём его (недолго), чтобы новый опрос не пошёл вторым рядом.
  async stop() {
    this.halt?.();
    await this.bot.stop().catch(() => {});
    await Promise.race([this.polling, sleep(3000)]);
  }

  // Темы в личном чате включаются в @BotFather (Threaded Mode); проверяем, включены ли сейчас.
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
    // нажал кнопку — значит, не спит: ночью ответы на нажатие не откладываются до утра (раньше «не спит» считалось только
    // по сообщениям, и после «Ответить» ночью подсказка ждала 8:00)
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
    if (msg.from?.id === ctx.me.id || msg.pinned_message || msg.managed_bot_created) return; // служебные: бот закрепил «Пульт», создан личный бот и т. п.
    if (!this.owner) return this.tryPair(ctx);
    if (!this.isOwner(ctx)) {
      // привязать заново (новый аккаунт, новый телефон): код даёт только archi pair в Терминале этого Mac — с другого
      // аккаунта принимается лишь верный код, пока он открыт; прочее — тишина, как всем чужим
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

  // again — уже есть владелец: привязка переходит к новому аккаунту, прежний узнаёт об этом (подмену не провернуть тихо)
  private async tryPair(ctx: Context, again = false) {
    const text = ctx.message?.text ?? "";
    log("tg", "сообщение до привязки владельца", { from: ctx.from?.id, chat: ctx.chat?.type, text: text.replace(/\d/g, "#").slice(0, 40) });
    if (ctx.chat?.type !== "private" || !existsSync(PAIR_FILE)) return;
    const p = readJson<{ hash: string; expires: number; attempts: number }>(PAIR_FILE, { hash: "", expires: 0, attempts: 99 });
    const code = text.replace(/^\/(start|pair)(@\w+)?\s*/, "").replace(/\s+/g, "").trim();
    if (!/^\d{6}$/.test(code)) {
      if (again) return;
      // окно привязки открыто, а кода нет — подсказать, а не молчать
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
    let voice: string | undefined;
    for (const m of msgs) {
      const t = m.text ?? m.caption ?? "";
      if (t) texts.push(t);
      const f = await this.download(m).catch((e) => {
        log("tg", "не скачал файл", String(e));
        return null;
      });
      if (!f) continue;
      if (f.kind === "voice" || f.kind === "audio" || f.kind === "video_note") {
        this.typing();
        const said = await transcribe(f.path);
        if (said) {
          voice = said;
          texts.push(said);
          // что услышал — в кавычках, с заглавной, сразу под голосовым (без цитаты: оно и так строкой выше)
          const heard = said.replace(/[_*`]/g, " ").trim();
          const line = `${heard.charAt(0).toUpperCase()}${heard.slice(1)}`;
          await this.send(tr(`«${line}»`, `“${line}”`), { silent: true, threadId: m.is_topic_message ? m.message_thread_id : undefined });
          continue; // распознанное голосовое — это текст, сам файл архитектору не нужен
        }
      }
      files.push(f);
    }
    const r = first.reply_to_message;
    this.lastId = Math.max(this.lastId, ...msgs.map((x) => x.message_id));
    this.lastOwnerAt = Date.now();
    // пересланное — чужие слова, не его согласие: в «его слово» не идёт
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
    if (!res.ok) throw new Error(`скачивание: HTTP ${res.status}`);
    const day = new Date().toISOString().slice(0, 10);
    const dir = join(INBOX, day);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${m.message_id}-${basename(pick.name).replace(/[^\p{L}\p{N}._-]+/gu, "_")}`);
    writeFileSync(path, new Uint8Array(await res.arrayBuffer()), { mode: 0o600 });
    return { path, kind: pick.kind, mime: pick.mime, name: pick.name };
  }

  // ── отправка ───────────────────────────────────────────────────────────────

  // ── темп чата, 429 и повторы без дублей (уроки Hermes #91969, OpenClaw network-errors, ccbot PR #93) ──
  private lastOut = 0; // последний вызов в чат владельца: один слот в секунду на отправки
  private floodUntil = 0; // Telegram наказал за частоту — до этого времени промежуточное (черновики, правки) не шлём
  private deferred: (() => Promise<unknown>)[] = [];
  private flushTimer?: Timer;

  private get flooded() {
    return Date.now() < this.floodUntil;
  }

  // kind: "send" — сообщение владельцу (ждёт слот; по сети повторяется, только если запрос точно не ушёл); "edit" — правка/служебное.
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
          throw e; // длинный штраф: не засыпать — отправку отложит send(), правку пропустят
        }
        if (!(e instanceof GrammyError) && attempt < 2 && (kind === "edit" || preConnect(e))) {
          await sleep(1500);
          continue;
        }
        throw e;
      }
    }
  }

  // Отправка содержания: разметку не понял — "parse" (пусть шлют проще); длинный 429 — отложить и дослать; сбой сети — один повтор
  // (для ответа владельцу лучше редкий дубль, чем потеря — ccbot message_queue.py).
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

  lastId = 0; // последнее сообщение в чате — его или наше: ответ на него цитировать незачем
  private remember(id: number, kind: "rich" | "text") {
    this.lastId = Math.max(this.lastId, id);
    this.kinds.set(id, kind);
    if (this.kinds.size > 2000) this.kinds.delete(this.kinds.keys().next().value!);
  }

  // Кнопки, которые сейчас висят под сообщением: «Пульт» повторяет кнопки запроса, чтобы решать в одно касание.
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

  // Отправляет Markdown владельцу; длинное режет на части. Возвращает id сообщений.
  // forceReply — поле ввода у владельца сразу встаёт ответом на это сообщение (подсказка — в поле).
  // Что бот отправил владельцу без архитектора (сводки, быстрые ответы, сообщения о связи, ссылки): архитектор видит это
  // со следующим сообщением владельца. Иначе он о них не знает и считает последним своё старое сообщение.
  hostSent: { at: number; text: string }[] = [];
  lastOwnerAt = 0;
  // его сообщения за последние полчаса: «останови», «поставь цель» — его слово, второй раз кнопкой не спрашиваем
  ownerSaid: { at: number; text: string }[] = [];
  // Ночью (0:00–8:00) владелец спит: даже «тихое» сообщение зажигает баннер. Что он не просил и что не ждёт его
  // кнопки — откладываем до утреннего итога.
  private nightHeld = readJson<{ at: number; text: string }[]>(NIGHT_FILE, []);
  takeNightHeld() {
    const held = this.nightHeld;
    this.nightHeld = [];
    writeJson(NIGHT_FILE, []);
    return held;
  }

  // skipAtNight — ночью, пока он спит, не откладывать до утра, а не слать вовсе: утренний итог покажет это сам (страницы)
  async send(md: string, opts: { replyTo?: number; buttons?: Button[][]; silent?: boolean; threadId?: number; forceReply?: string; from?: "architect"; asked?: string; skipAtNight?: boolean } = {}): Promise<number[]> {
    const chat = this.owner;
    if (!chat) return [];
    // вид задаёт код, а не модель: жирное, адреса кнопками, типографика, без точки в конце
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
    // ночью (0:00–8:00 по часам Mac) — без звука, если отправитель не попросил звук явно
    opts = { ...opts, silent: opts.silent ?? night };
    log("tg", `→ ${opts.silent ? "(тихо) " : ""}${clean.replace(/\s+/g, " ").slice(0, 80)}`); // что ушло владельцу — для разбора жалоб
    if (opts.from !== "architect") this.hostSent = [...this.hostSent, { at: Date.now(), text: opts.asked ? `на его «${opts.asked}» — ${clean}` : clean }].slice(-12);
    // полный текст и кнопки — отдельно: по первым 80 знакам не прочесть, что бот написал
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

  // Последние сообщения архитектора — чтобы ошибку в них исправить на месте, а не только новым сообщением
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

  // buttons: undefined — не трогать, null — убрать.
  async edit(messageId: number, md: string, opts: { buttons?: Button[][] | null } = {}) {
    const chat = this.owner;
    if (!chat || !messageId) return;
    if (this.flooded && opts.buttons === undefined) return; // промежуточная правка подождёт — следующий круг покажет то же
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

  // Потоковый черновик ответа: живёт ~30 с, поэтому его обновляют, пока идёт работа; итог — обычным send().
  // Пока текста нет — блок «Думаю…» (что сейчас делается); когда пишется ответ — сам текст Markdown-ом.
  // Ошибки разбираем: 429 и сеть — пропустить кадр; «не понял разметку» — проще, но только до конца хода (OpenClaw #92004, Hermes).
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
      if (!(e instanceof GrammyError) || e.error_code !== 400) return; // сеть — просто пропустить кадр
      this.draftMode = this.draftMode === "rich" && body ? "blocks" : "plain";
      log("tg", `черновик: Telegram не принял (${e.description}) — до конца хода проще`);
    }
  }

  // Правка, которая говорит, удалась ли она: false — сообщения больше нет (удалено), надо слать новое.
  async editStrict(messageId: number, md: string, opts: { buttons?: Button[][] | null } = {}): Promise<"ok" | "gone" | "error"> {
    const chat = this.owner;
    if (!chat) return "error";
    if (this.flooded) return "error"; // пульт обновится на следующем круге
    try {
      await this.call(() =>
        // тот же вид, что у /status: закреп правится по 170 раз за день и обходил типограф — тире и предлоги на краю строки
        this.bot.api.raw.editMessageText({ chat_id: chat, message_id: messageId, rich_message: { markdown: richSafe(clip(noFinalDot(typograph(scrub(tameBold(md)))), RICH_LIMIT)) }, reply_markup: keyboard(opts.buttons) }),
      );
      return "ok";
    } catch (e) {
      const s = String(e);
      if (s.includes("message is not modified")) return "ok";
      // пересоздавать — только если Telegram прямо ответил, что сообщения нет; сеть, сон Mac, 429 — повторить позже (иначе плодятся копии «Пульта»)
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

  async remove(messageId: number) {
    const chat = this.owner;
    if (chat) await this.bot.api.deleteMessage(chat, messageId).catch(() => {});
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

  // Альбом снимков (до 10): первая подпись — общая.
  async sendAlbum(items: { path: string; caption?: string }[], opts: { threadId?: number; replyTo?: number; silent?: boolean } = {}): Promise<number[]> {
    const chat = this.owner;
    if (!chat || !items.length) return [];
    // снимки хоста (после выкладки, «так станет») архитектор тоже должен знать, иначе пришлёт такие же сам
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

  async renameTopic(threadId: number, name: string) {
    const chat = this.owner;
    if (chat) await this.bot.api.editForumTopic(chat, threadId, { name: clip(name, 128) }).catch(() => {});
  }
}

// Ошибка до соединения — запрос точно не ушёл, повтор не создаст дубль (OpenClaw network-errors.ts).
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
