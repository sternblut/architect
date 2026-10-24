// «Пульт» — одно закреплённое сообщение: что сейчас. Первая строка — прямой ответ («4 ждут вас:»), её видно в полосе закрепа;
// дальше кто ждёт и чего, проблемы, кто работает, кто закончил. Под ним — решения в одно касание.
// Правится на месте (без уведомлений); новое — только если старое удалили. Тот же вид — у ответа «что у нас».
import { join } from "node:path";
import type { Approvals } from "./approvals";
import { STATE, tr } from "./config";
import { stopHolds } from "./holds";
import type { AgentRow } from "./sessions";
import { renderView, view, type Ask, type Overview, type View } from "./status";
import type { Button, Telegram } from "./telegram";
import { clean, type SessionUI } from "./ui";
import { clip, hhmm, log, readJson, writeJson } from "./util";

const FILE = join(STATE, "board.json");
type Pending = Ask & { messageId: number; kind: "confirm" | "question"; final: boolean };
const EMPTY: Overview = { at: 0, rows: [], sites: [], repos: [], machine: { load5: 0, cpus: 0, diskFreeGb: 0 }, flags: [] };

// Что именно просят сделать — словами, глаголом («отправить код в main»); сама команда остаётся в запросе.
export function deed(action: string): string {
  const a = action.replace(/\s+/g, " ").trim();
  // уже словами: по-русски — кириллица, по-английски — фраза с заглавной без ключей и знаков оболочки
  const words = tr(/[а-яё]/i.test(a), /^[A-Z][a-z]/.test(a) && !/(^|\s)--?\w/.test(a)) && !/[|&;$`=]|\b(cd|ls|cat|python3?|bun|node|bash|sh)\s/.test(a);
  const said = () => clip(tr(a.charAt(0).toLowerCase(), /^[A-Z][a-z]+\b/.test(a) ? a.charAt(0).toLowerCase() : a.charAt(0)) + a.slice(1).split(/[:\n]/)[0], 60);
  // по-английски первая строка брифа сама начинается с глагола: «Deploy Beacon» — это слова, а не команда deploy
  if (words && tr(false, true)) return said();
  if (/\bgit\b.*\bpush\b/.test(a)) return /\b(main|master)\b/.test(a) ? tr(`отправить код в${String.fromCharCode(0xa0)}main`, "push code to main") : tr("отправить код на GitHub", "push code to GitHub"); // «в main» не рвётся по строкам
  if (/\bgh\s+pr\s+merge\b/.test(a)) return tr("слить PR", "merge the PR");
  if (/\bgh\s+(workflow\s+run|run\s+rerun)\b|\b(deploy|publish|release)\b/i.test(a)) return tr("выложить", "deploy");
  if (/(^|[\s;&|])(rm|rmdir|trash)\s|\bunlink\b/.test(a)) return tr("удалить файлы", "delete files");
  if (words) return said();
  return tr("выполнить команду", "run a command");
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
// первые слова до n знаков; предлог или союз в конце не оставляем
const words = (s: string, n: number) => {
  let out = "";
  for (const w of s.split(" ")) {
    if (`${out} ${w}`.trim().length > n) break;
    out = `${out} ${w}`.trim();
  }
  return out.replace(tr(/(\s+(в|во|на|с|со|к|ко|и|а|по|за|из|у|о|об|для|от|до))+$/i, /(\s+(to|in|into|on|at|of|for|from|with|by|and|or|the|a|an))+$/i), "");
};

// Вопрос коротко, без путей и имён файлов: длинный — от самой фразы с вопросом, целыми фразами.
export function shortQuestion(q: string): string {
  const s = clean(q.replace(/\s+/g, " ").trim());
  if (s.length <= 90) return s.replace(/^./, (c) => c.toLowerCase());
  // закреп не обрезает «Как чинить?» — это и есть то, что нужно от владельца, — и не ставит вместо вопроса начало
  // рассказа. Берём последнюю фразу с «?», к ней — что влезет после неё («Это около часа работы»), потом до неё.
  const parts = s.split(/(?<=[.!?])\s+(?=[А-ЯЁA-Z«])/); // «рис. 2» — не конец фразы
  let i = parts.findLastIndex((p) => p.includes("?"));
  if (i < 0) i = parts.length - 1;
  let out = parts[i].length <= 90 ? parts[i] : "";
  for (let j = i + 1; out && j < parts.length && `${out} ${parts[j]}`.length <= 90; j++) out = `${out} ${parts[j]}`;
  for (let j = i - 1; out && j >= 0 && `${parts[j]} ${out}`.length <= 90; j--) out = `${parts[j]} ${out}`;
  // «Как чинить?», «Удалить?» без предмета не понять: к короткому вопросу — первая фраза, где
  // сказано, о чём речь, до тире: «Маяк: прогон на v15 упал на проверке ссылок. Как чинить?»
  if (i > 0 && parts[i].length < 40 && !out.startsWith(parts[0])) {
    const subject = parts[0].split(/\s+[—–]\s+/)[0].replace(/[.!…:;,]+$/, "");
    if (`${subject}. ${parts[i]}`.length <= 100) out = `${subject}. ${parts[i]}`;
  }
  return (out || clip(parts[i], 90)).replace(/^./, (c) => c.toLowerCase());
}

export class Board {
  private st = readJson<{ messageId?: number }>(FILE, {});
  private flagIds = new Map<string, string>(); // короткий id кнопки → текст проблемы
  private replyIds = new Map<string, { sessionId: string; cwd: string; what?: string }>(); // короткий id «Ответить» → сессия
  onFix?: (flag: string, messageId: number) => void;
  private lastMd = "";
  private lastAt = 0;
  overview?: Overview;

  constructor(private d: { tg: Telegram; ui: SessionUI; approvals: Approvals }) {
    d.tg.onCallback("f", async ({ id, messageId, answer }) => {
      const flag = this.flagIds.get(id);
      if (!flag) return answer(tr("Это уже не актуально", "This is no longer relevant"));
      await answer(tr("Беру в работу", "On it"));
      this.onFix?.(flag, messageId);
    });
    // «Обновить» из прежних версий «Пульта»: кнопки ещё висят под старыми сообщениями
    d.tg.onCallback("b", async ({ answer }) => {
      this.lastMd = "";
      await answer(tr("Обновляю", "Refreshing"));
      await this.render(this.rows, true);
    });
    d.tg.onCallback("r", async ({ id, answer }) => {
      const r = this.replyIds.get(id);
      if (!r) return answer(tr("Это уже не актуально", "This is no longer relevant"));
      await answer(tr("Напишите ответ", "Type your reply"));
      await this.d.ui.askReply(r.sessionId, r.cwd, r.what);
    });
    // «Проверить за меня: …» — его просьба архитектору подготовить приёмку: проверить работу и прислать бриф
    d.tg.onCallback("p", async ({ id, messageId, answer }) => {
      const name = this.prepareIds.get(id);
      if (!name || !this.onPrepare) return answer(tr("Это уже не актуально", "This is no longer relevant"));
      await answer(tr("Проверю и пришлю отчёт; «принято» — за вами", "I’ll check and send a report; the final sign-off is yours"));
      this.onPrepare(`Подготовь приёмку «${name}»`, messageId);
    });
  }

  private prepareIds = new Map<string, string>(); // короткий id «Проверить за меня» → имя сессии
  onPrepare?: (text: string, messageId: number) => void;
  architectDown?: () => boolean; // архитектор не может отвечать (лимит Claude)

  private rows: AgentRow[] = [];

  // Запросы разрешения и вопросы, которые висят кнопками, — первыми в «ждут вас»: что от владельца нужно — вопросом.
  // У запроса первая строка брифа уже человеческая («Выложить «Маяк»»); имя сессии стоит в начале строки — из брифа его убираем.
  private pending(): Pending[] {
    return this.d.approvals.list().map((p) => {
      const name = p.source.replace(/^«(.+)»$/, "$1");
      let what = p.kind === "confirm" ? `${deed(p.summary)}?` : shortQuestion(p.summary);
      // «в проекте «Маяк»» у сессии «Маяк» — лишнее; у чужого проекта — нужно: без него «Удалить 3 файла «p3»?»
      const quoted = tr(` «${name}»`, ` “${name}”`);
      const own = what.includes(quoted);
      if (what.toLowerCase().startsWith(`${name.toLowerCase()} `) || what.toLowerCase().startsWith(`${name.toLowerCase()}: `)) what = what.slice(name.length).replace(/^:?\s+/, ""); // «Блог — блог просит удалить…»
      return { name, what: own ? what.replace(quoted, "").replace(tr(/ (проекта|в проекте)(?=[ ?])/, / (of project|in project)(?=[ ?])/), "") : what, messageId: p.messageId, kind: p.kind, final: p.final };
    });
  }

  // «Разобраться» — к проблемам, с которыми есть что делать (сайт, место на диске; не к лимиту), подпись видна целиком.
  fixButtons(flags = this.overview?.flags ?? []): Button[][] {
    const rows: Button[][] = [];
    for (const f of flags.filter((x) => !tr(/лимита? Claude/i, /Claude limit/i).test(x))) {
      const id = Bun.hash(f).toString(36).slice(0, 10);
      this.flagIds.set(id, f);
      const site = f.match(tr(/^Сайт (.+?) не открывается/, /^(.+?) site is down/))?.[1];
      const text = site
        ? tr(`Разобраться с сайтом ${site}`, `Look into the ${site} site`)
        : tr(/диске/, /disk/).test(f)
          ? tr("Разобраться с местом на диске", "Look into disk space")
          : tr(`Разобраться: ${clip(f.split(":")[0], 26)}`, `Look into: ${clip(f.split(":")[0], 26)}`);
      rows.push([{ text, data: `f:${id}` }]);
    }
    return rows.slice(0, 3);
  }

  // По кнопке на решение, в порядке строк — глагол и предмет, одинаково под «Пультом» и под ответом «что у нас»:
  // «Ответить: …» — поле ввода встаёт ответом этой сессии; необратимое («Отправить код в main: Регламенты») — теми же
  // нажатиями, что под самим запросом, отдельно последним. К приёмке — «Проверить за меня: …»: архитектор проверит работу
  // и пришлёт бриф, «принято» владелец ставит сам в сессии. Не больше четырёх и одной «Разобраться».
  private buttons(v: View, asks: Pending[]): Button[][] {
    const rows: Button[][] = [];
    const decide: Button[][] = [];
    for (const i of v.waiting) {
      const a = asks.find((x) => x.name === i.name && x.what === i.what);
      if (a) {
        const all = this.d.tg.buttonsOf(a.messageId)?.flat() ?? [];
        const yes = all.find((b) => b.data?.endsWith(":y"));
        const free = all.find((b) => b.data?.endsWith(":free"));
        // «Отправить код в main: Регламенты»; не влезает — без имени; и так не влезает — глагол и имя: «Отправить: Architect»
        const verb = cap(i.what.replace(/\?$/, ""));
        // своё решение архитектора — без «: Архитектор»; имя уже в глаголе («Выложить Маяк») — без повтора «: Маяк: прогон v15»
        const stem = a.name.split(/[\s:]+/)[0].toLowerCase().slice(0, 4);
        const who = a.name === "Архитектор" || (stem.length >= 3 && verb.toLowerCase().includes(stem)) ? "" : `: ${a.name}`;
        // не влезает — по словам, без висящего предлога: «Влить правку в основную версию», а не «Влить»
        const label = [`${verb}${who}`, verb, words(verb, 40 - who.length) + who, words(verb, 40)].find((t) => t.length <= 40 && t.length > who.length) ?? clip(verb.split(" ")[0], 40);
        // обратимое — одним касанием, бриф со снимками уже пришёл; необратимое («Вернуть нельзя») — только из самого брифа
        if (a.kind === "confirm" && yes && !a.final) decide.push([{ text: label, data: yes.data }]);
        if (a.kind === "question" && free) rows.push([{ text: clip(`${tr("Ответить", "Reply")}: ${a.name}`, 40), data: free.data }]);
        continue;
      }
      if (!i.reply || !i.sessionId) continue;
      const id = Bun.hash(i.sessionId).toString(36).slice(0, 10);
      this.replyIds.set(id, { sessionId: i.sessionId, cwd: i.cwd!, what: i.what });
      rows.push([{ text: clip(`${tr("Ответить", "Reply")}: ${i.name}`, 40), data: `r:${id}` }]);
    }
    // одна форма на все: «Проверить за меня: …», а если хоть одна не влезает — у всех «Проверить: …»; обычными словами
    // («Подготовить приёмку» человек со стороны не поймёт)
    // без архитектора (кончился лимит Claude) «Проверить за меня» и «Разобраться» не сработают — не показываем
    const down = this.architectDown?.() ?? false;
    const accept = down ? [] : v.accept.slice(0, 2);
    // «Проверить работу» рядом с «ждут вашей проверки» читалось как «посмотреть самому», а запускает проверку новой
    // сессией
    const full = tr("Проверить за меня", "Check for me");
    const long = accept.some((i) => `${full}: ${i.name}`.length > 32); // в строку кнопки iPhone входит ~32 знака
    for (const i of accept) {
      const id = Bun.hash(i.name).toString(36).slice(0, 10);
      this.prepareIds.set(id, i.name);
      rows.push([{ text: clip(`${long ? tr("Проверить", "Check") : full}: ${i.name}`, 40), data: `p:${id}` }]);
    }
    return [...rows.slice(0, 4 - Math.min(decide.length, 2)), ...(down ? [] : this.fixButtons().slice(0, 1)), ...decide.slice(0, 2)];
  }

  // Та же сводка — архитектору (инструмент overview): те же имена и состояния, что видит владелец; full — все имена.
  summary(o: Overview, full = false): string {
    return renderView(view(o, { asks: this.pending(), holds: stopHolds.all() }), false, full);
  }

  // Вид «Пульта» (board) или ответа «что у нас»: текст, он же без времени обновления (для сравнения), и кнопки.
  // то же состояние, что видит «Пульт», — для коротких ответов хоста
  snapshot(o: Overview): View {
    return view(o, { asks: this.pending(), holds: stopHolds.all() });
  }

  compose(o: Overview, board = true): { md: string; body: string; buttons: Button[][] } {
    const asks = this.pending();
    const v = view(o, { asks, holds: stopHolds.all() });
    const body = renderView(v, board);
    return { md: board ? renderView(v, true, false, [tr(`Обновлено в ${hhmm()}`, `Updated at ${hhmm()}`)]) : body, body, buttons: this.buttons(v, asks) };
  }

  // Вызывается наблюдателем на каждом круге.
  async render(rows: AgentRow[], force = false) {
    this.rows = rows;
    if (!this.d.tg.owner) return;
    const { md, body, buttons } = this.compose({ ...(this.overview ?? EMPTY), rows });
    if (!force && body === this.lastMd && Date.now() - this.lastAt < 5 * 60_000) return; // время обновления само по себе не повод править
    if (!force && Date.now() - this.lastAt < 15_000) return;
    this.lastMd = body;
    this.lastAt = Date.now();
    if (this.st.messageId) {
      const r = await this.d.tg.editStrict(this.st.messageId, md, { buttons });
      if (r === "ok") return;
      if (r === "error") {
        this.lastMd = ""; // не удалось — попробовать на следующем круге, новый пульт не создавать
        return;
      }
    }
    const [id] = await this.d.tg.send(md, { buttons, silent: true });
    if (!id) return;
    this.st.messageId = id;
    writeJson(FILE, this.st);
    await this.d.tg.unpinAll(); // закреплён всегда один пульт
    await this.d.tg.pin(id);
    log("board", "пульт создан и закреплён");
  }
}
