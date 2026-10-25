// The English interface (lang: "en"): the key views on the same data as the Russian tests (view, morning, brief, limits,
// owner-word). setLang("en") switches the language and the end switches it back, in case Russian tests share the
// process. Session ids, update ids and sites are its own, so shared module state (names, registries) stays untouched.
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ARCH_STATE_DIR ??= mkdtempSync(join(tmpdir(), "arch-english-"));
process.env.ARCH_LOGS_DIR ??= process.env.ARCH_STATE_DIR;
const REPO = join(import.meta.dir, "..");

// Stub gh: no PRs, no runs, no network
const root = mkdtempSync(join(tmpdir(), "arch-english-repos-"));
mkdirSync(join(root, "bin"));
writeFileSync(join(root, "bin", "gh"), "#!/bin/sh\necho '[]'\n", { mode: 0o755 });
process.env.PATH = `${join(root, "bin")}:${process.env.PATH}`;

const { config, setLang, ensureDirs, STATE } = await import("../src/config");
ensureDirs();
const status = await import("../src/status");
const { morningMd } = await import("../src/morning");
const { decisionBrief } = await import("../src/brief");
const { briefMd, Approvals } = await import("../src/approvals");
const { Board } = await import("../src/board");
const { SessionUI } = await import("../src/ui");
const { Telegram } = await import("../src/telegram");
const { limitRu, replyFailed, saidByOwner } = await import("../src/architect");
const { outageReport } = await import("../src/outage");
const { setClaudeBin } = await import("../src/sessions");
const { typograph, urlsToButtons } = await import("../src/typo");
const { linksMd, linkButtons } = await import("../src/watcher");

const NB = String.fromCharCode(0xa0);
const plain = (s: string) => s.replaceAll(NB, " ").replace(/\u2011/g, "-");
const sites = config.sites;

beforeAll(() => {
  setLang("en");
  config.sites = [{ name: "Beacon", url: "https://beacon.example.com/", repo: "acme-beacon" }];
});
afterAll(() => {
  setLang("ru");
  config.sites = sites;
  setSystemTime();
});

// A separate English process for modules that keep state (limit samples)
const isolated = (code: string) =>
  Bun.spawnSync(["bun", "-e", code], { cwd: REPO, env: { ...process.env, ARCH_LANG: "en", ARCH_STATE_DIR: mkdtempSync(join(tmpdir(), "arch-english-own-")) }, stdout: "pipe", stderr: "pipe" }).stdout.toString();

const row = (o: Record<string, unknown>) => ({ cwd: "/tmp/no-such-folder", kind: "interactive" as const, startedAt: Date.now(), pid: 1, ...o });
const overview = (flags: string[] = []) => ({
  at: 0,
  rows: [row({ sessionId: "en-a", name: "Beacon", status: "waiting", waitingFor: "dialog open" }), row({ sessionId: "en-b", name: "Arena", status: "busy" }), row({ sessionId: "en-c", name: "Handbook", status: "idle" })],
  sites: [{ name: "Beacon", url: "", code: 200, ok: true }],
  repos: [],
  machine: { load5: 1, cpus: 10, diskFreeGb: 100 },
  flags,
  limits: { week: 62 },
});

// A fake Telegram: Bot API answers are made up and the calls recorded. Update ids are large and random: seen ids persist
// in state shared with other tests, and a repeat would drop the tap.
function fakeTelegram() {
  writeFileSync(join(STATE, "owner.json"), JSON.stringify({ id: 333333 }));
  const tg = new Telegram("123456:ENGLISH_TEST_TOKEN_ENGLISH_TEST_TOKEN_ENG");
  tg.bot.botInfo = { id: 42, is_bot: true, first_name: "arch", username: "test_bot" } as any;
  const calls: { method: string; payload: any }[] = [];
  let n = 500;
  let u = 900_000_000 + Math.floor(Math.random() * 90_000_000);
  tg.bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    return (method.startsWith("send") ? { ok: true, result: { message_id: ++n, date: 0, chat: { id: 333333, type: "private" } } } : { ok: true, result: true }) as any;
  });
  const press = (data: string) =>
    tg.bot.handleUpdate({ update_id: ++u, callback_query: { id: String(u), from: { id: 333333, is_bot: false, first_name: "A" }, chat_instance: "1", data, message: { message_id: 5, date: 0, chat: { id: 333333, type: "private" } } } } as any);
  const texts = (kb: any) => (kb?.inline_keyboard ?? []).map((r: any[]) => r.map((b) => b.text));
  // Wait until the message is sent (the brief runs git commands, slower on a slow machine) and, given the approvals,
  // until the request is registered as pending: otherwise a tap can arrive first and find it expired.
  const sent = async (k = 1, approvals?: { list(): unknown[] }) => {
    for (let i = 0; i < 250 && calls.filter((c) => c.method === "sendRichMessage").length < k; i++) await Bun.sleep(20);
    for (let i = 0; i < 250 && approvals && approvals.list().length < k; i++) await Bun.sleep(10);
    return calls.filter((c) => c.method === "sendRichMessage");
  };
  return { tg, calls, press, texts, sent };
}

describe("time", () => {
  test("today, tomorrow, a date — at 24-hour time; until; due", () => {
    setSystemTime(new Date("2026-10-22T11:07:00Z")); // 14:07 in Moscow
    const now = Date.now();
    const h = 3600_000;
    expect(plain(status.untilTime(now + 3 * h))).toBe("until 17:07");
    expect(plain(status.untilTime(now + 20 * h))).toBe("until tomorrow at 10:07");
    expect(plain(status.untilTime(now + 5 * 24 * h))).toBe("until Oct 27 at 14:07");
    expect(plain(status.whenHuman(now + 3 * h))).toBe("today at 17:07");
    expect(plain(status.whenHuman(now + 20 * h))).toBe("tomorrow at 10:07");
    expect(plain(status.whenHuman(now + 5 * 24 * h))).toBe("Oct 27 at 14:07");
    expect(plain(status.deadline("make the catalog show real numbers by October 23"))).toBe("due tomorrow");
    expect(plain(status.deadline("ship it by Oct 31"))).toBe("due Oct 31");
    expect(plain(status.deadline("к показу 31 октября"))).toBe("due Oct 31"); // a Russian goal works in English too
    expect(status.deadline("no dates here, Octopus 5")).toBe("");
    expect(plain(status.apiStop("You've hit your weekly limit · resets Oct 30 at 11pm (Europe/Moscow)", now))).toBe("paused until Oct 30 at 23:00: the weekly limit ran out");
    expect(status.apiStop("API Error: 500", now)).toBe("stopped on an error, you can resume it");
    expect(plain(status.forecast(50, now + 24 * h, 7 * 24 * h, now))).toBe("At the current pace it will last until the reset, tomorrow at 14:07.");
    expect(plain(status.forecast(95, now + 24 * h, 7 * 24 * h, now))).toMatch(/^At the current pace it will run out today at \d\d:\d\d, and it resets tomorrow at 14:07\.$/);
    setSystemTime();
  });
});

describe("pinned summary and /status", () => {
  test("first line answers what is needed; states in plain words", () => {
    const o = overview();
    expect(status.render(o)).toStartWith("**1 task needs your decision:**");
    expect(status.renderView(status.view(o), true)).toStartWith("**1 task needs your decision:**");
    expect(status.render(o)).toContain("**Beacon** — question on the Mac.");
    expect(status.render(o)).toContain("Working: Arena.");
    expect(status.render(o)).toContain("Paused: Handbook.");
    expect(status.render(o)).toContain("Weekly Claude limit: 62% used.");
    expect(plain(status.renderView(status.view(o), true))).toContain("1 task in progress, 1 paused.");
    expect(status.render({ ...o, rows: [] })).toStartWith("**Nothing needs your attention**");
    expect(status.render({ ...o, limits: { week: 100 } })).toContain("Paused: Arena, Handbook.");
    expect(status.render(o, false, { holds: ["en-a", "en-c"] })).toContain("**Beacon** and **Handbook** — waiting for your reply");
  });

  test("no Russian left in the views", () => {
    const o = overview(["Beacon site is down: the server returns error 502"]);
    for (const md of [status.render(o), status.renderView(status.view(o), true)]) expect(md).not.toMatch(/[а-яё]/i);
  });

  test("flags and their buttons: a site and the disk get «Look into», the Claude limit does not", () => {
    const board = new Board({ tg: { onCallback() {} } as any, ui: {} as any, approvals: {} as any });
    const flags = ["Weekly Claude limit is 91% used: if it runs out, work stops until tomorrow at 23:00", "Beacon site is down: the server returns error 502", "Only 9 GB left on the Mac’s disk: time to free up space"];
    expect(board.fixButtons(flags).flat().map((b) => b.text)).toEqual(["Look into the Beacon site", "Look into disk space"]);
  });

  test("a decision on the board is the same tap as under the request; the button names the verb", async () => {
    const { tg, press, sent } = fakeTelegram();
    const approvals = new Approvals(tg);
    const board = new Board({ tg, ui: new SessionUI(tg), approvals });
    const decision = approvals.confirm({ source: "Architect build", action: "git push origin build:main", timeoutMs: 5000 });
    await sent(1, approvals);
    const c = board.compose(overview(), true);
    expect(c.md.replace(/\*\*/g, "")).toContain("Architect build — push code to main?");
    expect(plain(c.md)).toMatch(/Updated at \d\d:\d\d$/);
    const yes = c.buttons.flat().find((b) => b.text === "Push code to main: Architect build")!;
    expect(yes.data).toMatch(/:y$/);
    await press(yes.data!);
    expect(await decision).toBe("yes");
  });
});

describe("morning summary", () => {
  const view = (o: Partial<{ waiting: { name: string; what: string; ask?: boolean }[]; accept: string[] }> = {}) =>
    ({ total: 5, waiting: o.waiting ?? [], accept: (o.accept ?? []).map((name) => ({ name, what: "" })), paused: [], working: [], problems: [], sites: "", limit: "" }) as any;

  test("nothing needed — said first; who worked overnight and what they did", () => {
    const { md, buttons } = morningMd({
      view: view({ accept: ["Beacon"] }),
      worked: [{ name: "A*", doing: "Collected 12 iPhone and Mac screenshots", until: Date.parse("2026-10-22T02:40:00Z") }, { name: "Handbook", until: Date.parse("2026-10-22T01:15:00Z") }],
      pages: [{ name: "A*", title: "A* prototype C", url: "https://claude.ai/artifact/X1" }],
    });
    expect(md).toStartWith("**Morning.** Nothing needs your attention.\n\nWorked overnight:\nA* — collected 12 iPhone and Mac screenshots.\nHandbook — worked until ");
    expect(md).toContain("Ready for your review: Beacon.");
    expect(md).toContain("New preview page — button below.");
    expect(buttons).toEqual([[{ text: "A* prototype C", url: "https://claude.ai/artifact/X1" }]]); // the title already starts with the name
  });

  test("decisions waiting — the count first, each below; no work overnight", () => {
    const { md } = morningMd({ view: view({ waiting: [{ name: "Catalog", what: "question on the Mac: “Send the client the reply?”" }, { name: "Beacon", what: "deploy to the site?" }] }), worked: [], pages: [], held: [] });
    expect(md).toBe("**Morning.** 2 tasks need your decision:\n**Catalog** — question on the Mac: “Send the client the reply?”.\n**Beacon** — deploy to the site?\n\nNo work overnight.");
  });

  test("held overnight — the last five, when the architect can’t answer", () => {
    const { md } = morningMd({ view: view(), worked: [], pages: [], held: ["One", "Two"] });
    expect(md).toEndWith("Held back overnight:\nOne.\nTwo.");
  });
});

describe("deploy and delete requests", () => {
  const git = (cwd: string, ...a: string[]) => {
    const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  };
  let beacon = "";
  beforeAll(() => {
    beacon = join(root, "beacon");
    mkdirSync(join(beacon, "src"), { recursive: true });
    git(beacon, "init", "-q");
    git(beacon, "remote", "add", "origin", "https://github.com/acme/acme-beacon.git");
    writeFileSync(join(beacon, "index.html"), "<h1>Beacon</h1>\n");
    writeFileSync(join(beacon, "src", "OldHeader.tsx"), "export const OldHeader = 1;\n");
    git(beacon, "add", "-A");
    git(beacon, "commit", "-q", "-m", "base");
    git(beacon, "update-ref", "refs/remotes/origin/main", "HEAD");
    for (const [body, msg] of [["<h1>Beacon AI</h1>\n", "Keep the flag on the country line"], ["<h1>Beacon AI 2026</h1>\n", "Title: year in the header"]]) {
      writeFileSync(join(beacon, "index.html"), body);
      git(beacon, "commit", "-q", "-am", msg);
    }
    writeFileSync(join(beacon, "notes.txt"), "draft\n");
  });
  const bash = (command: string, o: { shots?: number; worker?: boolean } = {}) => decisionBrief({ tool: "Bash", input: { command, description: "Push to main" }, cwd: beacon, source: "«Beacon header», beacon", shots: o.shots, worker: o.worker, inTopic: true });

  test("deploy: what changes, where, whether it can be undone; my advice uses the button’s verb", async () => {
    const b = (await bash("git push origin main", { shots: 2, worker: true }))!;
    expect(b.head).toBe("Deploy Beacon");
    expect(b.lines).toEqual(["Title — year in the header and 1 more change", "Goes live on beacon.example.com", "The previous version can be restored"]);
    expect(b.advice).toBe("I’d allow it if the screenshots above look right: no checks ran");
    const md = briefMd(b);
    expect(md).toStartWith("**Deploy Beacon?**\nTitle — year in the header and 1 more change.\nGoes live on beacon.example.com.\nThe previous version can be restored.\n\nI’d deploy it if the screenshots above look right: no checks ran.");
    expect(md).toContain("<details><summary>What changes</summary>");
    expect(md).toContain("2 changes going out:");
    expect(md).toContain("Why I’m asking: pushing to the main branch deploys the site right away");
    const look = (await bash("git push origin main", { worker: true }))!;
    expect(look.advice).toBe("I’d take a look first: no screenshots of the new version, and no checks ran");
    expect(look.more?.label).toBe("Show me first");
  });

  test("delete: a file in history — can be restored; outside history — can’t be undone", async () => {
    const tracked = (await bash("rm src/OldHeader.tsx"))!;
    expect(tracked.head).toBe("Delete file “OldHeader” in project “Beacon”");
    expect(tracked.lines).toEqual(["Can be restored from the project history"]);
    expect(tracked.advice).toBe("I’d allow it: nothing in the project refers to it");
    expect(briefMd(tracked)).toContain("I’d delete it: nothing in the project refers to it.");
    const gone = (await bash("rm notes.txt"))!;
    expect(gone.lines).toEqual(["Can’t be undone: the file isn’t in the project history"]);
    expect(gone.advice).toBe("I’d check what gets deleted first: the list is below");
    expect(gone.details!.join("\n")).toContain("What gets deleted:\n- notes.txt — not in the project history");
  });

  test("the request card: buttons, the board line, and an irreversible one decided only from its own card", async () => {
    const { tg, calls, press, texts, sent } = fakeTelegram();
    const approvals = new Approvals(tg);
    const board = new Board({ tg, ui: new SessionUI(tg), approvals });
    const del = approvals.confirm({ source: "«Beacon header»", action: "rm notes.txt", tool: "Bash", input: { command: "rm notes.txt", description: "Delete notes" }, cwd: beacon, timeoutMs: 8000 });
    const card = (await sent(1, approvals))[0];
    expect(card.payload.rich_message.markdown).toStartWith("Delete file “notes.txt” in project “Beacon”?");
    expect(texts(card.payload.reply_markup)).toEqual([["Delete", "Decline"]]);
    expect(approvals.list()[0].final).toBe(true); // "Can’t be undone": not from the dashboard
    const c = board.compose({ ...overview(), rows: [] }, true);
    expect(c.md.replace(/\*\*/g, "")).toContain("Beacon header — delete file “notes.txt” in project “Beacon”?");
    expect(c.buttons.flat().some((b) => /^Delete/.test(b.text))).toBe(false);
    await press(card.payload.reply_markup.inline_keyboard[0][0].callback_data);
    expect(await del).toBe("yes");
    const done = calls.filter((c) => c.method === "editMessageText").at(-1)!;
    expect(texts(done.payload.reply_markup)[0][0]).toMatch(/^Allowed at \d\d:\d\d$/);
  });
});

describe("question with options", () => {
  test("the question first, the advice with its reason, the rest under Details; tapping marks the choice", async () => {
    const { tg, calls, press, texts, sent: sentAll } = fakeTelegram();
    const approvals = new Approvals(tg);
    const answer = approvals.ask({
      source: "«Blog», blog",
      questions: [{ question: "Blog wants to delete 34 GB of old draft images. Delete?", options: [{ label: "Yes, delete (Recommended)", description: "Frees about 34 GB" }, { label: "No", description: "Blog works with what it has" }] }],
      timeoutMs: 5000,
    });
    const sent = (await sentAll(1, approvals))[0];
    const md = plain(sent.payload.rich_message.markdown);
    expect(md).toStartWith("Blog wants to delete 34 GB of old draft images. Delete?");
    expect(md).toContain("Session “Blog” recommends “Yes, delete”: frees about 34 GB.");
    expect(md).not.toContain("your own answer"); // no service hint
    expect(md).toContain("<details><summary>Details</summary>");
    expect(texts(sent.payload.reply_markup)).toEqual([["Yes, delete"], ["No"]]);
    await press(sent.payload.reply_markup.inline_keyboard[0][0].callback_data);
    expect(await answer).toEqual({ "Blog wants to delete 34 GB of old draft images. Delete?": "Yes, delete (Recommended)" });
    const done = calls.filter((c) => c.method === "editMessageText").at(-1)!;
    expect(texts(done.payload.reply_markup)[0][0]).toMatch(/^Picked “Yes, delete” at \d\d:\d\d$/);
    expect(done.payload.rich_message.markdown).not.toContain("Or reply to this message");
  });

  test("several options — «Send (2)»", async () => {
    const { tg, calls, press, texts, sent: sentAll } = fakeTelegram();
    const approvals = new Approvals(tg);
    void approvals.ask({ source: "Архитектор", questions: [{ question: "Which sites should the review cover?", multiSelect: true, options: [{ label: "Beacon" }, { label: "Arena" }] }], timeoutMs: 5000 });
    const sent = (await sentAll(1, approvals))[0];
    expect(sent.payload.rich_message.markdown).toContain("You can pick several, then tap “Send”"); // last line: the typographer drops the final dot
    await press(sent.payload.reply_markup.inline_keyboard[0][0].callback_data);
    await press(sent.payload.reply_markup.inline_keyboard[1][0].callback_data);
    expect(texts(calls.filter((c) => c.method === "editMessageText").at(-1)!.payload.reply_markup).at(-1)).toEqual(["Send (2)"]);
  });
});

describe("limit and failure notices", () => {
  test("weekly limit: when work stops — first; what to do — the command on its own line", () => {
    const msg = plain(
      isolated(
        'import { weekWarning } from "./src/limits"; const r = "2025-03-14T01:59:59Z"; const t0 = Date.parse("2025-03-10T06:15:00Z"); weekWarning({ week: 80, weekResets: r }, t0); process.stdout.write(weekWarning({ week: 89, weekResets: r }, t0 + 3 * 3600_000 - 60_000) ?? "nothing")',
      ),
    );
    expect(msg).toMatch(/^\*\*Weekly Claude limit will run out (today|tomorrow|Mar \d+) at \d\d:\d\d\.\*\*\n/);
    expect(msg).toContain("89% used, and it only resets Mar 14 at 05:00: until then all work stops, including my replies.");
    expect(msg).toEndWith("To keep work going, buy more usage.\nhttps://claude.ai/settings/usage");
    const later = new Date(Date.now() + 3 * 86_400_000); // not today, or the message has no day
    const resets = `${later.toLocaleString("en-US", { month: "short" })} ${later.getDate()}`;
    expect(plain(limitRu(`You've hit your weekly limit · resets ${resets} at 11pm (Europe/Moscow)`))).toMatch(/^\*\*Weekly Claude limit reached\.\*\*\nWork is paused until .+ at 23:00\. Until then I can only show the summary\.$/);
  });

  test("a reply that failed: what was said, then why — no raw error", () => {
    expect(replyFailed("", "error")).toBe("Couldn’t reply: Claude is having trouble right now. Try again in a couple of minutes.");
    expect(replyFailed("Half the answer", "too_long")).toBe("Half the answer\n\nCouldn’t finish: the conversation got too long — send /new and we’ll start over.");
    expect(replyFailed("", "limit")).toBe("Couldn’t reply: the Claude limit ran out.");
  });

  test("connection gaps: the Mac slept or had no internet", async () => {
    setClaudeBin(join(root, "no-claude")); // no sessions
    const from = Date.parse("2026-10-22T09:07:00Z");
    const to = Date.parse("2026-10-22T11:06:00Z");
    expect(plain(await outageReport(from, to, "sleep"))).toBe("The Mac was asleep from 12:07 to 14:06, so work was paused.\nWhat you wrote during that time only just arrived — replying now.");
    expect(plain(await outageReport(from, to, "dns"))).toStartWith("**The Mac had no internet from 12:07 to 14:06.**");
    setClaudeBin("claude");
  });
});

describe("buttons and links", () => {
  test("request buttons: the verb or Allow, then Decline", async () => {
    const { tg, texts, sent } = fakeTelegram();
    const approvals = new Approvals(tg);
    void approvals.confirm({ source: "Архитектор", action: "Stop “Blog”", reason: "work will stop; the conversation is kept, so it can resume later", timeoutMs: 4000 });
    void approvals.confirm({ source: "Mac", action: "ffprobe -v error x.mp4", timeoutMs: 4000 });
    const cards = await sent(2); // one message per second, so the second comes a second later
    expect(cards[0].payload.rich_message.markdown).toStartWith("Stop “Blog”?");
    expect(texts(cards[0].payload.reply_markup)).toEqual([["Stop", "Decline"]]);
    expect(cards[1].payload.rich_message.markdown).toContain("Requested by Mac");
    expect(texts(cards[1].payload.reply_markup)).toEqual([["Allow", "Decline"]]);
  });

  test("links become buttons that say what they open; new pages", () => {
    const r = urlsToButtons("Handbook updated the version at the same link: https://claude.ai/artifact/ExampleArtifact0000001\nhttps://github.com/acme/beacon/pull/6\nhttps://github.com/acme/beacon/actions/runs/1");
    expect(r.md).toBe("Handbook updated the version");
    expect(r.links.map((l) => l.text)).toEqual(["Open preview", "Changes on GitHub", "Checks on GitHub"]);
    expect(linksMd("Handbook", [{ url: "u", at: 0, title: "Name picker" }])).toBe("Handbook — new preview page: “Name picker”");
    expect(linksMd("Handbook", [{ url: "a", at: 0 }, { url: "b", at: 0 }])).toBe("Handbook — 2 new preview pages");
    expect(linkButtons([{ url: "a", at: 0 }, { url: "b", at: 0 }]).map((r) => r[0].text)).toEqual(["Page 1", "Page 2"]);
  });
});

describe("the owner’s word in English", () => {
  test("stop — a command with the session name right after it; questions and «not» are not consent", () => {
    const stop = (said: string, name = "Beacon") => saidByOwner("mcp__arch__stop_session", { session: "x" }, [said], name);
    expect(stop("Stop Beacon")).toBe(true);
    expect(stop("please halt the Beacon session")).toBe(true);
    expect(stop("ok, pause Beacon for now")).toBe(true);
    expect(stop("Why did Beacon stop?")).toBe(false);
    expect(stop("Don’t stop Beacon, let it work")).toBe(false);
    expect(stop("do not stop beacon")).toBe(false);
    expect(stop("Stop Beacon, not Arena", "Arena")).toBe(false);
    expect(stop("Stop asking me about Beacon")).toBe(false);
  });

  test("remove the goal — remove/clear/drop/cancel next to «goal» and the name", () => {
    const clear = (said: string) => saidByOwner("mcp__arch__clear_goal", { session: "x" }, [said], "Handbook");
    expect(clear("Remove the goal from Handbook")).toBe(true);
    expect(clear("clear Handbook goal")).toBe(true);
    expect(clear("What’s the goal of Handbook?")).toBe(false);
    expect(clear("Do not remove the goal from Handbook")).toBe(false);
    expect(clear("Remove Handbook")).toBe(false);
  });
});

describe("typography and the language switch", () => {
  test("English rules: curly quotes and apostrophes, dashes, ranges, numbers kept with their word", () => {
    const t = typograph(`Beacon - the "new" header 3-5 is ready, it's 12 GB`);
    expect(plain(t)).toBe("Beacon — the “new” header 3–5 is ready, it’s 12 GB");
    expect(t).toContain(`Beacon${NB}—`); // a dash never starts a line
    expect(t).toEndWith(`12${NB}GB`); // a number stays with its unit
    expect(typograph("до сброса в четверг")).toBe("до сброса в четверг"); // Russian prepositions are not an English rule
  });

  test("Russian comes back unchanged", () => {
    setLang("ru");
    expect(status.render({ ...overview(), rows: [] })).toStartWith("**От вас ничего не нужно**");
    setLang("en");
    expect(status.render({ ...overview(), rows: [] })).toStartWith("**Nothing needs your attention**");
  });

  test("the architect’s prompt ends with one English line; Russian install — the same prompt as before", () => {
    const tail = (lang: string) =>
      Bun.spawnSync(["bun", "-e", 'import { ARCHITECT_APPEND } from "./src/prompt"; process.stdout.write(ARCHITECT_APPEND.slice(-900))'], { cwd: REPO, env: { ...process.env, ARCH_LANG: lang }, stdout: "pipe" }).stdout.toString();
    expect(tail("en")).toContain("без сводки.\n\nThe owner reads English.");
    expect(tail("ru")).toEndWith("одна-две строки, без сводки.\n");
  });

  test("archi speaks the install language", () => {
    const help = Bun.spawnSync(["bash", join(REPO, "bin", "arch"), "help"], { env: { ...process.env, ARCH_LANG: "en" }, stdout: "pipe" }).stdout.toString();
    expect(help).toContain("archi on            — turn the architect on");
    expect(help).not.toMatch(/[а-яё]/i);
  });
});
