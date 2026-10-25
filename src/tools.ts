// The architect's tools, an in-process MCP server. Each does one thing and returns text for the model.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import type { Approvals } from "./approvals";
import { ARCH_HOME, HOME, SHOTS, STATE, config, projectDir, tr } from "./config";
import { collect, render } from "./status";
import { ARCH_NOTE, type AgentRow, conversation, deliver, sessionDigest as digestFor, isTrusted, listAgents, ownerWords, pendingRestarts, readTail, restartSession, setGoal, startWorker, stopSession, transcriptPath, trustKey, workers } from "./sessions";
import { quotesOwner } from "./architect";
import { stopHolds } from "./holds";
import { nextAt, promises } from "./promises";
import type { Telegram } from "./telegram";
import { displayName, findSession, giveName, missingSession, sessionLabel, type SessionUI } from "./ui";
import { ago, clip, hhmm, log, run, tilde } from "./util";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
const SECRET_FILE = /(^|\/)(\.env(\..*)?|id_(rsa|ed25519|ecdsa)(\.pub)?|.*\.(pem|key|p12|keychain-db)|credentials(\.json)?|hook-secret|owner\.json|worker-settings\.json)$/i;

// The result of restart_session, grouped: restarted, to restart after the turn, can't be restarted from here
export async function restartReport(targets: AgentRow[], rows: AgentRow[]): Promise<string> {
  const done: string[] = [];
  const later: string[] = [];
  const old: string[] = [];
  const failed: string[] = [];
  for (const r of targets) {
    const name = sessionLabel(r.sessionId!, r.cwd, rows);
    const res = await restartSession(r);
    if (res.ok) done.push(name);
    else if (res.how === "queued") {
      pendingRestarts.add(r.sessionId!);
      later.push(name);
    } else if (res.how === "old-tab") old.push(name);
    else if (res.how !== "self") failed.push(`${name}: ${res.note}`);
  }
  const list = (a: string[]) => a.join(", ");
  return [
    done.length ? `Перезапустил ${list(done)}: ${done.length > 1 ? "те же вкладки, те же разговоры" : "та же вкладка, тот же разговор"}, новая версия Claude Code.` : "",
    later.length ? `${list(later)} ${later.length > 1 ? "работают — перезапущу, когда закончат ход" : "работает — перезапущу, когда закончит ход"}.` : "",
    old.length > 1 ? `${list(old)} открыты в старых вкладках Терминала, отсюда их не перезапустить. Чтобы смог: в новой вкладке наберите archi adopt и имя — для каждой.` : "",
    old.length === 1 ? `${old[0]} открыта в старой вкладке Терминала, отсюда её не перезапустить. Чтобы смог: в новой вкладке наберите archi adopt ${old[0]}.` : "",
    failed.length ? `Не перезапустил: ${failed.join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n") || "Запущенных сессий нет.";
}

// summary: the dashboard overview (the names and states the owner sees); without it, the same overview without pending
// requests. wake: a message to the owner right away and with sound, with step buttons (Architect.wake).
export function makeTools(d: { tg: Telegram; approvals: Approvals; ui: SessionUI; claudePath: string; bunPath: string; summary?: (full: boolean) => Promise<string>; wake?: (md: string) => Promise<void> }) {
  return createSdkMcpServer({
    name: "arch",
    version: "1.0.0",
    tools: [
      tool("overview", "Сводка «что у нас» — та же, что «Пульт» у владельца: кто ждёт его решения и чего, кто ждёт «принято», кто работает, кто на паузе, что ломает работу. Называй сессии и состояния её словами. Вызывай, когда владелец спрашивает, что происходит.", { full: z.boolean().optional().describe("все имена без сокращения") }, async ({ full }) => text(d.summary ? await d.summary(!!full) : render(await collect(true), !!full)), { annotations: { readOnlyHint: true }, alwaysLoad: true }),

      tool(
        "sessions",
        "Все сессии Claude Code на этом Mac (фоновые и в терминалах владельца): id, имя, папка, состояние, чего ждёт, тема и последний ответ.",
        { include_finished: z.boolean().optional() },
        async ({ include_finished }) => {
          const rows = (await listAgents(true)).filter((r) => include_finished || r.pid || r.state === "working" || r.state === "blocked");
          if (!rows.length) return text("Живых сессий нет.");
          return text(
            rows
              .map((r) => {
                const dg = digestFor(r);
                const w = workers.get(r.sessionId);
                return [
                  `• ${sessionLabel(r.sessionId ?? "", r.cwd, rows)} [id ${r.id ?? "—"} · session ${r.sessionId ?? "?"}] ${r.kind === "interactive" ? "терминал" : "фон"}${w ? " · запущена архитектором" : ""}`,
                  `  папка: ${tilde(r.cwd)} · состояние: ${r.state ?? "—"}/${r.status ?? "—"}${r.waitingFor ? ` · ждёт: ${r.waitingFor}` : ""} · начата ${ago(r.startedAt)} назад`,
                  dg.goal || dg.title || w?.task ? `  о чём: ${clip(w?.task ?? dg.goal ?? dg.title ?? "", 200)}` : "",
                  dg.lastText ? `  последний ответ: ${clip(dg.lastText.replace(/\s+/g, " "), 300)}` : "",
                ]
                  .filter(Boolean)
                  .join("\n");
              })
              .join("\n"),
          );
        },
        { annotations: { readOnlyHint: true }, alwaysLoad: true },
      ),

      tool(
        "session_log",
        "Ход одной сессии: последние реплики владельца и Claude и вызовы инструментов, время — по часам Mac. session — id, sessionId или часть имени; hours — всё за последние N часов («что у блога за сутки» — 24); find — только строки с этими словами, по всему журналу («откуда ссылка на редакцию»).",
        { session: z.string(), lines: z.number().int().min(4).max(80).optional(), hours: z.number().min(1).max(72).optional(), find: z.string().min(3).optional() },
        async ({ session, lines, hours, find }) => {
          const r = await findSession(session);
          if (!r?.sessionId) return fail(await missingSession(session));
          // hours and find read much deeper into the transcript
          const deep = hours !== undefined || find !== undefined;
          const since = hours ? Date.now() - hours * 3600_000 : 0;
          const all = conversation(readTail(transcriptPath(r.cwd, r.sessionId), deep ? 30_000_000 : undefined).filter((e) => !since || Date.parse(e.timestamp ?? "") >= since), deep ? 100_000 : (lines ?? 20));
          const rows = (find ? all.filter((x) => x.toLowerCase().includes(find.toLowerCase())) : all).slice(-(lines ?? (deep ? 60 : 20)));
          const none = find ? `«${find}» в журнале не нашёл` : hours ? `за ${hours} ч в журнале ничего` : "журнал пуст";
          return text(`${r.name ?? r.id} · ${tilde(r.cwd)} · ${r.state ?? ""}/${r.status ?? ""}\n` + (rows.join("\n") || none));
        },
        { annotations: { readOnlyHint: true }, alwaysLoad: true },
      ),

      tool(
        "recent_files",
        "Файлы, которые недавно появились или поменялись в папке сессии (рендеры, снимки, отчёты): когда, размер, путь — новые сверху. session — id, sessionId или часть имени; hours — за сколько часов (по умолчанию 24).",
        { session: z.string(), hours: z.number().min(1).max(168).optional() },
        async ({ session, hours }) => {
          const r = await findSession(session);
          if (!r) return fail(await missingSession(session));
          if (r.cwd === HOME) return fail("Папка сессии — домашняя, обход займёт слишком долго. Смотри конкретную папку через Glob.");
          const h = hours ?? 24;
          const found = await run(["find", r.cwd, "(", "-name", "node_modules", "-o", "-name", ".git", ")", "-prune", "-o", "-type", "f", "-mmin", `-${Math.round(h * 60)}`, "-print"], { timeoutMs: 20_000 });
          const files = found.stdout
            .split("\n")
            .filter(Boolean)
            .map((p) => ({ p, s: statSync(p, { throwIfNoEntry: false }) }))
            .filter((x) => x.s)
            .sort((a, b) => b.s!.mtimeMs - a.s!.mtimeMs);
          const mb = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1e3))} КБ`);
          const list = files.slice(0, 40).map(({ p, s }) => `${ago(s!.mtimeMs)} назад · ${mb(s!.size)} · ${p.slice(r.cwd.length + 1)}`);
          return text(files.length ? `${tilde(r.cwd)}, за ${h} ч — ${files.length} файлов${files.length > 40 ? ", новые 40" : ""}:\n${list.join("\n")}` : `${tilde(r.cwd)}: за ${h} ч новых файлов нет.`);
        },
        { annotations: { readOnlyHint: true }, alwaysLoad: true },
      ),

      tool(
        "folders",
        "Папки проектов владельца: где уже работал Claude Code, доверена ли папка, git-репозиторий, когда была последняя сессия. query — часть названия (можно по-русски).",
        { query: z.string().optional() },
        async ({ query }) => {
          const cfg = JSON.parse(readFileSync(join(HOME, ".claude.json"), "utf8"));
          const known = Object.entries((cfg.projects ?? {}) as Record<string, { hasTrustDialogAccepted?: boolean }>);
          const q = (query ?? "").toLowerCase();
          const rows = known
            .filter(([p]) => existsSync(p) && (!q || p.toLowerCase().includes(q)))
            .map(([p, v]) => {
              let last = 0;
              try {
                last = statSync(projectDir(p)).mtimeMs;
              } catch {}
              return { p, trusted: !!v.hasTrustDialogAccepted, last, git: existsSync(join(p, ".git")) };
            })
            .sort((a, b) => b.last - a.last)
            .slice(0, 40);
          if (!rows.length) return text(`Ничего не нашёл по «${query}». Можно поискать шире: Glob/Bash ls в ${config.roots.map(tilde).join(", ")}.`);
          return text(rows.map((r) => `${tilde(r.p)} · ${r.trusted ? "доверена" : "НЕ доверена"}${r.git ? " · git" : ""} · сессия ${r.last ? ago(r.last) + " назад" : "не было"}`).join("\n"));
        },
        { annotations: { readOnlyHint: true }, alwaysLoad: true },
      ),

      tool(
        "start_session",
        "Запустить новую фоновую сессию Claude Code в папке проекта с задачей. Сессия работает по правилам своей папки (CLAUDE.md, память). У владельца появится тема этой сессии в Telegram с карточкой хода. task — задача словами владельца плюс нужный контекст.",
        {
          folder: z.string().describe("полный путь к папке"),
          task: z.string().min(10),
          name: z.string().min(2).max(40).describe("короткое имя по-русски или латиницей, видно владельцу; без двоеточия — оно стоит в кнопках «Ответить: имя»"),
          model: z.enum(["opus", "sonnet"]).optional(),
          effort: z.enum(["high", "xhigh", "max"]).optional(),
          goal: z.boolean().optional().describe("поставить задачу целью /goal: сессия работает, пока цель не достигнута (условие завершения — в тексте задачи); только с разрешения владельца — кнопку хост покажет сам"),
        },
        async ({ folder, task, name, model, effort, goal }) => {
          let w;
          try {
            w = await startWorker({ folder, task, name, model: model ?? config.workers.model, effort: effort ?? config.workers.effort, remote: true, goal });
          } catch (e) {
            if (String(e).includes("NOT_TRUSTED")) {
              const key = await trustKey(folder);
              const ok = await d.approvals.confirm({
                source: "Архитектор",
                action: tr(`Доверить Claude Code папку ${tilde(key)}`, `Trust Claude Code with folder ${tilde(key)}`),
                reason: tr(
                  "Claude Code ещё не открывали в этой папке. Доверие — как ответ «Yes» в окне доверия при первом запуске: Claude будет читать её настройки и правила.",
                  "Claude Code hasn’t been opened in this folder yet. Trusting it is like answering “Yes” in the trust prompt on first launch: Claude will read the folder’s settings and rules.",
                ),
                timeoutMs: 30 * 60_000,
              });
              if (ok !== "yes") return fail("Владелец не доверил папку — сессию не запускаю.");
              trustFolder(key);
              w = await startWorker({ folder, task, name, model: model ?? config.workers.model, effort: effort ?? config.workers.effort, remote: true, goal });
            } else return fail(String(e));
          }
          await d.ui.adopt(w.sessionId, w.cwd);
          return text(`Запущена «${w.name}» [id ${w.id}, session ${w.sessionId}] в ${tilde(w.cwd)}. Владелец видит её в своей теме Telegram; её итоги и вопросы придут туда.`);
        },
        { alwaysLoad: true },
      ),

      tool(
        "message_session",
        "Передать сессии слово владельца. words — его слова дословно, целиком или кусками через «…»: хост сверит их с его сообщениями за 30 минут и ответами на твои вопросы. note — твоё от себя (контекст, ответ за него по его правилам): сессия увидит, что это от тебя, а не от него. Работающая сессия получает сразу, в свой же процесс, без перезапуска — как его слова из Telegram; твоя занятая сессия — когда закончит ход. «принято» и /команды уходят его собственной репликой — передавай их отдельно, без note: фоновой и сессии с обёрткой можно, сессии из Терминала без обёртки — нет.",
        { session: z.string(), words: z.string().optional(), note: z.string().optional() },
        async ({ session, words, note }) => {
          const w = words?.trim(), n = note?.trim();
          if (!w && !n) return fail("Нечего передать: нужны words или note.");
          // the code, not the model, checks that these are the owner's words
          if (w && !quotesOwner(w, d.tg.ownerSaid.map((x) => x.text))) {
            log("tools", "message_session: не его слова — не передаю", clip(w, 200));
            return fail("Это не его слова дословно: в его сообщениях за 30 минут их нет. Его реплику передай в words как есть (можно кусками через «…»), своё — в note.");
          }
          const r = await findSession(session);
          if (!r) return fail(await missingSession(session));
          // the owner's words arrive as their own message; a note is signed, so the hook never quotes it as theirs
          const t = n ? `${w ? `${ownerWords([w])}\n\n` : ""}${ARCH_NOTE}${n}` : w!;
          if (r.sessionId && stopHolds.answer(r.sessionId, t)) return text("Передано: сессия ждала ответа и получила его сразу.");
          const res = await deliver(r, t);
          if (res.how === "needs-sendmessage") return text(`${res.note}. Отправь сам инструментом SendMessage сессии «${r.name}» (папка ${tilde(r.cwd)}).`);
          return res.ok ? text(`Передано: ${res.note}.`) : fail(`Не передано: ${res.note}`);
        },
        { alwaysLoad: true },
      ),

      tool(
        "set_goal",
        "Поставить сессии цель /goal по слову владельца. condition — его слова дословно: тогда хост ставит цель сразу; свою формулировку хост сначала покажет ему кнопкой. Работает для фоновых сессий и для сессий из Терминала с обёрткой перезапуска (в их же вкладке).",
        { session: z.string(), condition: z.string().min(10) },
        async ({ session, condition }) => {
          const r = await findSession(session);
          if (!r) return fail(await missingSession(session));
          const res = await setGoal(r, condition);
          if (res.how === "queued") return text("Поставлю цель, как только она закончит текущий шаг.");
          return res.ok ? text("Цель поставлена — сессия работает, пока она не достигнута.") : fail(`Не поставил: ${res.note}`);
        },
        { alwaysLoad: true },
      ),

      tool(
        "clear_goal",
        "Снять цель /goal с сессии (сессия перестаёт крутиться до достижения цели, разговор сохраняется). По слову владельца: если он сам только что сказал снять её, хост не спрашивает второй раз, иначе спросит кнопкой.",
        { session: z.string() },
        async ({ session }) => {
          const r = await findSession(session);
          if (!r) return fail(await missingSession(session));
          const res = await setGoal(r, null);
          if (res.how === "queued") return text("Сниму цель, как только она закончит текущий шаг.");
          return res.ok ? text("Цель снята.") : fail(`Не снял: ${res.note}`);
        },
        { alwaysLoad: true },
      ),

      tool(
        "stop_session",
        "Остановить сессию по слову владельца: если он сам только что попросил остановить её, хост не спрашивает второй раз, иначе спросит кнопкой. Разговор сохраняется, её можно продолжить.",
        { session: z.string() },
        async ({ session }) => {
          const r = await findSession(session);
          if (!r?.id) return fail(r ? `«${session}» — сессия в терминале: она останавливается только там.` : await missingSession(session));
          return text(await stopSession(r.id));
        },
        { annotations: { destructiveHint: true }, alwaysLoad: true },
      ),

      tool(
        "restart_session",
        "Перезапустить сессию на нынешней версии Claude Code с того же места: тот же разговор и та же цель. Фоновую — штатно; сессию из Терминала — в её же вкладке, если она запущена с обёрткой перезапуска (иначе не трогаю и говорю об этом). Занятую перезапущу сам, когда она закончит ход. session — имя или «все».",
        { session: z.string() },
        async ({ session }) => {
          const rows = await listAgents(true);
          const all = /^\s*вс[её]\s*$/i.test(session);
          const one = all ? undefined : await findSession(session);
          if (!all && !one) return fail(await missingSession(session));
          return text(await restartReport(all ? rows.filter((r) => r.sessionId && r.pid) : [one!], rows));
        },
        { alwaysLoad: true },
      ),

      tool(
        "fix_message",
        "Исправить на месте своё прошлое сообщение владельцу, если в нём ошибка: текст заменится, внизу встанет «Исправлено в ЧЧ:ММ». which — 1 последнее, 2 предпоследнее и так далее; md — исправленный текст целиком. После этого в ответе одной строкой «Поправка: …» — правка не звонит, а он должен узнать.",
        { which: z.number().int().min(1).max(20).optional(), md: z.string().min(2) },
        async ({ which, md }) => ((await d.tg.correct(which ?? 1, md)) ? text("Исправлено на месте.") : fail("Такого сообщения нет — исправь новым сообщением «Поправка: …».")),
        { alwaysLoad: true },
      ),

      // At night the architect's replies wait for the morning; this is how it reaches the owner when work due by
      // morning stops
      tool(
        "wake_owner",
        "Ночью (0:00–8:00), пока он спит, твои ответы ждут утреннего итога. Если встала работа, которую он ждёт к утру, или без его выбора утро встанет, — напиши ему этим инструментом: придёт сразу и со звуком. md — что случилось и что он может сделать, одной-двумя строками. Днём не нужен: обычный ответ и так приходит со звуком.",
        { md: z.string().min(2) },
        async ({ md }) => {
          await (d.wake ? d.wake(md) : d.tg.send(md, { silent: false, from: "architect" }));
          return text("Отправлено со звуком. Закончи ход без текста: обычный ответ ночью ждёт утра.");
        },
        { alwaysLoad: true },
      ),

      // The host records the promise, so "I'll send it when…" survives a usage limit and /new
      tool(
        "follow_up",
        "Записать своё обещание владельцу («пришлю, когда сессия закончит», «напомню в 9:30»): хост напомнит тебе в срок, а если ты не сможешь ответить (лимит) — сам скажет ему. Без записи не обещай. what — что обещал, его словами; session — напомнить, когда эта сессия закончит ход; at — к какому времени ЧЧ:ММ по часам Mac (с session — крайний срок; без at — через 3 часа).",
        { what: z.string().min(3), session: z.string().optional(), at: z.string().regex(/^\d{1,2}:\d{2}$/).optional() },
        async ({ what, session, at }) => {
          if (!session && !at) return fail("Нужен повод: session или at.");
          const r = session ? await findSession(session) : undefined;
          if (session && !r?.sessionId) return fail(await missingSession(session));
          const name = r ? sessionLabel(r.sessionId!, r.cwd, await listAgents(true)) : undefined;
          const p = promises.add({ what: what.trim(), due: at ? nextAt(at) : Date.now() + 3 * 3600_000, session: r?.sessionId, name });
          const by = hhmm(new Date(p.due));
          if (!r) return text(`Записал: напомню тебе в ${by}.`);
          const idle = r.status !== "busy" && r.state !== "working";
          return text(`Записал: напомню, когда «${name}» закончит ход, не позже ${by}.${idle ? " Она сейчас не работает — её итог уже есть (session_log)." : ""}`);
        },
        { alwaysLoad: true },
      ),

      tool(
        "name_session",
        "Назвать сессию словами владельца: так её будут звать сводка, закреп, кнопки и ты сам. Когда он поправляет имя («это не лендинг, это блог») или в фактах два одинаковых имени — дай короткое понятное имя (до 30 знаков) и скажи ему одной строкой.",
        { session: z.string(), name: z.string().min(2).max(30) },
        async ({ session, name }) => {
          const r = await findSession(session);
          if (!r?.sessionId) return fail(await missingSession(session));
          const was = sessionLabel(r.sessionId, r.cwd, await listAgents(true));
          giveName(r.sessionId, name.trim());
          return text(`Теперь «${name.trim()}» (было «${was}»).`);
        },
        { alwaysLoad: true },
      ),

      tool(
        "watch_session",
        "Завести у владельца тему и карточку для уже идущей сессии (например, запущенной им самим), чтобы он видел её ход и мог отвечать ей из Telegram.",
        { session: z.string() },
        async ({ session }) => {
          const r = await findSession(session);
          if (!r?.sessionId) return fail(await missingSession(session));
          await d.ui.adopt(r.sessionId, r.cwd);
          // only the architect's own sessions get a card, so don't promise one for any other
          return text(workers.get(r.sessionId) ? `Карточка «${r.name ?? r.id}» заведена.` : `Карточки в чате у этой сессии не будет: она запущена в терминале. Её состояние владелец видит в «Пульте».`);
        },
        { alwaysLoad: true },
      ),

      tool(
        "screenshot",
        `Снять страницу сайта. device: iphone (WebKit 390×844), macbook (1470×870), monitor (${config.monitor?.width ?? 2560}×${config.monitor?.height ?? 1440}). Снимок — быстрый взгляд движком Playwright, не настоящий Safari на iPhone. send: false — только для своей проверки, владельцу не уходит (смотри его инструментом Read); по умолчанию снимок уходит владельцу.`,
        { url: z.string().url(), device: z.enum(["iphone", "macbook", "monitor"]).optional(), full_page: z.boolean().optional(), caption: z.string().optional(), send: z.boolean().optional() },
        async ({ url, device, full_page, caption, send }) => {
          const out = join(SHOTS, `${new Date().toISOString().replace(/[:.]/g, "-")}-${device ?? "iphone"}.png`);
          const r = await run([d.bunPath, join(ARCH_HOME, "src", "shot-cli.ts"), url, device ?? "iphone", out, full_page ? "full" : ""], { timeoutMs: 180_000, cwd: ARCH_HOME });
          if (r.code !== 0 || !existsSync(out)) return fail(`Снимок не вышел: ${clip(r.stderr || r.stdout, 400)}`);
          const info = JSON.parse(r.stdout.trim().split("\n").pop() || "{}");
          // a shot for its own check isn't sent, or the owner would get a duplicate after a deploy
          if (send === false) return text(`Снимок для твоей проверки (владельцу не ушёл): ${out} (HTTP ${info.status}, «${info.title}»). Посмотри его инструментом Read.`);
          // a human caption: "Beacon on iPhone, 22:30", not "https://beacon.example.com/ · iphone · HTTP 200"
          const site = config.sites.find((s) => url.replace(/\/$/, "").startsWith(s.url.replace(/\/$/, "")))?.name ?? url.replace(/^https?:\/\//, "").split("/")[0];
          const on = tr({ iphone: "на iPhone", macbook: "на MacBook", monitor: "на мониторе" }, { iphone: "on iPhone", macbook: "on MacBook", monitor: "on a monitor" })[device ?? "iphone"];
          await d.tg.sendFile(out, caption ?? `${site} ${on}, ${hhmm()}`, true, undefined, "architect");
          return text(`Снимок отправлен владельцу: ${out} (HTTP ${info.status}, «${info.title}»). Можешь посмотреть его сам инструментом Read.`);
        },
        { alwaysLoad: true },
      ),

      tool(
        "send_file",
        "Отправить владельцу файл с Mac (отчёт, картинку, архив). Секреты (.env, ключи, токены) не отправляются.",
        { path: z.string(), caption: z.string().optional() },
        async ({ path, caption }) => {
          const p = path.replace(/^~(?=\/)/, HOME);
          if (SECRET_FILE.test(p) || p.startsWith(STATE)) return fail("Это секрет или служебный файл — не отправляю.");
          if (!existsSync(p)) return fail(`Файла нет: ${path}`);
          if (statSync(p).size > 49 * 1024 * 1024) return fail("Больше 49 МБ — Telegram не примет. Сожми или выложи иначе.");
          await d.tg.sendFile(p, caption ?? basename(p), /\.(png|jpe?g|webp)$/i.test(p), undefined, "architect");
          return text("Отправлено.");
        },
        { alwaysLoad: true },
      ),
    ],
  });
}

// Called only after the owner's yes (see start_session)
function trustFolder(key: string) {
  const path = join(HOME, ".claude.json");
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  cfg.projects ??= {};
  cfg.projects[key] = { ...(cfg.projects[key] ?? {}), hasTrustDialogAccepted: true };
  const tmp = `${path}.arch-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: statSync(path).mode & 0o777 });
  renameSync(tmp, path);
  log("tools", `папке доверено по слову владельца: ${tilde(key)}`);
  if (!isTrusted(key)) log("tools", "доверие не подтвердилось после записи", key);
}
