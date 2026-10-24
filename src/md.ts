// Markdown ответа Claude → Telegram. Основной путь — rich-сообщения (Bot API 10.1+): Markdown рисует сам Telegram,
// здесь только экранируем то, что он прочтёт иначе. Запасной путь — HTML старого вида (b, i, s, code, pre, a, blockquote).
import { esc } from "./util";

const LIMIT = 3900;

// Теги, которые Rich Markdown понимает как разметку; любой другой «<» показываем как есть.
const KNOWN_TAG = /^<\/?(b|strong|i|em|u|ins|s|strike|del|code|mark|sub|sup|tg-[a-z-]+|a|br|details|summary|blockquote|p|pre|ul|ol|li|table|tr|td|th|caption|h[1-6]|footer|hr|aside|cite|figure|figcaption|img|video|audio|input)(\s|>|\/)/i;

// Строка, с которой начинается свой блок Markdown: перед ней жёсткий перенос не нужен.
const BLOCK = /^\s*([-*+]\s|\d+[.)]\s|>|#|\||```|~~~|<\/?(details|summary|blockquote|table|tr|td|th|ul|ol|li|pre|p)\b)/i;

// Текст вне кода и ссылок: Telegram не держит правила CommonMark — «A* … A*» у него курсив, «a_b» тоже.
const plain = (seg: string) =>
  seg
    .replace(/(?<!\\)\$/g, () => "\\$")
    .replace(/</g, (m, off: number, s: string) => (KNOWN_TAG.test(s.slice(off)) ? m : "&lt;"))
    .replace(/(?<=[A-Za-z0-9])(?<![*\\])\*(?![*\p{L}\p{N}])/gu, "\\*")
    .replace(/(?<=[\p{L}\p{N}])(?<!\\)_(?=[\p{L}\p{N}])/gu, "\\_");

// Обычная строка текста: не начало блока и без отступа (отступ — продолжение пункта списка или код).
const prose = (s: string) => !!s.trim() && !BLOCK.test(s) && !/^\s/.test(s);

// Markdown Claude → Rich Markdown Telegram: «$» не формула, незнакомый «<» не тег, незакрытый блок кода закрыт,
// перенос строки остаётся переносом (одиночный «\n» Telegram склеивает в абзац),
// пустая строка между абзацами текста остаётся пустой строкой: Telegram для iOS рисует абзацы вплотную.
export function richSafe(md: string): string {
  const out: string[] = [];
  // «<details><summary>…</summary>» открывает HTML-блок до пустой строки: без неё строки внутри слипаются и Markdown не разбирается
  const lines = md
    .replace(/<\/summary>[ \t]*\n?(?=[ \t]*\S)/gi, "</summary>\n\n")
    .replace(/(?<=\S)[ \t]*\n?[ \t]*<\/details>/gi, "\n\n</details>")
    .split("\n");
  const SPACER = "\u00a0  "; // неразрывный пробел и жёсткий перенос: строка без текста, но для Markdown не пустая
  let fence = false;
  let proseBlock = false; // текущий абзац начался с обычной строки текста
  lines.forEach((line, k) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      proseBlock = false;
      out.push(line);
      return;
    }
    if (fence) {
      out.push(line);
      return;
    }
    if (!line.trim()) {
      if (out.at(-1) === SPACER) return; // несколько пустых строк подряд — одна
      const next = lines.slice(k + 1).find((l) => l.trim());
      if (proseBlock && next !== undefined && prose(next)) {
        // между двумя абзацами текста — видимая пустая строка (неразрывный пробел) внутри одного абзаца
        if (!/( {2}|\\)$/.test(out[out.length - 1])) out[out.length - 1] += "  ";
        out.push(SPACER);
        return;
      }
      proseBlock = false;
      out.push(line);
      return;
    }
    if (BLOCK.test(line)) proseBlock = false;
    else if (k === 0 || !lines[k - 1].trim()) proseBlock = prose(line);
    const safe = line
      .split(/(`[^`\n]*`|\[[^\]\n]*\]\([^)\s]*\)|https?:\/\/\S+)/)
      .map((seg, i) => (i % 2 ? seg : plain(seg)))
      .join("");
    const next = lines[k + 1];
    const hard = safe.trim() && next?.trim() && !BLOCK.test(next) && !/^\s*\|/.test(safe) && !/( {2}|\\)$/.test(safe);
    out.push(hard ? safe + "  " : safe);
  });
  if (fence) out.push("```");
  return out.join("\n");
}

// Произвольный текст (имя, путь, слова сессии) внутри Markdown — без случайной разметки.
export const mdEsc = (s: string) => s.replace(/([\\`*_\[\]~|<>$=#])/g, "\\$1");
const unEsc = (s: string) => s.replace(/\\([\\`*_\[\]~|<>$=#])/g, "$1");

function inline(s: string): string {
  const codes: string[] = [];
  let t = s.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  t = esc(unEsc(t));
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, txt, url) => `<a href="${url.replace(/"/g, "&quot;")}">${txt}</a>`);
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/__([^_\n]+)__/g, "<b>$1</b>");
  t = t.replace(/(^|[\s(«])\*([^*\s][^*\n]*?)\*(?=[\s).,;:!?»]|$)/g, "$1<i>$2</i>");
  t = t.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

function tableRow(line: string) {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim())
    .filter(Boolean);
}

export function mdToHtml(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let quote: string[] = [];
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
    quote = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      flushQuote();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre>${esc(body.join("\n"))}</pre>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      quote.push(inline(line.replace(/^\s*>\s?/, "")));
      i++;
      continue;
    }
    flushQuote();
    if (/^\s*\|.*\|\s*$/.test(line)) {
      // таблицы Telegram не умеет — строки «ячейка — ячейка»
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        if (!/^\s*\|?\s*:?-{2,}/.test(lines[i])) rows.push(tableRow(lines[i]));
        i++;
      }
      const [head, ...rest] = rows;
      if (rest.length && head) for (const r of rest) out.push("• " + r.map((c, k) => (k === 0 ? `<b>${inline(c)}</b>` : inline(c))).join(" — "));
      else for (const r of rows) out.push(r.map(inline).join(" — "));
      continue;
    }
    const h = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (h) out.push(`<b>${inline(h[1])}</b>`);
    else if (/^\s*([-*+])\s+/.test(line)) out.push(line.replace(/^(\s*)[-*+]\s+(.*)$/, (_, sp, rest) => `${sp}• ${inline(rest)}`));
    else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) out.push("");
    else out.push(inline(line));
    i++;
  }
  flushQuote();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function stripMd(md: string): string {
  return unEsc(md)
    .replace(/```\w*\n?/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "");
}

// Режет длинный markdown на части не длиннее лимита Telegram, не разрывая блоки кода.
export function splitMd(md: string, limit = LIMIT): string[] {
  if (md.length <= limit) return [md];
  const parts: string[] = [];
  let cur = "";
  let inFence = false;
  for (const line of md.split("\n")) {
    const toggles = /^\s*```/.test(line);
    if (cur.length + line.length + 1 > limit && !inFence && cur) {
      parts.push(cur);
      cur = "";
    }
    if (line.length > limit) {
      for (let k = 0; k < line.length; k += limit) parts.push(line.slice(k, k + limit));
      continue;
    }
    cur += (cur ? "\n" : "") + line;
    if (toggles) inFence = !inFence;
    if (cur.length > limit * 1.5) {
      parts.push(cur + (inFence ? "\n```" : ""));
      cur = inFence ? "```" : "";
    }
  }
  if (cur) parts.push(cur);
  return parts;
}
