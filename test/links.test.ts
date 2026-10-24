import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
const home = mkdtempSync(join(tmpdir(), "arch-links-home-"));
process.env.ARCH_STATE_DIR = mkdtempSync(join(tmpdir(), "arch-links-"));
const { lastLink, pagesIn, titleOf, freshLinks, markTold, pagesOf, linkOf, asLists, pageTitle } = await import("../src/links");
const { linksMd, linkButtons } = await import("../src/watcher");

// A tool call and its result, as they appear in a transcript
let n = 0;
const call = (name: string, text: string, ts: string, command = "") => {
  const id = `t${++n}`;
  return [
    { type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "tool_use", id, name, input: { command } }] } },
    { type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } },
  ];
};
const result = (text: string, ts: string) => call("Artifact", text, ts);
const said = (text: string, ts: string) => ({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }] } });

test("takes the link from the publishing tool's result, the latest one", () => {
  const l = lastLink([
    ...result("Published /private/tmp/x/index.html at https://claude.ai/artifact/AAA111", "2026-10-19T18:59:00Z"),
    ...result("Published /private/tmp/x/index.html at https://claude.ai/artifact/ExampleArtifact0000001", "2026-10-19T19:30:00Z"),
  ] as any);
  expect(l?.url).toBe("https://claude.ai/artifact/ExampleArtifact0000001");
  expect(l?.at).toBe(Date.parse("2026-10-19T19:30:00Z"));
});

test("a …/release/… URL after a deploy counts; a mention in text or a GitHub release doesn't", () => {
  expect(lastLink(call("Bash", "deployed: https://course.example.com/release/42/ ok", "2026-10-20T08:00:00Z", "./scripts/deploy-release.sh 42") as any)?.url).toBe("https://course.example.com/release/42/");
  expect(lastLink([said("посмотрите https://claude.ai/artifact/ZZZ", "2026-10-20T08:00:00Z")] as any)).toBeUndefined();
  expect(lastLink(call("Bash", "https://github.com/acme/x/release/v1", "2026-10-20T08:00:00Z", "./deploy.sh") as any)).toBeUndefined();
});

// Otherwise grep output over old transcripts would be announced as a new preview link
test("a Published … at … line in search or read output is not a publication", () => {
  expect(lastLink(call("Bash", "x.jsonl: Published /tmp/a/index.html at https://claude.ai/artifact/FAKE1", "2026-10-21T14:50:00Z", "grep -r Published ~/.claude/projects") as any)).toBeUndefined();
  expect(lastLink(call("Read", "Published /tmp/a/index.html at https://claude.ai/artifact/FAKE2", "2026-10-21T14:50:00Z") as any)).toBeUndefined();
  expect(lastLink(call("Bash", "deployed: https://course.example.com/release/42/", "2026-10-21T14:50:00Z", "grep -n release test/links.test.ts") as any)).toBeUndefined();
  expect(lastLink(call("Bash", "https://course.example.com/release/42/", "2026-10-21T14:50:00Z", "python3 - <<EOF\nprint(1)\nEOF") as any)).toBeUndefined();
  // a result without its call in the tail is unknown, not a publication
  expect(lastLink([{ type: "user", timestamp: "2026-10-21T14:50:00Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "lost", content: "Published /a at https://claude.ai/artifact/LOST" }] } }] as any)).toBeUndefined();
});

test("the page title is its <title>; no file, no title", () => {
  const f = join(home, "page.html");
  writeFileSync(f, "<html><head><title>Выбор названий &amp; томов</title></head></html>");
  expect(titleOf(f)).toBe("Выбор названий & томов");
  expect(titleOf(join(home, "nope.html"))).toBeUndefined();
});

// A session can publish two pages within a minute
test("two new pages of a session: one message, both registered, each with its title", () => {
  const cwd = "/Users/x/handbook";
  const site = join(home, "v19.html");
  const names = join(home, "names.html");
  writeFileSync(site, "<title>Регламенты ACME v19</title>");
  writeFileSync(names, "<title>Выбор названий</title>");
  const lines = [
    ...result(`Published ${site} at https://claude.ai/artifact/SITE19`, "2026-10-21T14:48:14Z"),
    ...result(`Published ${names} at https://claude.ai/artifact/NAMES1`, "2026-10-21T14:49:09Z"),
  ];
  const rows = [{ sessionId: "s1", cwd }] as any;
  const read = () => lines as any;
  const fresh = freshLinks(rows, read);
  expect(fresh.length).toBe(1);
  expect(fresh[0].pages.map((p) => p.title)).toEqual(["Выбор названий", "Регламенты ACME v19"]);
  expect(linksMd("Регламенты", fresh[0].pages)).toBe("Регламенты — 2 новые страницы для просмотра");
  expect(linkButtons(fresh[0].pages).map((r) => r[0].text)).toEqual(["Выбор названий", "Регламенты ACME v19"]);
  markTold("s1");
  expect(freshLinks(rows, read)).toEqual([]); // not news the second time
  expect(pagesOf("s1").map((p) => p.url)).toEqual(["https://claude.ai/artifact/NAMES1", "https://claude.ai/artifact/SITE19"]);
  expect(linkOf("s1")?.title).toBe("Выбор названий");
  expect(linksMd("Регламенты", [fresh[0].pages[0]])).toBe("Регламенты — новая страница для просмотра: «Выбор названий»");
});

test("an old registry entry with a single link reads as a list", () => {
  expect(asLists({ old: { url: "https://claude.ai/artifact/OLD", at: 1, told: true } }).old.map((p) => p.url)).toEqual(["https://claude.ai/artifact/OLD"]);
});

test("a page from a folder with a space in its path is registered with its title, found again by URL", () => {
  const dir = join(home, "мои проекты");
  mkdirSync(dir, { recursive: true });
  const page = join(dir, "index.html");
  writeFileSync(page, "<title>A* прототип C</title>");
  const lines = result(`Published ${page} at https://claude.ai/artifact/ExampleArtifact0000002 (Version 1, version id 1790000000-0a52) Icon: "chart".\n\nWarning: …`, "2026-10-21T23:24:21Z");
  expect(pagesIn(lines as any).map((p) => p.file)).toEqual([page]);
  freshLinks([{ sessionId: "s7", cwd: "/x" }] as any, () => lines as any);
  expect(pageTitle("https://claude.ai/artifact/ExampleArtifact0000002")).toBe("A* прототип C");
  expect(pageTitle("https://claude.ai/artifact/NONE")).toBeUndefined();
});

test("six pages in a transcript: once told, none comes back", () => {
  const lines = [1, 2, 3, 4, 5, 6].flatMap((i) => result(`Published /nope/${i}.html at https://claude.ai/artifact/P${i}`, `2026-10-21T1${i}:00:00Z`));
  const rows = [{ sessionId: "s6", cwd: "/x" }] as any;
  expect(freshLinks(rows, () => lines as any)[0].pages.length).toBe(6);
  markTold("s6");
  expect(freshLinks(rows, () => lines as any)).toEqual([]);
});
