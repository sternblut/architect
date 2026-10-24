// Ссылки для просмотра, которые публикуют сессии. Владелец не должен их выпрашивать: хост присылает их сам.
// У сессии их бывает несколько (новая версия сайта и страница выбора названий за одну минуту) — реестр помнит все,
// а не одну последнюю.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { STATE } from "./config";
import type { AgentRow, Entry } from "./sessions";
import { readTail, transcriptPath } from "./sessions";
import { clip, readJson, writeJson } from "./util";

export type Link = { url: string; at: number; title?: string; told?: boolean };
const FILE = join(STATE, "links.json");
// раньше у сессии была одна ссылка — старую запись читаем как список из неё
export const asLists = (raw: Record<string, Link | Link[]>): Record<string, Link[]> => Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]));
const known = asLists(readJson(FILE, {}));

// публикация страницы для просмотра (инструмент Artifact) и выкладка на тестовый адрес …/release/…
// Путь файла бывает с пробелами: проекты часто лежат в папке с пробелом («мои проекты»).
const PUBLISHED = /Published\s+([^"\\\n]+?)\s+at\s+(https:\/\/claude\.ai\/artifact\/[\w-]+)/g;
const RELEASE = /(https:\/\/(?!github\.com)[\w.-]+\/release\/[^\s"'<>)\\]*)/g;

// Опубликованные страницы — только из ответа самого инструмента публикации (Artifact) и команды выкладки: вывод grep
// по чужим журналам — не публикация.
// Повторная публикация по той же ссылке обновляет время; file — что опубликовано (из него берём заголовок).
const DEPLOY = /(^|[\s/])[\w.-]*(deploy|publish)[\w.-]*(\s|$)/i;
const READS = /(^|[|;&]\s*)(grep|rg|cat|sed|awk|head|tail|less|jq|find|ls|python3?|bun|node|git\s+(log|show|diff|grep))\b/;
export function pagesIn(entries: Entry[]): (Link & { file?: string })[] {
  const out = new Map<string, Link & { file?: string }>();
  const calls = new Map<string, { name: string; command: string }>(); // id вызова → инструмент и команда
  for (const e of entries) {
    if (!Array.isArray(e.message?.content)) continue;
    const blocks = e.message!.content as { type?: string; id?: string; name?: string; input?: { command?: unknown }; tool_use_id?: string; content?: unknown }[];
    for (const b of blocks) if (b.type === "tool_use" && b.id) calls.set(b.id, { name: b.name ?? "", command: String(b.input?.command ?? "") });
    if (e.type !== "user") continue;
    const at = Date.parse(e.timestamp ?? "") || Date.now();
    for (const b of blocks) {
      if (b.type !== "tool_result") continue;
      const call = calls.get(b.tool_use_id ?? "");
      if (!call) continue; // вызова в хвосте журнала нет — не знаем, что это было
      const text = JSON.stringify(b.content ?? "");
      if (call.name === "Artifact") for (const m of text.matchAll(PUBLISHED)) out.set(m[2], { url: m[2], at, file: m[1] });
      if (call.name === "Bash" && DEPLOY.test(call.command) && !READS.test(call.command)) for (const m of text.matchAll(RELEASE)) out.set(m[1], { url: m[1], at });
    }
  }
  return [...out.values()].sort((a, b) => a.at - b.at);
}

export const lastLink = (entries: Entry[]) => pagesIn(entries).at(-1);

// Заголовок страницы — её <title>, пока файл на месте: по нему владелец отличит новую версию сайта от страницы выбора
export function titleOf(file?: string): string | undefined {
  try {
    if (!file || !file.startsWith("/") || !existsSync(file) || statSync(file).size > 3_000_000) return;
    const t = readFileSync(file, "utf8").match(/<title[^>]*>([^<]{1,300})<\/title>/i)?.[1];
    const clean = t
      ?.replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
    return clean ? clip(clean, 40) : undefined;
  } catch {
    return;
  }
}

// Новые страницы с прошлого раза — по сессиям: о них владельцу сразу. Повторная публикация по той же ссылке — не новость.
export function freshLinks(rows: AgentRow[], read = (r: AgentRow) => readTail(transcriptPath(r.cwd, r.sessionId!), 400_000)): { sessionId: string; cwd: string; pages: Link[] }[] {
  const fresh: { sessionId: string; cwd: string; pages: Link[] }[] = [];
  let changed = false;
  for (const r of rows) {
    if (!r.sessionId) continue;
    const list = (known[r.sessionId] ??= []);
    for (const p of pagesIn(read(r))) {
      const was = list.find((x) => x.url === p.url);
      if (was) {
        if (p.at > was.at) [was.at, changed] = [p.at, true];
        continue;
      }
      const page: Link = { url: p.url, at: p.at, title: titleOf(p.file), told: false };
      list.push(page);
      changed = true;
    }
    // свежие — первыми; помним до 30: обрежь до пяти — шестая из журнала снова сошла бы за новую и пришла бы опять
    list.sort((a, b) => b.at - a.at).splice(30);
    const untold = list.filter((x) => !x.told);
    if (untold.length) fresh.push({ sessionId: r.sessionId, cwd: r.cwd, pages: untold });
  }
  if (changed) writeJson(FILE, known);
  return fresh;
}

export function markTold(sessionId: string) {
  for (const p of known[sessionId] ?? []) p.told = true;
  writeJson(FILE, known);
}

// Заголовок опубликованной страницы по её адресу — подпись кнопки, когда в самой строке сообщения названия нет
export const pageTitle = (url: string) => Object.values(known).flat().find((p) => p.url === url)?.title;

// Последняя опубликованная страница сессии и все её страницы, свежие первыми.
export const linkOf = (sessionId?: string) => (sessionId ? pagesOf(sessionId)[0] : undefined);
export const pagesOf = (sessionId?: string) => (sessionId ? [...(known[sessionId] ?? [])].sort((a, b) => b.at - a.at) : []);
