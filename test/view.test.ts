// «Пульт» и ответ «что у нас»: страховка от возврата к старому виду — эмодзи, служебные слова, стена текста.
// Хорош ли вид — решают глаза, а не эти проверки.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ARCH_STATE_DIR = mkdtempSync(join(tmpdir(), "arch-view-"));
process.env.ARCH_LOGS_DIR = process.env.ARCH_STATE_DIR;
const { view, render, renderView, limitReset, apiStop, forecast, deadline } = await import("../src/status");
const { deed } = await import("../src/board");
const { clean } = await import("../src/ui");

const EMOJI = /\p{Extended_Pictographic}/u;
const row = (o: Record<string, unknown>) => ({ cwd: "/tmp/нет-такой-папки", kind: "interactive" as const, startedAt: Date.now(), pid: 1, ...o });
const overview = (flags: string[] = []) => ({
  at: 0,
  rows: [
    row({ sessionId: "a", name: "Маяк", status: "waiting", waitingFor: "dialog open" }),
    row({ sessionId: "b", name: "Арена", status: "busy" }),
    row({ sessionId: "c", name: "Регламенты", status: "idle" }),
  ],
  sites: [{ name: "Маяк", url: "", code: 200, ok: true }],
  repos: [],
  machine: { load5: 1, cpus: 10, diskFreeGb: 100 },
  flags,
  limits: { week: 62 },
});

describe("«Пульт» и «что у нас»", () => {
  test("без эмодзи и служебных слов Claude Code", () => {
    const o = overview(["Сайт Маяк не открывается: сервер отвечает ошибкой 502"]);
    for (const md of [render(o), renderView(view(o), true)]) {
      expect(EMOJI.test(md)).toBe(false);
      expect(md).not.toMatch(/dialog open|permission prompt|waiting|busy|claude-[0-9a-f]/);
    }
  });

  test("первая строка — прямой ответ; у «Пульта» — сколько ждут его решения (её видно в полосе закрепа)", () => {
    const o = overview();
    // понятно человеку со стороны: что нужно от него, без числа сессий
    expect(render(o).startsWith("**1 задача ждёт вашего решения:**")).toBe(true);
    expect(renderView(view(o), true).startsWith("**1 задача ждёт вашего решения:**")).toBe(true);
    expect(render({ ...o, rows: [] })).toStartWith("**От вас ничего не нужно**");
    expect(render(o)).toContain("**Маяк** — вопрос на Mac");
    expect(render(o)).toContain("На паузе: Регламенты.");
  });

  test("лимит кончился — никто не «работает»: все на паузе", () => {
    const md = render({ ...overview(), limits: { week: 100 } });
    expect(md).not.toMatch(/Работа/);
    expect(md).toContain("На паузе: Арена, Регламенты.");
  });

  test("лимит в «Пульте» — с выводом, а не голым процентом", () => {
    const md = (week: number, left: number) => render({ ...overview(), limits: { week, weekResets: new Date(Date.now() + left).toISOString() } }).replace(/\u00a0/g, " ");
    const day = 86400_000;
    expect(md(50, day)).toContain("Недельный лимит Claude потрачен на 50% — хватит до сброса.");
    expect(md(80, 3 * day)).toMatch(/Недельный лимит Claude потрачен на 80% — кончится [^.]+\./);
    expect(md(86, day / 2)).toContain("Недельный лимит Claude потрачен на 86% — хватит до сброса."); // от 85%, но с запасом — не красное
    expect(md(90, 3 * day)).not.toContain("лимит Claude потрачен"); // кончится до сброса — это уже в проблемах
  });

  test("хватит ли лимита до сброса — по нынешнему темпу; срок — из цели сессии", () => {
    const now = Date.parse("2026-10-19T12:00:00Z");
    const reset = now + 86400_000; // до сброса сутки: прошло шесть седьмых недели
    expect(forecast(50, reset, 7 * 86400_000, now)).toMatch(/^При нынешнем темпе хватит до сброса/);
    expect(forecast(95, reset, 7 * 86400_000, now)).toMatch(/^При нынешнем темпе кончится .+, а сброс — /);
    expect(deadline("к показу 31 декабря каталог показывает реальные цифры").replace(/\u00a0/g, " ")).toBe("срок 31 декабря");
    expect(deadline("без сроков")).toBe("");
  });

  test("одинаковое ожидание у нескольких — одной строкой", () => {
    const md = render(overview(), false, { holds: ["a", "c"] });
    expect(md).toContain("**Маяк** и **Регламенты** — ждут вашего ответа");
  });

  test("«Разобраться» — к сайту и месту на диске, подпись видна целиком; к лимиту — нет", async () => {
    const { Board } = await import("../src/board");
    const board = new Board({ tg: { onCallback() {} } as any, ui: {} as any, approvals: {} as any });
    const flags = ["Потрачено 91% недельного лимита Claude: если кончится, сессии встанут до завтра, 23:00", "Сайт Маяк не открывается: сервер отвечает ошибкой 502", "На диске Mac осталось 9 ГБ: пора освободить место"];
    expect(board.fixButtons(flags).flat().map((b) => b.text)).toEqual(["Разобраться с сайтом Маяк", "Разобраться с местом на диске"]);
  });

  test("пауза по лимиту называет лимит; после сброса ошибки уже нет", () => {
    const at = Date.parse("2026-10-19T09:00:00Z");
    expect(apiStop("You've hit your weekly limit · resets Oct 30 at 11pm (Europe/Moscow)", at)).toMatch(/^на паузе до .+: кончился недельный лимит$/);
    expect(apiStop("You've hit your session limit · resets Oct 1 at 3pm (Europe/Moscow)", at)).toBe("");
  });

  test("сброс лимита из ошибки Claude: дата из текста, а «5pm» после пяти — уже завтра", () => {
    expect(limitReset("You've hit your weekly limit · resets Oct 20 at 11pm (Europe/Moscow)", Date.parse("2026-10-19T09:00:00Z"))).toBe(Date.parse("2026-10-20T20:00:00Z"));
    expect(limitReset("You've hit your session limit · resets 5pm (Europe/Moscow)", Date.parse("2026-10-19T15:00:00Z"))).toBe(Date.parse("2026-10-20T14:00:00Z"));
    expect(limitReset("API Error: overloaded")).toBeUndefined();
  });

  test("решение по запросу в «Пульте» — то же нажатие, что под самим запросом; после решения кнопка уходит", async () => {
    const { STATE } = await import("../src/config");
    const { Telegram } = await import("../src/telegram");
    const { Approvals } = await import("../src/approvals");
    const { SessionUI } = await import("../src/ui");
    const { Board } = await import("../src/board");
    writeFileSync(join(STATE, "owner.json"), JSON.stringify({ id: 222222 }));
    const tg = new Telegram("123456:VIEW_TEST_TOKEN_VIEW_TEST_TOKEN_VIEW_TEST");
    tg.bot.botInfo = { id: 42, is_bot: true, first_name: "arch", username: "test_bot" } as any;
    let n = 100;
    tg.bot.api.config.use(async (_prev, method) => (method.startsWith("send") ? { ok: true, result: { message_id: ++n, date: 0, chat: { id: 222222, type: "private" } } } : { ok: true, result: true }) as any);
    const approvals = new Approvals(tg);
    const board = new Board({ tg, ui: new SessionUI(tg), approvals });
    const decision = approvals.confirm({ source: "Сборка архитектора", action: "git push origin build:main", timeoutMs: 5000 });
    await Bun.sleep(30);
    const push = (b: { text: string }) => b.text.replace(/\u00a0/g, " ") === "Отправить код в main: Сборка архитектора";
    const yes = board.compose(overview(), true).buttons.flat().find(push)!;
    expect(yes.data).toMatch(/:y$/);
    const press = { update_id: 777, callback_query: { id: "7", from: { id: 222222, is_bot: false, first_name: "A" }, chat_instance: "1", data: yes.data, message: { message_id: 5, date: 0, chat: { id: 222222, type: "private" } } } };
    await tg.bot.handleUpdate(press as any);
    expect(await decision).toBe("yes");
    expect(board.compose(overview(), true).buttons.flat().some(push)).toBe(false);
  });

  test("слова сессии и владельца — без путей и имён файлов, и перетащенных в терминал тоже", () => {
    expect(clean("записан в validation/x.md и в CHANGELOG")).toBe("записан и в CHANGELOG");
    expect(clean("/Users/a/Downloads/Договор\\ 2026\\ \\(1\\).pdf /Users/a/Downloads/1.\\ Справка.pdf посмотри эти два")).toBe("посмотри эти два");
  });

  test("что просят сделать — глаголом, без команды", () => {
    expect(deed("git push origin build:main — код архитектора в main").replace(/\u00a0/g, " ")).toBe("отправить код в main");
    expect(deed("rm -rf build-old")).toBe("удалить файлы");
    expect(deed("Доверить Claude Code папку ~/Desktop/project")).toBe("доверить Claude Code папку ~/Desktop/project");
    expect(deed('f=$(ls ~/.claude/projects/*/x.jsonl); python3 -I - "$f"')).toBe("выполнить команду");
  });
});

// iOS склеивает строки уведомления через пробел: «…срок завтра Потрачено 86%…»
test("каждая строка сводки кончается знаком — на экране блокировки они не слипаются", () => {
  const v = { total: 9, waiting: [{ name: "Каталог", what: "в терминале вопрос: «Отправить заказчику ответ?», срок завтра" }, { name: "Блог", what: "ставить метку «новинка»?", ask: true }], accept: [], paused: [], working: [], problems: ["Недельный лимит Claude кончился: сессии стоят до завтра, 23:00"], sites: "", limit: "" } as any;
  const md = renderView(v);
  expect(md).toContain("срок завтра.");
  expect(md).toContain("ставить метку «новинка»?");
  expect(md).not.toContain("новинка»?.");
  expect(md).toContain("до завтра, 23:00.");
});

// иначе одно имя стоит и в «готово», и в «работают»: две сессии с одним именем различает дата начала
test("две сессии с одним именем — с датой начала", () => {
  const o = overview();
  const twin = (id: string, startedAt: number, status: string) => ({ ...o.rows[0], sessionId: id, id, name: "Близнец", pid: 7, status, state: undefined, startedAt, cwd: "/tmp/twin" });
  const v = view({ ...o, rows: [twin("tw1", Date.parse("2026-10-19T09:00:00Z"), "busy"), twin("tw2", Date.parse("2026-10-21T09:00:00Z"), "busy")] as any });
  expect(v.working.map((i) => i.name)).toEqual(["Близнец (с 19.10)", "Близнец (с 21.10)"]);
});

// хост угадывает имя по адресу сайта в цели и может ошибиться; имя от владельца — главнее
test("имя, данное владельцем через архитектора, главнее догадок хоста", async () => {
  const { giveName, displayName } = await import("../src/ui");
  const rows = [{ sessionId: "blog1", name: "claude-e6", cwd: "/tmp/blog", pid: 1 }] as any;
  giveName("blog1", "Блог");
  expect(displayName("blog1", "/tmp/blog", rows)).toBe("Блог");
});

// сводка по GitHub одной строкой; падение из-за оплаты GitHub — помечено, не тревога
test("GitHub одной строкой для фактов архитектора", async () => {
  const { githubLine } = await import("../src/status");
  const f = (repo: string, o: object = {}) => ({ repo, failing: [], staleFailing: 0, running: [], prs: [], ...o }) as any;
  expect(githubLine([f("x-astar", { prs: [{ number: 1, title: "a", isDraft: false }] }), f("x-beacon", { running: [{}] })])).toBe("На GitHub: открыты правки — x-astar (1); идут проверки — x-beacon; падений проверок нет.");
  expect(githubLine([f("x-beacon", { failing: [{ workflowName: "Deploy", headBranch: "main", conclusion: "startup_failure" }] })])).toContain("Deploy в main — не стартовала, похоже, из-за оплаты GitHub");
});

// после перевода в фон Claude Code называет сессию «continue previous session»
test("запомненное имя не уступает имени процесса; общие слова Claude Code — не имя", async () => {
  const { displayName } = await import("../src/ui");
  const rows = [{ sessionId: "keep1", name: "Ремонт шапки", cwd: "/tmp/keep1", pid: 1 }] as any;
  expect(displayName("keep1", "/tmp/keep1", rows)).toBe("Ремонт шапки"); // запомнилось
  rows[0].name = "continue previous session";
  expect(displayName("keep1", "/tmp/keep1", rows)).toBe("Ремонт шапки"); // не перебивается
  const fresh = [{ sessionId: "keep2", name: "continue previous session", cwd: "/tmp/Блог компании", pid: 2 }] as any;
  expect(displayName("keep2", "/tmp/Блог компании", fresh)).not.toBe("continue previous session");
});
