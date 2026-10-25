// Long messages are split for Telegram in order, every part within the limit, code blocks closed and reopened.
import { expect, test } from "bun:test";
import { splitMd } from "../src/md";

const LIMIT = 300;
// the parts glued back, without the fence lines the splitter added, give the original lines in order
const glue = (parts: string[], opener: string) =>
  parts
    .map((p, i) => {
      let lines = p.split("\n");
      if (i > 0 && lines[0] === opener) lines = lines.slice(1);
      if (i < parts.length - 1 && lines.at(-1) === "```") lines = lines.slice(0, -1);
      return lines.join("\n");
    })
    .join("\n");
const balanced = (p: string) => p.split("\n").filter((l) => /^\s*```/.test(l)).length % 2 === 0;

test("a long code block: parts within the limit, each closed and the next reopened, nothing lost or reordered", () => {
  const code = Array.from({ length: 40 }, (_, i) => `line ${i} ${"x".repeat(20)}`);
  const md = ["Итог:", "```ts", ...code, "```", "Дальше — выкладка."].join("\n");
  const parts = splitMd(md, LIMIT);
  expect(parts.length).toBeGreaterThan(2);
  for (const p of parts) expect(p.length).toBeLessThanOrEqual(LIMIT);
  for (const p of parts) expect(balanced(p)).toBe(true);
  for (const p of parts.slice(1, -1)) expect(p.startsWith("```ts")).toBe(true); // reopened with its first line
  expect(glue(parts, "```ts")).toBe(md);
});

test("a line longer than a part comes after the text before it, cut into pieces within the limit", () => {
  const md = ["Сначала вот это.", "```", "y".repeat(700), "```", "Потом это."].join("\n");
  const parts = splitMd(md, LIMIT);
  expect(parts[0].startsWith("Сначала вот это.")).toBe(true);
  for (const p of parts) expect(p.length).toBeLessThanOrEqual(LIMIT);
  for (const p of parts) expect(balanced(p)).toBe(true);
  expect(parts.join("").replace(/[^y]/g, "").length).toBe(700);
  expect(parts.at(-1)!.endsWith("Потом это.")).toBe(true);
});

test("plain text is split at line ends", () => {
  const md = Array.from({ length: 30 }, (_, i) => `Строка ${i}: ${"слово ".repeat(5)}`).join("\n");
  const parts = splitMd(md, LIMIT);
  for (const p of parts) expect(p.length).toBeLessThanOrEqual(LIMIT);
  expect(parts.join("\n")).toBe(md);
});
