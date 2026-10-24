// HTTP-приёмник хуков: только 127.0.0.1 и секретный заголовок.
// /hook/*      — рабочие сессии архитектора (их хуки из --settings, со шлагбаумом);
// /hook/any/*  — все остальные сессии Mac (общий хук из ~/.claude/settings.json): пока владелец за Mac — «решай в терминале»,
//                отошёл — разрешения и вопросы идут в Telegram; вернулся — всё отпускается обратно в терминал.
import { timingSafeEqual } from "node:crypto";
import type { Approvals, Decision, Question } from "./approvals";
import { config, tr } from "./config";
import { stopHolds } from "./holds";
import { onReturn, ownerAway } from "./presence";
import { listAgents, outbox, readTail, spinCount, toolBrief, transcriptPath, workers } from "./sessions";
import { candidateShots } from "./shots";
import { ownerId, type Button } from "./telegram";
import { foldLong } from "./ui";
import { clip, log } from "./util";

export type HookUI = {
  label(sessionId: string, cwd: string): string;
  threadFor(sessionId: string, cwd: string): Promise<number | undefined>;
  turnEnded(sessionId: string, cwd: string, text: string, opts?: { silent?: boolean }): Promise<void>;
  workerTurn(sessionId: string, cwd: string, text: string): Promise<void>; // итог сессии архитектора — ему на разбор
  sessionQuestion(sessionId: string, cwd: string, text: string, opts: { held: boolean }): Promise<void>; // вопрос чужой сессии — архитектору на суждение
  alert(sessionId: string, cwd: string, text: string): Promise<void>;
  post(sessionId: string, cwd: string, md: string, opts?: { silent?: boolean; buttons?: Button[][] }): Promise<number[]>;
  markHooked(sessionId: string): void;
  permissionDecided(sessionId: string, cwd: string, action: string, decision: Decision): void;
  stopped?(sessionId: string, cwd: string): void; // любая сессия закончила ход — обещания архитектора о ней пора выполнить
};

const SIX_HOURS = 6 * 3600_000;
const HOLD_MS = 2 * 3600_000;
const BACK_AT_MAC = () => tr("Решите на Mac", "Decide on the Mac"); // подпись погасшей кнопки, когда владелец вернулся к Mac

// Ошибки API и лимита — не вопросы владельцу и не повод писать ему
export const API_ERROR = /hit your (weekly |session |5-hour |)limit|usage limit|API Error|overloaded|rate.?limit|Credit balance|Please run \/login|Invalid API key|Prompt is too long/i;

export const looksLikeQuestion = (t: string) => {
  const tail = t.trim().slice(-400);
  return /\?\s*(\*\*|_|»|")?\s*$/.test(tail) || /\?\s*\n/.test(tail) || /(жду (вашего|ваш|«|от вас)|скажите|выберите|подтвердите|ответьте|нужн[оа] ваш)/i.test(tail);
};

// Записка архитектора сессии (message_session, note) — не слова владельца: в его кавычки не берётся
export const ARCH_NOTE = "Архитектор от себя — это не слова владельца: ";
export function ownerWords(msgs: string[]) {
  const own = msgs.filter((m) => !m.includes(ARCH_NOTE));
  const said = own.length === 1 ? `Сообщение владельца из Telegram: «${own[0]}»` : own.length ? `Сообщения владельца из Telegram:\n${own.map((m) => `— «${m}»`).join("\n")}` : "";
  return [said, ...msgs.filter((m) => m.includes(ARCH_NOTE))].filter(Boolean).join("\n\n");
}

// Сессию ведёт цель /goal или другой Stop-хук: она идёт дальше сама, держать её нельзя — ответ доставим при следующей остановке.
function goalDriven(body: Record<string, any>, sid: string, cwd: string) {
  if (body.stop_hook_active) return true;
  try {
    return spinCount(readTail(transcriptPath(cwd, sid), 300_000), 3 * 3600_000) > 0;
  } catch {
    return false;
  }
}

export function startHookServer(secret: string, approvals: Approvals, ui: HookUI) {
  const expected = Buffer.from(secret);
  const authed = (req: Request) => {
    const got = Buffer.from(req.headers.get("x-arch-secret") ?? "");
    const host = req.headers.get("host") ?? "";
    return got.length === expected.length && timingSafeEqual(got, expected) && (host === `127.0.0.1:${config.hookPort}` || host === `localhost:${config.hookPort}`);
  };

  // вернулся к Mac — всё ждущее отпускаем обратно в терминал
  const pending = new Set<AbortController>();
  onReturn(() => {
    for (const c of pending) c.abort(BACK_AT_MAC());
    pending.clear();
    for (const sid of stopHolds.all()) stopHolds.release(sid);
  });
  const watch = (signal: AbortSignal) => {
    const c = new AbortController();
    signal.addEventListener("abort", () => c.abort(tr("Сессия сняла запрос", "The session withdrew the request")));
    pending.add(c);
    return { signal: c.signal, done: () => pending.delete(c) };
  };
  const lastAsked = new Map<string, { text: string; at: number }>();
  // Носитель секрета не должен писать владельцу от имени произвольной сессии: текст принимаем только от сессий, которые хост знает
  let knownCache = { at: 0, ids: new Set<string>() };
  async function known(sid: string): Promise<boolean> {
    if (!sid) return false;
    if (workers.get(sid)) return true;
    if (Date.now() - knownCache.at > 5000) {
      try {
        knownCache = { at: Date.now(), ids: new Set((await listAgents(true)).map((r) => r.sessionId ?? "")) };
      } catch {}
    }
    if (knownCache.ids.has(sid)) return true;
    log("hooks", "запрос от неизвестной сессии отброшен", { sid: sid.slice(0, 8) });
    return false;
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: config.hookPort,
    idleTimeout: 0, // ответа владельца ждём часами
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || !url.pathname.startsWith("/hook/")) return new Response("not found", { status: 404 });
      if (!authed(req)) {
        log("hooks", "отклонён запрос без верного секрета", { path: url.pathname });
        return new Response("forbidden", { status: 403 });
      }
      let body: Record<string, any>;
      try {
        body = (await req.json()) as Record<string, any>;
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const sid = String(body.session_id ?? "");
      const cwd = String(body.cwd ?? "");
      try {
        switch (url.pathname) {
          case "/hook/pre": {
            const r = await onPre(body, sid, cwd);
            // хук уже сдался ждать — сообщения владельца вернуть в очередь, а не потерять
            if (req.signal.aborted && "additionalContext" in r && r.queued) for (const m of r.queued) outbox.push(sid, m);
            const { queued: _q, ...out } = r as { queued?: string[] };
            return Response.json(out);
          }
          case "/hook/permission":
            return Response.json(await onPermission(body, sid, cwd, req.signal));
          case "/hook/stop":
            if (!(await known(sid))) return Response.json({});
            return Response.json(await onStop(body, sid, cwd));
          case "/hook/stopfail": {
            // тревоги — архитектору (main.ts), не владельцу. Упор в лимит не шлём и ему: он и сам упёрся, сессия продолжит после сброса
            if (!(await known(sid))) return Response.json({});
            const err = String(body.error ?? "unknown");
            if (err === "rate_limit") log("hooks", "ход сессии упёрся в лимит", { sid: sid.slice(0, 8) });
            else await ui.alert(sid, cwd, `ход оборвался ошибкой API (${err}${body.error_details ? `: ${clip(String(body.error_details), 200)}` : ""}). Её работа встала посреди хода`);
            return Response.json({});
          }
          case "/hook/notify":
            if (!(await known(sid))) return Response.json({});
            if (/elicitation/.test(String(body.notification_type))) await ui.alert(sid, cwd, "ждёт ввода в форме MCP-сервера: отсюда её не заполнить — только в терминале или в приложении Claude");
            return Response.json({});
          case "/hook/any/permission":
            return Response.json(await anyPermission(body, sid, cwd, req.signal));
          case "/hook/any/question":
            return Response.json(await anyQuestion(body, sid, cwd, req.signal));
          case "/hook/any/stop":
            return Response.json(await anyStop(body, sid, cwd, req.signal));
          case "/hook/ask": {
            // `archi ask`: скрипт на Mac спрашивает владельца кнопкой (например, перед push в main). Решает только владелец.
            const decision = await approvals.confirm({ source: clip(String(body.source ?? "Mac"), 60), action: clip(String(body.action ?? ""), 2000), reason: body.reason ? clip(String(body.reason), 600) : undefined, timeoutMs: 30 * 60_000, signal: req.signal });
            return Response.json({ decision });
          }
        }
      } catch (e) {
        log("hooks", `ошибка ${url.pathname}`, String(e));
      }
      return Response.json({});
    },
  });

  // ── рабочие сессии архитектора ─────────────────────────────────────────────

  async function onPre(body: Record<string, any>, sid: string, cwd: string) {
    if (body.tool_name === "AskUserQuestion") {
      const questions = (body.tool_input?.questions ?? []) as Question[];
      const answers = await approvals.ask({ source: ui.label(sid, cwd), questions, timeoutMs: SIX_HOURS - 120_000, threadId: await ui.threadFor(sid, cwd) });
      return answers ? { answers } : {};
    }
    const msgs = outbox.take(sid);
    return msgs.length ? { additionalContext: ownerWords(msgs), queued: msgs } : {};
  }

  // Запрос разрешения — бриф решения (approvals → brief.ts); к выкладке — снимки кандидата, которые сделала сама сессия.
  async function onPermission(body: Record<string, any>, sid: string, cwd: string, signal: AbortSignal) {
    const action = describe(body);
    const decision = await approvals.confirm({ source: ui.label(sid, cwd), action, ...asked(body, sid, cwd), timeoutMs: SIX_HOURS - 120_000, signal, threadId: await ui.threadFor(sid, cwd) });
    ui.permissionDecided(sid, cwd, action, decision);
    return permissionReply(decision);
  }

  async function onStop(body: Record<string, any>, sid: string, cwd: string) {
    const text = String(body.last_assistant_message ?? "").trim();
    const msgs = outbox.take(sid);
    if (msgs.length) return { decision: "block", reason: ownerWords(msgs) }; // владелец уже ответил — сессия идёт дальше, итог не нужен
    if (text) await ui.workerTurn(sid, cwd, text);
    ui.stopped?.(sid, cwd);
    return {};
  }

  // ── все остальные сессии Mac ───────────────────────────────────────────────

  async function anyPermission(body: Record<string, any>, sid: string, cwd: string, reqSignal: AbortSignal) {
    ui.markHooked(sid);
    if (!ownerId() || !(await ownerAway())) return {}; // Telegram не привязан или владелец за Mac — решает терминал
    const action = describe(body);
    const w = watch(reqSignal);
    try {
      const decision = await approvals.confirm({ source: ui.label(sid, cwd), action, ...asked(body, sid, cwd), timeoutMs: SIX_HOURS - 120_000, signal: w.signal, threadId: await ui.threadFor(sid, cwd) });
      ui.permissionDecided(sid, cwd, action, decision);
      return decision === "timeout" ? {} : permissionReply(decision);
    } finally {
      w.done();
    }
  }

  async function anyQuestion(body: Record<string, any>, sid: string, cwd: string, reqSignal: AbortSignal) {
    ui.markHooked(sid);
    if (!ownerId() || !(await ownerAway())) return {}; // Telegram не привязан или владелец за Mac — решает терминал
    const questions = (body.tool_input?.questions ?? []) as Question[];
    const w = watch(reqSignal);
    try {
      const answers = await approvals.ask({ source: ui.label(sid, cwd), questions, timeoutMs: SIX_HOURS - 120_000, signal: w.signal, threadId: await ui.threadFor(sid, cwd) });
      if (!answers) return {};
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...body.tool_input, answers } } };
    } finally {
      w.done();
    }
  }

  async function anyStop(body: Record<string, any>, sid: string, cwd: string, reqSignal: AbortSignal) {
    ui.markHooked(sid);
    const queued = outbox.take(sid);
    if (queued.length) return { decision: "block", reason: ownerWords(queued) };
    ui.stopped?.(sid, cwd);
    const text = String(body.last_assistant_message ?? "").trim();
    if (!text || !ownerId() || !(await ownerAway())) return {};
    // по умолчанию — тишина: отчёты, ошибки API и лимита владельцу не пересылаем; вопрос — архитектору на суждение
    if (API_ERROR.test(text) || !looksLikeQuestion(text)) return {};
    const prev = lastAsked.get(sid);
    const repeat = prev?.text === text && Date.now() - prev.at < 3600_000;
    lastAsked.set(sid, { text, at: Date.now() });
    let held = !goalDriven(body, sid, cwd);
    if (!held) {
      // сессия с целью /goal идёт сама — не держим; снова ждёт того же (крутится вхолостую, тратит лимит) — держим, цель остаётся
      let spins = 0;
      try {
        spins = spinCount(readTail(transcriptPath(cwd, sid), 300_000), 10 * 60_000);
      } catch {}
      held = repeat || spins >= 3;
    }
    if (!repeat) await ui.sessionQuestion(sid, cwd, text, { held });
    if (!held) return {};
    reqSignal.addEventListener("abort", () => stopHolds.release(sid));
    const answer = await stopHolds.wait(sid, HOLD_MS);
    return answer ? { decision: "block", reason: ownerWords([answer]) } : {};
  }

  return server;
}

// Сырое действие — для журнала решений и наблюдателя (ждать ли выкладку); владелец видит бриф.
function describe(body: Record<string, any>) {
  const tool = String(body.tool_name ?? "");
  const input = (body.tool_input ?? {}) as Record<string, unknown>;
  return tool === "Bash" ? String(input.command ?? "") : `${tool}: ${toolBrief(tool, input) || JSON.stringify(input).slice(0, 600)}`;
}

// Из чего собирается бриф: инструмент, его вход, папка сессии, её снимки кандидата; своя ли это рабочая сессия (её можно попросить снять кандидата).
function asked(body: Record<string, any>, sid: string, cwd: string) {
  const w = workers.get(sid);
  return { tool: String(body.tool_name ?? ""), input: (body.tool_input ?? {}) as Record<string, unknown>, cwd, shots: candidateShots(w?.id), worker: !!w };
}

function permissionReply(decision: Decision) {
  const hso = (d: Record<string, unknown>) => ({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: d } });
  if (decision === "yes") return hso({ behavior: "allow" });
  return hso({
    behavior: "deny",
    message:
      typeof decision === "object"
        ? decision.tell // «Сначала покажи» / «Сначала объясни»: не отказ, сессия спросит снова
        : decision === "no"
        ? "Владелец отказал в Telegram. Не повторяй это действие и не обходи отказ; если без него нельзя — объясни владельцу и спроси, как быть."
        : "Владелец не ответил вовремя — считается отказом. Продолжай без этого действия или спроси владельца ещё раз позже.",
  });
}
