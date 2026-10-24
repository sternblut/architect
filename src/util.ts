import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME, LOGS } from "./config";

const knownSecrets = new Set<string>();
export function registerSecret(s: string) {
  if (s && s.length >= 8) knownSecrets.add(s);
}

// Маскирует токены и ключи перед любым выводом: журнал, Telegram, ответы инструментов.
export function scrub(text: string): string {
  let t = text;
  for (const s of knownSecrets) t = t.split(s).join("«скрыто»");
  return t
    .replace(/\b\d{5,16}:[A-Za-z0-9_-]{30,}\b/g, "«токен скрыт»")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g, "«токен скрыт»")
    .replace(/\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b/g, "«ключ скрыт»")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "«ключ скрыт»")
    .replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, "«токен скрыт»")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "«закрытый ключ скрыт»");
}

export function log(scope: string, msg: string, extra?: unknown) {
  const line = `${new Date().toISOString()} [${scope}] ${msg}${extra === undefined ? "" : " " + safeJson(extra)}`;
  const clean = scrub(line);
  try {
    appendFileSync(join(LOGS, "host.log"), clean + "\n");
  } catch {}
  if (process.stdout.isTTY) console.log(clean);
}

function safeJson(v: unknown) {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export type RunResult = { code: number; stdout: string; stderr: string };

export async function run(cmd: string[], opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string | undefined>; stdin?: string } = {}): Promise<RunResult> {
  try {
    const p = Bun.spawn(cmd, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => p.kill(), opts.timeoutMs ?? 60_000);
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timer);
    return { code, stdout, stderr };
  } catch (e) {
    return { code: -1, stdout: "", stderr: String(e) };
  }
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(path: string, data: unknown) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  renameSync(tmp, path);
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const tilde = (p: string) => (p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p);
// Длинное — с многоточием по границе слова: «Снимки главной страницы сдел…» читается как опечатка
export const clip = (s: string, n: number) => {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const word = /\s/.test(s[n - 1]) ? cut : cut.replace(/\s+\S*$/, "");
  return `${(word.length >= n / 2 ? word : cut).replace(/[\s,;:—–-]+$/, "")}…`;
};

// Длинное — целыми фразами, пока влезают; первая и так длиннее — по границе слова
export function sentences(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  let out = "";
  for (const p of t.split(/(?<=[.!?])\s+(?=[А-ЯЁA-Z«])/)) {
    if (`${out} ${p}`.trim().length > n) break;
    out = `${out} ${p}`.trim();
  }
  return out || clip(t, n);
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s} с`;
  if (s < 3600) return `${Math.round(s / 60)} мин`;
  if (s < 86400) return `${Math.round(s / 3600)} ч`;
  return `${Math.round(s / 86400)} дн`;
}

// «с 13:50» сегодня, «с 14 октября» — если не сегодня
export function since(ms: number) {
  const d = new Date(ms);
  const day = (x: Date) => x.toLocaleDateString("ru-RU");
  return day(d) === day(new Date()) ? `с ${hhmm(d)}` : `с ${d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}`;
}

export function hhmm(d = new Date()) {
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

export function randomId(n = 8) {
  const a = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => a[b % a.length]).join("");
}
