// The host's typographer: code, not the model, decides how a message looks on an iPhone. A line there fits 34–38
// characters, so a dangling preposition, a bold line wrapping three times or a URL split over two lines hurt reading.
// Code, URLs and HTML tags are left alone.
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

// What must stay untouched: code blocks and spans, URLs, tags, whole Markdown links
const KEEP = /```[\s\S]*?```|`[^`\n]*`|<[^>\n]+>|\[[^\]\n]*\]\([^)\s]+\)|https?:\/\/\S+/g;

function text(seg: string): string {
  let s = seg;
  // JavaScript's \b doesn't see Cyrillic, so word boundaries are spelled out
  for (const [re, to] of YO) s = s.replace(new RegExp(`(?<![\\p{L}])${re.source.replace(/\\b/g, "")}(?![\\p{L}])`, "gu"), to);
  // a preposition or conjunction never ends a line
  s = s.replace(new RegExp(`(^|[\\s(«„"—])(${SHORT}) (?=\\S)`, "giu"), (_m, pre: string, w: string) => `${pre}${w}${NB}`);
  // a dash between words is an em dash with a no-break space before it
  s = s.replace(/(\S) [-–—] (?=\S)/g, `$1${NB}— `);
  s = s.replace(/(\S) — /g, `$1${NB}— `);
  // number and time ranges take an en dash: 3–5, 10:00–12:00
  s = s.replace(/(\d)-(\d)/g, "$1–$2");
  // a number stays with its word: "3,5 часа", "№ 5"
  s = s.replace(/(\d) (?=\p{L})/gu, `$1${NB}`);
  s = s.replace(/№ (?=\d)/g, `№${NB}`);
  // straight quotes become «guillemets»
  s = s.replace(/(^|[\s(\[—-])"([^"\n]+)"/g, "$1«$2»");
  return s;
}

// English: the same dashes and ranges, a number stays with its word ("12 GB", "Oct 27"), “curly” quotes (guillemets
// included) and ’ for apostrophes
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
  // protected parts become placeholders for a while, so the rules still see their neighbors (a preposition before `code`)
  const kept: string[] = [];
  const masked = md.replace(KEEP, (m) => `\uE000${kept.push(m) - 1}\uE001`);
  return tr(text, textEn)(masked).replace(/\uE000(\d+)\uE001/g, (_m, i: string) => kept[Number(i)]);
}

// Bold only in messages of four lines or more, and only one leading fragment of up to 30 characters; otherwise almost
// every message would open with a bold line wrapping three times.
export function tameBold(md: string): string {
  // mask code as typograph() does, or a deploy card with code under "Details" stays bold
  const kept: string[] = [];
  const masked = md.replace(/```[\s\S]*?```|`[^`\n]*`/g, (m) => `\uE000${kept.push(m) - 1}\uE001`);
  return bold(masked).replace(/\uE000(\d+)\uE001/g, (_m, i: string) => kept[Number(i)]);
}

function bold(md: string): string {
  const lines = md.split("\n").filter((l) => l.trim());
  // bold text may contain an escaped asterisk: "**Site A\*: deploy…?**"
  const first = md.match(/^\s*\*\*((?:\\\*|[^*\n])+)\*\*/);
  const keepFirst = lines.length >= 4 && !!first && first[1].length <= 30;
  const body = keepFirst ? md.slice(first![0].length) : md;
  const plain = body.replace(/\*\*((?:\\\*|[^*\n])+)\*\*/g, "$1");
  return keepFirst ? `**${first![1]}**${plain}` : plain;
}

// Drops the final period of a statement: in a chat it reads as a stern tone
export function noFinalDot(md: string): string {
  if (tr(false, /\b(etc|vs)\.\s*$/i.test(md))) return md; // "etc" without its period looks like a typo
  return md.replace(tr(/(\p{L}{3,}|\d|[»)%])\.\s*$/u, /(\p{L}{3,}|\d|[»”)%])\.\s*$/u), "$1");
}

// A long URL becomes a labeled button: a URL over two lines says nothing, and a link in the text opens only after
// Telegram's "Open link?" prompt. Short ones (up to 30 characters) stay. pageTitle gives a published page's title
// (the registry in src/links.ts).
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
    // the line the URL belongs to: its own, or the previous one when the URL starts a line
    const lines = out.split("\n");
    const ctx = (lines.at(-1)?.trim() ? lines.at(-1)! : (lines.at(-2) ?? "")).trim();
    links.push({ text: label(url), url, ctx });
    // drop what is left once the URL is cut out ("at this link:", "preview link:")
    out = out.replace(tr(/[ \t]*((по (той же |прежней )?ссылке|ссылка( для просмотра)?|по адресу)[ \t]*)?:?[ \t]*$/i, /[ \t]*((at (the same |this )?link|(preview )?link|here)[ \t]*)?:?[ \t]*$/i), "");
    out += m[0].slice(url.length);
  }
  out += md.slice(last);
  // The button says which page it is: three "Open preview" buttons in a row can't be told apart. The label is the quoted
  // name from its line, else the page's own title, else, with several links, the short line itself.
  for (const l of links) {
    if (!/claude\.ai\/(code\/)?artifact\//.test(l.url)) continue;
    const line = l.ctx.replace(/\*\*|__|`/g, "").replace(/\\(.)/g, "$1").replace(/^[-•]\s+/, "").replace(/[\s:;,.—–-]+$/, "").trim();
    const title = l.ctx.match(QUOTED())?.[1] ?? pageTitle(l.url) ?? (links.length > 1 && line.length >= 3 && line.length <= 40 ? line : undefined);
    if (title) l.text = clipLabel(title);
  }
  // identical labels get the bold name from their line, and two versions of one page the time from their line
  // ("Naming, 15:06" and "Naming, 04:22")
  const twins = () => new Set(links.map((l) => l.text).filter((t, i, all) => all.indexOf(t) !== i));
  let same = twins();
  for (const l of links)
    if (same.has(l.text)) {
      const name = l.ctx.match(/\*\*((?:\\.|[^*\\])+)\*\*/)?.[1]?.replace(/\\(.)/g, "$1"); // "**A\***" has an escaped asterisk inside
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

// A quoted name in the message line; English uses “these quotes”
const QUOTED = () => tr(/«([^»]+)»/, /[«“]([^»”]+)[»”]/);

// Never cut mid-word, which reads as a typo
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

// Lines without final punctuation run together on the lock screen, where iOS joins notification lines with a space, so
// the host adds periods, in the architect's messages as in its own. Code, tables, headings, lines ending in ":" and
// lines under three words are left alone; noFinalDot drops the last period.
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
