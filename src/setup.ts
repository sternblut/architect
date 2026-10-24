// The setup questions in the bot: which folders, which sites, whether to follow GitHub; three questions with buttons.
// They run while config.setupDone is false (the template's value), then write config.local.json and start the architect.
// /setup runs them again. A config without setupDone has no setup at all.
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, HOME, STATE, config, tr } from "./config";
import type { Button, Incoming, Telegram } from "./telegram";
import { log, readJson, run, writeJson } from "./util";

const FILE = join(STATE, "setup.json");
type St = { step: "folders" | "sites" | "sites-wait" | "github" | "done"; cands: string[]; roots: string[]; sites: { name: string; url: string; repo?: string }[]; msgId?: number; gh?: string; ghText?: string };
const fresh = (): St => ({ step: "folders", cands: [], roots: [], sites: [] });

// Where projects usually live, plus the folders Claude Code has worked in
const USUAL = ["Desktop", "Documents", "Developer", "Projects", "Code", "code", "src", "dev", "work", "repos", "GitHub", "Sites"];
const RU: Record<string, string> = { Desktop: "Рабочий стол", Documents: "Документы", Downloads: "Загрузки" };
const label = (rel: string) => tr(RU[rel] ?? rel, rel);
const COUNT = ["", "одним сайтом", "двумя сайтами", "тремя сайтами", "четырьмя сайтами"];
const SITES = () => tr("Есть сайты, за которыми мне следить?", "Any websites I should keep an eye on?");

export function folderCandidates(home = HOME): string[] {
  const out = new Set<string>();
  try {
    const projects = Object.keys((JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).projects ?? {}) as Record<string, unknown>);
    for (const p of projects) if (p.startsWith(home + "/")) out.add(p.slice(home.length + 1).split("/")[0]);
  } catch {}
  for (const d of USUAL) out.add(d);
  return [...out].filter((d) => d && !d.startsWith(".") && d !== "Library" && existsSync(join(home, d)) && statSync(join(home, d)).isDirectory()).slice(0, 6);
}

// "example.com\nhttps://shop.example.com/ru" → sites; anything else is skipped
export function parseSites(text: string): { name: string; url: string }[] {
  const out: { name: string; url: string }[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const s = raw.trim().replace(/[.;]+$/, "");
    if (!/^(https?:\/\/)?[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+(:\d+)?(\/\S*)?$/iu.test(s)) continue;
    try {
      const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
      const name = (u.hostname.replace(/^www\./, "") + (u.pathname === "/" ? "" : u.pathname)).replace(/\/$/, "");
      if (!out.some((x) => x.url === u.href)) out.push({ name, url: u.href });
    } catch {}
  }
  return out.slice(0, 10);
}

// Deploy screenshots need a site linked to its repo: keep an existing link (/setup doesn't erase it), else match the
// homepage URL set on the GitHub repo
export function linkRepos<S extends { url: string; repo?: string }>(sites: S[], repos: { name: string; homepageUrl?: string }[], known: { url: string; repo?: string }[]): S[] {
  const host = (u: string) => u.replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "").toLowerCase();
  return sites.map((s) => {
    const repo = known.find((x) => x.url === s.url)?.repo ?? repos.find((x) => x.homepageUrl && host(x.homepageUrl) === host(s.url))?.name;
    return repo ? { ...s, repo } : s;
  });
}

export class Setup {
  private st: St = readJson<St>(FILE, fresh());

  constructor(
    private tg: Telegram,
    private done: () => void,
  ) {
    tg.onCallback("w", ({ id, value, messageId, answer }) => this.press(id, value, messageId, answer));
  }

  get active() {
    return config.setupDone === false;
  }

  // /setup works whenever the config has setupDone
  get restartable() {
    return config.setupDone !== undefined;
  }

  // The bot description, seen before the first "Start"
  async describe() {
    await this.tg.bot.api.setMyDescription(tr("Ваш архитектор на Mac: ведёт сессии Claude Code в ваших папках. Отвечает только вам.", "Your architect on the Mac: runs Claude Code sessions in your folders. Answers only you.")).catch(() => {});
    await this.tg.bot.api.setMyShortDescription(tr("Ваш архитектор на Mac. Отвечает только вам.", "Your architect on the Mac. Answers only you.")).catch(() => {});
  }

  restart() {
    config.setupDone = false;
    this.st = fresh();
    this.save();
  }

  async message(m: Incoming) {
    const t = m.text.trim();
    if (this.st.step === "sites-wait" && !t.startsWith("/")) {
      const sites = parseSites(t);
      if (!sites.length) return void (await this.tg.send(tr("Не нашёл адресов. Пришлите, например: example.com", "I didn’t find any addresses. Send something like: example.com")));
      this.st.sites = sites;
      const n = sites.length;
      const names = sites.map((s) => s.name).join(", ");
      return this.askGithub(tr(`Слежу ${n < COUNT.length ? `за ${COUNT[n]}` : `за сайтами (${n})`}: ${names}.\n\n`, `Watching ${n === 1 ? "1 site" : `${n} sites`}: ${names}.\n\n`));
    }
    if (this.st.msgId && !/^\/(start|setup)\b/.test(t)) return void (await this.tg.send(tr("Сначала закончим настройку — ответьте кнопкой выше.", "Let’s finish setup first — answer with a button above.")));
    return this.greet();
  }

  private hello() {
    const owner = readJson<{ name?: string }>(join(STATE, "owner.json"), {});
    return tr(
      `Здравствуйте${owner.name ? `, ${owner.name}` : ""}. Я ваш архитектор на этом Mac: веду сессии Claude Code в ваших папках и пересылаю сюда их вопросы. Необратимое — только после вашего нажатия кнопки.\n\n`,
      `Hello${owner.name ? `, ${owner.name}` : ""}. I’m your architect on this Mac: I run Claude Code sessions in your folders and forward their questions here. Nothing irreversible happens until you tap a button.\n\n`,
    );
  }

  private async greet() {
    this.st = { ...fresh(), cands: folderCandidates() };
    const [id] = await this.tg.send(this.hello() + this.foldersText(), { buttons: this.foldersButtons() });
    this.st.msgId = id;
    this.save();
  }

  private foldersText() {
    const picked = this.st.roots.map((r) => label(r)).join(", ");
    return tr(
      `Настроим за минуту. Где ваши проекты? Выберите одну или несколько папок.${picked ? `\n\nВыбрано: ${picked}` : ""}`,
      `Let’s set things up in a minute. Where are your projects? Pick one or more folders.${picked ? `\n\nSelected: ${picked}` : ""}`,
    );
  }

  private foldersButtons(): Button[][] {
    const left = this.st.cands.map((c, i) => ({ c, i })).filter(({ c }) => !this.st.roots.includes(c));
    const rows: Button[][] = [];
    for (let k = 0; k < left.length; k += 2) rows.push(left.slice(k, k + 2).map(({ c, i }) => ({ text: label(c), data: `w:f:${i}` })));
    rows.push([{ text: tr("Вся домашняя папка", "Whole home folder"), data: "w:home" }]);
    rows.push([{ text: tr("Дальше", "Next"), data: "w:next", style: "primary" }]);
    return rows;
  }

  private async press(id: string, value: string, messageId: number, answer: (t?: string) => Promise<void>) {
    if (this.st.step === "done" || !this.active) return answer(tr("Уже настроено", "Already set up"));
    await answer();
    if (id === "f" && this.st.step === "folders") {
      const c = this.st.cands[Number(value)];
      if (c && !this.st.roots.includes(c)) this.st.roots.push(c);
      this.save();
      return this.tg.edit(messageId, this.hello() + this.foldersText(), { buttons: this.foldersButtons() });
    }
    if ((id === "home" || id === "next") && this.st.step === "folders") {
      if (id === "home" || !this.st.roots.length) this.st.roots = ["~"];
      const picked = this.st.roots.map((r) => (r === "~" ? tr("вся домашняя папка", "whole home folder") : label(r))).join(", ");
      await this.tg.edit(messageId, `${this.hello()}${tr("Где ваши проекты?", "Where are your projects?")} ${picked[0].toUpperCase()}${picked.slice(1)}.`, { buttons: null });
      this.st.step = "sites";
      this.save();
      return void (await this.tg.send(SITES(), { buttons: [[{ text: tr("Есть, пришлю адреса", "Yes, I’ll send the addresses"), data: "w:sites:yes" }, { text: tr("Нет", "No"), data: "w:sites:no" }]] }));
    }
    if (id === "sites" && this.st.step === "sites") {
      await this.tg.edit(messageId, `${SITES()} ${value === "yes" ? tr("Есть.", "Yes.") : tr("Нет.", "No.")}`, { buttons: null });
      if (value === "yes") {
        this.st.step = "sites-wait";
        this.save();
        return void (await this.tg.send(tr("Пришлите адреса, каждый с новой строки.", "Send the addresses, one per line.")));
      }
      return this.askGithub("");
    }
    if (id === "gh" && this.st.step === "github") {
      await this.tg.edit(messageId, `${this.st.ghText} ${value === "yes" ? tr("Да.", "Yes.") : tr("Нет.", "No.")}`, { buttons: null });
      return this.finish(value === "yes" ? this.st.gh : undefined);
    }
  }

  private async askGithub(prefix: string) {
    const r = await run(["gh", "api", "user", "--jq", ".login"], { timeoutMs: 15_000 });
    const login = r.code === 0 ? r.stdout.trim() : "";
    if (!/^[\w-]+$/.test(login))
      return this.finish(undefined, `${prefix}${tr("GitHub можно подключить позже: войдите на Mac командой gh auth login и напишите /setup.", "You can connect GitHub later: sign in on the Mac with gh auth login, then send /setup.")}\n\n`);
    this.st.step = "github";
    this.st.gh = login;
    this.st.ghText = `${prefix}${tr(`GitHub: на этом Mac выполнен вход как ${login}. Следить за прогонами и PR?`, `GitHub: this Mac is signed in as ${login}. Watch checks and pull requests?`)}`;
    this.save();
    await this.tg.send(this.st.ghText, { buttons: [[{ text: tr("Да", "Yes"), data: "w:gh:yes" }, { text: tr("Нет", "No"), data: "w:gh:no" }]] });
  }

  private async finish(github: string | undefined, prefix = "") {
    let repos: string[] = [];
    let list: { name: string; pushedAt: string; homepageUrl?: string }[] = [];
    if (github) {
      const r = await run(["gh", "repo", "list", github, "--limit", "30", "--json", "name,pushedAt,homepageUrl"], { timeoutMs: 30_000 });
      try {
        list = JSON.parse(r.stdout);
        repos = [...list].sort((a, b) => Date.parse(b.pushedAt) - Date.parse(a.pushedAt)).slice(0, 8).map((x) => x.name);
      } catch {}
    }
    this.st.sites = linkRepos(this.st.sites, list, config.sites);
    const roots = this.st.roots.map((r) => (r === "~" ? "~" : `~/${r}`));
    // config.local.json, written atomically: what it had plus the answers
    const raw = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, "utf8")) : {};
    Object.assign(raw, { roots, sites: this.st.sites, githubOwner: github ?? "", repos, setupDone: true });
    const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, CONFIG_FILE);
    Object.assign(config, { roots: roots.map((r) => r.replace(/^~(?=\/|$)/, HOME)), sites: this.st.sites, githubOwner: github ?? "", repos, setupDone: true });
    this.st.step = "done";
    this.save();
    log("setup", "настройка закончена", { roots, sites: this.st.sites.length, repos: repos.length });
    this.done(); // start the architect and the watcher even if the message below fails
    await this.tg.send(
      `${prefix}${tr(
        "Настроено. Пишите задачу обычными словами.\n\nВверху чата будет пульт: кто ждёт вас и кто работает. Короткая сводка — «что у нас».",
        "All set. Describe a task in plain words.\n\nA summary will stay pinned at the top of the chat: who needs you and who’s working. For a quick summary, ask “what’s up?”.",
      )}`,
    );
  }

  private save() {
    writeJson(FILE, this.st);
  }
}
