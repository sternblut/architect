// "archi adopt <name>": move a session from a tab opened before the restart wrapper into a new tab that has it.
// The old process ends (the conversation is on disk) and the wrapper resumes it in the new tab.
// Prints "<folder><TAB><session id>", or why it can't.
import { tr } from "./config";
import { fits } from "./fast";
import { listAgents, wrapVersion } from "./sessions";
import { displayName } from "./ui";

// --dry: only say what would happen, the safe way to try it on real sessions
const dry = process.argv.includes("--dry");
const want = process.argv.slice(2).filter((a) => a !== "--dry").join(" ").trim();
// Background sessions too: one can be open in a tab through attach
const rows = (await listAgents(true)).filter((r) => r.sessionId && r.pid);
const words = want.toLowerCase().split(/[^\p{L}\p{N}*]+/u).filter(Boolean);
const name = (r: (typeof rows)[number]) => displayName(r.sessionId!, r.cwd, rows);
const hit = rows.filter((r) => words.length && words.every((w) => fits(w, name(r))));
const say = (t: string) => {
  console.log(t);
  process.exit(1);
};
if (!want) say(tr("Наберите имя сессии: archi adopt A*", "Type the session name: archi adopt A*"));
if (!hit.length) say(tr(`Сессию «${want}» не нашёл. Сейчас открыты: ${rows.map(name).join(", ")}`, `Couldn’t find session “${want}”. Open now: ${rows.map(name).join(", ")}`));
if (hit.length > 1) say(tr(`Под «${want}» подходят несколько: ${hit.map(name).join(", ")} — уточните имя`, `Several sessions match “${want}”: ${hit.map(name).join(", ")} — be more specific`));
const r = hit[0];
if ((await wrapVersion(r)) >= 1) say(tr(`«${name(r)}» уже во вкладке с перезапуском`, `“${name(r)}” is already in a tab with restart support`));
if (r.status === "busy" || r.state === "working") say(tr(`«${name(r)}» сейчас работает — дождитесь, пока она закончит ход`, `“${name(r)}” is working right now — wait until it finishes its turn`));
if (dry) {
  console.log(
    tr(
      `всухую: завершил бы ${r.kind === "background" ? `фоновую ${r.id}` : `процесс ${r.pid}`} и поднял бы ${r.sessionId} в ${r.cwd}`,
      `dry run: would stop ${r.kind === "background" ? `background session ${r.id}` : `process ${r.pid}`} and bring up ${r.sessionId} in ${r.cwd}`,
    ),
  );
  process.exit(0);
}
if (r.kind === "background" && r.id) {
  // Claude Code stops it and keeps the conversation; its attach window closes by itself
  const st = Bun.spawnSync(["claude", "stop", r.id], { stdout: "pipe", stderr: "pipe" });
  if (st.exitCode !== 0) say(tr(`Фоновую «${name(r)}» остановить не вышло: ${st.stderr.toString().trim().slice(0, 160)}`, `Couldn’t stop background session “${name(r)}”: ${st.stderr.toString().trim().slice(0, 160)}`));
  console.log(`${r.cwd}\t${r.sessionId}`);
  process.exit(0);
}
process.kill(r.pid!, "SIGTERM");
for (let i = 0; i < 60; i++) {
  try {
    process.kill(r.pid!, 0);
    await Bun.sleep(250);
  } catch {
    console.log(`${r.cwd}\t${r.sessionId}`);
    process.exit(0);
  }
}
say(tr(`Старый процесс «${name(r)}» не завершился за 15 с — закройте его вкладку сами и повторите`, `The old process of “${name(r)}” didn’t exit within 15 s — close its tab yourself and try again`));
