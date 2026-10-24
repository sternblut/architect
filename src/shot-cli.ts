// Снимок страницы отдельным процессом: общая очередь браузера (config.browserLock, если есть) и headless-движок.
// bun src/shot-cli.ts <url> <iphone|macbook|monitor> <out.png> [full] [запись-связки-ключей]
// Пароль закрытого сайта процесс читает из связки ключей сам и никуда не выводит.
import { webkit, chromium } from "playwright-core";
import { HOME, config, tr } from "./config";

const [url, device = "iphone", out, full, keychain] = process.argv.slice(2);
const D = {
  iphone: { engine: webkit, width: 390, height: 844, scale: 3, mobile: true },
  macbook: { engine: chromium, width: 1470, height: 870, scale: 2, mobile: false },
  monitor: { engine: chromium, width: config.monitor?.width ?? 2560, height: config.monitor?.height ?? 1440, scale: 1, mobile: false },
}[device as "iphone" | "macbook" | "monitor"];
if (!url || !out || !D) {
  console.error("bun src/shot-cli.ts <url> <iphone|macbook|monitor> <out.png> [full]");
  process.exit(2);
}

let release: (() => void) | undefined;
try {
  const lock = await import(config.browserLock!.replace(/^~(?=\/)/, HOME));
  release = await lock.acquireBrowserLock(`architect shot ${url}`);
} catch {
  // очередь недоступна — снимаем без неё (один короткий браузер)
}
let httpCredentials: { username: string; password: string } | undefined;
if (keychain) {
  const p = Bun.spawnSync(["security", "find-generic-password", "-s", keychain, "-a", "admin", "-w"], { stdout: "pipe", stderr: "ignore" });
  if (p.exitCode === 0) httpCredentials = { username: "admin", password: p.stdout.toString().trim() };
}
const browser = await D.engine.launch({ headless: true });
try {
  // сайт — на языке владельца, как его увидит он сам
  const ctx = await browser.newContext({ viewport: { width: D.width, height: D.height }, deviceScaleFactor: D.scale, isMobile: D.mobile, hasTouch: D.mobile, locale: tr("ru-RU", "en-US"), httpCredentials });
  const page = await ctx.newPage();
  const res = await page.goto(url, { waitUntil: "load", timeout: 45_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: out, fullPage: full === "full" });
  console.log(JSON.stringify({ status: res?.status() ?? null, title: await page.title(), url: page.url() }));
} finally {
  await browser.close();
  release?.();
}
