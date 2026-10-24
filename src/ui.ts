// Как сессии выглядят у владельца: своя тема в личном чате (если включён Threaded Mode),
// карточка с состоянием и кнопками, итоги ходов, тревоги. Без тем — всё в общем чате с привязкой ответов.
import { basename, join } from "node:path";
import { ARCH_HOME, HOME, STATE, config, tr } from "./config";
import { mdEsc, stripMd } from "./md";
import { conversationRows, deliver, listAgents, readTail, sessionDigest, stopSession, transcriptPath, workers, type AgentRow, type ConvRow } from "./sessions";
import type { Button, Telegram } from "./telegram";
import { clip, hhmm, log, readJson, writeJson } from "./util";
import { understood } from "./understand";

type View = { threadId?: number; cardId?: number; name: string; cwd: string; cardMd?: string; cardButtons?: string; cardState?: string; cardAt?: number; lastTurnAt?: number; lastPosted?: string };
type Store = { views: Record<string, View>; msgs: Record<string, string> };
const FILE = join(STATE, "ui.json");

// Состояние словами — без значков и эмодзи
// «done» Claude Code — закончила ход, а не «на паузе»: в карточке «на паузе» читалось «кто-то остановил»
const WORD: Record<string, string> = { starting: "запускается", working: "работает", blocked: "ждёт вас", done: "закончила", failed: "остановилась на ошибке", stopped: "остановлена" };
const WORD_EN: Record<string, string> = { starting: "starting", working: "working", blocked: "waiting for you", done: "finished", failed: "stopped on an error", stopped: "stopped" };
// те же слова, что в закрепе: по суждению о сессии (src/understand.ts), если оно есть
const UNDERSTOOD: Record<string, string> = { needs_owner: "ждёт вашего решения", accept: "закончила, ждёт вашей проверки", paused: "на паузе", working: "работает" };
const UNDERSTOOD_EN: Record<string, string> = { needs_owner: "needs your decision", accept: "finished, ready for your review", paused: "paused", working: "working" };
const LOG = () => tr("Последние шаги", "Recent steps"); // кнопка журнала сессии

// Длинный итог: главное видно сразу, остальное — под «Ещё…» (сворачиваемый блок rich-сообщения).
export function foldLong(md: string, visible = 900): string {
  if (md.length <= visible + 300) return md;
  const lines = md.split("\n");
  let fence = false;
  let len = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    len += lines[i].length + 1;
    if (!fence && len >= visible * 0.6 && lines[i].trim() === "" && i < lines.length - 1) {
      const rest = lines.slice(i + 1).join("\n").trim();
      return `${lines.slice(0, i).join("\n").trim()}\n\n<details><summary>${tr(`Ещё ${rest.length} знаков`, `${rest.length} more characters`)}</summary>\n\n${rest}\n\n</details>`;
    }
    if (!fence && len >= visible * 1.4) break;
  }
  return md;
}

// claude-7f, user-99 — имя без смысла; номер фоновой сессии «c3a758b4» — тоже («Ждут вашего решения: Арена, c3a758b4»
// не понять); и общие слова, которыми Claude Code сам называет фоновую сессию («continue previous session»)
const autoName = (n?: string) => !n || /^[\w.-]+-[0-9a-f]{2,4}$/i.test(n) || /^[0-9a-f]{6,}(-[0-9a-f-]+)?$/i.test(n) || /^(continue( the)? previous session|new session|untitled( session)?)$/i.test(n);
// Слова сессии для владельца — без путей и имён файлов: «служебный файл Excel ~$Отчёт.xlsx» → «служебный файл Excel»
export const clean = (t: string) =>
  t
    // путь или имя файла — вместе с предлогом перед ним: «записан в validation/x.md и в CHANGELOG» → «записан и в CHANGELOG»;
    // перетащенный в терминал файл — путь с «\ » вместо пробелов; по-английски — свои предлоги: «saved to a/b.md»
    .replace(
      tr(
        /(?:\s(?:в|во|на|из|к|по|от)(?=\s))?(?:(^|\s)[~/](?:\\\s|\S)*[^\s,.;:!?»)]|\s?\S+\/\S+\.\w{1,5}\b|\s?\S+\.(xlsx?|docx?|md|json|jsonl|ts|js|py|html|csv|pdf|png|jpe?g|txt)\b)/gi,
        /(?:\s(?:in|into|to|at|from|on)(?=\s))?(?:(^|\s)[~/](?:\\\s|\S)*[^\s,.;:!?»”)]|\s?\S+\/\S+\.\w{1,5}\b|\s?\S+\.(xlsx?|docx?|md|json|jsonl|ts|js|py|html|csv|pdf|png|jpe?g|txt)\b)/gi,
      ),
      "$1",
    )
    .replace(/\s+([?.,!])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
// адрес сайта в цели сессии — её имя словами владельца; длинный адрес раньше (Онлайн-курс лежит внутри Лендинга)
const SITES = config.sites
  .map((s) => ({ name: s.name, re: new RegExp(`(?<![\\w.-])${s.url.replace(/^https?:\/\//, "").replace(/\/$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i"), len: s.url.length }))
  .sort((a, b) => b.len - a.len);

// Имя сессии для владельца: имя от архитектора или /rename → сайт из цели → своя папка → начало цели → тема, которую дал Claude.
// Имя, под которым владелец уже знает сессию, не меняется: автозаголовок Claude идёт за разговором, и «A*»
// превратилась бы в «Ветка master и опубликованный сайт». Меняет имя только сам владелец (/rename).
const NAMES_FILE = join(STATE, "names.json");
// папка бота и её рабочая копия (architect, architect-dev) — сессия, которая его строит
const OWN = new RegExp(`^${basename(ARCH_HOME).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(-[\\w]+)?$`, "i");
const BUILD = () => tr("Сборка бота", "Bot build");
// запомненное служебное имя («c3a758b4») и имя папки бота («Architect») — не имена: забываем, сессия получит человеческое заново
const known = Object.fromEntries(Object.entries(readJson<Record<string, string>>(NAMES_FILE, {})).filter(([, v]) => !autoName(v) && !OWN.test(v)));
const keep = (sessionId: string, name: string) => {
  if (known[sessionId] !== name) {
    known[sessionId] = name;
    writeJson(NAMES_FILE, known);
  }
  return name;
};

// Имя, которое сессии дал владелец через архитектора (например, «назови её Блог»), — главнее любых догадок хоста:
// имя по адресу сайта в её цели бывает неверным.
const GIVEN_FILE = join(STATE, "given-names.json");
const given = readJson<Record<string, string>>(GIVEN_FILE, {});
export function giveName(sessionId: string, name: string) {
  given[sessionId] = name;
  writeJson(GIVEN_FILE, given);
}

export function displayName(sessionId: string, cwd: string, rows: AgentRow[] = []): string {
  if (given[sessionId]) return given[sessionId];
  const w = workers.get(sessionId);
  if (w?.name) return w.name;
  // запомненное имя — до имени процесса: после перевода в фон Claude Code называет сессию «continue previous session»,
  // и бот подхватил бы это имя. Переименовать может только владелец (name_session)
  if (known[sessionId]) return known[sessionId];
  const row = rows.find((r) => r.sessionId === sessionId);
  if (row?.name && !autoName(row.name)) return keep(sessionId, row.name);
  const d = sessionDigest({ sessionId, cwd } as AgentRow);
  if (d.named && d.title) return keep(sessionId, clip(d.title, 40));
  return named(sessionId, cwd, rows, d);
}

function named(sessionId: string, cwd: string, rows: AgentRow[], d: ReturnType<typeof sessionDigest>): string {
  const site = d.goal ? SITES.find((s) => s.re.test(d.goal!)) : undefined;
  if (site) return keep(sessionId, site.name);
  const folder = basename(cwd).replace(/[^\p{L}\p{N}]+$/u, "");
  const alone = rows.length > 0 && rows.filter((r) => r.cwd === cwd && (r.pid || r.state === "working" || r.state === "blocked")).length <= 1;
  if (folder && alone && cwd !== HOME && !config.roots.includes(cwd)) return keep(sessionId, cap1(folder));
  const clause = d.goal?.replace(/^ЦЕЛЬ\s*—\s*/i, "").split(/[,.:;(]|\s—\s/)[0].trim();
  const bySite = clause && config.sites.find((s) => clause.toLowerCase().startsWith(s.name.toLowerCase() + " ")); // «блог компании» → «Блог»
  if (bySite) return keep(sessionId, bySite.name);
  if (clause && clause.length <= 40) return keep(sessionId, cap1(clause));
  // в общей папке — подпапка, где идёт её работа: «мои проекты/astar» → сайт «A*» (а не тема Claude «Ветка master и опубликованный сайт»)
  // хвост журнала бывает короток (большие ответы инструментов) — найденную подпапку помним, чтобы имя не прыгало
  const sub = workDir(d.tools ?? [], cwd) ?? workDirs.get(sessionId);
  if (sub) {
    workDirs.set(sessionId, sub);
    // папка самого бота — «Сборка бота», а не «Architect»: так зовут сам бот, и в списке «Работают: …, Architect» читалось,
    // будто это он
    if (OWN.test(sub)) return keep(sessionId, BUILD());
    return keep(sessionId, config.sites.find((s) => s.repo === sub || s.repo?.endsWith(`-${sub}`))?.name ?? cap1(sub));
  }
  return clip(d.title ?? clause ?? (cap1(folder) || `${tr("сессия", "session")} ${sessionId.slice(0, 6)}`), 40);
}

const workDirs = new Map<string, string>(); // сессия → подпапка, где она работает

// Подпапка cwd, где почти все её последние команды и файлы (не меньше двух и трёх пятых от всех с путём внутри cwd)
function workDir(tools: string[], cwd: string): string | undefined {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const base = cwd.startsWith(`${HOME}/`) ? `(?:${esc(HOME)}|~)${esc(cwd.slice(HOME.length))}` : esc(cwd);
  const re = new RegExp(`${base}/([^/\\s"'\`]+)`);
  const count = new Map<string, number>();
  for (const t of tools) {
    const sub = t.match(re)?.[1];
    if (sub && !sub.startsWith(".")) count.set(sub, (count.get(sub) ?? 0) + 1);
  }
  const all = [...count.values()].reduce((a, b) => a + b, 0);
  const [top, n] = [...count].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  return n >= 2 && n >= all * 0.6 ? top : undefined;
}

// Слова сессии коротко: без путей и разметки, целыми фразами до 170 знаков
function short(t: string): string {
  const s = clean(stripMd(t))
    .replace(/\.?\s+-\s+/g, ". ")
    .replace(/\s+/g, " ")
    .trim();
  let out = "";
  for (const x of s.split(/(?<=[.!?…])\s+/)) {
    if (`${out} ${x}`.trim().length > 170) break;
    out = `${out} ${x}`.trim();
  }
  return out || `${s.slice(0, s.lastIndexOf(" ", 165))}…`;
}

const SYSTEM_TEXT = /^\s*(You've hit your|API Error|Claude Code returned an error|Request interrupted|\[Request interrupted|Prompt is too long|Credit balance)/i;

// Её последние реплики по делу: без команд, без «Жду…» по кругу и без служебной переписки («статус сессии architect-ae»);
// в одну минуту — одна, самая полная (ход дробится на куски с одной мыслью)
function talk(sessionId: string, cwd: string): ConvRow[] {
  const rows: ConvRow[] = [];
  for (const r of conversationRows(readTail(transcriptPath(cwd, sessionId)), 400)) {
    if (r.who === "tool" || (r.who === "claude" && /^(жду(?!\p{L})|waiting\b)/iu.test(r.text.trim())) || /\b[a-z]+-[0-9a-f]{2,4}\b/.test(r.text) || !short(r.text)) continue;
    // ошибка лимита или API — не её слова: «Ответить: Арена» показал бы «You've hit your session limit…»
    if (r.who === "claude" && SYSTEM_TEXT.test(r.text)) continue;
    const prev = rows.at(-1);
    if (prev && prev.ts === r.ts && prev.who === r.who) {
      if (r.text.length > prev.text.length) rows[rows.length - 1] = r;
    } else rows.push(r);
  }
  return rows;
}

// «14:08» сегодня, «16 октября, 14:08» раньше; «Oct 16, 14:08»
const day = (t: number) =>
  tr(new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "long" }), new Date(t).toLocaleDateString("en-US", { day: "numeric", month: "short" }));
const when = (r: ConvRow) => (day(r.at) === day(Date.now()) ? r.ts : `${day(r.at)}, ${r.ts}`);

export class SessionUI {
  private s: Store = readJson<Store>(FILE, { views: {}, msgs: {} });
  rows = new Map<string, AgentRow>();
  private hooked = new Set<string>(); // сессии с общим хуком: их ход приходит хуками, а не из журнала

  markHooked(sessionId: string) {
    this.hooked.add(sessionId);
  }
  isHooked(sessionId: string) {
    return this.hooked.has(sessionId);
  }

  constructor(private tg: Telegram) {
    tg.onCallback("s", async ({ id, value, answer }) => {
      const view = this.s.views[id];
      if (!view) return answer(tr("Сессия не найдена", "Session not found"));
      const row = this.rows.get(id);
      if (value === "log") {
        await this.post(id, view.cwd, this.logMd(id, view), { silent: true, bare: true, buttons: [[{ text: tr("Ответить", "Reply"), data: `s:${id}:reply` }]] });
        return answer();
      }
      if (value === "reply") {
        await answer(tr("Напишите ответ", "Type your reply"));
        return this.askReply(id, view.cwd);
      }
      if (value === "stop") {
        await this.tg.edit(view.cardId!, (view.cardMd ?? "") + tr("\n\n**Остановить её?** Разговор сохранится, её можно будет продолжить.", "\n\n**Stop it?** The conversation is kept, so you can resume it later."), {
          buttons: [[{ text: tr("Остановить", "Stop"), data: `s:${id}:stop!`, style: "danger" }, { text: tr("Отмена", "Cancel"), data: `s:${id}:back` }]],
        });
        return answer();
      }
      if (value === "back") {
        view.cardMd = undefined;
        await this.renderCard(id);
        return answer();
      }
      if (value === "stop!") {
        if (!row?.id) return answer(tr("Она открыта на Mac — остановить можно только там", "It’s open on the Mac — you can only stop it there"));
        await answer(tr("Останавливаю", "Stopping")); // ответить на нажатие сразу: claude stop идёт до 30 с
        const out = await stopSession(row.id);
        if (!/stopped/i.test(out)) log("ui", "остановить не вышло", clip(out, 300));
        await this.post(id, view.cwd, /stopped/i.test(out) ? tr("Остановлена.", "Stopped.") : tr("Остановить не вышло. Попробуйте ещё раз или остановите её на Mac.", "Couldn’t stop it. Try again or stop it on the Mac."), { silent: true });
        view.cardMd = undefined;
        await this.renderCard(id);
        return;
      }
      // «Продолжить» после сбоя или остановки: пробудить её тем же путём, что ответ владельца
      if (value === "go") {
        const r = row ?? (await listAgents(true)).find((x) => x.sessionId === id); // упавшей нет среди живых
        if (!r) return answer(tr("Сессия не найдена", "Session not found"));
        await answer(tr("Продолжает", "Resuming"));
        // это реплика от имени владельца — на его языке: по-русски сессия могла бы и ответить по-русски
        const res = await deliver(r, tr("Продолжай с того места, где остановилась.", "Continue from where you left off."));
        if (!res.ok) await this.post(id, view.cwd, `${tr("не продолжила", "didn’t resume")}: ${mdEsc(clip(res.note, 200))}`, { silent: true, inline: true });
        return;
      }
      return answer();
    });
  }

  private save() {
    const keys = Object.keys(this.s.msgs);
    if (keys.length > 1500) for (const k of keys.slice(0, keys.length - 1500)) delete this.s.msgs[k];
    writeJson(FILE, this.s);
  }

  // Имя, которое видит владелец, — без кавычек и папки.
  nameOf(sessionId: string, cwd: string) {
    return displayName(sessionId, cwd, [...this.rows.values()]);
  }

  // Имя в кавычках — внутри фразы («Сессия «Маяк» ждёт ответа»).
  label(sessionId: string, cwd: string) {
    return `«${this.nameOf(sessionId, cwd)}»`;
  }

  has(sessionId: string) {
    return !!this.s.views[sessionId];
  }

  view(sessionId: string): View | undefined {
    return this.s.views[sessionId];
  }

  sessionForThread(threadId: number) {
    return Object.entries(this.s.views).find(([, v]) => v.threadId === threadId)?.[0];
  }
  sessionForMessage(messageId: number) {
    return this.s.msgs[String(messageId)];
  }

  private ensure(sessionId: string, cwd: string): View {
    return (this.s.views[sessionId] ??= { name: this.nameOf(sessionId, cwd), cwd });
  }

  async threadFor(sessionId: string, cwd: string): Promise<number | undefined> {
    const v = this.ensure(sessionId, cwd);
    if (v.threadId || !this.tg.topicsOn) return v.threadId;
    v.threadId = await this.tg.createTopic(`${v.name} · ${basename(cwd)}`);
    if (v.threadId) {
      v.cardId = undefined; // карточка переезжает в тему
      v.cardMd = undefined;
      this.save();
      await this.renderCard(sessionId);
    }
    return v.threadId;
  }

  // Сообщение в тему сессии; без тем — в общий чат с подписью, чья это сессия: строкой над текстом
  // или, если inline, в начале первой строки — «**Маяк** — ждёт «принято»»; bare — текст называет её сам.
  async post(sessionId: string, cwd: string, md: string, opts: { silent?: boolean; buttons?: Button[][]; forceReply?: string; inline?: boolean; bare?: boolean } = {}) {
    const threadId = await this.threadFor(sessionId, cwd);
    const name = `**${mdEsc(this.nameOf(sessionId, cwd))}**`;
    const text = threadId || opts.bare ? cap1(md) : opts.inline ? `${name} — ${md}` : `${name}\n${cap1(md)}`;
    const ids = await this.tg.send(text, { threadId, silent: opts.silent, buttons: opts.buttons, forceReply: opts.forceReply });
    for (const id of ids) this.s.msgs[String(id)] = sessionId;
    this.save();
    return ids;
  }

  // «Ответить» в «Пульте»: поле ввода само встаёт ответом на это сообщение, а ответ уходит сессии обычным путём.
  // Пока он пишет, перед глазами — её вопрос, а если вопроса нет — её последние слова.
  async askReply(sessionId: string, cwd: string, what?: string) {
    const name = this.nameOf(sessionId, cwd);
    const question = !!what?.endsWith("?");
    const waits = question ? tr(`спрашивает: ${mdEsc(what!)}`, `asks: ${mdEsc(what!)}`) : tr("ждёт вашего ответа.", "is waiting for your reply.");
    const head = `**${mdEsc(name)}** ${waits} ${tr("Напишите — передам как есть.", "Type it and I’ll pass it on as is.")}`;
    const last = question ? undefined : talk(sessionId, cwd).filter((r) => r.who === "claude").at(-1);
    await this.post(sessionId, cwd, [head, last ? `**${when(last)}**  \n${mdEsc(short(last.text))}` : ""].filter(Boolean).join("\n\n"), { bare: true, forceReply: tr("Ваш ответ", "Your reply") }); // «Ответ для Арена» — имя не склоняется; кто ждёт — строкой выше
  }

  onTurn?: (sessionId: string, cwd: string, text: string) => void; // «Пульт» помнит, кто недавно закончил

  async album(sessionId: string, cwd: string, items: { path: string; caption?: string }[], replyTo?: number, silent = true) {
    const threadId = await this.threadFor(sessionId, cwd);
    const ids = await this.tg.sendAlbum(items, { threadId, replyTo, silent });
    for (const id of ids) this.s.msgs[String(id)] = sessionId;
    this.save();
  }

  // Ход своей сессии закончен: карточка и «Пульт» обновятся, сообщение владельцу пишет архитектор после разбора
  noteTurn(sessionId: string, cwd: string, text: string) {
    this.onTurn?.(sessionId, cwd, text);
    const v = this.ensure(sessionId, cwd);
    v.lastTurnAt = Date.now();
    this.save();
  }

  async turnEnded(sessionId: string, cwd: string, text: string, opts: { silent?: boolean } = {}) {
    this.onTurn?.(sessionId, cwd, text);
    const v = this.ensure(sessionId, cwd);
    v.lastTurnAt = Date.now();
    const body = text.trim();
    if (!body || body === v.lastPosted) return;
    v.lastPosted = body;
    await this.post(sessionId, cwd, foldLong(body), { silent: opts.silent });
  }

  // Тревога: что случилось — первой строкой жирным («Сессия «Маяк» остановилась на ошибке в 13:40»), подробности ниже,
  // под ней — что можно сделать. Текст тревоги — сказуемое к «сессия»: «остановилась…», «упала», «ждёт решения в окне…».
  async alert(sessionId: string, cwd: string, text: string, opts: { silent?: boolean } = {}) {
    const [first, ...rest] = text.trim().replace(/^сессия\s+/i, "").split(/(?<=\.)\s+/);
    const news = first.replace(/\.$/, "").replace(/ в (?=\d)/g, ` в${String.fromCharCode(0xa0)}`); // «в 13:40» не рвётся
    const who = tr(`Сессия «${this.nameOf(sessionId, cwd)}»`, `Session “${this.nameOf(sessionId, cwd)}”`);
    // «упала», «остановилась», «ждёт» — одной фразой; иное («ход оборвался…») — через двоеточие
    const head = /^[а-яё]+(?:ла|лась|ёт|ет|ит)(?![а-яё])/.test(news) ? `${who} ${news}` : `${who}: ${news}`;
    const rc = sessionDigest({ sessionId, cwd } as AgentRow).rcUrl;
    // как у карточки после сбоя: «Продолжить» первым, ниже «Последние шаги» и «Открыть в Claude» — по одной в ряд, целиком
    const buttons: Button[][] = [[{ text: tr("Продолжить", "Resume"), data: `s:${sessionId}:go` }], [{ text: LOG(), data: `s:${sessionId}:log` }], ...(rc ? [[{ text: tr("Открыть в Claude", "Open in Claude"), url: rc }]] : [])];
    // точка в конце заголовка: на экране блокировки он сливается со следующей строкой
    await this.post(sessionId, cwd, [`**${mdEsc(head)}.**`, ...rest].join("\n"), { ...opts, bare: true, buttons });
  }

  // «Последние шаги»: две последние реплики, новые сверху, по фразе-две; время своей строкой (другой день — с датой).
  // Заголовок — имя сессии и «последние шаги».
  private logMd(sessionId: string, v: View) {
    const lines = talk(sessionId, v.cwd)
      .slice(-2)
      .reverse()
      .map((r) => `**${when(r)}**  \n${r.who === "owner" ? tr("Вы: ", "You: ") : r.who === "session" ? tr("Другая сессия: ", "Another session: ") : ""}${mdEsc(short(r.text))}`);
    return [
      `**${mdEsc(this.nameOf(sessionId, v.cwd))}** — ${tr("последние шаги", "recent steps")}`,
      ...(lines.length ? lines : [tr("Пояснений в последних шагах нет — только служебные команды.", "No explanations in the recent steps, only internal commands.")]),
    ].join("\n\n");
  }

  stateOf(sessionId: string): string {
    const row = this.rows.get(sessionId);
    const w = workers.get(sessionId);
    if (row?.state) return row.state;
    if (row) return row.status === "busy" ? "working" : row.status === "waiting" ? "blocked" : "done";
    return w && Date.now() - w.startedAt < 90_000 ? "starting" : "stopped";
  }

  cardMd(sessionId: string): { md: string; buttons: Button[][] } {
    const v = this.s.views[sessionId];
    const row = this.rows.get(sessionId);
    const w = workers.get(sessionId);
    const d = sessionDigest(row ?? ({ sessionId, cwd: v.cwd } as AgentRow));
    const state = this.stateOf(sessionId);
    // имя жирным, под ним — что с ней сейчас и с какого времени (задачу не пересказываем: имя и так о ней)
    const NB = String.fromCharCode(0xa0);
    const day = (x: Date) => tr(x.toLocaleDateString("ru-RU", { day: "numeric", month: "long" }), x.toLocaleDateString("en-US", { day: "numeric", month: "short" })).replace(" ", NB);
    const today = (t: number) => day(new Date(t)) === day(new Date());
    const at = (t: number) => (today(t) ? `${NB}${hhmm(new Date(t))}` : `${NB}${day(new Date(t))}`);
    const started = w?.startedAt ?? row?.startedAt ?? Date.now(); // карточки — у сессий архитектора: он и знает, когда запустил
    // ждёт: фоновой сессии решение приходит сюда кнопкой, терминальной — только в её окне на Mac
    const blocked =
      row?.waitingFor === "input needed" ? tr("ждёт ответа", "waiting for a reply") : row?.kind === "background" ? tr("ждёт вашего решения", "needs your decision") : tr("ждёт вас на Mac", "waiting for you on the Mac");
    const now = state === "working" ? `${tr(" с", " since")}${at(started)}` : state === "done" && v.lastTurnAt ? `${tr(today(v.lastTurnAt) ? " в" : "", today(v.lastTurnAt) ? " at" : " on")}${at(v.lastTurnAt)}` : ""; // «закончила 16 октября», не «в 16 октября»
    const u = state === "done" ? understood(sessionId) : undefined;
    const md = [
      `**${mdEsc(this.nameOf(sessionId, v.cwd))}**  \n${cap1(state === "blocked" ? blocked : u ? tr(UNDERSTOOD, UNDERSTOOD_EN)[u.state] : (tr(WORD, WORD_EN)[state] ?? state))}${now}`,
      row?.kind === "interactive" && !d.rcUrl ? tr("Идёт в терминале на Mac: с iPhone её не открыть.", "Running in Terminal on the Mac: it can’t be opened from iPhone.") : "",
    ]
      .filter(Boolean)
      .join("\n\n"); // состояние и примечание — отдельными абзацами (richSafe сделает пустые строки видимыми)
    // «Остановить» без красного: красная — только в подтверждении, где решение и принимается; после сбоя — «Продолжить»
    // по одной кнопке в ряд — подписи целиком; главное действие первым: после сбоя «Продолжить», «Остановить» — после «Последних шагов»
    const log = [{ text: LOG(), data: `s:${sessionId}:log` }];
    const buttons: Button[][] =
      state === "failed" || state === "stopped"
        ? [[{ text: tr("Продолжить", "Resume"), data: `s:${sessionId}:go` }], log]
        : row?.id && row.pid
          ? [log, [{ text: tr("Остановить", "Stop"), data: `s:${sessionId}:stop` }]]
          : [log];
    if (d.rcUrl) buttons.push([{ text: tr("Открыть в Claude", "Open in Claude"), url: d.rcUrl }]);
    return { md, buttons };
  }

  // карточка уходит в Telegram — второй вызов (запуск и круг наблюдателя разом) не шлёт вторую: иначе первая так и висит «Запускается»
  private cardBusy = new Set<string>();
  async renderCard(sessionId: string) {
    if (this.cardBusy.has(sessionId)) return;
    this.cardBusy.add(sessionId);
    try {
      await this.drawCard(sessionId);
    } finally {
      this.cardBusy.delete(sessionId);
    }
  }

  private async drawCard(sessionId: string) {
    const v = this.s.views[sessionId];
    if (!v) return;
    const { md, buttons } = this.cardMd(sessionId);
    const bkey = JSON.stringify(buttons);
    const state = this.stateOf(sessionId);
    if (md === v.cardMd && bkey === v.cardButtons && v.cardId) return;
    if (!v.cardId && !workers.get(sessionId)) return; // карточки — только у сессий архитектора; остальные видны в «Пульте»
    // строка «Сейчас: …» меняется часто — без смены состояния правим карточку не чаще раза в 30 с
    if (v.cardId && state === v.cardState && bkey === v.cardButtons && Date.now() - (v.cardAt ?? 0) < 30_000) return;
    v.cardMd = md;
    v.cardButtons = bkey;
    v.cardState = state;
    v.cardAt = Date.now();
    if (v.cardId) await this.tg.edit(v.cardId, md, { buttons });
    else {
      const [id] = await this.tg.send(md, { buttons, threadId: v.threadId, silent: true });
      v.cardId = id;
      if (id) this.s.msgs[String(id)] = sessionId;
    }
    this.save();
  }

  // Вызывается наблюдателем на каждом круге: обновляет карточки живых сессий и один раз — ушедших (станут «остановлена»).
  async refresh(rows: AgentRow[]) {
    this.rows = new Map(rows.filter((r) => r.sessionId && (r.pid || r.state === "working" || r.state === "blocked" || r.state === "done")).map((r) => [r.sessionId!, r]));
    for (const id of Object.keys(this.s.views)) {
      const v = this.s.views[id];
      if (!this.rows.has(id) && (v.cardState === "stopped" || v.cardState === "failed")) continue;
      if (!workers.get(id)) continue;
      try {
        await this.renderCard(id);
      } catch (e) {
        log("ui", "карточка не обновилась", String(e));
      }
    }
  }

  async adopt(sessionId: string, cwd: string) {
    this.ensure(sessionId, cwd);
    await this.threadFor(sessionId, cwd);
    await this.renderCard(sessionId);
  }
}
