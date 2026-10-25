// What a pkill or killall would stop right now, for the gate's process rule: the matching processes with their folder
// and parent, read with pgrep, ps and lsof. pgrep leaves out itself and its ancestors, as pkill does, so the session
// that asks is not among them.
import type { Proc } from "./policy";

// -9, -TERM, -sigint; not -P or -U, which select processes
const SIGNALS = "HUP INT QUIT ILL TRAP ABRT EMT FPE KILL BUS SEGV SYS PIPE ALRM TERM URG STOP TSTP CONT CHLD TTIN TTOU IO XCPU XFSZ VTALRM PROF WINCH INFO USR1 USR2".split(" ");
const isSignal = (x: string) => /^-\d+$/.test(x) || (x.startsWith("-") && SIGNALS.includes(x.slice(1).toUpperCase().replace(/^SIG/, "")));

// The pgrep arguments that select what the command would stop: [] when it stops nothing, null when it can't be told
export function selection(cmd: "pkill" | "killall", args: string[]): string[] | null {
  if (cmd === "pkill") {
    // a signal comes only first; -I (ask before each) is pkill's own, pgrep takes the rest as is
    const a = isSignal(args[0] ?? "") ? args.slice(1) : args;
    return a.map((x) => (/^-[A-Za-z]+$/.test(x) ? x.replace(/I/g, "") : x)).filter((x) => x !== "-");
  }
  const names: string[] = [];
  const by: string[] = [];
  let regex = false;
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    if (["-l", "-s", "-d", "-help"].includes(x)) return []; // lists or shows, sends nothing
    if (x === "-m") regex = true;
    else if (x === "-u" || x === "-t" || x === "-c") {
      const val = args[++i];
      if (val === undefined) return null;
      if (x === "-c") names.push(val);
      else by.push(x, val);
    } else if (["-v", "-z", "-e", "-I"].includes(x) || isSignal(x)) continue;
    else if (x.startsWith("-")) return null;
    else names.push(x);
  }
  if (!names.length && !by.length) return [];
  return [...(regex ? [] : ["-x"]), ...by, ...names];
}

export function stopsNow(cmd: "pkill" | "killall", args: string[]): Proc[] | null {
  const sel = selection(cmd, args);
  if (!sel) return null;
  if (!sel.length) return [];
  const found = sh(["pgrep", ...sel]);
  if (found.code === 1) return [];
  if (found.code !== 0) return null;
  const pids = lines(found.out).map((l) => Number(l.split(/\s+/)[0])).filter((n) => n > 0);
  const info = table(pids);
  const parents = table([...new Set([...info.values()].map((x) => x.ppid))]);
  const cwds = cwdOf(pids);
  return pids.flatMap((pid) => {
    const i = info.get(pid);
    return i ? [{ pid, name: i.name, args: i.args, cwd: cwds.get(pid), parent: parents.get(i.ppid)?.args }] : []; // gone meanwhile
  });
}

function table(pids: number[]): Map<number, { ppid: number; name: string; args: string }> {
  const m = new Map<number, { ppid: number; name: string; args: string }>();
  if (!pids.length) return m;
  const p = pids.join(",");
  // a name may have spaces, so names and command lines come from two calls
  const args = new Map(lines(sh(["ps", "-ww", "-o", "pid=,args=", "-p", p]).out).map((l) => [Number(l.match(/^\s*(\d+)/)?.[1]), l.replace(/^\s*\d+\s+/, "")]));
  for (const l of lines(sh(["ps", "-o", "pid=,ppid=,ucomm=", "-p", p]).out)) {
    const r = l.match(/^\s*(\d+)\s+(\d+)\s+(.*?)\s*$/);
    if (r) m.set(Number(r[1]), { ppid: Number(r[2]), name: r[3], args: args.get(Number(r[1])) ?? "" });
  }
  return m;
}

function cwdOf(pids: number[]): Map<number, string> {
  const m = new Map<number, string>();
  let pid = 0;
  for (const l of lines(sh(["lsof", "-a", "-d", "cwd", "-p", pids.join(","), "-Fn"]).out)) {
    if (l.startsWith("p")) pid = Number(l.slice(1));
    else if (l.startsWith("n")) m.set(pid, l.slice(1));
  }
  return m;
}

const sh = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore", timeout: 5000 });
  return { code: r.exitedDueToTimeout ? -1 : r.exitCode, out: r.stdout.toString() };
};
const lines = (s: string) => s.split("\n").filter((l) => l.trim());
