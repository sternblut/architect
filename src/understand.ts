// Session understanding: each session's state as the owner would judge it from the whole history, not the last line.
// Heuristics alone take a finished session repeating "waiting" for a pending decision, and an optional "send the
// recording if you have one" for a question. The model is called only on real changes: repeats don't change the key.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE, config, tr } from "./config";
import { type AgentRow, conversationRows, readTail, sessionDigest, spinCount, transcriptPath } from "./sessions";
import { clip, hhmm, log, readJson, writeJson } from "./util";

export type Understanding = {
  state: "needs_owner" | "accept" | "working" | "paused";
  spinning: boolean; // repeating itself
  doing: string; // what it did or is doing, in plain words
  needs: string; // needs_owner only: what exactly the owner must do
  key: string;
  at: number;
};

const FILE = join(STATE, "understand.json");
const cache: Record<string, Understanding> = readJson(FILE, {});

const RULES = `Ты читаешь ход одной сессии Claude Code владельца и решаешь, в каком она состоянии — так, как понял бы он сам, глядя на её историю целиком, а не на последнюю фразу.

Состояния:
- needs_owner — без его решения или ответа сессия дальше не пойдёт: прямой вопрос, ответа на который нет в цели и в его прошлых словах, или открытый запрос разрешения. Необязательное предложение («если есть запись встречи — пришлите», «могу ещё…», «скажите, если нужно») — не вопрос.
- accept — работа по цели сделана, сессия ждёт его «принято» или его оценки результата.
- working — сейчас делает работу: недавние действия, движение к цели.
- paused — стоит: закончила без условия «принято», ждёт внешнего события, её остановили, или упёрлась в лимит или ошибку.

spinning — true, если в конце она по кругу повторяет одно и то же (цель /goal не даёт ей остановиться): работа уже сделана, новые реплики ничего не добавляют.
doing — одна фраза до 100 знаков обычными словами: что сделала (итог); работает — что делает сейчас; встала — что делала и почему встала («Готовила выкладку главной страницы — встала на ошибке входа в Claude»). Строку прочтёт сам владелец в утреннем итоге и в сводке: о нём — на «вы» («чтобы вы выбрали»), не «владелец». Не начинай с её имени — оно стоит перед строкой. Без путей, имён инструментов и служебных слов (буфер, журнал, коммит, агент, PR, CI, API, ветка, лендинг, /goal, «проверка цели»); лимит — «пятичасовой» или «недельный», не «лимит сессии». Холостой ход («по кругу пишет «жду»») — это spinning, в doing его не пересказывай.
Имена сайтов и проектов владельца (${config.sites.map((s) => s.name).join(", ") || "—"}) — только имена: главную страницу сайта называй «главная страница», не «стартовая».
needs — только для needs_owner: что именно нужно от владельца, одной фразой до 90 знаков, с глагола в неопределённой форме: «Выбрать вариант первых экранов на доске». Её имя стоит перед строкой — внутри не повторяй («решить, входит ли она в релиз», а не «… входит ли Арена в релиз … по Арене»). Без догадок («скорее всего»): не знаешь, о чём вопрос, — «Ответить ей в Терминале на Mac». Иначе пустая строка.
Не выдумывай. Не уверен — paused и честный doing.${tr("", "\nThe owner reads English: write doing and needs in plain English, same rules — needs starts with a verb (“Pick a first-screen option on the board”); if unsure what is asked — “Reply to it in Terminal on the Mac”.")}`;

const SCHEMA = {
  type: "object",
  properties: {
    state: { type: "string", enum: ["needs_owner", "accept", "working", "paused"] },
    spinning: { type: "boolean" },
    doing: { type: "string" },
    needs: { type: "string" },
  },
  required: ["state", "spinning", "doing", "needs"],
  additionalProperties: false,
};

// The session's course for the model: the goal, the process state and the conversation, repeats collapsed into one
// line. key is the same without repeat counts and times, so one more "waiting" doesn't call the model.
export function digestOf(r: AgentRow): { text: string; key: string } {
  const entries = readTail(transcriptPath(r.cwd, r.sessionId!), 600_000);
  const d = sessionDigest(r);
  const rows: { line: string; base: string; n: number; last: string }[] = [];
  for (const c of conversationRows(entries, 80)) {
    const base = `${c.who === "owner" ? "Владелец" : c.who === "session" ? "Другая сессия" : c.who === "tool" ? "  ↳" : "Claude"}: ${clip(c.text.replace(/\s+/g, " "), c.who === "tool" ? 120 : 500)}`;
    const prev = rows.at(-1);
    // identical messages in a row become one line with a count: the model sees the spinning, the key ignores the count
    if (prev && c.who === "claude" && prev.base.slice(0, 70) === base.slice(0, 70)) {
      prev.n++;
      prev.last = c.ts;
      continue;
    }
    rows.push({ line: `[${c.ts}] ${base}`, base, n: 1, last: c.ts });
  }
  const talk = rows.slice(-30);
  const proc = r.status === "busy" || r.state === "working" ? "сейчас работает" : r.waitingFor ? `ждёт: ${r.waitingFor}` : "простаивает";
  const head = [`Цель (дословно): ${clip(d.goal ?? d.title ?? "не задана", 1500)}`, `Процесс: ${proc}, ${r.kind === "interactive" ? "в терминале" : "в фоне"}.`, d.apiError ? `Последний ход оборвался ошибкой API: ${clip(d.apiError, 200)}` : ""].filter(Boolean);
  const spins = spinCount(entries, 60 * 60_000);
  const text = [
    ...head,
    spins ? `За последний час цель /goal ${spins} раз не дала ей остановиться.` : "",
    "Ход работы (последнее внизу):",
    ...talk.map((x) => (x.n > 1 ? `${x.line} (и ещё ${x.n - 1} раз почти так же, до ${x.last})` : x.line)),
  ]
    .filter(Boolean)
    .join("\n");
  // the rules are part of the key, so new rules re-judge every session instead of keeping old lines for weeks
  const key = Bun.hash([RULES, ...head, ...talk.map((x) => x.base)].join("\n")).toString(36);
  return { text, key };
}

// While the Claude limit is out or Claude refuses, judgments wait: until the reset for a limit, 10 minutes otherwise
let pausedUntil = 0;
const failed = (e: unknown) => {
  pausedUntil = Math.max(pausedUntil, Date.now() + 10 * 60_000);
  log("understand", `суждение не получилось, следующее — не раньше ${hhmm(new Date(pausedUntil))}`, String(e));
};

// The model's judgment of one session, with no tools and no transcript written to disk
async function judge(text: string): Promise<Omit<Understanding, "key" | "at"> | undefined> {
  const q = query({
    prompt: text,
    options: { model: "opus", systemPrompt: RULES, tools: [], maxTurns: 1, persistSession: false, settingSources: [], cwd: tmpdir(), outputFormat: { type: "json_schema", schema: SCHEMA } },
  });
  for await (const m of q) {
    const l = m.type === "rate_limit_event" ? m.rate_limit_info : undefined;
    if (l?.status === "rejected" && l.resetsAt) pausedUntil = l.resetsAt * (l.resetsAt < 1e12 ? 1000 : 1);
    if (m.type !== "result") continue;
    const out = (m as { structured_output?: unknown }).structured_output;
    if (out && typeof out === "object") return out as Omit<Understanding, "key" | "at">;
    log("understand", "модель не вернула суждение", clip(String((m as { result?: string }).result ?? m.subtype), 200));
  }
}

const busy = (r: AgentRow) => r.status === "busy" || r.state === "working";
// A /goal kept it from stopping more than once in 10 minutes: spinning
export const looping = (r: AgentRow) => spinCount(readTail(transcriptPath(r.cwd, r.sessionId!), 300_000), 10 * 60_000) >= 2;

// The current judgment of a session; undefined until there is one, and the heuristics apply
export const understood = (sessionId?: string) => (sessionId ? cache[sessionId] : undefined);

// Judges sessions whose course has changed, one at a time: the model is expensive and there is no hurry
let running = false;
export async function refresh(rows: AgentRow[]) {
  if (running) return;
  running = true;
  try {
    // skip working sessions (the process shows it, and judging every step wastes the limit), except those a /goal
    // keeps spinning: busy on paper, done in fact
    for (const r of rows.filter((x) => x.sessionId && x.pid && (!busy(x) || looping(x)))) {
      if (Date.now() < pausedUntil) break;
      const { text, key } = digestOf(r);
      if (cache[r.sessionId!]?.key === key) continue;
      const u = await judge(text).catch(failed);
      if (!u) continue;
      cache[r.sessionId!] = { ...u, key, at: Date.now() };
      writeJson(FILE, cache);
    }
  } finally {
    running = false;
  }
}

// Judges now, busy sessions included: the morning summary says what each did overnight, and a working session's
// judgment could still be from the evening
export async function judgeNow(rows: AgentRow[]) {
  for (const r of rows.filter((x) => x.sessionId)) {
    if (Date.now() < pausedUntil) break;
    const { text, key } = digestOf(r);
    if (cache[r.sessionId!]?.key === key) continue;
    const u = await judge(text).catch(failed);
    if (!u) continue;
    cache[r.sessionId!] = { ...u, key, at: Date.now() };
    writeJson(FILE, cache);
  }
}
