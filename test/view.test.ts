// The dashboard and the "what's up" answer: guards against regressions such as emoji, internal words and walls of text.
// Whether the view looks good is for a human to judge, not these checks.
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

describe("dashboard and what's up", () => {
  test("no emoji and no Claude Code internals", () => {
    const o = overview(["Сайт Маяк не открывается: сервер отвечает ошибкой 502"]);
    for (const md of [render(o), renderView(view(o), true)]) {
      expect(EMOJI.test(md)).toBe(false);
      expect(md).not.toMatch(/dialog open|permission prompt|waiting|busy|claude-[0-9a-f]/);
    }
  });

  test("the first line answers directly: how many decisions wait (visible in the pinned bar)", () => {
    const o = overview();
    // clear to an outsider: what is needed, not how many sessions there are
    expect(render(o).startsWith("**1 задача ждёт вашего решения:**")).toBe(true);
    expect(renderView(view(o), true).startsWith("**1 задача ждёт вашего решения:**")).toBe(true);
    expect(render({ ...o, rows: [] })).toStartWith("**От вас ничего не нужно**");
    expect(render(o)).toContain("**Маяк** — вопрос на Mac");
    expect(render(o)).toContain("На паузе: Регламенты.");
  });

  test("with the limit out nobody is working: all are paused", () => {
    const md = render({ ...overview(), limits: { week: 100 } });
    expect(md).not.toMatch(/Работа/);
    expect(md).toContain("На паузе: Арена, Регламенты.");
  });

  test("the limit line says what the number means, not a bare percent", () => {
    const md = (week: number, left: number) => render({ ...overview(), limits: { week, weekResets: new Date(Date.now() + left).toISOString() } }).replace(/\u00a0/g, " ");
    const day = 86400_000;
    expect(md(50, day)).toContain("Недельный лимит Claude потрачен на 50% — хватит до сброса.");
    expect(md(80, 3 * day)).toMatch(/Недельный лимит Claude потрачен на 80% — кончится [^.]+\./);
    expect(md(86, day / 2)).toContain("Недельный лимит Claude потрачен на 86% — хватит до сброса."); // 85% or more with headroom is not red
    expect(md(90, 3 * day)).not.toContain("лимит Claude потрачен"); // running out before the reset is a problem instead
  });

  test("whether the limit lasts comes from the pace; a deadline comes from the goal", () => {
    const now = Date.parse("2026-10-19T12:00:00Z");
    const reset = now + 86400_000; // a day to the reset: six sevenths of the week are gone
    expect(forecast(50, reset, 7 * 86400_000, now)).toMatch(/^При нынешнем темпе хватит до сброса/);
    expect(forecast(95, reset, 7 * 86400_000, now)).toMatch(/^При нынешнем темпе кончится .+, а сброс — /);
    expect(deadline("к показу 31 декабря каталог показывает реальные цифры").replace(/\u00a0/g, " ")).toBe("срок 31 декабря");
    expect(deadline("без сроков")).toBe("");
  });

  test("the same wait for several sessions is one line", () => {
    const md = render(overview(), false, { holds: ["a", "c"] });
    expect(md).toContain("**Маяк** и **Регламенты** — ждут вашего ответа");
  });

  test("Look into for a site and disk space, not for the limit", async () => {
    const { Board } = await import("../src/board");
    const board = new Board({ tg: { onCallback() {} } as any, ui: {} as any, approvals: {} as any });
    const flags = ["Потрачено 91% недельного лимита Claude: если кончится, сессии встанут до завтра, 23:00", "Сайт Маяк не открывается: сервер отвечает ошибкой 502", "На диске Mac осталось 9 ГБ: пора освободить место"];
    expect(board.fixButtons(flags).flat().map((b) => b.text)).toEqual(["Разобраться с сайтом Маяк", "Разобраться с местом на диске"]);
  });

  test("a limit pause names the limit; after the reset the error no longer applies", () => {
    const at = Date.parse("2026-10-19T09:00:00Z");
    expect(apiStop("You've hit your weekly limit · resets Oct 30 at 11pm (Europe/Moscow)", at)).toMatch(/^на паузе до .+: кончился недельный лимит$/);
    expect(apiStop("You've hit your session limit · resets Oct 1 at 3pm (Europe/Moscow)", at)).toBe("");
  });

  test("the reset time from Claude's error: the date from the text, and 5pm seen after five means tomorrow", () => {
    expect(limitReset("You've hit your weekly limit · resets Oct 20 at 11pm (Europe/Moscow)", Date.parse("2026-10-19T09:00:00Z"))).toBe(Date.parse("2026-10-20T20:00:00Z"));
    expect(limitReset("You've hit your session limit · resets 5pm (Europe/Moscow)", Date.parse("2026-10-19T15:00:00Z"))).toBe(Date.parse("2026-10-20T14:00:00Z"));
    expect(limitReset("API Error: overloaded")).toBeUndefined();
  });

  test("a decision on the dashboard is the same tap as under the request, and the button goes after it", async () => {
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

  test("words without paths or file names, including files dragged into the terminal", () => {
    expect(clean("записан в validation/x.md и в CHANGELOG")).toBe("записан и в CHANGELOG");
    expect(clean("/Users/a/Downloads/Договор\\ 2026\\ \\(1\\).pdf /Users/a/Downloads/1.\\ Справка.pdf посмотри эти два")).toBe("посмотри эти два");
  });

  test("what is asked becomes a verb, without the command", () => {
    expect(deed("git push origin build:main — код архитектора в main").replace(/\u00a0/g, " ")).toBe("отправить код в main");
    expect(deed("rm -rf build-old")).toBe("удалить файлы");
    expect(deed("Доверить Claude Code папку ~/Desktop/project")).toBe("доверить Claude Code папку ~/Desktop/project");
    expect(deed('f=$(ls ~/.claude/projects/*/x.jsonl); python3 -I - "$f"')).toBe("выполнить команду");
  });
});

// iOS joins notification lines with a space
test("every summary line ends with punctuation, so lines don't run together on the lock screen", () => {
  const v = { total: 9, waiting: [{ name: "Каталог", what: "в терминале вопрос: «Отправить заказчику ответ?», срок завтра" }, { name: "Блог", what: "ставить метку «новинка»?", ask: true }], accept: [], paused: [], working: [], problems: ["Недельный лимит Claude кончился: сессии стоят до завтра, 23:00"], sites: "", limit: "" } as any;
  const md = renderView(v);
  expect(md).toContain("срок завтра.");
  expect(md).toContain("ставить метку «новинка»?");
  expect(md).not.toContain("новинка»?.");
  expect(md).toContain("до завтра, 23:00.");
});

test("two sessions with the same name get their start dates", () => {
  const o = overview();
  const twin = (id: string, startedAt: number, status: string) => ({ ...o.rows[0], sessionId: id, id, name: "Близнец", pid: 7, status, state: undefined, startedAt, cwd: "/tmp/twin" });
  const v = view({ ...o, rows: [twin("tw1", Date.parse("2026-10-19T09:00:00Z"), "busy"), twin("tw2", Date.parse("2026-10-21T09:00:00Z"), "busy")] as any });
  expect(v.working.map((i) => i.name)).toEqual(["Близнец (с 19.10)", "Близнец (с 21.10)"]);
});

// The host guesses names from the goal and can be wrong
test("a name the owner gave through the architect beats the host's guesses", async () => {
  const { giveName, displayName } = await import("../src/ui");
  const rows = [{ sessionId: "blog1", name: "claude-e6", cwd: "/tmp/blog", pid: 1 }] as any;
  giveName("blog1", "Блог");
  expect(displayName("blog1", "/tmp/blog", rows)).toBe("Блог");
});

// A run that never started is marked as a likely billing issue, not an alarm
test("GitHub in one line for the architect's facts", async () => {
  const { githubLine } = await import("../src/status");
  const f = (repo: string, o: object = {}) => ({ repo, failing: [], staleFailing: 0, running: [], prs: [], ...o }) as any;
  expect(githubLine([f("x-astar", { prs: [{ number: 1, title: "a", isDraft: false }] }), f("x-beacon", { running: [{}] })])).toBe("На GitHub: открыты правки — x-astar (1); идут проверки — x-beacon; падений проверок нет.");
  expect(githubLine([f("x-beacon", { failing: [{ workflowName: "Deploy", headBranch: "main", conclusion: "startup_failure" }] })])).toContain("Deploy в main — не стартовала, похоже, из-за оплаты GitHub");
});

// After /bg Claude Code calls the session "continue previous session"
test("a remembered name beats the process name; Claude Code's generic words are no name", async () => {
  const { displayName } = await import("../src/ui");
  const rows = [{ sessionId: "keep1", name: "Ремонт шапки", cwd: "/tmp/keep1", pid: 1 }] as any;
  expect(displayName("keep1", "/tmp/keep1", rows)).toBe("Ремонт шапки"); // remembered
  rows[0].name = "continue previous session";
  expect(displayName("keep1", "/tmp/keep1", rows)).toBe("Ремонт шапки"); // not overridden
  const fresh = [{ sessionId: "keep2", name: "continue previous session", cwd: "/tmp/Блог компании", pid: 2 }] as any;
  expect(displayName("keep2", "/tmp/Блог компании", fresh)).not.toBe("continue previous session");
});
