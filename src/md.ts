// Claude's Markdown for Telegram. Rich messages (Bot API 10.1+) render Markdown in Telegram, so richSafe() only escapes
// what Telegram would read differently. mdToHtml() is the fallback to classic HTML (b, i, s, code, pre, a, blockquote).
import { esc } from "./util";

const LIMIT = 3900;

// Tags Rich Markdown treats as markup; any other "<" is shown as is
const KNOWN_TAG = /^<\/?(b|strong|i|em|u|ins|s|strike|del|code|mark|sub|sup|tg-[a-z-]+|a|br|details|summary|blockquote|p|pre|ul|ol|li|table|tr|td|th|caption|h[1-6]|footer|hr|aside|cite|figure|figcaption|img|video|audio|input)(\s|>|\/)/i;

// A line that starts its own Markdown block, so the line before it needs no hard break
const BLOCK = /^\s*([-*+]\s|\d+[.)]\s|>|#|\||```|~~~|<\/?(details|summary|blockquote|table|tr|td|th|ul|ol|li|pre|p)\b)/i;

// Text outside code and links. Telegram doesn't follow CommonMark here: "A* … A*" and "a_b" turn italic.
const plain = (seg: string) =>
  seg
    .replace(/(?<!\\)\$/g, () => "\\$")
    .replace(/</g, (m, off: number, s: string) => (KNOWN_TAG.test(s.slice(off)) ? m : "&lt;"))
    .replace(/(?<=[A-Za-z0-9])(?<![*\\])\*(?![*\p{L}\p{N}])/gu, "\\*")
    .replace(/(?<=[\p{L}\p{N}])(?<!\\)_(?=[\p{L}\p{N}])/gu, "\\_");

// A plain text line: not a block start and not indented (an indent continues a list item or is code)
const prose = (s: string) => !!s.trim() && !BLOCK.test(s) && !/^\s/.test(s);

// Claude's Markdown → Telegram Rich Markdown: "$" is not math, an unknown "<" is not a tag, an open code block is closed,
// a single "\n" stays a line break (Telegram would join the lines), and a blank line between paragraphs stays visible
// (Telegram for iOS draws paragraphs with no gap).
export function richSafe(md: string): string {
  const out: string[] = [];
  // "<details><summary>…</summary>" opens an HTML block that ends at a blank line; without one the lines inside run together unparsed
  const lines = md
    .replace(/<\/summary>[ \t]*\n?(?=[ \t]*\S)/gi, "</summary>\n\n")
    .replace(/(?<=\S)[ \t]*\n?[ \t]*<\/details>/gi, "\n\n</details>")
    .split("\n");
  const SPACER = "\u00a0  "; // no-break space and a hard break: a line with no text that Markdown doesn't treat as blank
  let fence = false;
  let proseBlock = false; // the current paragraph started with a plain text line
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
      if (out.at(-1) === SPACER) return; // collapse repeated blank lines
      const next = lines.slice(k + 1).find((l) => l.trim());
      if (proseBlock && next !== undefined && prose(next)) {
        // between two text paragraphs: a visible empty line within one paragraph
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

// Escapes arbitrary text (a name, a path, a session's words) for use inside Markdown
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
      // Telegram HTML has no tables: rows become "cell — cell"
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

// Splits long Markdown into Telegram-sized parts, avoiding splits inside code blocks
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
