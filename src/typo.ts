// Типограф хоста: вид сообщения на iPhone задаёт код, а не модель.
// На iPhone строка вмещает 34–38 знаков, поэтому висящий предлог, жирная строка в три ряда и адрес на две строки
// ломают чтение. Код, адреса и HTML-теги не трогаем.
import { tr } from "./config";

const NB = " ";
const SHORT = "в|во|к|ко|с|со|у|о|об|и|а|но|на|по|за|до|от|из|не|ни|для|под|над|при|про|без|или|что|как|я|мы";
const YO: [RegExp, string][] = [
  [/\bждет\b/g, "ждёт"],
  [/\bЖдет\b/g, "Ждёт"],
  [/\bеще\b/g, "ещё"],
  [/\bЕще\b/g, "Ещё"],
  [/\bидет\b/g, "идёт"],
  [/\bпришлет\b/g, "пришлёт"],
  [/\bпридет\b/g, "придёт"],
  [/\bотчет(а|у|ом|е|ы|ов)?\b/g, "отчёт$1"],
  [/\bОтчет(а|у|ом|е|ы|ов)?\b/g, "Отчёт$1"],
];

// Части текста, которые трогать нельзя: блоки и строки кода, адреса, теги, ссылки Markdown целиком.
const KEEP = /```[\s\S]*?```|`[^`\n]*`|<[^>\n]+>|\[[^\]\n]*\]\([^)\s]+\)|https?:\/\/\S+/g;

function text(seg: string): string {
  let s = seg;
  // JS-шный \b не видит кириллицу — границы слова пишем сами
  for (const [re, to] of YO) s = s.replace(new RegExp(`(?<![\\p{L}])${re.source.replace(/\\b/g, "")}(?![\\p{L}])`, "gu"), to);
  // предлог или союз не остаётся в конце строки
  s = s.replace(new RegExp(`(^|[\\s(«„"—])(${SHORT}) (?=\\S)`, "giu"), (_m, pre: string, w: string) => `${pre}${w}${NB}`);
  // тире между словами — длинное, с неразрывным пробелом перед ним
  s = s.replace(/(\S) [-–—] (?=\S)/g, `$1${NB}— `);
  s = s.replace(/(\S) — /g, `$1${NB}— `);
  // диапазоны чисел и времени — короткое тире: 3–5, 10:00–12:00
  s = s.replace(/(\d)-(\d)/g, "$1–$2");
  // число и слово не разрываются: «3,5 часа», «№ 5»
  s = s.replace(/(\d) (?=\p{L})/gu, `$1${NB}`);
  s = s.replace(/№ (?=\d)/g, `№${NB}`);
  // прямые кавычки — «ёлочки»
  s = s.replace(/(^|[\s(\[—-])"([^"\n]+)"/g, "$1«$2»");
  return s;
}

// Английский — свои правила: тире и диапазоны те же, число не отрывается от слова («12 GB», «Oct 27»), кавычки —
// “английские” (и «ёлочки», если попались), апостроф — ’. Предлогов и «ё» по-английски нет.
function textEn(seg: string): string {
  let s = seg;
  s = s.replace(/(\S) [-–—] (?=\S)/g, `$1${NB}— `);
  s = s.replace(/(\S) — /g, `$1${NB}— `);
  s = s.replace(/(\d)-(\d)/g, "$1–$2");
  s = s.replace(/(\d) (?=\p{L})/gu, `$1${NB}`);
  s = s.replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?=\d)/g, `$1${NB}`);
  s = s.replace(/(^|[\s(\[—-])"([^"\n]+)"/g, "$1“$2”");
  s = s.replace(/«([^«»\n]*)»/g, "“$1”");
  s = s.replace(/(\p{L})'(\p{L})/gu, "$1’$2");
  return s;
}

export function typograph(md: string): string {
  // неприкосновенное — на время в знаки-заместители: так правила видят соседство (предлог перед `кодом`)
  const kept: string[] = [];
  const masked = md.replace(KEEP, (m) => `\uE000${kept.push(m) - 1}\uE001`);
  return tr(text, textEn)(masked).replace(/\uE000(\d+)\uE001/g, (_m, i: string) => kept[Number(i)]);
}

// Жирное: только в сообщении от четырёх строк и только один фрагмент в начале до 30 знаков. Остальное — обычным:
// иначе почти каждое сообщение начинается с жирной строки в три ряда.
export function tameBold(md: string): string {
  // код не трогаем: прячем его на время, как в типографе, иначе карточка выкладки с кодом в «Подробнее» остаётся жирной
  const kept: string[] = [];
  const masked = md.replace(/```[\s\S]*?```|`[^`\n]*`/g, (m) => `\uE000${kept.push(m) - 1}\uE001`);
  return bold(masked).replace(/\uE000(\d+)\uE001/g, (_m, i: string) => kept[Number(i)]);
}

function bold(md: string): string {
  const lines = md.split("\n").filter((l) => l.trim());
  // внутри жирного может стоять экранированная звёздочка: без этого «**Сайт A\*: выкладывать…?**» остаётся жирным в три строки
  const first = md.match(/^\s*\*\*((?:\\\*|[^*\n])+)\*\*/);
  const keepFirst = lines.length >= 4 && !!first && first[1].length <= 30;
  const body = keepFirst ? md.slice(first![0].length) : md;
  const plain = body.replace(/\*\*((?:\\\*|[^*\n])+)\*\*/g, "$1");
  return keepFirst ? `**${first![1]}**${plain}` : plain;
}

// Последняя точка утвердительного сообщения: точку в конце читают как подчёркнуто строгий тон.
export function noFinalDot(md: string): string {
  if (tr(false, /\b(etc|vs)\.\s*$/i.test(md))) return md; // «etc.» без точки — опечатка
  return md.replace(tr(/(\p{L}{3,}|\d|[»)%])\.\s*$/u, /(\p{L}{3,}|\d|[»”)%])\.\s*$/u), "$1");
}

// Длинный адрес — кнопкой со словами: адрес на две строки ничего не говорит, а под текстом Telegram открывает
// ссылку только через окно «Открыть ссылку?». Короткий (до 30 знаков) остаётся в тексте.
// pageTitle — заголовок опубликованной страницы по адресу (реестр src/links.ts).
export function urlsToButtons(md: string, pageTitle: (url: string) => string | undefined = () => undefined): { md: string; links: { text: string; url: string }[] } {
  const links: { text: string; url: string; ctx: string }[] = [];
  let out = "";
  let last = 0;
  for (const m of md.matchAll(KEEP)) {
    out += md.slice(last, m.index);
    last = m.index! + m[0].length;
    const url = m[0].replace(/[.,;:!?)»*]+$/, "");
    if (!/^https?:\/\//.test(m[0]) || url.length <= 30 || links.some((l) => l.url === url) || links.length >= 3) {
      out += links.some((l) => l.url === url) ? m[0].slice(url.length) : m[0];
      continue;
    }
    // строка, к которой относится адрес: та же, а если адрес с новой строки — предыдущая («**Регламенты** — «…», в 18:35:»)
    const lines = out.split("\n");
    const ctx = (lines.at(-1)?.trim() ? lines.at(-1)! : (lines.at(-2) ?? "")).trim();
    links.push({ text: label(url), url, ctx });
    // от вырезанного адреса на этой строке остаются «по ссылке:», «ссылка для просмотра:» — убрать
    out = out.replace(tr(/[ \t]*((по (той же |прежней )?ссылке|ссылка( для просмотра)?|по адресу)[ \t]*)?:?[ \t]*$/i, /[ \t]*((at (the same |this )?link|(preview )?link|here)[ \t]*)?:?[ \t]*$/i), "");
    out += m[0].slice(url.length);
  }
  out += md.slice(last);
  // Кнопка говорит, что за страница: три «Ссылка для просмотра» подряд не различить. Подпись: название из своей строки
  // («Выбор названий»), иначе заголовок самой страницы («A* прототип C»), иначе — для нескольких ссылок — сама короткая
  // строка («A, главная»).
  for (const l of links) {
    if (!/claude\.ai\/(code\/)?artifact\//.test(l.url)) continue;
    const line = l.ctx.replace(/\*\*|__|`/g, "").replace(/\\(.)/g, "$1").replace(/^[-•]\s+/, "").replace(/[\s:;,.—–-]+$/, "").trim();
    const title = l.ctx.match(QUOTED())?.[1] ?? pageTitle(l.url) ?? (links.length > 1 && line.length >= 3 && line.length <= 40 ? line : undefined);
    if (title) l.text = clipLabel(title);
  }
  // одинаковые подписи не отличить — к ним имя из своей строки,
  // а две версии одной страницы — по времени из строки: «Выбор названий, 15:06» и «Выбор названий, 04:22»
  const twins = () => new Set(links.map((l) => l.text).filter((t, i, all) => all.indexOf(t) !== i));
  let same = twins();
  for (const l of links)
    if (same.has(l.text)) {
      const name = l.ctx.match(/\*\*((?:\\.|[^*\\])+)\*\*/)?.[1]?.replace(/\\(.)/g, "$1"); // «**A\***» — экранированная звёздочка внутри
      const title = l.ctx.match(QUOTED())?.[1] ?? pageTitle(l.url);
      if (name) l.text = clipLabel(title && !title.toLowerCase().startsWith(name.toLowerCase()) ? `${name}: ${title}` : (title ?? name));
    }
  same = twins();
  for (const l of links) {
    const at = l.ctx.match(/\b\d{1,2}:\d{2}\b/)?.[0];
    if (same.has(l.text) && at) l.text = clipLabel(`${l.text.replace(/…$/, "")}, ${at}`);
  }
  return { md: out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim(), links: links.map(({ text, url }) => ({ text, url })) };
}

// название в кавычках из строки сообщения — у английского свои “кавычки”
const QUOTED = () => tr(/«([^»]+)»/, /[«“]([^»”]+)[»”]/);

// не по середине слова: «Регламенты отдела поддержки клиен…» читается как опечатка
const clipLabel = (x: string) => (x.length <= 40 ? x : `${(/\s/.test(x[39]) ? x.slice(0, 39) : x.slice(0, 39).replace(/\s+\S*$/, "")).replace(/[\s,;:—–-]+$/, "")}…`);

function label(url: string): string {
  if (/claude\.ai\/(code\/)?artifact\//.test(url)) return tr("Ссылка для просмотра", "Open preview");
  if (/claude\.ai\/code\/session_/.test(url)) return tr("Открыть в Claude", "Open in Claude");
  if (/claude\.ai\/settings\/usage/.test(url)) return tr("Докупить лимит Claude", "Buy more Claude usage");
  if (/github\.com\/.+\/pull\/\d+/.test(url)) return tr("Изменения на GitHub", "Changes on GitHub");
  if (/github\.com\/[^/]+\/[^/]+\/actions(\/|$)/.test(url)) return tr("Проверки на GitHub", "Checks on GitHub");
  const host = url.replace(/^https?:\/\//, "").split("/")[0];
  return host.length <= 30 ? host : tr("Открыть ссылку", "Open link");
}

// Строки-фразы без знака в конце на экране блокировки слипаются: iOS склеивает строки уведомления через пробел
// («…на сайте Прогон CI на v15…»). Хост ставит точку сам — в сообщениях архитектора так же, как в своих.
// Не трогает код, таблицы, заголовки, строки на «:» и короткие (меньше трёх слов); последнюю точку снимет noFinalDot.
export function lineDots(md: string): string {
  let fence = false;
  return md
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      if (fence || /^\s*(#|\||```|<)/.test(line)) return line;
      const t = line.trimEnd();
      if (t.split(/\s+/).length < 3 || /[.?!…:;,]$/.test(t.replace(/\*+$/, ""))) return line;
      return tr(/[\p{L}\p{N}»)*]$/u, /[\p{L}\p{N}»”)*]$/u).test(t) ? `${t}.` : line;
    })
    .join("\n");
}
