// Понимание сессий: состояние каждой — так, как понял бы владелец, читая её историю, а не по последней фразе.
// Эвристика записывала в «ждут вашего решения» сессии, которые давно закончили и по кругу повторяли «жду»,
// а необязательное «пришлите запись, если есть» принимала за вопрос. Нужна логика, которая учитывает контекст.
// Модель зовётся только на настоящих переменах: повторы «жду» суть не меняют, и ключ кэша от них не зависит.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE, config, tr } from "./config";
import { type AgentRow, conversationRows, readTail, sessionDigest, spinCount, transcriptPath } from "./sessions";
import { clip, hhmm, log, readJson, writeJson } from "./util";

export type Understanding = {
  state: "needs_owner" | "accept" | "working" | "paused";
  spinning: boolean; // по кругу повторяет одно и то же
  doing: string; // что сделано или что делает — его словами
  needs: string; // только для needs_owner: что именно нужно от владельца
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

// Ход сессии для модели: цель, что происходит с процессом, разговор с повторами, схлопнутыми в одну строку.
// key — то же без счётчиков повторов и времени «сколько назад»: новый «жду» не меняет суть, модель не зовём.
export function digestOf(r: AgentRow): { text: string; key: string } {
  const entries = readTail(transcriptPath(r.cwd, r.sessionId!), 600_000);
  const d = sessionDigest(r);
  const rows: { line: string; base: string; n: number; last: string }[] = [];
  for (const c of conversationRows(entries, 80)) {
    const base = `${c.who === "owner" ? "Владелец" : c.who === "session" ? "Другая сессия" : c.who === "tool" ? "  ↳" : "Claude"}: ${clip(c.text.replace(/\s+/g, " "), c.who === "tool" ? 120 : 500)}`;
    const prev = rows.at(-1);
    // одинаковые реплики подряд — одной строкой со счётчиком: так модель видит холостой ход, а ключ от счётчика не зависит
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
  // правила в ключе: поменялись слова суждения — после выпуска сессии судятся заново, а не держат старые строки неделями
  const key = Bun.hash([RULES, ...head, ...talk.map((x) => x.base)].join("\n")).toString(36);
  return { text, key };
}

// Кончился лимит Claude или он не пускает — суждения ждут. Раньше круг каждые 2 минуты поднимал Claude на каждую
// сессию и получал отказ, до 60 раз в час. Лимит — до его сброса, прочие отказы — 10 минут.
let pausedUntil = 0;
const failed = (e: unknown) => {
  pausedUntil = Math.max(pausedUntil, Date.now() + 10 * 60_000);
  log("understand", `суждение не получилось, следующее — не раньше ${hhmm(new Date(pausedUntil))}`, String(e));
};

// Суждение модели по одной сессии. Без инструментов и без записи разговора на диск.
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
// за 10 минут цель не раз не дала ей остановиться — холостой ход
export const looping = (r: AgentRow) => spinCount(readTail(transcriptPath(r.cwd, r.sessionId!), 300_000), 10 * 60_000) >= 2;

// Что известно о сессии сейчас; undefined — ещё не понята (тогда работает прежняя эвристика).
export const understood = (sessionId?: string) => (sessionId ? cache[sessionId] : undefined);

// Понять сессии, у которых изменилась суть. По одной: модель — дорогой ресурс, спешить незачем.
let running = false;
export async function refresh(rows: AgentRow[]) {
  if (running) return;
  running = true;
  try {
    // работающих не судим (видно по процессу, модель на каждом их шаге — пустая трата лимита) — кроме тех,
    // кого по кругу гоняет цель /goal: процесс «занят», а по сути работа сделана и сессия повторяет «жду»
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

// Суждение сейчас — и о занятых: утренний итог пишет «что сделала ночью», а у работающей сессии понимание могло
// остаться вечерним: «упёрлась в лимит», хотя она давно снова работает.
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
