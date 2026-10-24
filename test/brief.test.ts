// Бриф решения: что видит владелец вместо сырой команды. Настоящие временные репозитории git; gh — подставной скрипт, сеть не нужна.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "arch-brief-"));
mkdirSync(join(root, "bin"));
// подставной gh: правка №14 с зелёной автопроверкой; прогонов по коммитам нет (с FAKE_RUNS — есть, с номерами версий)
writeFileSync(
  join(root, "bin", "gh"),
  `#!/bin/sh
case "$*" in
  *"run list"*)
    if [ -n "$FAKE_RUNS" ]; then
      sha=$(echo "$*" | sed -E 's/.*--commit ([0-9a-f]+).*/\\1/')
      printf '[{"workflowName":"CI","status":"completed","conclusion":"failure","headSha":"0000000","createdAt":"2026-10-19T09:00:00Z"},{"workflowName":"CI","status":"completed","conclusion":"failure","headSha":"%s","createdAt":"2026-10-19T07:00:00Z"},{"workflowName":"CI","status":"completed","conclusion":"success","headSha":"%s","createdAt":"2026-10-19T08:00:00Z"}]' "$sha" "$sha"
    else echo '[]'; fi ;;
  *"pr view"*) echo '{"number":14,"title":"Новая шапка","headRefName":"header","baseRefName":"main","changedFiles":2,"isDraft":false,"statusCheckRollup":[{"name":"tests","status":"COMPLETED","conclusion":"SUCCESS"}],"commits":[{"messageHeadline":"Шапка: новый логотип"},{"messageHeadline":"Fix spacing"}],"files":[{"path":"src/Header.tsx"},{"path":"src/header.css"}]}' ;;
  *) echo '[]' ;;
esac
`,
  { mode: 0o755 },
);
process.env.PATH = `${join(root, "bin")}:${process.env.PATH}`;
const { asAsk, decisionBrief, sessionName } = await import("../src/brief");

const git = (cwd: string, ...a: string[]) => {
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
};
function repo(name: string, origin: string, files: Record<string, string>) {
  const dir = join(root, name);
  mkdirSync(dir);
  git(dir, "init", "-q");
  git(dir, "remote", "add", "origin", `https://github.com/acme/${origin}.git`);
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  return dir;
}
const commit = (dir: string, f: string, body: string, msg: string) => {
  writeFileSync(join(dir, f), body);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
};

let beacon = "";
let home = "";
let lab = "";
beforeAll(() => {
  beacon = repo("beacon", "beacon", { "index.html": "<h1>Маяк</h1>\n", "src/OldHeader.tsx": "export const OldHeader = 1;\n", "src/Footer.tsx": "export const Footer = 1;\n", "src/App.tsx": "import { Footer } from './Footer';\n" });
  commit(beacon, "index.html", "<h1>Маяк ИИ</h1>\n", "Keep the flag on the country line");
  commit(beacon, "index.html", "<h1>Маяк ИИ 2026</h1>\n", "Заголовок: год в шапке");
  home = repo("home", "home", { "index.html": "<p>Acme</p>\n" });
  lab = repo("lab", "landing-lab", { "a.txt": "a\n" });
});

const bash = (command: string, cwd: string, o: { shots?: number; worker?: boolean; description?: string; source?: string; inTopic?: boolean } = {}) =>
  decisionBrief({ tool: "Bash", input: { command, description: o.description ?? "Do something" }, cwd, source: o.source ?? "«Шапка Маяка», beacon", shots: o.shots, worker: o.worker, inTopic: o.inTopic ?? true }); // по умолчанию — в теме сессии: кто просит, видно и так
const visible = (b: any) => [b.head, ...b.lines, b.advice].join("\n");

describe("выкладка", () => {
  test("push в main сайта: что, где, что изменится, откат; совет по снимкам выше; команда — только под «Подробнее»", async () => {
    const b = (await bash("git push origin main", beacon, { shots: 2, worker: true }))!;
    expect(b.head).toBe("Выложить Маяк"); // короткое действие первой строкой, что меняется — второй
    expect(b.lines).toEqual(["Заголовок — год в шапке и ещё 1 правка", "Обновится beacon.example.com", "Прежнюю версию можно вернуть"]);
    expect(b.advice).toBe("Советую разрешить, если снимки выше устраивают: автопроверок не было");
    expect(b.lean).toBe("allow");
    expect(b.deploy).toBe(true);
    expect(visible(b)).not.toMatch(/git|main|push/);
    const more = b.details!.join("\n");
    expect(more).toContain("Keep the flag on the country line"); // все правки — под «Подробнее»
    expect(more).toContain("git push origin main");
  });

  test("снимков нет, сессия своя — совет сначала посмотреть и кнопка «Сначала покажи» просит её снять кандидата", async () => {
    const b = (await bash("cd src && git push origin HEAD:main", beacon, { worker: true }))!;
    expect(b.head).toBe("Выложить Маяк"); // короткое действие первой строкой, что меняется — второй
    expect(b.advice).toBe("Советую сначала посмотреть: снимков новой версии нет, автопроверок не было");
    expect(b.lean).toBe("look");
    expect(b.more?.label).toBe("Сначала покажи");
    expect(b.more?.tell).toContain("$CLAUDE_JOB_DIR/tmp/evidence");
  });

  test("чужая сессия без снимков — без кнопки съёмки: снять кандидата её не попросить", async () => {
    const b = (await bash("git push origin main", beacon))!;
    expect(b.more).toBeUndefined();
    expect(b.advice).toBe("Решите сами: снимков новой версии нет, автопроверок не было");
  });

  test("перезапись основной версии — не советую", async () => {
    const b = (await bash("git push --force origin main", beacon, { shots: 2 }))!;
    expect(b.advice).toBe("Не советую: это необратимо");
    expect(b.lean).toBe("reject");
  });

  test("слияние правки в main сайта: автопроверка прошла, снимков нет", async () => {
    const b = (await bash("gh pr merge 14 --squash --delete-branch", beacon, { worker: true }))!;
    expect(b.head).toBe("Выложить Маяк");
    expect(b.lines).toEqual(["Шапка — новый логотип и ещё 1 правка", "Обновится beacon.example.com", "Прежнюю версию можно вернуть"]);
    expect(b.advice).toBe("Советую сначала посмотреть: автопроверка прошла, но снимков новой версии ещё нет");
    expect(b.details!.join("\n")).toContain("src/Header.tsx");
  });

  // у репозитория без сайта слияние выкладку не запускает — «Подробнее» не должно говорить обратное
  test("слияние в main репозитория без сайта — сколько правок и что сайты не изменятся", async () => {
    const b = (await bash("gh pr merge 14 --merge", lab))!;
    expect(b.head.replace(/\s/g, " ")).toBe("Влить 2 правки в основную версию в проекте «landing-lab»");
    expect(b.lines).toContain("Сайты не изменятся");
    expect(b.details!.join("\n")).not.toContain("запускает выкладку");
  });

  test("слияние в обход автопроверки — не советую", async () => {
    expect((await bash("gh pr merge 14 --admin --squash", beacon, { shots: 2 }))!.advice).toBe("Не советую: слияние в обход автопроверки");
  });

  test("push в ветку — не выкладка", async () => {
    const b = (await bash("git push -u origin feature/header", lab))!;
    expect(b.head).toBe("Отправить правки проекта «landing-lab» на GitHub");
    expect(b.lines).toEqual(["В ветку feature/header"]);
    expect(b.advice).toBe("Советую разрешить: основная версия от этого не изменится");
    expect(b.deploy).toBeFalsy();
    expect(b.noop).toBeFalsy(); // ветки на GitHub ещё нет — появится новая
  });

  test("push в ветку словами сессии: её описание — первой строкой, ветка не повторяется", async () => {
    const b = (await bash("git push origin review-1", lab, { description: "Отправить правки отчёта в ветку review-1" }))!;
    expect(b.head).toBe("Отправить правки отчёта в ветку review-1");
    expect(b.lines).toEqual([]);
  });

  test("push в ветку, где всё уже есть, — ничего не меняется, владельца не спрашиваем; в main — спрашиваем всегда", async () => {
    git(lab, "update-ref", "refs/remotes/origin/feature/done", "HEAD");
    expect((await bash("git push origin HEAD:feature/done", lab))!.noop).toBe(true);
    const m = (await bash("git push origin HEAD:main", lab))!;
    expect(m.noop).toBeFalsy();
    expect(m.lines).toEqual(["Новых правок нет — ничего не изменится"]);
  });

  test("не репозиторий: про правки молчим — «новых правок нет» было бы неправдой", async () => {
    const b = (await bash("git push origin review-1", root))!;
    expect(visible(b)).not.toContain("Новых правок нет");
    expect(b.noop).toBeFalsy();
  });

  test("совет к выкладке — только по проверке уходящей версии: чужой и старый упавшие прогоны не в счёт", async () => {
    process.env.FAKE_RUNS = "1";
    try {
      const b = (await bash("git push origin main", beacon, { shots: 2, worker: true }))!;
      expect(b.advice).toBe("Советую разрешить: автопроверка прошла, снимки выше");
      expect(b.lean).toBe("allow");
    } finally {
      delete process.env.FAKE_RUNS;
    }
  });

  test("кто просит — на виду, когда запрос не в теме самой сессии", async () => {
    const b = (await bash("git push origin main", beacon, { shots: 2, inTopic: false }))!;
    expect(b.lines.at(-1)).toBe("Просит сессия «Шапка Маяка»");
    expect(b.details!.join("\n")).not.toContain("Просит"); // в «Подробнее» — уже только папка
  });
});

describe("удаление", () => {
  test("файл в истории проекта, ссылок нет — советую разрешить", async () => {
    const b = (await bash("rm src/OldHeader.tsx", beacon))!;
    expect(b.rule).toEqual({ kind: "delete", project: "Маяк" }); // вернётся из истории — можно правилом «без вопросов»
    expect(b.head).toBe("Удалить файл «OldHeader» в проекте «Маяк»");
    expect(b.lines).toEqual(["Можно вернуть из истории проекта"]);
    expect(b.advice).toBe("Советую разрешить: в проекте на него никто не ссылается");
    expect(b.details!.join("\n")).toContain("Искал «OldHeader» по проекту: упоминаний нет, кроме самого файла");
  });

  test("на файл ещё ссылаются — не советую, кто ссылается — под «Подробнее»", async () => {
    const b = (await bash("rm -f src/Footer.tsx", beacon))!;
    expect(b.advice).toBe("Не советую: на него ещё ссылаются 1 файл");
    expect(b.lean).toBe("reject");
    expect(b.details!.join("\n")).toContain("src/App.tsx");
  });

  // «вернуть можно не всё» — неправда, когда в истории нет ни одного из файлов
  test("несколько файлов: ни одного нет в истории — «вернуть нельзя»; часть — сколько именно", async () => {
    mkdirSync(join(beacon, "renders"), { recursive: true });
    for (const f of ["a.mkv", "b.mkv"]) writeFileSync(join(beacon, "renders", f), "x");
    const none = (await bash("rm renders/a.mkv renders/b.mkv", beacon))!;
    expect(none.head.replace(/\s/g, " ")).toBe("Удалить 2 файла в проекте «Маяк»");
    expect(none.lines).toEqual(["Что: «a.mkv», «b.mkv» в renders", "Вернуть нельзя: этих файлов нет в истории проекта"]);
    const some = (await bash("rm renders/a.mkv src/App.tsx", beacon))!;
    expect(some.lines).toEqual(["Что: «a.mkv», «App.tsx»", "Вернуть можно не всё: в истории проекта нет 1 из 2"]);
  });

  // команда идёт из папки архитектора, а удаляет файлы другого проекта: проект — по удаляемому; где это и сколько места освободится
  test("удаление в другом проекте: его имя, что и где удаляется, сколько места освободится", async () => {
    const blog = join(root, "blog");
    mkdirSync(blog);
    git(blog, "init", "-q");
    writeFileSync(join(blog, "README.md"), "блог\n");
    git(blog, "add", "-A");
    git(blog, "commit", "-q", "-m", "base");
    for (const d of ["gens/g1/intro/proof/r1/chunk", "gens/g1/outro/proof-r1/samples"]) {
      mkdirSync(join(blog, d), { recursive: true });
      for (const f of ["a.mp4", "b.mp4"]) writeFileSync(join(blog, d, f), Buffer.alloc(700_000));
    }
    const cmd = `rm -rf "${join(blog, "gens/g1/intro/proof/r1/chunk")}" "${join(blog, "gens/g1/outro/proof-r1/samples")}"`;
    const b = (await bash(cmd, home, { source: "Архитектор" }))!;
    expect(b.head.replace(/\s/g, " ")).toBe("Удалить 4 файла в проекте «blog»");
    expect(b.lines).toEqual(["Что: «chunk», «samples» в gens/g1", "Освободится 3 МБ", "Вернуть нельзя: этих файлов нет в истории проекта"]);
  });

  // команда правит стили через sed -i и пересобирает сайт — «Удалять нечего… ничего не изменится» было бы неправдой
  test("удалять нечего, но в команде есть другие шаги — без «ничего не изменится» и без совета", async () => {
    const b = (await decisionBrief({ tool: "Bash", input: { command: "sed -i '' 's/a/b/' slides.css && npm run build && rm -rf slides-old", description: "Правлю стили слайдов и пересобираю сайт" }, cwd: beacon, source: "«Регламенты», beacon" }))!;
    expect(b.head).toBe("Поправить стили слайдов и пересобрать сайт"); // описание сессии — от первого лица, заголовок — что разрешить
    expect(b.lines.slice(0, 2)).toEqual(["Удалять пока нечего: этих файлов сейчас нет", "Остальные шаги команды — в «Подробнее»"]);
    expect(b.advice).toBe("");
  });

  test("файла нет в истории проекта — откатить нельзя", async () => {
    writeFileSync(join(beacon, "notes.txt"), "черновик\n");
    const b = (await bash("rm notes.txt", beacon))!;
    expect(b.lines).toEqual(["Вернуть нельзя: файла нет в истории проекта"]);
    expect(b.rule).toBeUndefined(); // невосстановимое — всегда вопросом, правило его не разрешит
    expect(b.advice).toBe("Советую сначала посмотреть, что удаляется: список ниже");
    expect(b.details!.join("\n")).toContain("черновик");
  });
});

describe("правка файлов и прочее", () => {
  test("главная страница чужого проекта", async () => {
    const b = (await decisionBrief({ tool: "Edit", input: { file_path: join(home, "index.html"), old_string: "Acme", new_string: "ACME" }, cwd: beacon, source: "«Шапка Маяка», beacon" }))!;
    expect(b.head).toBe("Изменить главную страницу проекта «Главная»");
    expect(b.lines).toEqual(["Просит сессия «Шапка Маяка» из проекта «Маяк»", "Правка: «Acme» станет «ACME»", "Прежнюю версию можно вернуть"]);
    expect(b.advice).toBe("Решите сами: правка простая, но проект ведёт другая сессия");
    expect(b.lean).toBeUndefined(); // совета нет — обе кнопки цветные
    expect(b.details!.join("\n")).not.toContain("Просит"); // кто просит — уже на виду
    expect(b.details![0]).toContain("+ ACME");
  });

  test("непонятная команда — чем опасна и кнопка «Сначала объясни»", async () => {
    const b = (await bash(`python3 -c 'import shutil; shutil.rmtree("x")'`, lab))!;
    expect(b.head).toBe("Запустить скрипт в проекте «landing-lab»");
    expect(b.lines).toEqual(["Скрипт может удалять файлы"]); // rmtree удаляет, а не меняет: строка не противоречит делу
    expect(b.more?.label).toBe("Сначала объясни");
    expect(b.more?.tell).toContain("description");
    expect(b.advice).toBe("Советую сначала узнать, что делает скрипт: сессия опишет его словами и спросит снова");
  });

  test("описание сессии по-русски становится первой строкой", async () => {
    const b = (await bash("chmod -R 755 site", lab, { description: "Открыть права на папку сайта", source: "Архитектор" }))!;
    expect(b.head).toBe("Открыть права на папку сайта");
    expect(b.more).toBeUndefined();
    expect(b.advice).toBe(""); // совета без основания нет
    expect(b.details!.join("\n")).toContain("Просит архитектор");
  });

  test("короткое описание сессии — целиком одной строкой, длинное режется по тире; «ничего не меняя» не пишется", async () => {
    const net = `python3 -c 'import shutil, urllib.request; shutil.rmtree("old-cache"); urllib.request.urlopen("https://google.com")'`;
    const b = (await bash(net, lab, { description: "Открыть Google и узнать браузер — настройки не меняются" }))!;
    expect(b.head).toBe("Открыть Google и узнать браузер — настройки не меняются");
    expect(b.lines).toEqual(["Скрипт может удалять файлы и выходить в интернет"]);
    expect(b.advice).toBe("");
    const long = (await bash(net, lab, { description: "Открыть страницу проверки браузера и записать, какой движок и версию она показывает — настройки не меняются" }))!;
    expect(long.head).toBe("Открыть страницу проверки браузера и записать, какой движок и версию она показывает");
    expect(long.lines[0]).toBe("Настройки не меняются");
    const quiet = (await bash(net, lab, { description: "Считаю по GitHub минуты проверок, ничего не меняя" }))!;
    expect(quiet.head).toBe("Считаю по GitHub минуты проверок");
  });

  test("свои инструменты архитектора — без брифа, действие уже словами", async () => {
    expect(await decisionBrief({ tool: "mcp__arch__stop_session", input: { session: "x" }, cwd: lab, source: "Архитектор" })).toBeUndefined();
  });
});

describe("слова владельца", () => {
  test("служебное имя сессии не показываем — вместо него папка", () => {
    expect(sessionName("«Шапка Маяка», мои проекты/beacon")).toBe("«Шапка Маяка»");
    expect(sessionName("«claude-e7», мои проекты/beacon")).toBe("в папке beacon");
    expect(sessionName("«сессия 1a2b3c», мои проекты/beacon")).toBe("в папке beacon");
  });

  test("письмо — имя сервиса без служебной приставки, вернуть нельзя", async () => {
    const b = (await decisionBrief({ tool: "mcp__claude_ai_Gmail__send_email", input: { to: "olga@example.com", subject: "Отчёт", body: "Привет" }, cwd: lab, source: "Архитектор" }))!;
    expect(b.head).toBe("Отправить письмо olga@example.com");
    expect(b.lines).toEqual(["Тема: Отчёт", "Вернуть нельзя: уйдёт сразу"]);
  });
});

// На экране блокировки строки карточки без знака слипаются («Выложить Маяк 3 ссылки… Обновится …»);
// совет — тем же глаголом, что кнопка [Выложить], а не «разрешить»
test("карточка: первая строка — вопрос, строки с точкой, совет тем же глаголом, что кнопка", async () => {
  const { briefMd } = await import("../src/approvals");
  const md = briefMd({ head: "Выложить Маяк", lines: ["3 ссылки «Методики» ведут на новые страницы", "Обновится beacon.example.com"], advice: "Советую разрешить: автопроверка прошла, снимки выше", deploy: true } as any);
  expect(md).toStartWith("**Выложить Маяк?**\n3 ссылки «Методики» ведут на новые страницы.\nОбновится beacon.example.com.\n\nСоветую выложить: автопроверка прошла, снимки выше.");
  expect(briefMd({ head: "Запускаю тесты", lines: [], advice: "Советую разрешить: опасного тут не вижу" } as any)).toBe("**Запускаю тесты.**\n\nСоветую разрешить: опасного тут не вижу.");
  // глагол на «-ться» — тоже просьба: вопросом и с советом тем же глаголом
  expect(briefMd({ head: "Обратиться к example.com", lines: [], advice: "Советую разрешить: адрес из задачи" } as any)).toBe("**Обратиться к example.com?**\n\nСоветую обратиться: адрес из задачи.");
});

// описание сессии от первого лица («Удаляю 17 тысяч сырых снимков…») — ещё не заголовок карточки
test("описание сессии в заголовке карточки — тем, что разрешают: «Удалить …», «Поправить … и пересобрать …»", () => {
  expect(asAsk("Удаляю 17 тысяч сырых снимков старых разборов лендинга (12 ГБ) по списку Онлайн-курса")).toBe("Удалить 17 тысяч сырых снимков старых разборов лендинга (12 ГБ) по списку Онлайн-курса");
  expect(asAsk("Правлю стили, пересобираю сайт и выкладываю")).toBe("Поправить стили, пересобрать сайт и выложить");
  expect(asAsk("Смотрю журнал сессии")).toBe("Смотрю журнал сессии"); // чего нет в словаре — как есть
  expect(asAsk("Удаляю архив и ставлю заново")).toBe("Удалить архив и поставить заново");
});
