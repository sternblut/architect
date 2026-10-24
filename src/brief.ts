// Бриф решения: вместо сырой команды владелец видит, что изменится, можно ли вернуть и что советует архитектор.
// Источники: сама команда или инструмент, git папки (что уходит, чей репозиторий и сайт — config.json), GitHub (автопроверки PR и прогоны),
// шлагбаум (policy.ts — почему спрашиваем). Без модели: всё из фактов, каждая проверка с тайм-аутом; не узнал — так и пишем.
// На виду — человеческие слова; файлы, команды, ветки — под «Подробнее».
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { ARCH_HOME, HOME, config, tr, type Site } from "./config";
import { mdEsc } from "./md";
import { classifyCommand, classifyTool, gitBranchSync, parseShell, stripPrefixes, type PolicyContext, type Verdict } from "./policy";
import { clip, run, tilde } from "./util";

// Куда склоняется совет: цветом выделена только его кнопка. Без совета все кнопки нейтральные.
export type Lean = "allow" | "look" | "reject";
// Третья кнопка: попросить сессию сначала показать или объяснить. Запрос снимается с этим текстом для сессии — она спросит снова.
// note — подпись погасшей кнопки, next — всплывашка владельцу: что будет дальше.
export type More = { label: string; note: string; next: string; tell: string };
export type Brief = {
  head: string; // первая строка, жирным: что изменится
  lines: string[]; // где, что именно, можно ли вернуть
  advice: string; // совет архитектора и его основание; пусто — совета нет (без основания не советуем)
  lean?: Lean;
  more?: More;
  details?: string[]; // под «Подробнее»: что именно (правки, файлы, сама правка), кто просит, почему спрашиваем, команда
  deploy?: boolean; // выкладка сайта: снимки кандидата идут над брифом
  noop?: boolean; // проверено, что ничего не изменится (push в ветку, где всё уже есть), — владельца не спрашиваем
  // вид действия и проект: на такой карточке кнопка «… без вопросов» — правило владельца; выкладка сайта, обновление
  // основной версии репозитория без сайта, удаление в проекте. Перезапись истории и слияние в обход проверок — без неё
  rule?: { kind: "deploy" | "main" | "delete"; project: string };
};

const SHOTS = (): More => ({
  label: tr("Сначала покажи", "Show me first"),
  note: tr("Снимки запрошены", "Screenshots requested"),
  next: tr("Сессия снимет новую версию и спросит снова", "The session will screenshot the new version and ask again"),
  tell: "Владелец пока не решил: сначала покажи ему кандидата. Сними главный экран и изменённое место на iPhone и Mac, положи PNG в $CLAUDE_JOB_DIR/tmp/evidence/ и запроси ту же команду снова — снимки придут ему вместе с кнопкой.",
});
// tell читает сессия, а не владелец; язык описания — его: он увидит его первой строкой
const EXPLAIN = (): More => ({
  label: tr("Сначала объясни", "Explain first"),
  note: tr("Объяснение запрошено", "Explanation requested"),
  next: tr("Сессия опишет команду и спросит снова", "The session will describe the command and ask again"),
  tell: `Владелец пока не решил: не понял, что делает команда. Запроси её снова, а в поле description одним предложением ${tr("по-русски", "по-английски")} напиши, что она изменит, — владелец увидит это первой строкой.`,
});

const FILE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
const fence = (s: string, lang = "") => "```" + lang + "\n" + s.replace(/```/g, "`​``") + "\n```";
const q = (s: string) => tr(`«${mdEsc(s)}»`, `“${mdEsc(s)}”`);
// слова на языке владельца: по-русски — с кириллицей; по-английски — латиница без кириллицы
const isRu = (s: string) => tr(/[а-яё]/i.test(s), /[a-z]/i.test(s) && !/[а-яё]/i.test(s));

// Описание сессии — от первого лица («Удаляю 17 тысяч снимков»), а заголовок карточки — то, что владелец разрешает:
// «Удалить 17 тысяч снимков?», как «Выложить Маяк».
const AS_ASK: Record<string, string> = {
  удаляю: "удалить", стираю: "стереть", чищу: "почистить", очищаю: "очистить", убираю: "убрать", выкладываю: "выложить",
  отправляю: "отправить", публикую: "опубликовать", перезаписываю: "перезаписать", сливаю: "слить", ставлю: "поставить",
  запускаю: "запустить", переношу: "перенести", обновляю: "обновить", создаю: "создать", меняю: "поменять", правлю: "поправить",
  пересобираю: "пересобрать", собираю: "собрать", скачиваю: "скачать", перемещаю: "переместить", копирую: "скопировать",
  переименовываю: "переименовать", освобождаю: "освободить", сжимаю: "сжать", включаю: "включить", выключаю: "выключить",
  останавливаю: "остановить", перезапускаю: "перезапустить", записываю: "записать", добавляю: "добавить", заменяю: "заменить",
  восстанавливаю: "восстановить", откатываю: "откатить", сбрасываю: "сбросить", закрываю: "закрыть", архивирую: "заархивировать",
};
export const asAsk = (desc: string) =>
  desc.replace(/(^|,\s+|\s+и\s+)([А-ЯЁа-яё]+)/g, (m, sep: string, w: string) => {
    const inf = AS_ASK[w.toLowerCase()];
    return inf ? `${sep}${sep ? inf : cap(inf)}` : m;
  });
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const low = (s: string) => (tr(/^[А-ЯЁ][а-яё]/, /^[A-Z][a-z]+\b/).test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
export function plural(k: number, one: string, few: string, many: string) {
  const a = k % 10;
  const b = k % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
}
const n = (k: number, one: string, few: string, many: string) => `${k} ${plural(k, one, few, many)}`; // неразрывный пробел: «12 файлов» не рвётся на iPhone
const en = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
const edits = (k: number) => tr(n(k, "правка", "правки", "правок"), en(k, "change", "changes"));
const files = (k: number) => tr(n(k, "файл", "файла", "файлов"), en(k, "file", "files"));
const go = (k: number) => tr(`${k === 1 ? "Уходит" : "Уходят"} ${edits(k)}`, `${cap(edits(k))} going out`);
const andMore = (k: number) => tr(`и ещё ${k}`, `and ${k} more`);
const list = (rows: string[], max = 8) => [...rows.slice(0, max).map((r) => `- ${mdEsc(r)}`), ...(rows.length > max ? [`- ${andMore(rows.length - max)}`] : [])].join("\n");

// Что меняется — словами самой сессии из её правок, если она писала на языке владельца. Иначе пусто: «1 правка» владельцу
// ничего не говорит, сами правки — под «Подробнее».
function whatOf(subjects: string[]): string {
  const ru = subjects.filter(isRu);
  if (!ru.length) return "";
  const first = clip(low(ru[0].replace(/\.$/, "").replace(": ", " — ")), 60); // «Шапка: логотип» → «шапка — логотип»
  const k = subjects.length - 1;
  return `${mdEsc(first)}${subjects.length > 1 ? tr(` и ещё ${edits(k)}`, ` and ${k} more ${k === 1 ? "change" : "changes"}`) : ""}`;
}

// undefined — команда не ответила (не репозиторий, нет ветки): тогда молчим, а не пишем «новых правок нет»
async function shOk(cwd: string, cmd: string[], ms = 4000): Promise<string | undefined> {
  const r = await run(cmd, { cwd: existsSync(cwd) ? cwd : undefined, timeoutMs: ms });
  return r.code === 0 ? r.stdout.trim() : undefined;
}
const sh = async (cwd: string, cmd: string[], ms = 4000) => (await shOk(cwd, cmd, ms)) ?? "";
const git = (cwd: string, ...a: string[]) => sh(cwd, ["git", "-C", cwd, ...a]);
// Настоящий путь (git отдаёт его же): /tmp → /private/tmp и прочие ссылки, иначе файл «окажется» вне своего проекта
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p === dirname(p) ? p : join(real(dirname(p)), basename(p));
  }
}

// ── чей это проект ──────────────────────────────────────────────────────────

type Proj = { name: string; site?: Site; slug?: string; top?: string };

async function project(path: string): Promise<Proj> {
  let at = path;
  while (at !== "/" && !(existsSync(at) && statSync(at).isDirectory())) at = dirname(at); // файл или ещё не созданная папка — смотрим ближайшую папку
  const [top, url] = await Promise.all([git(at, "rev-parse", "--show-toplevel"), git(at, "remote", "get-url", "origin")]);
  const m = url.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  const site = m ? config.sites.find((s) => s.repo === m[2]) : undefined;
  const own = top && (top === ARCH_HOME || top.startsWith(ARCH_HOME + "/")) ? ARCH() : undefined;
  return { name: site?.name ?? own ?? (m?.[2] ?? basename(top || at)), site, slug: m ? `${m[1]}/${m[2]}` : undefined, top: top || undefined };
}
const host = (s: Site) => s.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
const shownFile = (p: string) => q(basename(p).replace(/\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|rb|go|swift)$/i, "")); // расширение кода — под «Подробнее»
const inProj = (p: Proj) => tr(`в проекте ${q(p.name)}`, `in project ${q(p.name)}`);
const ARCH = () => tr("архитектор", "architect"); // папка самого бота — его проект

// Имя сессии для владельца: «Шапка Маяка». Служебное (claude-e7, «сессия 1a2b3c», номер сессии) ему ничего не говорит — тогда папка.
// По-английски — вместе со словом «session»: «Asked by session “Header”», «Requested by the session in folder beacon».
const INTERNAL = /^(?:[a-z]+-[0-9a-f]{2,4}|сессия [0-9a-f]{6}|[0-9a-f]{8}-[0-9a-f-]{27})$/i;
const INTERNAL_EN = /^(?:[a-z]+-[0-9a-f]{2,4}|сессия [0-9a-f]{6}|session [0-9a-f]{6}|[0-9a-f]{8}-[0-9a-f-]{27})$/i;
export const plainSessionName = (name: string, folder?: string) =>
  !tr(INTERNAL, INTERNAL_EN).test(name) ? tr(`«${name}»`, `session “${name}”`) : folder ? tr(`в папке ${basename(folder)}`, `the session in folder ${basename(folder)}`) : "";
// то же из подписи сессии («Шапка Маяка», beacon) — для Markdown
export function sessionName(source: string): string {
  const m = source.match(/^«([^»]*)»(?:,\s*(.+))?$/);
  // без папки служебное имя давало пустоту: «Просит сессия.» — тогда хотя бы само имя
  return mdEsc(m ? plainSessionName(m[1], m[2]) || (m[1] ? tr(`«${m[1]}»`, `session “${m[1]}”`) : "") : source);
}
const BACK_SITE = () => tr("Прежнюю версию можно вернуть", "The previous version can be restored");
const BACK_REPO = () => tr("Вернуть можно новой правкой", "Can be undone with a new change");

// ── автопроверки GitHub ─────────────────────────────────────────────────────

type Ci = { state: "green" | "red" | "running" | "none" | "stuck"; name?: string };

function ciOf(items: { name?: string; workflowName?: string; status?: string; conclusion?: string; state?: string }[]): Ci {
  if (!items.length) return { state: "none" };
  // проверки не стартовали — обычно оплата или квота GitHub Actions: тогда не запустится и выкладка,
  // и это надо сказать до его «Выложить», а не после
  const failed = items.filter((x) => /FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED/i.test(x.conclusion ?? x.state ?? ""));
  if (failed.length && failed.every((x) => /STARTUP_FAILURE/i.test(x.conclusion ?? x.state ?? ""))) return { state: "stuck", name: failed[0].workflowName ?? failed[0].name };
  const bad = items.find((x) => /FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED|STARTUP_FAILURE/i.test(x.conclusion ?? x.state ?? ""));
  if (bad) return { state: "red", name: bad.workflowName ?? bad.name };
  if (items.some((x) => (x.status ? !/^completed$/i.test(x.status) : /PENDING|EXPECTED/i.test(x.state ?? "")))) return { state: "running" };
  return { state: "green" };
}

// Только прогоны той самой версии, что уходит, и по каждому конвейеру — последний: старый упавший прогон или чужая ветка не в счёт.
async function runsFor(p: Proj, sha: string): Promise<Ci> {
  if (!p.slug || !sha) return { state: "none" };
  const out = await sh(p.top ?? ARCH_HOME, ["gh", "run", "list", "-R", p.slug, "--commit", sha, "--json", "workflowName,status,conclusion,headSha,createdAt", "--limit", "20"], 6000);
  try {
    type Run = { workflowName?: string; status?: string; conclusion?: string; headSha?: string; createdAt?: string };
    const last = new Map<string, Run>();
    for (const r of (JSON.parse(out || "[]") as Run[]).filter((r) => r.headSha === sha).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))))
      if (!last.has(r.workflowName ?? "")) last.set(r.workflowName ?? "", r);
    return ciOf([...last.values()]);
  } catch {
    return { state: "none" };
  }
}
const ciFailed = (ci: Ci) => (ci.state === "red" && ci.name ? [tr(`Не прошла автопроверка ${q(ci.name)}`, `Check ${q(ci.name)} failed`)] : []);

// Совет к выкладке держится на двух фактах — автопроверка и снимки кандидата от самой сессии, — и оба названы в нём самом.
// Снимков нет, а сессия своя рабочая (умеет класть их хосту) — «Сначала покажи» просит её снять кандидата.
function deployAdvice(ci: Ci, shots: number, worker: boolean, site: boolean): Pick<Brief, "advice" | "lean" | "more"> {
  if (ci.state === "stuck")
    return { advice: tr("Не советую сейчас: GitHub не запускает проверки, обычно из-за оплаты, — значит, не запустится и выкладка", "I wouldn’t right now: GitHub isn’t starting checks, usually a billing issue, so the deploy won’t start either"), lean: "reject" };
  if (ci.state === "red") return { advice: tr("Не советую: автопроверка этой версии не прошла", "I wouldn’t: checks failed for this version"), lean: "reject" };
  if (ci.state === "running") return { advice: tr("Лучше дождаться: автопроверка этой версии ещё идёт", "Better to wait: checks for this version are still running"), lean: "look" };
  if (!site)
    return ci.state === "green" ? { advice: tr("Советую разрешить: автопроверка прошла", "I’d allow it: checks passed"), lean: "allow" } : { advice: tr("Решите сами: автопроверок по этим правкам не было", "Your call: no checks ran on these changes") };
  if (shots)
    return {
      advice: ci.state === "green" ? tr("Советую разрешить: автопроверка прошла, снимки выше", "I’d allow it: checks passed, screenshots above") : tr("Советую разрешить, если снимки выше устраивают: автопроверок не было", "I’d allow it if the screenshots above look right: no checks ran"),
      lean: "allow",
    };
  const why = ci.state === "green" ? tr("автопроверка прошла, но снимков новой версии ещё нет", "checks passed, but there are no screenshots of the new version yet") : tr("снимков новой версии нет, автопроверок не было", "no screenshots of the new version, and no checks ran");
  return worker ? { advice: tr(`Советую сначала посмотреть: ${why}`, `I’d take a look first: ${why}`), lean: "look", more: SHOTS() } : { advice: tr(`Решите сами: ${why}`, `Your call: ${why}`) };
}

// ── git push ─────────────────────────────────────────────────────────────────

// said — описание команды словами сессии (по-русски — первая строка запроса в ветку; выкладке первую строку пишут факты)
async function gitPush(args: string[], cwd: string, shots: number, worker: boolean, said: string): Promise<Brief> {
  const flags = args.filter((a) => a.startsWith("-"));
  const pos = args.filter((a) => !a.startsWith("-"));
  const remote = pos[0] ?? "origin";
  const p = await project(cwd);
  const cur = gitBranchSync(cwd);
  const specs = pos.length > 1 ? pos.slice(1) : [cur];
  const force = flags.some((a) => /^(-f|--force|--force-with-lease|--force-if-includes)(=|$)/.test(a)) || specs.some((s) => s.startsWith("+"));
  if (flags.some((a) => a === "--all" || a === "--tags" || a === "--mirror"))
    return {
      head: tr(`Отправить на GitHub все ветки и метки ${inProj(p)}`, `Push all branches and tags to GitHub ${inProj(p)}`),
      lines: [tr("Может запустить выкладку, если среди них основная версия", "May start a deploy if the main version is among them")],
      advice: tr("Не советую: уйдёт всё сразу, лучше по одной ветке", "I wouldn’t: everything goes at once, better one branch at a time"),
      lean: "reject",
    };
  const [src0, dst0] = specs[0].replace(/^\+/, "").split(":");
  const src = src0 === "HEAD" || !src0 ? cur : src0;
  const dst = (dst0 ?? src).replace(/^refs\/heads\//, "");
  const main = /^(main|master)$/.test(dst);
  if (flags.some((a) => a === "--delete" || a === "-d") || specs[0].startsWith(":")) {
    const merged = (await git(cwd, "branch", "-r", "--merged", `${remote}/main`)).split("\n").some((b) => b.trim() === `${remote}/${dst}`);
    return {
      head: tr(`Удалить ветку на GitHub ${inProj(p)}`, `Delete a branch on GitHub ${inProj(p)}`),
      lines: [merged ? tr("Её правки уже в основной версии", "Its changes are already in the main version") : tr("Её правок нет в основной версии — они останутся только на Mac", "Its changes aren’t in the main version — they’ll stay only on the Mac")],
      advice: merged ? tr("Советую разрешить: всё уже в основной версии", "I’d allow it: everything is already in the main version") : tr("Советую сначала посмотреть, что в ней", "I’d check what’s in it first"),
      lean: merged ? "allow" : "look",
      details: [`${tr("Ветка", "Branch")}: ${mdEsc(dst)}`],
    };
  }
  const known = !!(await git(cwd, "rev-parse", "--verify", "-q", `${remote}/${dst}`));
  // logOut === "" — проверено, что новых правок нет; undefined — git не ответил, и про правки молчим
  const logOut = await shOk(cwd, ["git", "-C", cwd, "log", "--format=%s", "-n", "50", ...(known ? [`${remote}/${dst}..${src}`] : [src, "--not", `--remotes=${remote}`])]);
  const log = (logOut ?? "").split("\n").filter(Boolean);
  const changed = known ? (await git(cwd, "diff", "--name-only", `${remote}/${dst}...${src}`)).split("\n").filter(Boolean) : [];
  const listed = [log.length ? `${go(log.length)}:\n${list(log)}` : "", changed.length ? `${cap(files(changed.length))}:\n${fence(changed.slice(0, 15).join("\n") + (changed.length > 15 ? `\n… ${andMore(changed.length - 15)}` : ""))}` : ""].filter(Boolean);
  const what = whatOf(log); // первой строкой — что меняется, словами из правок
  if (main) {
    // первой строкой — короткое действие («Выложить Маяк»), что меняется — второй: строка до 30 знаков помещается
    // в одну строку iPhone и в уведомление; имя сайта — без кавычек
    const head = p.site ? tr(`Выложить ${p.site.name}`, `Deploy ${p.site.name}`) : tr(`Обновить основную версию ${inProj(p)}`, `Update the main version ${inProj(p)}`);
    const where = [...(what ? [what.charAt(0).toUpperCase() + what.slice(1)] : []), ...(p.site ? [tr(`Обновится ${host(p.site)}`, `Goes live on ${host(p.site)}`)] : [])];
    if (known && logOut === "" && !force)
      return { head, lines: [...where, tr("Новых правок нет — ничего не изменится", "No new changes — nothing will change")], advice: tr("Можно разрешить: ничего не изменится", "Safe to allow: nothing will change"), lean: "allow" };
    if (force)
      return {
        head,
        lines: [...where, ...(log.length ? [go(log.length)] : []), tr("Вернуть нельзя: прежняя история на GitHub пропадёт", "Can’t be undone: the previous history on GitHub will be lost")],
        advice: tr("Не советую: это необратимо", "I wouldn’t: this can’t be undone"),
        lean: "reject",
        details: listed,
        deploy: !!p.site,
      };
    const ci = await runsFor(p, await git(cwd, "rev-parse", src));
    return { head, lines: [...where, p.site ? BACK_SITE() : BACK_REPO()], ...deployAdvice(ci, shots, worker, !!p.site), details: [...listed, ...ciFailed(ci)], deploy: !!p.site, rule: { kind: p.site ? "deploy" : "main", project: p.site?.name ?? p.name } };
  }
  if (force)
    return {
      head: tr(`Перезаписать ветку ${mdEsc(dst)} на GitHub ${inProj(p)}`, `Overwrite branch ${mdEsc(dst)} on GitHub ${inProj(p)}`),
      lines: [...(log.length ? [go(log.length)] : []), tr("Вернуть нельзя: прежние правки этой ветки пропадут", "Can’t be undone: earlier changes on this branch will be lost")],
      advice: tr("Решите сами: так бывает, когда сессия переписала свои правки", "Your call: this happens when a session rewrites its own changes"),
      details: listed,
    };
  // в ветку: проект — его словами (описание сессии), ветка — на виду; где всё уже есть, ничего не меняется — не спрашиваем
  const own = isRu(said);
  return {
    head: own ? cap(mdEsc(said)) : tr(`Отправить правки ${p.top ? `проекта ${q(p.name)} ` : ""}на GitHub`, `Push ${p.top ? `${q(p.name)} ` : ""}changes to GitHub`),
    lines: [...(what ? [tr(`Правки: ${what}`, `Changes: ${what}`)] : []), ...(own && said.includes(dst) ? [] : [tr(`В ветку ${mdEsc(dst)}`, `To branch ${mdEsc(dst)}`)])],
    advice: tr(`Советую разрешить: ${p.site ? "сайт" : "основная версия"} от этого не изменится`, `I’d allow it: the ${p.site ? "site" : "main version"} won’t change`),
    lean: "allow",
    details: listed,
    noop: known && logOut === "",
  };
}

// ── gh pr merge ──────────────────────────────────────────────────────────────

async function prMerge(args: string[], cwd: string, shots: number, worker: boolean): Promise<Brief> {
  const VALUED = ["-R", "--repo", "-t", "--subject", "-b", "--body", "-F", "--body-file", "-A", "--author-email", "--match-head-commit"];
  const ri = args.findIndex((a) => a === "-R" || a === "--repo");
  const slug = ri >= 0 ? args[ri + 1] : args.find((a) => a.startsWith("--repo="))?.slice(7);
  const target = args.find((a, k) => !a.startsWith("-") && !VALUED.includes(args[k - 1]));
  const p = await project(cwd);
  const site = slug ? config.sites.find((s) => s.repo === slug.split("/")[1]) : p.site;
  const raw = await sh(cwd, ["gh", "pr", "view", ...(target ? [target] : []), ...(slug ? ["-R", slug] : []), "--json", "number,title,headRefName,baseRefName,changedFiles,statusCheckRollup,isDraft,commits,files"], 6000);
  type Pr = { number?: number; title?: string; headRefName?: string; baseRefName?: string; changedFiles?: number; isDraft?: boolean; statusCheckRollup?: []; commits?: { messageHeadline: string }[]; files?: { path: string }[] };
  let pr: Pr = {};
  try {
    pr = JSON.parse(raw || "{}");
  } catch {}
  const base = pr.baseRefName ?? "main";
  const live = /^(main|master)$/.test(base) && !!site;
  const ci = ciOf(pr.statusCheckRollup ?? []);
  const subjects = (pr.commits ?? []).map((c) => c.messageHeadline);
  const what = whatOf(subjects) || (pr.title && isRu(pr.title) ? mdEsc(low(pr.title)) : ""); // что меняется — словами из правок или названия
  const fileList = (pr.files ?? []).map((f) => f.path);
  return {
    // как у push в main: короткое действие первой строкой, что меняется — второй
    // в репозитории без сайта (сам бот) — сколько правок уходит и что сайты не изменятся: иначе на виду было бы
    // «Правка: build → main: …», а в «Подробнее» — неправда, что слияние запускает выкладку
    head: live
      ? tr(`Выложить ${site!.name}`, `Deploy ${site!.name}`)
      : /^(main|master)$/.test(base)
        ? tr(`Влить ${subjects.length > 1 ? n(subjects.length, "правку", "правки", "правок") : "правку"} в основную версию ${inProj(p)}`, `Merge ${subjects.length > 1 ? `${subjects.length} changes` : "the change"} into the main version ${inProj(p)}`)
        : tr(`Влить правку в ветку ${mdEsc(base)}`, `Merge the change into branch ${mdEsc(base)}`),
    lines: [
      ...(live ? [...(what ? [what.charAt(0).toUpperCase() + what.slice(1)] : []), tr(`Обновится ${host(site!)}`, `Goes live on ${host(site!)}`)] : what && !/→/.test(what) ? [tr(`Правка: ${what}`, `Change: ${what}`)] : []),
      ...(!site && /^(main|master)$/.test(base) ? [tr("Сайты не изменятся", "No sites will change")] : []),
      ...(args.includes("--auto") ? [tr("Сольётся само, когда пройдёт автопроверка", "Merges on its own once checks pass")] : []),
      live ? BACK_SITE() : BACK_REPO(),
    ],
    ...(args.includes("--admin")
      ? { advice: tr("Не советую: слияние в обход автопроверки", "I wouldn’t: this merge skips the checks"), lean: "reject" as const }
      : pr.isDraft
        ? { advice: tr("Не советую: правка ещё черновик", "I wouldn’t: the change is still a draft"), lean: "reject" as const }
        : !raw
          ? { advice: tr("Советую сначала посмотреть правку на GitHub: прочитать её не удалось", "I’d look at the change on GitHub first: I couldn’t read it"), lean: "look" as const }
          : deployAdvice(ci, shots, worker, live)),
    details: [
      pr.title ? `${tr("Правка", "Change")}${pr.number ? tr(` №${pr.number}`, ` #${pr.number}`) : ""}: ${q(pr.title)}` : "",
      subjects.length ? `${go(subjects.length)}:\n${list(subjects)}` : "",
      fileList.length ? `${cap(files(fileList.length))}:\n${fence(fileList.slice(0, 15).join("\n") + (fileList.length > 15 ? `\n… ${andMore(fileList.length - 15)}` : ""))}` : "",
      ...ciFailed(ci),
      args.some((a) => a === "--delete-branch" || a === "-d") ? tr("Ветку правки потом удалит", "The change’s branch will be deleted afterwards") : "",
    ].filter(Boolean),
    deploy: live,
    ...(args.includes("--admin") || !/^(main|master)$/.test(base) ? {} : { rule: { kind: live ? ("deploy" as const) : ("main" as const), project: site?.name ?? p.name } }),
  };
}

// ── удаление ─────────────────────────────────────────────────────────────────

type Gone = { abs: string; rel: string; dir: boolean; files: number; inGit: number; dirty: boolean; missing: boolean };

async function inspect(abs: string, top: string | undefined): Promise<Gone> {
  const rel = top && abs.startsWith(top + "/") ? relative(top, abs) : tilde(abs);
  if (!existsSync(abs)) return { abs, rel, dir: false, files: 0, inGit: 0, dirty: false, missing: true };
  const dir = statSync(abs).isDirectory();
  let count = 1;
  if (dir) {
    count = 0;
    const walk = (d: string, depth: number) => {
      if (count > 5000 || depth > 12) return;
      for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name), depth + 1) : count++;
    };
    try {
      walk(abs, 0);
    } catch {}
  }
  if (!top || !abs.startsWith(top + "/")) return { abs, rel, dir, files: count, inGit: 0, dirty: true, missing: false };
  const [tracked, status] = await Promise.all([git(top, "ls-files", "--", abs), git(top, "status", "--porcelain", "--", abs)]);
  return { abs, rel, dir, files: count, inGit: tracked ? tracked.split("\n").length : 0, dirty: !!status, missing: false };
}

// Кто ещё ссылается на удаляемый файл: ссылки остались — сломается сборка или страница. Слишком общее имя (index, style) — не судим.
async function refsTo(abs: string, top: string): Promise<{ key: string; found: string[] } | undefined> {
  const name = basename(abs);
  const code = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|rb|go|swift)$/i.test(name);
  const key = code ? name.replace(/\.[^.]+$/, "") : name;
  if (key.length < 5 || /^(index|main|style|styles|readme|utils|types|tests?|config|package|app|page|layout)$/i.test(key)) return undefined;
  const out = await git(top, "grep", "-l", "-F", ...(code ? ["-w"] : []), key, "--", ".", `:!${relative(top, abs)}`);
  return { key, found: out.split("\n").filter(Boolean) };
}

// more — в команде есть и другие шаги (описание сессии или ""): тогда о всей команде по одной её части не судим.
// Иначе сессия правит стили через sed -i и пересобирает сайт, а бриф говорит «удалять нечего… ничего не изменится».
async function removal(targets: string[], cwd: string, more?: string): Promise<Brief> {
  const paths: string[] = [];
  for (const t of targets.slice(0, 50)) {
    if (/[*?[]/.test(t)) {
      try {
        for (const f of new Bun.Glob(t).scanSync({ cwd, onlyFiles: false, dot: true })) paths.push(resolve(cwd, f));
      } catch {}
    } else paths.push(resolve(cwd, t.replace(/^~(?=\/|$)/, HOME)));
  }
  // проект — по тому, что удаляется, а не по папке, откуда команда: иначе, когда архитектор чистит черновики другого
  // проекта, карточка говорит «Удалить 21671 файл в проекте «архитектор»» — и не понять, что удаляется.
  const p = await project(paths[0] ?? cwd);
  const live = (await Promise.all(paths.slice(0, 50).map((x) => inspect(real(x), p.top)))).filter((g) => !g.missing);
  if (!live.length && more !== undefined)
    return {
      head: isRu(more) ? cap(mdEsc(asAsk(more))) : tr(`Выполнить команду ${inProj(p)}`, `Run a command ${inProj(p)}`),
      lines: [tr("Удалять пока нечего: этих файлов сейчас нет", "Nothing to delete yet: these files don’t exist right now"), tr("Остальные шаги команды — в «Подробнее»", "The command’s other steps are under “Details”")],
      advice: "",
    };
  if (!live.length)
    return { head: tr(`Удалить файлы ${inProj(p)}`, `Delete files ${inProj(p)}`), lines: [tr("Удалять нечего: этих файлов уже нет", "Nothing to delete: these files are already gone")], advice: tr("Можно разрешить: ничего не изменится", "Safe to allow: nothing will change"), lean: "allow" };
  const total = live.reduce((s, g) => s + g.files, 0);
  // сколько места освободится — главное, когда чистят диск; и где это лежит, если удаляется не один файл
  const kb = Number((await run(["du", "-skc", ...live.map((g) => g.abs)], { timeoutMs: 20_000 })).stdout.trim().split("\n").at(-1)?.split(/\s+/)[0]) || 0;
  const size = kb >= 1024 * 1024 ? tr(`${(kb / 1024 / 1024).toFixed(1).replace(".", ",")} ГБ`, `${(kb / 1024 / 1024).toFixed(1)} GB`) : tr(`${Math.max(1, Math.round(kb / 1024))} МБ`, `${Math.max(1, Math.round(kb / 1024))} MB`);
  const inside = live.filter((g) => !/^[~/]/.test(g.rel)).map((g) => g.rel.split("/"));
  const common: string[] = []; // общая папка всего удаляемого внутри проекта
  if (inside.length === live.length && inside.length > 1)
    for (let i = 0; inside.every((r) => i < r.length - 1 && r[i] === inside[0][i]); i++) common.push(inside[0][i]);
  const names = live.slice(0, 2).map((g) => q(basename(g.rel))).join(", ") + (live.length > 2 ? tr(` и ещё ${live.length - 2}`, ` and ${live.length - 2} more`) : "");
  const where = live.length > 1 ? [common.length ? tr(`Что: ${names} в ${common.join("/")}`, `What: ${names} in ${common.join("/")}`) : tr(`Что: ${names}`, `What: ${names}`)] : [];
  const lost = live.filter((g) => g.dirty || g.inGit < g.files);
  const one = live.length === 1 ? live[0] : undefined;
  const away = one && (one.rel.startsWith("~") || one.rel.startsWith("/"));
  const head =
    one && !one.dir
      ? tr(`Удалить файл ${shownFile(one.rel)} ${away ? "вне проектов" : inProj(p)}`, `Delete file ${shownFile(one.rel)} ${away ? "outside projects" : inProj(p)}`)
      : one
        ? tr(`Удалить папку ${q(basename(one.rel))} ${inProj(p)}`, `Delete folder ${q(basename(one.rel))} ${inProj(p)}`)
        : tr(`Удалить ${files(total)} ${inProj(p)}`, `Delete ${files(total)} ${inProj(p)}`);
  // нет в истории ни одного из удаляемых — «Вернуть нельзя», а не «Вернуть можно не всё»
  const out = live.reduce((s, g) => s + Math.max(0, g.files - g.inGit), 0); // скольких файлов нет в истории
  const back = !lost.length
    ? tr("Можно вернуть из истории проекта", "Can be restored from the project history")
    : one && !one.dir
      ? one.inGit
        ? tr("Вернуть можно не всё: последние правки в нём не сохранены", "Only partly reversible: its latest edits aren’t saved")
        : tr("Вернуть нельзя: файла нет в истории проекта", "Can’t be undone: the file isn’t in the project history")
      : out >= total
        ? tr(`Вернуть нельзя: ${one?.dir ? "этой папки" : "этих файлов"} нет в истории проекта`, `Can’t be undone: ${one?.dir ? "this folder isn’t" : "these files aren’t"} in the project history`)
        : out
          ? tr(`Вернуть можно не всё: в истории проекта нет ${out} из ${total}`, `Only partly reversible: ${out} of ${total} ${out === 1 ? "isn’t" : "aren’t"} in the project history`)
          : tr("Вернуть можно не всё: последние правки в части файлов не сохранены", "Only partly reversible: latest edits in some files aren’t saved");
  const refs = one && !one.dir && one.inGit && p.top ? await refsTo(one.abs, p.top) : undefined;
  let preview = "";
  if (one && !one.dir) {
    try {
      const text = statSync(one.abs).size < 200_000 ? readFileSync(one.abs, "utf8") : "";
      if (text && !text.includes("\u0000")) preview = `${tr("Начало файла", "Start of the file")}:\n${fence(clip(text.trimEnd().split("\n").slice(0, 25).join("\n"), 2500))}`;
    } catch {}
  }
  const state = (g: Gone) =>
    g.inGit >= g.files && !g.dirty ? tr("есть в истории проекта", "in the project history") : g.inGit ? tr("есть несохранённые правки", "has unsaved edits") : tr("нет в истории проекта", "not in the project history");
  const rows = live.map((g) => `${g.rel}${g.dir ? tr(`, папка, ${files(g.files)}`, `, folder, ${files(g.files)}`) : ""} — ${state(g)}`);
  const k = refs?.found.length ?? 0;
  return {
    head,
    // «без вопросов» — только то, что вернётся из истории проекта: невосстановимое спрашиваем всегда, и правило его не разрешит
    ...(lost.length ? {} : { rule: { kind: "delete" as const, project: p.name } }),
    lines: [...(one?.dir ? [tr(`В ней ${files(one.files)}`, `It holds ${files(one.files)}`)] : []), ...where, ...(kb >= 1024 ? [tr(`Освободится ${size}`, `Frees ${size}`)] : []), back],
    ...(refs?.found.length
      ? { advice: tr(`Не советую: на него ещё ссылаются ${files(k)}`, `I wouldn’t: ${files(k)} still ${k === 1 ? "refers" : "refer"} to it`), lean: "reject" as const }
      : lost.length
        ? { advice: tr("Советую сначала посмотреть, что удаляется: список ниже", "I’d check what gets deleted first: the list is below"), lean: "look" as const }
        : refs
          ? { advice: tr("Советую разрешить: в проекте на него никто не ссылается", "I’d allow it: nothing in the project refers to it"), lean: "allow" as const }
          : { advice: tr("Советую разрешить: всё вернётся из истории проекта", "I’d allow it: everything can be restored from the project history"), lean: "allow" as const }),
    details: [
      `${tr("Что удалится", "What gets deleted")}:\n${list(rows, 15)}`,
      refs
        ? refs.found.length
          ? tr(`Искал ${q(refs.key)} по проекту, нашёл:\n${list(refs.found, 10)}`, `Searched the project for ${q(refs.key)}, found:\n${list(refs.found, 10)}`)
          : tr(`Искал ${q(refs.key)} по проекту: упоминаний нет, кроме самого файла`, `Searched the project for ${q(refs.key)}: no mentions except the file itself`)
        : "",
      preview,
    ].filter(Boolean),
  };
}

// ── правка файлов инструментами ──────────────────────────────────────────────

async function fileEdit(tool: string, input: Record<string, unknown>, cwd: string, who: string): Promise<Brief> {
  const path = real(resolve(cwd, String(input.file_path ?? input.notebook_path ?? "").replace(/^~(?=\/|$)/, HOME)));
  const [own, target] = await Promise.all([project(cwd), project(path)]);
  const exists = existsSync(path);
  const foreign = !!target.top && (target.slug && own.slug ? target.slug !== own.slug : target.top !== own.top); // свой worktree — не чужой
  const claude = path.startsWith(join(HOME, ".claude") + "/");
  const memory = claude && /\/memory\//.test(path);
  const home = !!target.top && relative(target.top, path) === "index.html"; // корневая index.html сайта — его главная страница
  const verb = tool === "Write" ? (exists ? tr("Перезаписать", "Overwrite") : tr("Создать", "Create")) : tr("Изменить", "Edit");
  const head = memory
    ? tr(`${verb} заметку в памяти Claude`, `${verb} a note in Claude’s memory`)
    : claude
      ? tr(`${verb} настройки Claude Code`, `${verb} Claude Code settings`)
      : home
        ? tr(`${verb} главную страницу проекта ${q(target.name)}`, `${verb} the home page of project ${q(target.name)}`)
        : target.top
          ? tr(`${verb} файл ${shownFile(path)} в проекте ${q(target.name)}`, `${verb} file ${shownFile(path)} in project ${q(target.name)}`)
          : tr(`${verb} файл ${shownFile(path)} вне проектов`, `${verb} file ${shownFile(path)} outside projects`);
  const tracked = exists && !!target.top && !!(await git(target.top, "ls-files", "--", path)) && !(await git(target.top, "status", "--porcelain", "--", path));
  const back = !exists
    ? tr("Вернуть просто: удалить новый файл", "Easy to undo: delete the new file")
    : tracked
      ? tr("Прежнюю версию можно вернуть", "The previous version can be restored")
      : tr("Прежнюю версию не вернуть: её нет в истории проекта", "The previous version can’t be restored: it’s not in the project history");
  const pick = memory
    ? { advice: tr("Можно разрешить: это заметка в памяти", "Safe to allow: it’s a note in memory"), lean: "allow" as const }
    : claude
      ? { advice: tr("Советую сначала посмотреть правку: это настройки Claude Code", "I’d look at the edit first: these are Claude Code settings"), lean: "look" as const }
      : tracked || !exists
          ? { advice: tr("Советую разрешить: правка обратима", "I’d allow it: the edit can be undone"), lean: "allow" as const }
          : { advice: tr("Советую сначала посмотреть правку: прежнюю версию не вернуть", "I’d look at the edit first: the previous version can’t be restored"), lean: "look" as const };
  const parts = tool === "MultiEdit" ? ((input.edits as { old_string: string; new_string: string }[]) ?? []) : tool === "Edit" ? [{ old_string: String(input.old_string ?? ""), new_string: String(input.new_string ?? "") }] : [];
  const diff = parts.flatMap((e) => [...e.old_string.split("\n").map((l) => `- ${l}`), ...e.new_string.split("\n").map((l) => `+ ${l}`), ""]);
  const body = String(input.content ?? input.new_source ?? "");
  const shown = diff.length ? `${tr("Правка", "Edit")}:\n${fence(clip(diff.join("\n").trimEnd(), 3000))}` : `${tr("Новый текст", "New text")}:\n${fence(clip(body.split("\n").slice(0, 30).join("\n"), 3000))}`;
  // короткую правку в одну строку видно сразу: текст без разметки, «было» → «стало»
  const text = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const one = parts.length === 1 && !parts[0].old_string.includes("\n") && !parts[0].new_string.includes("\n") ? parts[0] : undefined;
  const lines = diff.filter((l) => l).length;
  const inline =
    one && text(one.old_string) !== text(one.new_string) && text(one.old_string).length <= 60 && text(one.new_string).length <= 60
      ? [
          text(one.old_string)
            ? tr(`Правка: ${q(text(one.old_string))} станет ${q(text(one.new_string))}`, `Edit: ${q(text(one.old_string))} becomes ${q(text(one.new_string))}`)
            : tr(`Правка: добавится ${q(text(one.new_string))}`, `Edit: adds ${q(text(one.new_string))}`),
        ]
      : parts.length
        ? [tr(`Правка на ${n(lines, "строку", "строки", "строк")}, подробности ниже`, `${en(lines, "line", "lines")} changed, details below`)]
        : [];
  // чужой проект: короткая правка видна целиком — решает владелец (обе кнопки цветные); длинную советую сначала посмотреть
  const advice = foreign && !one
    ? { advice: tr("Советую сначала посмотреть правку: проект ведёт другая сессия", "I’d look at the edit first: another session runs this project"), lean: "look" as const }
    : foreign
      ? { advice: tr("Решите сами: правка простая, но проект ведёт другая сессия", "Your call: the edit is simple, but another session runs this project") }
      : pick;
  return {
    head,
    lines: [...(foreign ? [tr(`Просит ${who} из проекта ${q(own.name)}`, `Requested by ${who} from project ${q(own.name)}`)] : []), ...inline, back],
    ...advice,
    details: [shown, `${tr("Файл", "File")}: ${mdEsc(tilde(path))}`],
  };
}

// ── всё остальное: словами самой сессии или по главной команде ─────────────────

const INTERP = /^(python3?|node|bun|deno|tsx|ruby|perl|osascript)$/;

function verbOf(t: string[]): string {
  const cmd = basename(t[0] ?? "");
  const arg = t.slice(1).find((x) => !x.startsWith("-"));
  const url = t.find((x) => /^https?:\/\/[\w.-]+/.test(x))?.replace(/^https?:\/\//, "").split(/[/?#]/)[0];
  if (INTERP.test(cmd)) return arg && /\.\w+$/.test(arg) ? tr(`Запустить скрипт ${mdEsc(basename(arg))}`, `Run script ${mdEsc(basename(arg))}`) : tr("Запустить скрипт", "Run a script");
  if (/^(bash|sh|zsh)$/.test(cmd)) return arg ? tr(`Запустить скрипт ${mdEsc(basename(arg))}`, `Run script ${mdEsc(basename(arg))}`) : tr("Выполнить команды оболочки", "Run shell commands");
  if (/^(curl|wget|http|xh)$/.test(cmd)) return url ? tr(`Обратиться к ${mdEsc(url)}`, `Send a request to ${mdEsc(url)}`) : tr("Обратиться в сеть", "Send a request to the internet");
  if (cmd === "open") return url ? tr(`Открыть ${mdEsc(url)} на Mac`, `Open ${mdEsc(url)} on the Mac`) : tr("Открыть на Mac", "Open something on the Mac");
  if (cmd === "claude") return tr("Управлять сессиями Claude", "Manage Claude sessions");
  if (cmd === "gh") return tr("Изменить данные на GitHub", "Change data on GitHub");
  return tr("Выполнить команду", "Run a command");
}

// Чем именно опасен код, по тем же словам, что ищет шлагбаум: так владельцу понятнее, чем общий перечень
function codeRisk(command: string): string {
  const has = (re: RegExp) => re.test(command);
  // те же вызовы, на которые срабатывает шлагбаум (CODE_DELETES и CODE_OWNER_DEEDS в policy.ts), а не слова: иначе строка «может менять
  // файлы» стояла бы рядом с «ничего не меняя»
  const files = [
    has(/\b(unlink|rmtree|rmSync|rimraf|unlinkSync|removedirs)\b|\bos\.(remove|rmdir)\b|\.unlink\(/) && tr("удалять", "delete"),
    has(/\bopen\([^()]*,\s*(mode\s*=\s*)?["'][^"']*[wax+]|\b(writeFile|appendFile|writeFileSync|createWriteStream)\b|\bBun\.write\b|\.(write_text|write_bytes)\(|\bshutil\.(move|copy\w*)|\bFile\.(write|delete)/) && tr("менять", "change"),
  ]
    .filter(Boolean)
    .join(tr(" и ", " and "));
  const found = [
    files && tr(`${files} файлы`, `${files} files`),
    has(/\bsubprocess\b|child_process|\bexecSync\b|\bspawn(Sync)?\(|\bos\.(system|popen|exec\w*)|\bBun\.spawn/) && tr("запускать другие программы", "run other programs"),
    has(/\burlopen\(|\brequests\.\w+\(|\bfetch\(|\bhttp\.client|\bsocket\b|\bsmtplib\b/) && tr("выходить в интернет", "go online"),
  ].filter(Boolean) as string[];
  const all = found.length > 1 ? `${found.slice(0, -1).join(", ")} ${tr("и", "and")} ${found.at(-1)}` : found[0];
  return found.length ? tr(`Скрипт может ${all}`, `The script can ${all}`) : "";
}

// Причина шлагбаума словами владельца — для «Подробнее»; удаление и так видно из первой строки.
const HUMAN: [RegExp, string][] = [
  [/^push в main — это выкладка$/, "отправка в основную ветку сразу выкладывает сайт"],
  [/^gh pr merge — выкладка или запуск конвейера$/, "в основную версию — только с вашего слова: у сайта это выкладка"],
  [/^gh (workflow|run) \w+ — выкладка или запуск конвейера$/, "ручной запуск конвейера GitHub"],
  [/^push с перезаписью или удалением на GitHub$/, "перезапись или удаление на GitHub"],
  [/^push всех веток или тегов — может запустить выкладку$/, "уходят все ветки сразу — среди них может быть выкладка"],
  [/^git-алиас может скрывать push или удаление$/, "за сокращённой командой может скрываться отправка на GitHub или удаление"],
  [/^жёсткий сброс main$/, "несохранённые правки основной версии на Mac пропадут"],
  [/^запись через GitHub API$/, "изменение данных на GitHub"],
  [/^исполнение потока в оболочке — что именно, не видно$/, "команда выполняет текст, которого заранее не видно"],
  [/^запрос в связку ключей без имени службы/, "запрос пароля из связки ключей без точного имени может выдать секреты архитектора"],
  [/^перемещение файла с возможной перезаписью$/, "перенос может затереть другой файл"],
  [/^рекурсивная смена прав$/, "меняются права доступа у всех файлов папки"],
  [/^запрос наружу с подстановкой данных$/, "в запрос в интернет подставляются данные с Mac"],
  [/^установка расписания без надзора$/, "задача будет запускаться по расписанию без присмотра"],
  [/^(перезапись|дописывание) служебного файла$/, "меняется служебный файл: ключи, настройки оболочки или программ"],
  [/^запись в папку архитектора$/, "запись в папку самого бота"],
  [/^удаление файлов из кода$/, "скрипт удаляет файлы"],
  [/^удаление содержимого файла$/, "файл станет пустым"],
  [/^код запускает удаление, push, выкладку или письмо$/, "скрипт удаляет файлы, отправляет на GitHub, выкладывает или пишет людям"],
  [/^удаление через mv$/, "удаление через перенос"],
];
// По-английски — и те причины, что по-русски видны как есть. Сами причины шлагбаума остаются русскими: их читают и сессии.
const REASONS_EN: [RegExp, string][] = [
  [/^push в main — это выкладка$/, "pushing to the main branch deploys the site right away"],
  [/^gh pr merge — выкладка или запуск конвейера$/, "the main version changes only on your word: for a site, that’s a deploy"],
  [/^gh (workflow|run) \w+ — выкладка или запуск конвейера$/, "starting a GitHub pipeline by hand"],
  [/^push с перезаписью или удалением на GitHub$/, "overwriting or deleting on GitHub"],
  [/^push всех веток или тегов — может запустить выкладку$/, "all branches go at once — one of them may be a deploy"],
  [/^git-алиас может скрывать push или удаление$/, "a shortcut command may hide a push to GitHub or a deletion"],
  [/^жёсткий сброс main$/, "unsaved changes to the main version on the Mac will be lost"],
  [/^запись через GitHub API$/, "changing data on GitHub"],
  [/^исполнение потока в оболочке — что именно, не видно$/, "the command runs text that can’t be seen in advance"],
  [/^запрос в связку ключей без имени службы.*$/, "asking the keychain for a password without an exact name may return the architect’s secrets"],
  [/^перемещение файла с возможной перезаписью$/, "the move may overwrite another file"],
  [/^рекурсивная смена прав$/, "access rights change for every file in the folder"],
  [/^запрос наружу с подстановкой данных$/, "data from the Mac goes into an internet request"],
  [/^установка расписания без надзора$/, "the task will run on a schedule, unattended"],
  [/^(перезапись|дописывание) служебного файла$/, "a system file changes: keys, shell or app settings"],
  [/^запись в папку архитектора$/, "writing into the bot’s own folder"],
  [/^удаление файлов из кода$/, "the script deletes files"],
  [/^удаление содержимого файла$/, "the file will be emptied"],
  [/^код запускает удаление, push, выкладку или письмо$/, "the script deletes files, pushes to GitHub, deploys or writes to people"],
  [/^удаление через mv$/, "deleting by moving"],
  [/^git (\S+) — неизвестная подкоманда \(алиас\?\)$/, "git $1 is an unknown command (an alias?)"],
  [/^удаление ветки$/, "deleting a branch"],
  [/^удаление тега$/, "deleting a tag"],
  [/^git clean удаляет файлы без возврата$/, "git clean deletes files for good"],
  [/^gh release (\S+) — выпуск$/, "gh release $1: a release"],
  [/^gh repo (\S+) — меняет репозитории$/, "gh repo $1 changes repositories"],
  [/^gh (\S+ \S+) — секреты и переменные GitHub$/, "gh $1: GitHub secrets and variables"],
  [/^отправка файла с Mac наружу$/, "a file from the Mac goes out"],
  [/^выкладка или удаление в Google Cloud$/, "a deploy or deletion in Google Cloud"],
  [/^выкладка через (.+)$/, "a deploy via $1"],
  [/^публикация образа Docker$/, "publishing a Docker image"],
  [/^изменение инфраструктуры$/, "an infrastructure change"],
  [/^изменение кластера$/, "a cluster change"],
  [/^запись в облачное хранилище$/, "writing to cloud storage"],
  [/^изменение в AWS$/, "a change in AWS"],
  [/^создание ресурсов в AWS — это траты$/, "creating resources in AWS costs money"],
  [/^имя записи связки ключей подставляется командой — может скрывать токен архитектора$/, "the keychain entry name is built by a command — it may hide the architect’s token"],
  [/^перезапись файла$/, "overwriting a file"],
  [/^удаление из связки ключей$/, "deleting from the keychain"],
  [/^скрипт выкладки$/, "a deploy script"],
  [/^удаление файлов$/, "deleting files"],
  [/^выкладка$/, "a deploy"],
  [/^публикация пакета$/, "publishing a package"],
  [/^письмо или сообщение людям$/, "an email or message to people"],
  [/^письмо людям$/, "an email to people"],
  [/^сообщение людям через приложение Mac$/, "a message to people through a Mac app"],
  [/^трата денег \(Rapidata\)$/, "spending money (Rapidata)"],
  [/^трата денег$/, "spending money"],
  [/^удаление через инструмент$/, "deleting through a tool"],
  [/^claude (\S+) — вмешательство в сессии$/, "claude $1 interferes with sessions"],
  [/^остановка всех фоновых сессий$/, "stopping all background sessions"],
  [/^массовая остановка процессов$/, "stopping many processes at once"],
  [/^остановка служб macOS$/, "stopping macOS services"],
  [/^управление архитектором$/, "managing the architect"],
  [/^секреты архитектора$/, "the architect’s secrets"],
  [/^опасная операция с машиной$/, "a risky operation on the machine"],
];
const reasonEn = (reason: string) => {
  const hit = REASONS_EN.find(([re]) => re.test(reason));
  return hit ? reason.replace(hit[0], hit[1]) : reason;
};
const human = (reason: string) => tr(HUMAN.find(([re]) => re.test(reason))?.[1] ?? reason, reasonEn(reason));
const OBVIOUS = /^(удаление файлов|удаление ветки|git clean удаляет файлы без возврата)$/;

const ctxFor = (cwd: string): PolicyContext => ({ cwd, archHome: ARCH_HOME, hostingPattern: config.hostingPattern, keychainService: config.keychainService, branch: gitBranchSync });

// Главная команда цепочки — та, из-за которой шлагбаум спрашивает; её папка — с учётом cd и git -C.
function pick(command: string, cwd: string): { t: string[]; cwd: string; v: Verdict } {
  const rank = { ok: 0, ask: 1, deny: 2 } as const;
  let dir = cwd;
  let best: { t: string[]; cwd: string; v: Verdict } | undefined;
  for (const t0 of parseShell(command).commands) {
    const t = stripPrefixes(t0.filter((x) => !x.startsWith("\u0000"))); // без sudo, VAR=1, перенаправлений и heredoc
    if (!t.length) continue;
    if (t[0] === "cd" && t[1]) {
      dir = resolve(dir, t[1].replace(/^~(?=\/|$)/, HOME));
      continue;
    }
    const v = classifyCommand(t0, ctxFor(dir));
    if (!best || rank[v.decision] > rank[best.v.decision]) best = { t, cwd: t[0] === "git" && t[1] === "-C" && t[2] ? resolve(dir, t[2]) : dir, v };
  }
  return best ?? { t: [], cwd, v: { decision: "ok", reason: "" } };
}

async function bash(input: Record<string, unknown>, cwd: string, shots: number, worker: boolean, who: string): Promise<Brief> {
  const command = String(input.command ?? "");
  const { t, cwd: dir, v } = pick(command, cwd);
  const cmd = basename(t[0] ?? "");
  const g = cmd === "git" ? t.slice(1).filter((x, k, a) => !(x === "-C" || a[k - 1] === "-C" || x === "-c" || a[k - 1] === "-c")) : [];
  if (g[0] === "push") return gitPush(g.slice(1), dir, shots, worker, String(input.description ?? "").trim().replace(/\.$/, ""));
  if (cmd === "gh" && t[1] === "pr" && t[2] === "merge") return prMerge(t.slice(3), dir, shots, worker);
  if (/^(rm|rmdir|unlink|trash|srm|shred)$/.test(cmd)) {
    const steps = parseShell(command).commands.map((c) => stripPrefixes(c.filter((x) => !x.startsWith("\u0000")))).filter((c) => c.length && c[0] !== "cd").length;
    return removal(t.slice(1).filter((x) => !x.startsWith("-")), dir, steps > 1 ? String(input.description ?? "").trim().replace(/\.$/, "") : undefined);
  }
  const p = await project(dir);
  if (g[0] === "clean") {
    // что удалит git clean, показывает он сам в режиме «только показать» (-n)
    const flags = g.slice(1).map((a) => (/^-[a-z]+$/i.test(a) ? a.replace(/f/g, "") : a)).filter((a) => a !== "-" && a !== "--force");
    const gone = (await git(dir, "clean", "-n", ...flags)).split("\n").filter(Boolean).map((l) => l.replace(/^Would remove /, ""));
    return {
      head: tr(`Удалить ${files(gone.length)} ${inProj(p)}`, `Delete ${files(gone.length)} ${inProj(p)}`),
      lines: [tr("Вернуть нельзя: этих файлов нет в истории проекта", "Can’t be undone: these files aren’t in the project history")],
      advice: gone.length ? tr("Советую сначала посмотреть список ниже", "I’d check the list below first") : tr("Можно разрешить: удалять нечего", "Safe to allow: nothing to delete"),
      lean: gone.length ? "look" : "allow",
      details: gone.length ? [`${tr("Что удалится", "What gets deleted")}:\n${list(gone, 40)}`] : [],
    };
  }
  if (/выкладк|выпуск|конвейер/.test(v.reason))
    return {
      head: p.site ? tr(`Выложить ${q(p.site.name)}`, `Deploy ${q(p.site.name)}`) : tr(`Запустить выкладку ${inProj(p)}`, `Start a deploy ${inProj(p)}`),
      lines: [...(p.site ? [tr(`Обновится ${host(p.site)}`, `Goes live on ${host(p.site)}`)] : []), p.site ? BACK_SITE() : BACK_REPO()],
      ...(!p.site ? { advice: tr("Решите сами: что именно уйдёт, проверить я не могу", "Your call: I can’t check what exactly goes out") } : deployAdvice({ state: "none" }, shots, worker, true)),
      deploy: !!p.site,
    };
  const desc = String(input.description ?? "").trim().replace(/\.$/, "");
  const mine = who === tr("архитектор", "the architect");
  const where = p.name === ARCH() && dir === ARCH_HOME ? tr(" в папке архитектора", " in the architect’s folder") : ` ${inProj(p)}`;
  const why = v.reason
    ? (/^(удаление файлов из кода|код запускает)/.test(v.reason) && codeRisk(command)) || tr(`Почему спрашиваю: ${mdEsc(human(v.reason))}`, `Why I’m asking: ${mdEsc(human(v.reason))}`)
    : tr("Сама команда — в «Подробнее»", "The command itself is under “Details”");
  if (!v.reason) return { head: isRu(desc) ? cap(mdEsc(asAsk(desc))) : `${verbOf(t)}${where}`, lines: [why], advice: tr("Советую разрешить: опасного тут не вижу", "I’d allow it: I see nothing risky here"), lean: "allow" };
  if (isRu(desc)) {
    // описание сессии: первая мысль — жирной строкой, продолжение — обычной. Короткое не режем по тире,
    // «ничего не меняя» не пишем, совета без основания не даём
    const plain = desc.replace(tr(/,?\s*(ничего не меняя|ничего не меняется|владельцу ничего не уходит)(?![\p{L}])/giu, /,?\s*(without changing anything|nothing changes|changes nothing|read-only)(?![\p{L}])/giu), "").trim();
    const [first, ...rest] = plain.length <= 70 ? [plain] : plain.split(/\s+[—–-]\s+|;\s+/);
    return {
      head: cap(mdEsc(asAsk(first))),
      lines: [...(rest.length ? [cap(mdEsc(rest.join(", ")))] : []), why],
      advice: "",
    };
  }
  return {
    head: `${verbOf(t)}${where}`,
    lines: [why],
    advice: mine
      ? tr("Советую сначала узнать, что делает скрипт: опишу его словами и спрошу снова", "I’d find out what the script does first: I’ll describe it in plain words and ask again")
      : tr("Советую сначала узнать, что делает скрипт: сессия опишет его словами и спросит снова", "I’d find out what the script does first: the session will describe it in plain words and ask again"),
    lean: "look",
    more: EXPLAIN(),
  };
}

// MCP: письма, траты, удаление через инструменты
function mcp(tool: string, input: Record<string, unknown>, v: Verdict): Brief | undefined {
  if (!v.reason) return;
  const server = (tool.split("__")[1] ?? tool).replace(/^claude_ai_/, "").replace(/_/g, " "); // mcp__claude_ai_Gmail__… → Gmail
  if (/письмо|сообщение/.test(v.reason)) {
    const to = String(input.to ?? input.recipient ?? input.recipients ?? input.channel ?? input.chat_id ?? "");
    const subj = String(input.subject ?? input.title ?? "");
    return {
      head: tr(`Отправить ${/mail/i.test(tool) ? "письмо" : "сообщение"}${to ? ` ${mdEsc(clip(to, 60))}` : ""}`, `Send ${/mail/i.test(tool) ? "an email" : "a message"}${to ? ` to ${mdEsc(clip(to, 60))}` : ""}`),
      lines: [...(subj ? [`${tr("Тема", "Subject")}: ${mdEsc(clip(subj, 80))}`] : []), tr("Вернуть нельзя: уйдёт сразу", "Can’t be undone: it goes out right away")],
      advice: tr("Решите сами: письма людям — только с вашего слова", "Your call: messages to people go out only on your word"),
      details: [`${tr("Текст", "Text")}:\n${fence(clip(String(input.body ?? input.text ?? input.message ?? input.content ?? ""), 3000))}`],
    };
  }
  if (/трат/.test(v.reason))
    return { head: tr(`Потратить деньги через ${mdEsc(server)}`, `Spend money via ${mdEsc(server)}`), lines: [tr("Вернуть нельзя", "Can’t be undone")], advice: tr("Решите сами: траты — только с вашего слова", "Your call: money is spent only on your word") };
  return { head: tr(`${cap(v.reason.replace(/ через инструмент$/, ""))} через ${mdEsc(server)}`, `${cap(reasonEn(v.reason))} (${mdEsc(server)})`), lines: [], advice: tr("Советую сначала посмотреть подробности ниже", "I’d look at the details below first"), lean: "look" };
}

// Бриф для запроса разрешения. undefined — инструмент не наш (свои инструменты архитектора: там действие уже словами).
// shots — сколько снимков кандидата сделала сессия; worker — своя рабочая сессия (её можно попросить снять кандидата).
// inTopic — запрос придёт в тему самой сессии: кто просит, видно и так; иначе это строка на виду.
export async function decisionBrief(o: { tool: string; input: Record<string, unknown>; cwd: string; source: string; shots?: number; worker?: boolean; inTopic?: boolean }): Promise<Brief | undefined> {
  const shots = o.shots ?? 0;
  const v = classifyTool(o.tool, o.input, ctxFor(o.cwd));
  const who = o.source === "Архитектор" ? tr("архитектор", "the architect") : tr(`сессия ${sessionName(o.source)}`.trim(), sessionName(o.source));
  let b: Brief | undefined;
  if (o.tool === "Bash") b = await bash(o.input, o.cwd, shots, !!o.worker, who);
  else if (FILE_TOOLS.includes(o.tool)) b = await fileEdit(o.tool, o.input, o.cwd, who);
  else if (o.tool.startsWith("mcp__") && !o.tool.startsWith("mcp__arch__")) b = mcp(o.tool, o.input, v);
  if (!b) return;
  if (b.more?.label === SHOTS().label && !o.worker) b.more = undefined;
  const said = (s: string) => b!.lines.some((l) => l.includes(s));
  const asks = tr("Просит", "Requested by");
  const why = tr("Почему спрашиваю", "Why I’m asking");
  if (o.source !== "Архитектор" && !o.inTopic && !said(asks)) b.lines.push(`${asks} ${who}`);
  b.details = [
    ...(b.details ?? []),
    said(asks) ? `${tr("Папка сессии", "Session folder")}: ${mdEsc(tilde(o.cwd))}` : `${asks} ${who}, ${tr("папка", "folder")} ${mdEsc(tilde(o.cwd))}`,
    ...(v.reason && !OBVIOUS.test(v.reason) && !said(why) && !said(tr("Скрипт может", "The script can")) ? [`${why}: ${mdEsc(human(v.reason))}`] : []),
    ...(o.tool === "Bash" ? [`${tr("Команда", "Command")}:\n${fence(clip(String(o.input.command ?? ""), 2500))}`] : FILE_TOOLS.includes(o.tool) ? [] : [fence(clip(JSON.stringify(o.input, null, 1), 2500))]),
  ];
  return b;
}
