// Hook receiver: 127.0.0.1 only, with a secret header.
// /hook/*      the architect's sessions (hooks from --settings, with the policy gate)
// /hook/any/*  every other session on the Mac (the shared hook): while the owner is at the Mac the terminal decides;
//              when they are away, permissions and questions go to Telegram, and on return go back to the terminal
import { timingSafeEqual } from "node:crypto";
import type { Approvals, Decision, Question } from "./approvals";
import { config, tr } from "./config";
import { stopHolds } from "./holds";
import { onReturn, ownerAway } from "./presence";
import { ARCH_NOTE, deliver, listAgents, outbox, ownerWords, readTail, spinCount, toolBrief, transcriptPath, workers } from "./sessions";
import { candidateShots } from "./shots";
import { ownerId } from "./telegram";
import { clip, log } from "./util";

export type HookUI = {
  label(sessionId: string, cwd: string): string;
  threadFor(sessionId: string, cwd: string): Promise<number | undefined>;
  workerTurn(sessionId: string, cwd: string, text: string): Promise<void>; // a worker's turn summary, for the architect
  sessionQuestion(sessionId: string, cwd: string, text: string, opts: { held: boolean }): Promise<void>; // another session's question, for the architect to judge
  alert(sessionId: string, cwd: string, text: string): Promise<void>;
  markHooked(sessionId: string): void;
  permissionDecided(sessionId: string, cwd: string, action: string, decision: Decision): void;
  stopped?(sessionId: string, cwd: string): void; // any session ended its turn: promises about it are due
};

const SIX_HOURS = 6 * 3600_000;
const DEPLOY = /git\b.*\bpush\b|gh\s+(pr\s+merge|workflow\s+run|run\s+rerun)/;
const LATER =
  "Это решает владелец, а он сейчас не у Mac — карточка у него в Telegram. Не жди и не повторяй это действие: займись остальной работой. Когда он ответит, его решение придёт тебе сообщением; после «да» это можно будет сделать без вопроса.";
const HOLD_MS = 2 * 3600_000;
const BACK_AT_MAC = () => tr("Решите на Mac", "Decide on the Mac"); // shown on a request closed because the owner is back

// API and limit errors are not questions and not worth a message
export const API_ERROR = /hit your (weekly |session |5-hour |)limit|usage limit|API Error|overloaded|rate.?limit|Credit balance|Please run \/login|Invalid API key|Prompt is too long/i;

export const looksLikeQuestion = (t: string) => {
  const tail = t.trim().slice(-400);
  return /\?\s*(\*\*|_|»|")?\s*$/.test(tail) || /\?\s*\n/.test(tail) || /(жду (вашего|ваш|«|от вас)|скажите|выберите|подтвердите|ответьте|нужн[оа] ваш)/i.test(tail);
};

// A /goal or another Stop hook keeps the session going, so it can't be held; the answer is delivered at the next stop
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

  // back at the Mac: everything waiting goes back to the terminal
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
  // Whoever holds the secret must not message the owner as an arbitrary session: text only from sessions the host knows
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
    idleTimeout: 0, // the owner's answer can take hours
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
            // the hook gave up waiting: put the owner's messages back in the queue
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
            // Alerts go to the architect (main.ts), not the owner. A rate limit isn't sent even there: the architect hit it
            // too, and the session resumes after the reset.
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
            // `archi ask`: a script on the Mac asks the owner with a button, say before a push to main
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

  // ── workers ────────────────────────────────────────────────────────────────

  async function onPre(body: Record<string, any>, sid: string, cwd: string) {
    if (body.tool_name === "AskUserQuestion") {
      const questions = (body.tool_input?.questions ?? []) as Question[];
      const answers = await approvals.ask({ source: ui.label(sid, cwd), questions, timeoutMs: SIX_HOURS - 120_000, threadId: await ui.threadFor(sid, cwd) });
      return answers ? { answers } : {};
    }
    const msgs = outbox.take(sid);
    return msgs.length ? { additionalContext: ownerWords(msgs), queued: msgs } : {};
  }

  // The owner away from the Mac: a session doesn't wait on his card, so its work doesn't stand still. It is told he
  // decides and goes on with the rest; his answer reaches it later as a message, and after a yes exactly this action
  // passes once without asking. A push or deploy still waits for him: the host follows its pipeline from his yes.
  const granted = new Map<string, number>(); // "<session> <action>" → until when
  const waiting = new Set<string>(); // cards sent and not answered yet
  async function decideLater(body: Record<string, any>, sid: string, cwd: string) {
    const action = describe(body);
    const key = `${sid}\u0000${action}`;
    if (!waiting.has(key)) {
      waiting.add(key);
      void approvals
        .confirm({ source: ui.label(sid, cwd), action, ...asked(body, sid, cwd), timeoutMs: 12 * 3600_000, threadId: await ui.threadFor(sid, cwd) })
        .then(async (d) => {
          waiting.delete(key); // answered: asking again is a new card
          ui.permissionDecided(sid, cwd, action, d);
          if (d === "yes") granted.set(key, Date.now() + 2 * 3600_000);
          const note =
            d === "yes"
              ? `владелец разрешил кнопкой: ${clip(action, 300)}. Если это ещё нужно — сделай: второй раз спрашивать не придётся.`
              : d === "no"
                ? `владелец не разрешил: ${clip(action, 300)}. Не повторяй это и не обходи.`
                : typeof d === "object"
                  ? d.tell
                  : "";
          const row = note ? (await listAgents(true).catch(() => [])).find((r) => r.sessionId === sid) : undefined;
          if (row) await deliver(row, `${ARCH_NOTE}${note}`);
        })
        .catch((e) => log("hooks", "решение владельца не дошло до сессии", String(e)))
        .finally(() => waiting.delete(key));
    }
    return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: LATER } } };
  }
  const allowedOnce = (sid: string, action: string) => {
    const key = `${sid}\u0000${action}`;
    const ok = (granted.get(key) ?? 0) > Date.now();
    granted.delete(key);
    return ok;
  };
  const later = async (action: string) => !DEPLOY.test(action) && (await ownerAway());

  // A permission request becomes a decision brief (approvals → brief.ts), with the session's candidate shots for a deploy
  async function onPermission(body: Record<string, any>, sid: string, cwd: string, signal: AbortSignal) {
    const action = describe(body);
    if (allowedOnce(sid, action)) return permissionReply("yes");
    if (await later(action)) return decideLater(body, sid, cwd);
    const decision = await approvals.confirm({ source: ui.label(sid, cwd), action, ...asked(body, sid, cwd), timeoutMs: SIX_HOURS - 120_000, signal, threadId: await ui.threadFor(sid, cwd) });
    ui.permissionDecided(sid, cwd, action, decision);
    return permissionReply(decision);
  }

  async function onStop(body: Record<string, any>, sid: string, cwd: string) {
    const text = String(body.last_assistant_message ?? "").trim();
    const msgs = outbox.take(sid);
    if (msgs.length) return { decision: "block", reason: ownerWords(msgs) }; // the owner already answered: no summary needed
    if (text) await ui.workerTurn(sid, cwd, text);
    ui.stopped?.(sid, cwd);
    return {};
  }

  // ── all other sessions on the Mac ──────────────────────────────────────────

  async function anyPermission(body: Record<string, any>, sid: string, cwd: string, reqSignal: AbortSignal) {
    ui.markHooked(sid);
    if (!ownerId() || !(await ownerAway())) return {}; // not paired, or the owner is at the Mac: the terminal decides
    const action = describe(body);
    if (allowedOnce(sid, action)) return permissionReply("yes");
    if (await later(action)) return decideLater(body, sid, cwd);
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
    if (!ownerId() || !(await ownerAway())) return {};
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
    // silent by default: reports and API or limit errors are not forwarded; a question goes to the architect
    if (API_ERROR.test(text) || !looksLikeQuestion(text)) return {};
    const prev = lastAsked.get(sid);
    const repeat = prev?.text === text && Date.now() - prev.at < 3600_000;
    lastAsked.set(sid, { text, at: Date.now() });
    let held = !goalDriven(body, sid, cwd);
    if (!held) {
      // a /goal session goes on by itself and isn't held, unless it asks the same again (spinning, burning the limit)
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

// The raw action, for the decision log and the watcher (whether to wait for a deploy); the owner sees the brief
function describe(body: Record<string, any>) {
  const tool = String(body.tool_name ?? "");
  const input = (body.tool_input ?? {}) as Record<string, unknown>;
  return tool === "Bash" ? String(input.command ?? "") : `${tool}: ${toolBrief(tool, input) || JSON.stringify(input).slice(0, 600)}`;
}

// Inputs of the brief: tool, input, session folder, candidate shots, and whether it is a worker (which can be asked for shots)
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
        ? decision.tell // "Show me first" / "Explain first": not a refusal, the session asks again
        : decision === "no"
        ? "Владелец отказал в Telegram. Не повторяй это действие и не обходи отказ; если без него нельзя — объясни владельцу и спроси, как быть."
        : "Владелец не ответил вовремя — считается отказом. Продолжай без этого действия или спроси владельца ещё раз позже.",
  });
}
