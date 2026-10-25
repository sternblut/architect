// The watcher goes over the sessions every 10 seconds. The architect's sessions report through hooks; the others,
// background and Terminal ones, are seen through `claude agents --json` and their transcripts, and their questions go to
// the architect while the owner is away. It also runs queued restarts, follows deploys and refreshes the dashboard.
import { config, tr } from "./config";
import { ownerAway } from "./presence";
import { collect } from "./status";
import { weekWarning } from "./limits";
import { wakeAfterLimit } from "./limitwake";
import { freshLinks, type Link, markTold } from "./links";
import { displayName } from "./ui";
import { deliver, listAgents, pendingRestarts, restartSession, sessionDigest, workers, type AgentRow } from "./sessions";
import type { Telegram } from "./telegram";
import type { Board } from "./board";
import type { SessionUI } from "./ui";
import { shoot } from "./shots";
import { API_ERROR } from "./hookserver";
import { hhmm, log, run } from "./util";

type Seen = { state?: string; status?: string; waitingFor?: string; since: number; alerted?: boolean; idleSince?: number; relayedText?: string };
type Deploy = { repo: string; since: number; action: string; sessionId?: string; cwd?: string; settle?: (tail: string) => void }; // settle: the approval card's last line

const looksLikeQuestion = (t: string) => /\?\s*$|\?\s*\n|[?？]\s*(\*\*)?\s*$/.test(t.trim().slice(-400)) || /жду (вашего|ваш|«)|скажите|выберите|подтвердите/i.test(t.slice(-400));

export class Watcher {
  private seen = new Map<string, Seen>();
  private primed = false;
  private deploys: Deploy[] = [];
  private ticks = 0;

  // limitWarning takes the weekly limit warning; without it the host sends it to the owner directly
  constructor(private d: { tg: Telegram; ui: SessionUI; board: Board; bunPath: string; isSelf: (sessionId?: string) => boolean; question?: (sessionId: string, cwd: string, text: string) => Promise<void>; limitWarning?: (md: string) => Promise<void> }) {}

  start() {
    const loop = async () => {
      try {
        await this.tick();
      } catch (e) {
        log("watch", "круг наблюдения не удался", String(e));
      }
      setTimeout(loop, 10_000);
    };
    loop();
  }

  private lastTick = Date.now();
  private quietUntil = 0; // after the Mac wakes the network needs a moment: send nothing for a minute

  private async tick() {
    const gap = Date.now() - this.lastTick;
    this.lastTick = Date.now();
    if (gap > 60_000) {
      this.quietUntil = Date.now() + 60_000;
      log("watch", `Mac просыпался (пауза ${Math.round(gap / 1000)} с) — минуту без отправок`);
    }
    if (Date.now() < this.quietUntil) return;
    const rows = (await listAgents(true)).filter((r) => !this.d.isSelf(r.sessionId));
    await this.d.ui.refresh(rows);
    const away = await ownerAway();
    for (const r of rows) if (r.sessionId && (r.pid || r.state === "working" || r.state === "blocked")) await this.onRow(r, away);
    this.primed = true;
    if (this.ticks % 30 === 0) await this.d.tg.refreshMe(); // topics may have been turned on in @BotFather
    if (this.ticks++ % 30 === 0) await this.flags();
    if (this.ticks % 3 === 0) await this.links();
    if (this.ticks % 30 === 15) await this.afterLimit(rows);
    await this.restarts();
    await this.d.board.render(rows).catch((e) => log("watch", "пульт не обновился", String(e)));
    if (this.deploys.length && this.ticks % 3 === 0) await this.checkDeploys();
  }

  private async onRow(r: AgentRow, away: boolean) {
    const id = r.sessionId!;
    const prev = this.seen.get(id);
    const same = prev && prev.state === r.state && prev.status === r.status && prev.waitingFor === r.waitingFor;
    const cur: Seen = same ? prev : { state: r.state, status: r.status, waitingFor: r.waitingFor, since: Date.now(), idleSince: prev?.idleSince, relayedText: prev?.relayedText };
    this.seen.set(id, cur);
    if (!this.primed) {
      cur.relayedText = sessionDigest(r).lastText; // nothing from before the host started
      return;
    }
    const ours = !!workers.get(id);
    const busy = r.status === "busy" || r.state === "working";
    const waitingDialog = r.waitingFor === "permission prompt" || r.waitingFor === "dialog open" || r.waitingFor === "sandbox request";

    if (ours) {
      // turns and questions come through hooks; this covers what hooks miss
      if (!same && r.state === "failed") await this.d.ui.alert(id, r.cwd, "сессия упала. Откройте «Последние шаги» или скажите архитектору, что делать.");
      if (waitingDialog && !cur.alerted && Date.now() - cur.since > 120_000) {
        cur.alerted = true;
        await this.d.ui.alert(id, r.cwd, "ждёт решения в окне, а кнопка сюда не пришла (хост перезапускался?). Скажите архитектору «повтори запрос» — он разбудит сессию заново.");
      }
      return;
    }

    // other sessions, background and Terminal: with the shared hook, turns and questions come through it instead
    if (this.d.ui.isHooked(id)) return;
    if (busy) {
      cur.idleSince = undefined;
      return;
    }
    cur.idleSince ??= Date.now();
    const d = sessionDigest(r);
    const text = (d.lastText ?? "").trim();
    if (waitingDialog) return; // can't be answered from here; it shows on the dashboard
    // turn ended: reports are not forwarded; a real question goes to the architect, which decides whether to tell the owner
    if (!text || text === cur.relayedText || Date.now() - cur.idleSince < 20_000 || !away) return;
    cur.relayedText = text;
    if (looksLikeQuestion(text) && !API_ERROR.test(text)) await this.d.question?.(id, r.cwd, text);
  }

  // Queued restarts and messages: once the session ends its turn, do it and tell the owner in one line
  private async restarts() {
    const pending = pendingRestarts.all();
    if (!Object.keys(pending).length) return;
    const rows = await listAgents(true);
    for (const [sessionId, p] of Object.entries(pending)) {
      const r = rows.find((x) => x.sessionId === sessionId && x.pid);
      if (!r || Date.now() - p.at > 12 * 3600_000) {
        pendingRestarts.remove(sessionId);
        continue;
      }
      if (r.status === "busy" || r.state === "working" || (r.waitingFor && r.waitingFor !== "input needed")) continue;
      pendingRestarts.remove(sessionId);
      const res = p.prompt ? await deliver(r, p.prompt) : await restartSession(r);
      if (res.how === "queued") continue;
      const name = displayName(sessionId, r.cwd, rows);
      const done = p.prompt
        ? tr(`${name} закончила шаг и получила ваше сообщение.`, `${name} finished its step and got your message.`)
        : tr(`${name} закончила шаг и перезапущена на новой версии, продолжает с того же места.`, `${name} finished its step and restarted on the new version, picking up where it left off.`);
      const failed = tr(`${name}: ${p.prompt ? "передать сообщение" : "перезапустить"} не вышло — ${res.note}.`, `${name}: couldn’t ${p.prompt ? "pass on your message" : "restart it"} — ${res.note}.`);
      await this.d.tg.send(res.ok ? done : failed);
    }
  }

  // New preview pages go to the owner right away, one message per session, a button per page. The first passes only
  // record them. At night they are skipped, not held: the morning summary shows them as buttons anyway.
  // Work that stopped on the Claude limit goes on after the reset; the owner gets one line (held till morning at night)
  private async afterLimit(rows: AgentRow[]) {
    const woke = await wakeAfterLimit(rows);
    if (!woke.length) return;
    const names = woke.map((r) => displayName(r.sessionId!, r.cwd, rows)).join(", ");
    await this.d.tg.send(tr(`После сброса лимита Claude продолжили работу: ${names}.`, `After the Claude limit reset, these went back to work: ${names}.`), { silent: true });
  }

  private async links() {
    const rows = await listAgents(true);
    for (const f of freshLinks(rows)) {
      if (this.ticks > 3) await this.d.tg.send(linksMd(displayName(f.sessionId, f.cwd, rows), f.pages), { buttons: linkButtons(f.pages), skipAtNight: true });
      markTold(f.sessionId);
    }
  }

  private async flags() {
    const o = await collect(true);
    this.d.board.overview = o;
    // Flags show only on the dashboard, except the weekly limit: running out before the reset stops all work.
    // The architect decides what to say, since it knows whether the owner has already dealt with it.
    const warn = weekWarning(o.limits);
    if (warn && this.ticks > 1) await (this.d.limitWarning ? this.d.limitWarning(warn) : this.d.tg.send(warn, { silent: false }));
  }

  // The owner allowed a push, merge or deploy run: wait for the pipeline and show the new version
  async onApproved(action: string, cwd: string, sessionId?: string, settle?: (tail: string) => void) {
    if (!/git\b.*\bpush\b|gh\s+pr\s+merge|gh\s+workflow\s+run|gh\s+run\s+rerun/.test(action)) return settle?.("");
    const explicit = action.match(/(?:-R|--repo)[\s=]+([\w.-]+\/[\w.-]+)/)?.[1];
    let repo = explicit;
    if (!repo) {
      const r = await run(["git", "-C", cwd, "remote", "get-url", "origin"], { timeoutMs: 5000 });
      repo = r.stdout.trim().match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(\.git)?$/)?.[1];
    }
    if (!repo) return settle?.("");
    this.deploys.push({ repo, since: Date.now() - 60_000, action, sessionId, cwd, settle });
    log("watch", `жду выкладку ${repo}`);
  }

  private async checkDeploys() {
    for (const dep of [...this.deploys]) {
      const r = await run(["gh", "run", "list", "-R", dep.repo, "--limit", "8", "--json", "databaseId,workflowName,status,conclusion,createdAt,url,headBranch,displayTitle"], { timeoutMs: 40_000 });
      const runs = (r.code === 0 ? JSON.parse(r.stdout || "[]") : []) as { workflowName: string; status: string; conclusion: string; createdAt: string; url: string; headBranch: string; displayTitle: string }[];
      const mine = runs.filter((x) => Date.parse(x.createdAt) >= dep.since);
      // the site's name rather than the repo ("acme/beacon" means nothing to the owner)
      const sites = config.sites.filter((s) => s.repo === dep.repo.split("/")[1]);
      const who = sites.map((s) => s.name).join(", ") || dep.repo.split("/")[1];
      const say = (md: string) => (dep.sessionId && dep.cwd ? this.d.ui.post(dep.sessionId, dep.cwd, md) : this.d.tg.send(`${who} — ${md}`)).then(() => {});
      if (Date.now() - dep.since > 45 * 60_000) {
        this.deploys.splice(this.deploys.indexOf(dep), 1);
        dep.settle?.(tr("выкладка идёт дольше 45 минут", "the deploy is taking over 45 minutes"));
        await say(
          tr(
            `выкладка идёт уже 45 минут — дольше обычного. Дальше не слежу: итог — на GitHub, кнопкой ниже\nhttps://github.com/${dep.repo}/actions`,
            `the deploy has been running for 45 minutes — longer than usual. I’ve stopped watching it: the result will be on GitHub, button below\nhttps://github.com/${dep.repo}/actions`,
          ),
        );
        continue;
      }
      if (!mine.length || mine.some((x) => x.status !== "completed")) continue;
      this.deploys.splice(this.deploys.indexOf(dep), 1);
      const bad = mine.filter((x) => !["success", "skipped", "neutral"].includes(x.conclusion));
      dep.settle?.(bad.length ? tr("выкладка не прошла", "the deploy failed") : tr(`выложено в ${hhmm()}`, `deployed at ${hhmm()}`));
      if (bad.length) {
        await say(tr(`выкладка не прошла. Почему — на GitHub, кнопкой ниже\n${bad[0].url}`, `the deploy failed. The reason is on GitHub, button below\n${bad[0].url}`));
        continue;
      }
      // The screenshot is the deploy report: the caption says what happened, the picture shows the site now.
      // With sound, since the owner is waiting for the deploy they allowed.
      if (!sites.length) await say(tr("выкладка прошла", "the deploy went through"));
      for (const site of sites) {
        const shot = await shoot(site.url, "iphone", site.keychain);
        const host = site.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
        const caption = tr(`${site.name} — выкладка прошла, так ${host} выглядит сейчас`, `${site.name} — deployed. This is how ${host} looks now`);
        if (shot.path && dep.sessionId && dep.cwd) await this.d.ui.album(dep.sessionId, dep.cwd, [{ path: shot.path, caption }], undefined, false);
        else if (shot.path) await this.d.tg.sendFile(shot.path, caption, true);
        else {
          log("watch", "снимок после выкладки не вышел", shot.error ?? "");
          await say(tr(`выкладка прошла, а снимок сайта не вышел — откройте ${host} сами`, `the deploy went through, but the screenshot didn’t work — open ${host} yourself`));
        }
      }
    }
  }
}

// "Docs — new preview page: “Naming”"; several pages as a count, with the titles on the buttons
export function linksMd(name: string, pages: Link[]): string {
  const n = pages.length;
  if (n === 1) return tr(`${name} — новая страница для просмотра${pages[0].title ? `: «${pages[0].title}»` : ""}`, `${name} — new preview page${pages[0].title ? `: “${pages[0].title}”` : ""}`);
  return tr(`${name} — ${n} ${n < 5 ? "новые страницы" : "новых страниц"} для просмотра`, `${name} — ${n} new preview pages`);
}
export const linkButtons = (pages: Link[]) => pages.map((p, i) => [{ text: p.title ?? (pages.length === 1 ? tr("Открыть", "Open") : `${tr("Страница", "Page")} ${i + 1}`), url: p.url }]);
