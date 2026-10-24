// Strangers in a shared bot get a separate path: only a greeting and connecting their own Mac. No architect, tools,
// sessions or owner data: a raw Telegram update comes in, only prewritten texts go out. Message contents are never logged
// or passed on, files are never downloaded, and the rate is limited per person and overall.
// Connecting: the connector on the Mac shows a QR code with a /start c<Mac key> link and a four-digit code → the person
// types the code from their Mac's screen (a link can be forwarded, the code must be seen) → a "Create my bot" button
// (managed bots, Bot API 9.6) → the new bot's token is sealed to their Mac's key and put in the box (src/box.ts).
// The token exists only in memory until sealed.
// `bun src/guest.ts dist <folder>` builds a distribution: the installer `i` (bin/install.sh with the URLs and the
// manager key filled in) and archi.tgz.
import { GrammyError, type Api, type Context } from "grammy";
import type { InlineKeyboardMarkup, ReplyKeyboardMarkup, User } from "grammy/types";
import { join } from "node:path";
import { boxId, isDevicePub, managerKey, newManagerKey, pairCode, postBox, seal, type Letter } from "./box";
import { STATE, config, tr } from "./config";
import { MANAGER_SERVICE, readSecret, writeSecret } from "./secret";
import { log, readJson, writeJson } from "./util";

const FILE = join(STATE, "guests.json"); // bots created for strangers (no tokens), pending connections, used Mac keys
const PENDING_MS = 15 * 60_000;
const LIMIT = { perMin: 8, perDay: 60, allPerMin: 60 };

type Store = {
  bots: Record<string, { id: number; username: string; at: number }>;
  pending: Record<string, { pub: string; at: number; tries?: number; ok?: boolean }>; // ok: the code from the Mac's screen matched
  used: Record<string, number>;
};

// Texts in this bot's language (lang in the config), read at every send
export const TEXT = {
  get welcome() {
    return tr(
      "Архитектор — это Claude Code на вашем Mac, которым вы управляете из Telegram.\n\n" +
        "Вы получите своего бота. Он живёт на вашем Mac и работает под вашим входом в Claude. Этот бот к вашему Mac доступа не получит.\n\n" +
        "Подключение займёт три минуты.",
      "Architect is Claude Code on your Mac that you run from Telegram.\n\n" +
        "You’ll get your own bot. It lives on your Mac and works under your Claude sign-in. This bot gets no access to your Mac.\n\n" +
        "Connecting takes three minutes.",
    );
  },
  get description() {
    return tr("Архитектор — Claude Code на вашем Mac, которым вы управляете из Telegram. Здесь можно подключить свой Mac.", "Architect: Claude Code on your Mac that you run from Telegram. Connect your Mac here.");
  },
  get closed() {
    return tr("Подключение пока закрыто. Загляните позже.", "Connecting is closed for now. Check back later.");
  },
  get how() {
    return tr(
      "Этот бот создаёт вашего бота и передаёт его ключ на ваш Mac зашифрованным: сервер пересылки его не прочитает.\n\n" +
        "Дальше ваш Mac говорит с Telegram сам. Файлы, сессии и вход в Claude остаются на Mac.\n\n" +
        "Как у всех управляемых ботов Telegram, создатель этого бота технически может получить ключ вашего бота и читать вашу переписку с ним. Управлять вашим Mac он не может.",
      "This bot creates your bot and sends its key to your Mac encrypted: the relay server can’t read it.\n\n" +
        "After that, your Mac talks to Telegram on its own. Files, sessions and your Claude sign-in stay on the Mac.\n\n" +
        "As with every Telegram managed bot, the creator of this bot can technically get your bot’s key and read your chat with it. They can’t control your Mac.",
    );
  },
  get code() {
    return tr(
      "Mac на связи. Введите код с экрана Mac — четыре цифры под QR-кодом.\n\nЕсли вы не запускали команду на своём Mac, ничего не вводите: ссылку мог прислать кто-то другой.",
      "Your Mac checked in. Enter the code from its screen — the four digits under the QR code.\n\nIf you didn’t run the command on your own Mac, don’t enter anything: someone else may have sent you the link.",
    );
  },
  codeWrong: (left: number) => tr(`Код не совпал. Посмотрите на экран Mac ещё раз — осталось попыток: ${left}.`, `That code doesn’t match. Check the Mac’s screen again — ${left} ${left === 1 ? "try" : "tries"} left.`),
  get codeFailed() {
    return tr("Код не совпал. Запустите команду на Mac ещё раз — появится новый QR-код.", "That code doesn’t match. Run the command on the Mac again to get a new QR code.");
  },
  get online() {
    return tr("Код верный. Теперь создайте своего бота — кнопка внизу.", "Code accepted. Now create your bot — the button is below.");
  },
  get used() {
    return tr("Этот QR-код уже использован. Запустите команду на Mac ещё раз — появится новый.", "This QR code has already been used. Run the command on the Mac again to get a new one.");
  },
  get broken() {
    return tr("Ссылка повреждена. Отсканируйте QR-код на Mac ещё раз.", "The link is broken. Scan the QR code on the Mac again.");
  },
  get hint() {
    return tr("Чтобы подключить свой Mac, нажмите «Подключить мой Mac» выше или отправьте /start.", "To connect your Mac, tap “Connect my Mac” above or send /start.");
  },
  get failed() {
    return tr("Не получилось передать ключ на Mac. Запустите команду на Mac ещё раз.", "Couldn’t send the key to the Mac. Run the command on the Mac again.");
  },
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// A short installer URL, so the command doesn't wrap mid-word in a message
export const installCommand = (dist: string) => `curl -fsSL ${dist.replace(/\/$/, "")}/i | sh`;

// A suggested username for the personal bot: Latin, 5–32 characters, starting with a letter and ending in "bot"
export function suggestUsername(u: Pick<User, "username">): string {
  const base = (u.username ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "").replace(/^[^a-z]+/, "").slice(0, 23);
  if (base.length >= 2) return `${base}_arch_bot`;
  const tail = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
  return `archi_${tail}_bot`;
}

export class Guest {
  private st = readJson<Store>(FILE, { bots: {}, pending: {}, used: {} });
  private hits = new Map<number, { m: number; mAt: number; d: number; dAt: number }>();
  private all = { n: 0, at: 0 };

  constructor(
    private api: Api,
    private me: () => { username: string; canManage: boolean },
    private relay = config.connect!.relay,
    private dist = config.connect!.dist,
  ) {}

  // Everything not from the owner, plus managed-bot creation. Never calls the owner's handlers.
  async handle(ctx: Context) {
    const u = ctx.update;
    const from = ctx.from;
    if (!from || from.is_bot) return;
    // Telegram itself sends the creation update after the person acts, so no rate limit applies
    if (u.managed_bot) return this.created(u.managed_bot.user, u.managed_bot.bot);
    const m = u.message;
    if (m && (m.chat.type !== "private" || m.managed_bot_created)) return; // groups aren't counted; creation was already answered
    if (!this.allow(from.id)) return;
    if (u.callback_query) {
      const data = u.callback_query.data;
      await this.api.answerCallbackQuery(u.callback_query.id).catch(() => {});
      log("guest", "незнакомец нажал кнопку", { user: from.id, data: data === "g:connect" || data === "g:how" ? data : "чужая" });
      if (data === "g:connect") return this.instructions(from.id);
      if (data === "g:how") return this.say(from.id, TEXT.how);
      return;
    }
    if (!m) return;
    const t = (m.text ?? "").trim();
    const pair = t.match(/^\/start c([A-Za-z0-9_-]+)$/);
    if (pair) return this.pair(from, pair[1]);
    if (/^\d{4}$/.test(t) && this.awaitingCode(from.id)) return this.code(from, t);
    log("guest", `незнакомец: ${/^\/start\b/.test(t) ? "старт" : "сообщение"}`, { user: from.id }); // never the content
    if (/^\/start\b/.test(t)) return this.welcome(from.id);
    return this.say(from.id, TEXT.hint);
  }

  // The QR link from the Mac: /start c<Mac key>. Nothing irreversible happens before the code from that Mac's screen.
  // The owner can connect another Mac of theirs this way too.
  async pair(from: Pick<User, "id" | "first_name" | "last_name" | "username">, pub: string) {
    if (!isDevicePub(pub)) return this.say(from.id, TEXT.broken);
    this.prune();
    if (this.st.used[pub]) return this.say(from.id, TEXT.used);
    this.st.used[pub] = Date.now();
    this.st.pending[from.id] = { pub, at: Date.now(), tries: 0 };
    this.save();
    log("guest", "Mac на связи, жду код", { user: from.id, box: (await boxId(pub)).slice(0, 8) });
    if (!this.me().canManage && !this.st.bots[from.id]) return this.say(from.id, TEXT.closed);
    return this.say(from.id, TEXT.code);
  }

  awaitingCode(user: number): boolean {
    const p = this.st.pending[user];
    return !!p && !p.ok && Date.now() - p.at < PENDING_MS;
  }

  // The code from the Mac's screen: only then is a bot created or moved. Three tries, then a new QR code.
  async code(from: Pick<User, "id" | "first_name" | "last_name" | "username">, text: string) {
    const p = this.st.pending[from.id];
    if (!p || p.ok) return;
    const right = text === (await pairCode(p.pub));
    if (this.st.pending[from.id] !== p || p.ok) return; // meanwhile the tries ran out or the code was accepted
    if (!right) {
      p.tries = (p.tries ?? 0) + 1;
      if (p.tries >= 3) delete this.st.pending[from.id];
      this.save();
      log("guest", "код с Mac не совпал", { user: from.id, tries: p.tries });
      return this.say(from.id, p.tries >= 3 ? TEXT.codeFailed : TEXT.codeWrong(3 - p.tries));
    }
    p.ok = true;
    this.save();
    log("guest", "код с Mac совпал", { user: from.id });
    const mine = this.st.bots[from.id];
    if (mine) {
      // the person already has a bot: move it to this Mac with a new token, which disconnects the previous Mac
      try {
        const token = await this.api.replaceManagedBotToken(mine.id);
        return this.deliver(from as User, { id: mine.id, username: mine.username }, p.pub, token, true);
      } catch (e) {
        log("guest", "не перевыпустил ключ бота", String(e));
        if (!(e instanceof GrammyError && (e.error_code === 400 || e.error_code === 404))) return this.say(from.id, TEXT.failed);
        delete this.st.bots[from.id]; // deleted in @BotFather: create a new one
        this.save();
      }
    }
    if (!this.me().canManage) return this.say(from.id, TEXT.closed);
    const keyboard: ReplyKeyboardMarkup = {
      keyboard: [[{ text: tr("Создать моего бота", "Create my bot"), request_managed_bot: { request_id: crypto.getRandomValues(new Int32Array(1))[0], suggested_name: tr("Архитектор", "Architect"), suggested_username: suggestUsername(from) } }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    };
    return this.say(from.id, TEXT.online, keyboard);
  }

  // Telegram reports a created bot (or a new token for one): close the bot to everyone but its creator and send the token
  // to the Mac
  async created(creator: User, bot: User) {
    const had = this.st.bots[creator.id];
    const p = this.st.pending[creator.id];
    this.st.bots[creator.id] = { id: bot.id, username: bot.username ?? "", at: Date.now() };
    this.save();
    await this.api.setManagedBotAccessSettings(bot.id, true).catch((e) => log("guest", "не закрыл бота для чужих", String(e)));
    if (!p?.ok || Date.now() - p.at > PENDING_MS) {
      if (had?.id === bot.id) return; // a new token without a pending connection
      log("guest", "бот создан без Mac на связи", { user: creator.id, bot: bot.username });
      return this.instructions(creator.id);
    }
    const token = await this.api.getManagedBotToken(bot.id).catch((e) => (log("guest", "не получил ключ бота", String(e)), ""));
    if (!token) return this.say(creator.id, TEXT.failed);
    return this.deliver(creator, { id: bot.id, username: bot.username ?? "", name: bot.first_name }, p.pub, token, false);
  }

  private async deliver(owner: User, bot: { id: number; username: string; name?: string }, pub: string, token: string, moved: boolean) {
    // the token isn't even registered for scrubbing: scrub() masks its pattern anyway, and it lives here only until sealed
    try {
      const letter: Letter = { v: 1, token, bot, owner: { id: owner.id, name: [owner.first_name, owner.last_name].filter(Boolean).join(" ") || "Telegram", username: owner.username }, manager: this.me().username, at: Date.now() };
      await postBox(this.relay, await boxId(pub), await seal(letter, pub, (await this.key()).priv));
    } catch (e) {
      log("guest", "ключ на Mac не отправлен", String(e));
      return this.say(owner.id, TEXT.failed);
    }
    delete this.st.pending[owner.id];
    this.save();
    log("guest", moved ? "бот перенесён на новый Mac" : "личный бот создан, ключ отправлен на Mac", { user: owner.id, bot: bot.username });
    const text = moved
      ? tr(
          `Переношу вашего бота @${bot.username} на новый Mac. Прежний Mac от него отключён.\n\nПодтвердите на Mac — напишите «да» в Терминале.`,
          `Moving your bot @${bot.username} to the new Mac. The previous Mac is disconnected from it.\n\nConfirm on the Mac — type “yes” in Terminal.`,
        )
      : tr(
          `Бот @${bot.username} создан. Писать ему можете только вы.\n\nПодтвердите подключение на Mac — напишите «да» в Терминале. Потом откройте бота.`,
          `Bot @${bot.username} is ready. Only you can message it.\n\nConfirm the connection on the Mac — type “yes” in Terminal. Then open the bot.`,
        );
    return this.say(owner.id, text, { inline_keyboard: [[{ text: `${tr("Открыть", "Open")} @${bot.username}`, url: `https://t.me/${bot.username}` }]] });
  }

  // What a stranger sees before "Start": the bot description, unless the owner set one
  async describe() {
    const d = await this.api.getMyDescription().catch(() => ({ description: "x" }));
    if (!d.description) await this.api.setMyDescription(TEXT.description).catch(() => {});
  }

  private welcome(chat: number) {
    if (!this.me().canManage) return this.say(chat, TEXT.closed);
    return this.say(chat, TEXT.welcome, { inline_keyboard: [[{ text: tr("Подключить мой Mac", "Connect my Mac"), callback_data: "g:connect" }]] });
  }

  private instructions(chat: number) {
    const cmd = installCommand(this.dist);
    const text = tr(
      `1. На Mac откройте Терминал и вставьте команду:\n<pre>${esc(cmd)}</pre>\n2. Наведите камеру iPhone на QR-код, который она покажет.\n\nНужен Claude Code на Mac с вашим входом в Claude. Если его нет, команда предложит поставить.`,
      `1. On the Mac, open Terminal and paste this command:\n<pre>${esc(cmd)}</pre>\n2. Point your iPhone camera at the QR code it shows.\n\nYou need Claude Code on the Mac, signed in to your Claude account. If it isn’t installed, the command will offer to install it.`,
    );
    return this.say(chat, text, { inline_keyboard: [[{ text: tr("Скопировать команду", "Copy command"), copy_text: { text: cmd } }], [{ text: tr("Что видит этот бот", "What this bot can see"), callback_data: "g:how" }]] });
  }

  private async say(chat: number, html: string, reply_markup?: InlineKeyboardMarkup | ReplyKeyboardMarkup) {
    await this.api.sendMessage(chat, html, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup }).catch((e) => log("guest", "ответ незнакомцу не ушёл", String(e)));
  }

  // 8 a minute and 60 a day per person, 60 a minute for all strangers together, which bounds both replies and disk
  // writes. The per-person limit comes first, so one account can't use up the shared one. The rest is silently dropped.
  private allow(user: number): boolean {
    const now = Date.now();
    const h = this.hits.get(user) ?? { m: 0, mAt: now, d: 0, dAt: now };
    if (now - h.mAt > 60_000) Object.assign(h, { m: 0, mAt: now });
    if (now - h.dAt > 86_400_000) Object.assign(h, { d: 0, dAt: now });
    h.m++;
    h.d++;
    this.hits.delete(user);
    this.hits.set(user, h);
    if (this.hits.size > 5000) this.hits.delete(this.hits.keys().next().value!);
    if (h.m > LIMIT.perMin || h.d > LIMIT.perDay) {
      if (h.m === LIMIT.perMin + 1 || h.d === LIMIT.perDay + 1) log("guest", "незнакомец пишет слишком часто — не отвечаю", { user });
      return false;
    }
    if (now - this.all.at > 60_000) this.all = { n: 0, at: now };
    if (++this.all.n > LIMIT.allPerMin) {
      if (this.all.n === LIMIT.allPerMin + 1) log("guest", "чужих слишком много — минуту не отвечаю никому из них");
      return false;
    }
    return true;
  }

  private prune() {
    const now = Date.now();
    for (const [k, p] of Object.entries(this.st.pending)) if (now - p.at > PENDING_MS) delete this.st.pending[k];
    for (const [k, t] of Object.entries(this.st.used)) if (now - t > 86_400_000) delete this.st.used[k];
    const used = Object.entries(this.st.used);
    if (used.length > 5000) this.st.used = Object.fromEntries(used.sort((a, b) => b[1] - a[1]).slice(0, 5000));
    const bots = Object.entries(this.st.bots);
    if (bots.length > 10_000) this.st.bots = Object.fromEntries(bots.sort((a, b) => b[1].at - a[1].at).slice(0, 10_000));
  }

  private save() {
    writeJson(FILE, this.st);
  }

  private async key() {
    return managerKey(await ensureManagerKey());
  }
}

// The envelope signing key: one per manager, in the Keychain; its public part is baked into the installer
export async function ensureManagerKey(): Promise<string> {
  let k = readSecret(MANAGER_SERVICE);
  if (!k) {
    k = await newManagerKey();
    writeSecret(MANAGER_SERVICE, k);
  }
  return k;
}

// Builds the distribution: the installer `i` (bin/install.sh with the distribution and box URLs, the manager bot and its
// public key filled in) and archi.tgz with only what the host needs: no config.json, README or tests.
export async function buildDist(out: string, manager: string) {
  const { ARCH_HOME } = await import("./config");
  const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
  mkdirSync(out, { recursive: true });
  const tgz = join(out, "archi.tgz");
  const files = ["src", "bin/arch", "bin/install.sh", "package.json", "bun.lock", "tsconfig.json", "CLAUDE.md"].filter((f) => existsSync(join(ARCH_HOME, f)));
  const tar = Bun.spawnSync(["tar", "-czf", tgz, "--exclude", "*.test.ts", "-C", ARCH_HOME, ...files], { stderr: "pipe" });
  if (tar.exitCode !== 0) throw new Error(`tar: ${tar.stderr.toString()}`);
  const sha = new Bun.CryptoHasher("sha256").update(readFileSync(tgz)).digest("hex");
  const pub = (await managerKey(await ensureManagerKey())).pub;
  const script = readFileSync(join(ARCH_HOME, "bin", "install.sh"), "utf8")
    .replaceAll("__LANG__", config.lang === "en" ? "en" : "ru") // the installer and the new bot speak this bot's language
    .replaceAll("__DIST__", config.connect!.dist.replace(/\/$/, ""))
    .replaceAll("__RELAY__", config.connect!.relay.replace(/\/$/, ""))
    .replaceAll("__MANAGER__", manager)
    .replaceAll("__KEY__", pub)
    .replaceAll("__SHA256__", sha);
  writeFileSync(join(out, "i"), script, { mode: 0o644 });
  return { install: join(out, "i"), tgz, sha, pub };
}

if (import.meta.main && process.argv[2] === "dist") {
  const out = process.argv[3];
  const manager = process.argv[4] ?? readJson<{ username?: string }>(join(STATE, "bot.json"), {}).username;
  if (!out || !manager || !config.connect) {
    console.error(tr("bun src/guest.ts dist <папка> [имя бота] — нужен connect.relay и connect.dist в config.json", "bun src/guest.ts dist <folder> [bot name] — needs connect.relay and connect.dist in config.json"));
    process.exit(2);
  }
  const r = await buildDist(out, manager);
  console.log(tr(`Раздача собрана: ${r.install}, ${r.tgz} (sha256 ${r.sha.slice(0, 12)}…). Команда: ${installCommand(config.connect.dist)}`, `Distribution built: ${r.install}, ${r.tgz} (sha256 ${r.sha.slice(0, 12)}…). Command: ${installCommand(config.connect.dist)}`));
}
