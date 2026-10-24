// Setup: parsing site addresses and finding project folders (the whole flow is in test/e2e-connect.ts).
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ARCH_STATE_DIR ??= mkdtempSync(join(tmpdir(), "arch-setup-"));
process.env.ARCH_LOGS_DIR ??= process.env.ARCH_STATE_DIR;
const { folderCandidates, linkRepos, parseSites } = await import("../src/setup");

test("site addresses: bare domains, URLs, noise", () => {
  expect(parseSites("example.com\nhttps://shop.example.org/ru/, www.olga.example; привет http://")).toEqual([
    { name: "example.com", url: "https://example.com/" },
    { name: "shop.example.org/ru", url: "https://shop.example.org/ru/" },
    { name: "olga.example", url: "https://www.olga.example/" },
  ]);
  expect(parseSites("что у нас")).toEqual([]);
});

test("folders: where Claude has worked and the usual project places, existing ones only", () => {
  const home = mkdtempSync(join(tmpdir(), "arch-home-"));
  for (const d of ["Developer", "Documents", "clients/acme"]) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { [join(home, "clients/acme")]: {}, "/opt/elsewhere": {} } }));
  expect(folderCandidates(home)).toEqual(["clients", "Documents", "Developer"]);
});

// Deploy screenshots need a site linked to its repo; setup links them, and /setup keeps an existing link
test("links a site to its repo: the existing link, else the homepage URL set on the repo", () => {
  const sites = [{ name: "olga.example", url: "https://www.olga.example/" }, { name: "shop.example.org", url: "https://shop.example.org/" }, { name: "blog.example.org", url: "https://blog.example.org/" }];
  const repos = [{ name: "portfolio", homepageUrl: "https://olga.example" }, { name: "shop", homepageUrl: "" }];
  const known = [{ url: "https://shop.example.org/", repo: "shop" }];
  expect(linkRepos(sites, repos, known).map((s) => (s as { repo?: string }).repo)).toEqual(["portfolio", "shop", undefined]);
});
