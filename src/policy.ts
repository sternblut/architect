// The policy gate: what runs freely, what waits for the owner's yes in Telegram, what is refused.
// Rules only restrict: they never grant more than the session already has.
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export type Decision = "ok" | "ask" | "deny";
export type Verdict = { decision: Decision; reason: string };

export type PolicyContext = {
  cwd: string;
  archHome: string;
  hostingPattern: string;
  spendPattern?: string;
  keychainService: string;
  branch?: (cwd: string) => string;
};

const OK: Verdict = { decision: "ok", reason: "" };
const ask = (reason: string): Verdict => ({ decision: "ask", reason });
const deny = (reason: string): Verdict => ({ decision: "deny", reason });

function worst(a: Verdict, b: Verdict): Verdict {
  const rank = { ok: 0, ask: 1, deny: 2 } as const;
  return rank[b.decision] > rank[a.decision] ? b : a;
}

// ── command line parsing ─────────────────────────────────────────────────────

type Parsed = { commands: string[][]; nested: string[]; piped?: Set<number> };

// Splits a command line on ; && || | & and newlines, respecting quotes. The contents of $(...) and `...` are
// returned separately so they are checked too.
export function parseShell(src: string): Parsed {
  const commands: string[][] = [];
  const nested: string[] = [];
  const piped = new Set<number>();
  let cur: string[] = [];
  let tok = "";
  let has = false;
  let stdinNext = false; // here-string (<<<): the next word is the command's stdin
  const heredocs: { delim: string; strip: boolean; target: string[] }[] = [];
  const push = () => {
    if (has) {
      cur.push(stdinNext ? "\u0000STDIN:" + tok : tok);
      stdinNext = false;
    }
    tok = "";
    has = false;
  };
  let pipedNext = false;
  const end = () => {
    push();
    if (cur.length) {
      if (pipedNext) piped.add(commands.length);
      commands.push(cur);
    }
    cur = [];
    pipedNext = false;
  };
  const readSub = (i: number): [string, number] => {
    // i points just past "$("
    let depth = 1;
    let j = i;
    let q: string | null = null;
    while (j < src.length) {
      const c = src[j];
      if (q) {
        if (c === "\\" && q === '"') j++;
        else if (c === q) q = null;
      } else if (c === "'" || c === '"') q = c;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) break;
      j++;
    }
    return [src.slice(i, j), j];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      tok += j < 0 ? src.slice(i + 1) : src.slice(i + 1, j);
      has = true;
      i = j < 0 ? src.length : j;
    } else if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) {
          tok += src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === "$" && src[j + 1] === "(") {
          const [inner, k] = readSub(j + 2);
          nested.push(inner);
          tok += "$(" + inner + ")";
          j = k + 1;
          continue;
        }
        if (src[j] === "`") {
          const k = src.indexOf("`", j + 1);
          nested.push(src.slice(j + 1, k < 0 ? undefined : k));
          j = k < 0 ? src.length : k + 1;
          continue;
        }
        tok += src[j++];
      }
      has = true;
      i = j;
    } else if (c === "\\" && i + 1 < src.length) {
      if (src[i + 1] !== "\n") tok += src[i + 1];
      has = true;
      i++;
    } else if (c === "$" && src[i + 1] === "(") {
      const [inner, k] = readSub(i + 2);
      nested.push(inner);
      tok += "$(" + inner + ")";
      has = true;
      i = k;
    } else if (c === "`") {
      const k = src.indexOf("`", i + 1);
      nested.push(src.slice(i + 1, k < 0 ? undefined : k));
      has = true;
      i = k < 0 ? src.length : k;
    } else if (c === "|" && src[i + 1] !== "|") {
      // a pipe: mark the next command as reading stdin, to catch "… | sh"
      end();
      pipedNext = true;
    } else if (c === "\n" && heredocs.length) {
      // heredoc bodies, from the next line to the delimiter line: stdin of their command, not shell commands
      end();
      let j = i + 1;
      for (const h of heredocs) {
        const body: string[] = [];
        while (j < src.length) {
          const e = src.indexOf("\n", j);
          const line = src.slice(j, e < 0 ? src.length : e);
          j = e < 0 ? src.length : e + 1;
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
          body.push(line);
        }
        h.target.push("\u0000STDIN:" + body.join("\n"));
      }
      heredocs.length = 0;
      i = j - 1;
    } else if (c === ";" || c === "\n" || c === "&" || c === "|") {
      end();
      if ((c === "&" || c === "|") && src[i + 1] === c) i++;
    } else if (c === "<" && src[i + 1] === "<") {
      // heredoc (<<WORD … WORD) and here-string (<<<): the command's stdin, not a file. A shell runs it as commands,
      // an interpreter as code; for other commands it is data (commandRules).
      push();
      i += 2;
      if (src[i] === "<") stdinNext = true;
      else {
        const strip = src[i] === "-";
        if (strip) i++;
        while (src[i] === " " || src[i] === "\t") i++;
        let delim = "";
        while (i < src.length && !/[\s;&|<>()]/.test(src[i])) {
          if (src[i] === "'" || src[i] === '"') {
            const j = src.indexOf(src[i], i + 1);
            delim += src.slice(i + 1, j < 0 ? src.length : j);
            i = j < 0 ? src.length : j + 1;
          } else if (src[i] === "\\") {
            delim += src[i + 1] ?? "";
            i += 2;
          } else delim += src[i++];
        }
        i--;
        heredocs.push({ delim, strip, target: cur });
      }
    } else if (c === ">") {
      // output redirection: mark the target (truncating a file deletes it too); a descriptor before ">" (2>) is not an argument
      if (/^[0-9]$/.test(tok) && has) {
        tok = "";
        has = false;
      } else push();
      const append = src[i + 1] === ">";
      if (append) i++;
      if (src[i + 1] === "&") {
        i++; // 2>&1 is not a file
        while (/[0-9-]/.test(src[i + 1] ?? "")) i++;
      } else {
        while (src[i + 1] === " " || src[i + 1] === "\t") i++;
        tok = append ? "\u0000APPEND:" : "\u0000WRITE:";
        has = true;
      }
    } else if (c === "(" || c === ")" || c === "{" || c === "}") {
      // groups and subshells only delimit commands
      if (c === "(" || c === ")" || !has) end();
      else tok += c;
    } else if (c === " " || c === "\t") {
      push();
    } else if (c === "#" && !has) {
      const j = src.indexOf("\n", i);
      i = j < 0 ? src.length : j - 1;
    } else {
      tok += c;
      has = true;
    }
  }
  end();
  return { commands, nested, piped };
}

const WRAPPERS = new Set(["sudo", "nohup", "time", "exec", "command", "builtin", "caffeinate", "stdbuf", "unbuffer"]);

// Strips prefixes: VAR=1, env, sudo, nice -n 5, timeout 30 and the like
export function stripPrefixes(t: string[]): string[] {
  let i = 0;
  while (i < t.length) {
    const w = t[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++;
    else if (WRAPPERS.has(basename(w))) {
      i++;
      while (i < t.length && t[i].startsWith("-")) i++;
    } else if (basename(w) === "env") {
      i++;
      while (i < t.length && (t[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i]))) i++;
    } else if (basename(w) === "nice") {
      i++;
      if (t[i] === "-n") i += 2;
      else if (t[i]?.startsWith("-")) i++;
    } else if (basename(w) === "timeout" || basename(w) === "gtimeout") {
      i++;
      while (i < t.length && t[i].startsWith("-")) i++;
      i++; // the duration
    } else break;
  }
  return t.slice(i);
}

// ── rules ────────────────────────────────────────────────────────────────────

const SAFE_RM =
  /^(\.\/)?((dist|build|out|\.cache|coverage|test-results|playwright-report|node_modules|tmp|\.tmp|artifacts|\.next|\.astro|\.turbo|\.parcel-cache|__pycache__|\.pytest_cache|\.venv-tmp)(\/|$))|^(\/tmp\/|\/private\/tmp\/|\/private\/var\/folders\/|\$TMPDIR\/|\$\{TMPDIR\}\/|\$CLAUDE_JOB_DIR\/tmp\/|\$\{CLAUDE_JOB_DIR\}\/tmp\/)|^(~|\/Users\/[^/]+)\/\.claude\/jobs\/[\w-]+\/tmp(\/|$)|\.pyc$/;

// Inline code in another language (python3 -c, node -e, python3 - <<EOF): ask only about deleting and the owner's
// business inside it (push, merge, deploy, email). Writing files, network and running programs are ordinary research
// and build work that shouldn't need a button each time.
const CODE_DELETES = /\b(unlink|rmtree|rmSync|rmdirSync|rimraf|unlinkSync|removedirs)\b|\bos\.(remove|rmdir|truncate)\b|\.(unlink|rmdir)\(|\bfs\.(promises\.)?(rm|unlink|truncate)\w*|\bFile\.(delete|unlink)\b/;
const CODE_OWNER_DEEDS = /\brm\s+-[a-zA-Z]*[rf]|\bgit\s+push\b|\bgh\s+pr\s+merge\b|\b(deploy|publish)\b|\bscp\b|\brsync\b|\bsendmail\b|\bsmtplib\b|\|\s*(ba|z)?sh\b/;

const DEPLOY_SCRIPT = /(^|\/)(ship|deploy|publish|release)([\w.-]*)?(\.(sh|py|mjs|cjs|js|ts))?$/i;
const DEPLOY_WORD = /^(deploy|publish|release|ship)([:_-]\w*)?$|(^|[:_-])(deploy|publish|release|ship)$/i;
const INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "fish", "python", "python3", "node", "bun", "deno", "ruby", "perl", "tsx", "ts-node"]);

const GIT_EXEC_KEY = /^(core\.(sshcommand|pager|editor|fsmonitor|hookspath|askpass)|credential\.|diff\.external|gpg\.|sequence\.editor|filter\.|merge\.[^=]*\.driver|diff\.[^=]*\.(textconv|command)|uploadpack\.packobjectshook|protocol\.ext\.allow)/i;
function gitRules(t: string[], ctx: PolicyContext): Verdict {
  // skip git's global options: -C <path>, -c <k=v>, --git-dir=…, --no-pager
  let i = 1;
  let cwd = ctx.cwd;
  while (i < t.length && t[i].startsWith("-")) {
    if (t[i] === "-C") {
      cwd = t[i + 1] ?? cwd;
      i += 2;
    } else if (t[i] === "-c") {
      // a setting that runs a program (core.sshCommand, core.pager…) would run it past the gate;
      // core.hooksPath=/dev/null only turns hooks off
      if (GIT_EXEC_KEY.test(t[i + 1] ?? "") && !/^core\.hookspath=\/dev\/null$/i.test(t[i + 1] ?? "")) return ask("git запускает программу из своей настройки");
      i += 2;
    } else i++;
  }
  const sub = t[i];
  const args = t.slice(i + 1);
  const branch = () => (ctx.branch ? ctx.branch(cwd) : "");
  // git's built-in commands (git --list-cmds=main) minus those that email people, rewrite history, prune unreachable
  // objects, hand out secrets or start a server. An unknown name may be an alias hiding a push.
  const KNOWN = new Set(["add", "am", "annotate", "apply", "archive", "backfill", "bisect", "blame", "branch", "bugreport", "bundle", "cat-file", "check-attr", "check-ignore", "check-mailmap", "check-ref-format", "checkout", "cherry", "cherry-pick", "clean", "clone", "column", "commit", "commit-graph", "commit-tree", "config", "count-objects", "describe", "diagnose", "diff", "diff-files", "diff-index", "diff-pairs", "diff-tree", "difftool", "fetch", "flow", "fmt-merge-msg", "for-each-ref", "format-patch", "fsck", "fsck-objects", "gc", "get-tar-commit-id", "grep", "hash-object", "help", "history", "index-pack", "init", "interpret-trailers", "last-modified", "lfs", "log", "ls-files", "ls-remote", "ls-tree", "mailinfo", "mailsplit", "merge", "merge-base", "merge-file", "merge-tree", "mktag", "mktree", "multi-pack-index", "mv", "name-rev", "notes", "pack-objects", "pack-refs", "patch-id", "pull", "push", "range-diff", "read-tree", "rebase", "reflog", "refs", "remote", "repack", "replay", "repo", "rerere", "reset", "restore", "rev-list", "rev-parse", "revert", "rm", "shortlog", "show", "show-branch", "show-index", "show-ref", "sparse-checkout", "stash", "status", "stripspace", "submodule", "subtree", "switch", "symbolic-ref", "tag", "unpack-file", "unpack-objects", "update-index", "update-ref", "var", "verify-commit", "verify-pack", "verify-tag", "version", "whatchanged", "worktree", "write-tree"]);
  if (sub === "config" && args.some((a) => /^alias\./.test(a))) return ask("git-алиас может скрывать push или удаление");
  if (sub && !sub.startsWith("-") && !KNOWN.has(sub)) return ask(`git ${sub} — неизвестная подкоманда (алиас?)`);
  if (sub === "push") {
    if (args.some((a) => ["--force", "-f", "--force-with-lease", "--force-if-includes", "--delete", "-d", "--mirror", "--prune"].includes(a) || a.startsWith("--force-with-lease=")))
      return ask("push с перезаписью или удалением на GitHub");
    if (args.some((a) => a === "--all" || a === "--tags")) return ask("push всех веток или тегов — может запустить выкладку");
    const pos = args.filter((a) => !a.startsWith("-"));
    const refs = pos.slice(1);
    if (refs.some((r) => r.startsWith("+") || r.startsWith(":"))) return ask("push с перезаписью или удалением на GitHub");
    if (refs.some((r) => /(^|:|\/)(main|master)$/.test(r))) return ask("push в main — это выкладка");
    if (!refs.length && ["main", "master"].includes(branch())) return ask("push в main — это выкладка");
    // "git push origin HEAD" from main is a push to main
    if (refs.some((r) => /^(HEAD|@)$/.test(r)) && ["main", "master"].includes(branch())) return ask("push в main — это выкладка");
    return OK;
  }
  if (sub === "branch" && args.some((a) => ["-D", "-d", "--delete"].includes(a))) return ask("удаление ветки");
  if (sub === "tag" && args.some((a) => ["-d", "--delete"].includes(a))) return ask("удаление тега");
  if (sub === "clean" && args.some((a) => /^-[a-zA-Z]*f/.test(a) || a === "--force")) return ask("git clean удаляет файлы без возврата");
  if (sub === "reset" && args.includes("--hard") && ["main", "master"].includes(branch())) return ask("жёсткий сброс main");
  return OK;
}

function ghRules(t: string[], raw: string): Verdict {
  const [, a, b] = t;
  if (!a) return OK;
  if ((a === "pr" && b === "merge") || (a === "workflow" && (b === "run" || b === "enable")) || (a === "run" && b === "rerun"))
    return ask(`gh ${a} ${b} — выкладка или запуск конвейера`);
  if (a === "release" && ["create", "delete", "upload", "edit", "delete-asset"].includes(b)) return ask(`gh release ${b} — выпуск`);
  if (a === "repo" && ["delete", "archive", "rename", "edit", "create", "transfer"].includes(b)) return ask(`gh repo ${b} — меняет репозитории`);
  if ((a === "secret" || a === "variable") && ["set", "delete", "remove"].includes(b)) return ask(`gh ${a} ${b} — секреты и переменные GitHub`);
  if (a === "api") {
    const method = raw.match(/(?:-X|--method)[\s=]*([A-Za-z]+)/)?.[1]?.toUpperCase();
    const implicitPost = /\s(-f|-F|--field|--raw-field|--input)\b/.test(raw);
    if ((method && method !== "GET") || (!method && implicitPost)) return ask("запись через GitHub API");
  }
  return OK;
}

function curlRules(t: string[], raw: string, hosting: RegExp): Verdict {
  const urls = t.filter((x) => /^[a-z]+:\/\//i.test(x) || /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(x));
  const toHosting = urls.some((u) => hosting.test(u));
  const upload = t.some((x) => ["-T", "--upload-file"].includes(x)) || urls.some((u) => /^s?ftps?:\/\//i.test(u));
  const method = raw.match(/(?:-X|--request)[\s=]*([A-Za-z]+)/)?.[1]?.toUpperCase();
  const sendsFile = /(\s-d\s*@|\s--data(-binary|-raw|-urlencode)?[\s=]+@|\s-F\s*\S+=@|\s--form[\s=]+\S+=@)/.test(raw);
  if (toHosting && (upload || (method && method !== "GET" && method !== "HEAD"))) return deny("прямая запись на хостинг запрещена — выкладка только конвейерами репозиториев");
  if (upload || sendsFile) {
    if (urls.every((u) => /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/i.test(u))) return OK;
    return ask("отправка файла с Mac наружу");
  }
  if (urls.some((u) => /api\.github\.com/i.test(u)) && method && !["GET", "HEAD"].includes(method)) return ask("запись через GitHub API");
  return OK;
}

function deployCli(cmd: string, t: string[]): Verdict {
  const args = t.slice(1);
  const has = (...w: string[]) => w.some((x) => args.includes(x));
  switch (cmd) {
    case "vercel":
      return has("--prod", "deploy", "promote", "rollback", "remove", "rm") ? ask("выкладка через Vercel") : OK;
    case "netlify":
      return has("deploy") ? ask("выкладка через Netlify") : OK;
    case "firebase":
      return has("deploy") ? ask("выкладка через Firebase") : OK;
    case "wrangler":
      return has("deploy", "publish", "delete") ? ask("выкладка через Cloudflare") : OK;
    case "fly":
    case "flyctl":
      return has("deploy", "destroy") ? ask("выкладка через Fly") : OK;
    case "gcloud":
      return has("deploy") || args.includes("delete") ? ask("выкладка или удаление в Google Cloud") : OK;
    case "heroku":
      return args.some((a) => /^(releases:rollback|apps:destroy|container:release)/.test(a)) ? ask("выкладка через Heroku") : OK;
    case "docker":
      return has("push") ? ask("публикация образа Docker") : OK;
    case "terraform":
    case "tofu":
      return has("apply", "destroy", "import") ? ask("изменение инфраструктуры") : OK;
    case "kubectl":
      return has("apply", "delete", "rollout", "scale", "replace", "patch") ? ask("изменение кластера") : OK;
    case "helm":
      return has("install", "upgrade", "uninstall", "rollback", "delete") ? ask("изменение кластера") : OK;
    case "aws":
      // new machines and resources ("aws ec2 run-instances") cost money
      if (args.some((a) => /^(run-instances|start-instances|request-spot-|purchase-|allocate-|create-(?!invalidation))/.test(a))) return ask("создание ресурсов в AWS — это траты");
      return args[0] === "s3" && ["cp", "sync", "mv", "rm", "rb"].includes(args[1] ?? "") ? ask("запись в облачное хранилище") : args.some((a) => /^(delete|terminate|create-invalidation|put)/.test(a)) ? ask("изменение в AWS") : OK;
  }
  return OK;
}

// osascript: `do shell script "…"` runs /bin/sh, so it goes through the same rules, or a push to main, rm or reading
// the token would pass without a button. A command assembled from parts can't be parsed, so ask; the same for
// controlling Terminal (closing or typing into tabs) and keystrokes.
function osascriptRules(t: string[], ctx: PolicyContext, depth: number): Verdict {
  const code = t
    .slice(1)
    .filter((x, k, a) => a[k - 1] === "-e")
    .join("\n");
  if (!code) return t.slice(1).some((x) => !x.startsWith("-")) ? ask("скрипт AppleScript из файла — что в нём, не видно") : OK;
  let v: Verdict = OK;
  for (const m of code.matchAll(/do (?:shell )?script\s+("(?:[^"\\]|\\.)*"|[^\s"])/gi)) {
    if (!m[1].startsWith('"') || /^"[^"]*"\s*&/.test(code.slice(m.index! + m[0].length - m[1].length))) v = worst(v, ask("osascript запускает команду, собранную из частей, — что именно, не видно"));
    else if (depth < 4) v = worst(v, classifyBashDepth(m[1].slice(1, -1).replace(/\\(["\\])/g, "$1"), ctx, depth + 1));
  }
  if (/doShellScript/.test(code)) v = worst(v, ask("osascript запускает команду оболочки — что именно, не видно"));
  // listing windows is fine; opening, closing or typing would disturb sessions
  if (/application\s+"(Terminal|iTerm2?)"/i.test(code) && /\b(do script|close|quit|set|delete|keystroke|key code|activate|launch|make new|reopen|run)\b/i.test(code)) v = worst(v, ask("управление Терминалом — может закрыть или потревожить сессии"));
  if (/"System Events"/i.test(code) && /\b(keystroke|key code|click)\b/i.test(code)) v = worst(v, ask("нажатия клавиш через System Events"));
  return v;
}

// parseShell marks redirection targets and stdin (heredoc, here-string); here they are split from the arguments
function split(t0: string[]) {
  const writes: string[] = [];
  const appends: string[] = [];
  const stdin: string[] = [];
  const t: string[] = [];
  for (const x of t0) {
    if (x.startsWith("\u0000WRITE:")) writes.push(x.slice(7));
    else if (x.startsWith("\u0000STDIN:")) stdin.push(x.slice(7));
    else if (x.startsWith("\u0000APPEND:")) appends.push(x.slice(8));
    else t.push(x);
  }
  return { t, writes, appends, stdin: stdin.join("\n") };
}

// Where a session doesn't write without asking: login and autostart (keys, shell profiles, launch agents), settings of
// Claude Code and other programs, secrets, system folders, and the architect's own folder (writing its state would
// impersonate the owner). Everything else is ordinary work: sessions may do anything except delete, push to main,
// deploy, spend money or email people.
const SENSITIVE_TARGET =
  /(^|\/)\.(ssh|gnupg|aws|config|docker|kube)(\/|$)|(^|\/)\.claude\/(settings[\w.-]*\.json$|CLAUDE\.md$|keybindings\.json$|hooks|plugins|agents|commands|skills|\.credentials)|(^|\/)\.claude\.json$|authorized_keys|id_(rsa|ed25519|ecdsa)|(^|\/)\.(zshrc|zprofile|zshenv|zlogin|zlogout|bashrc|bash_profile|profile|login|netrc|npmrc|pypirc|gitconfig)$|(^|\/)\.env(\.\w+)?$|\.(pem|key|p12)$|(^|\/)Library\/(LaunchAgents|LaunchDaemons|Keychains)(\/|$)|^\/(private\/)?(etc|Library|System|usr|bin|sbin)\//;
function targetVerdict(w: string, ctx: PolicyContext, what: "перезапись" | "дописывание"): Verdict {
  if (/^\/dev\/(null|stdout|stderr|tty)$|^&?[0-9]$/.test(w)) return OK;
  if (SENSITIVE_TARGET.test(w)) return ask(`${what} служебного файла`);
  const abs = w.startsWith("~") ? join(homedir(), w.slice(1)) : resolve(ctx.cwd, w);
  if (ctx.cwd !== ctx.archHome && (abs === ctx.archHome || abs.startsWith(ctx.archHome + "/"))) return ask("запись в папку архитектора");
  return OK;
}

// Commands for which a heredoc body is plain data: text for cat or grep, a commit message
const STDIN_DATA = new Set(["cat", "tee", "grep", "egrep", "fgrep", "rg", "sed", "awk", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "jq", "yq", "column", "base64", "pbcopy", "git", "gh"]);

function commandRules(t0: string[], ctx: PolicyContext, hosting: RegExp, depth: number, piped = false): Verdict {
  const { t: t1, writes, appends, stdin } = split(t0);
  const t = stripPrefixes(t1);
  let v: Verdict = OK;
  // environment variables through which git runs a program (GIT_SSH_COMMAND=… git fetch), as with git -c core.sshCommand
  if (t1.some((x) => /^GIT_(SSH_COMMAND|SSH|ASKPASS|EDITOR|SEQUENCE_EDITOR|PAGER|EXTERNAL_DIFF|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+)=/.test(x))) v = worst(v, ask("git запускает программу из переменной окружения"));
  for (const w of writes) v = worst(v, targetVerdict(w, ctx, "перезапись"));
  // "> file" with no command empties the file: a deletion that bypasses rm
  if (!t.length || t[0] === ":" || t[0] === "true") for (const w of writes) if (!SAFE_RM.test(w) && !/^\/dev\//.test(w)) v = worst(v, ask("удаление содержимого файла"));
  for (const w of appends) v = worst(v, targetVerdict(w, ctx, "дописывание"));
  // A heredoc body is plain data for data commands; for an interpreter (python3 - <<EOF) the code check below applies;
  // for anything else (a shell, sudo -s, ssh, an unknown program) it is checked as commands, to be safe.
  const codeFromStdin = !!stdin && INTERPRETERS.has(basename(t[0] ?? "")) && !/^(bash|sh|zsh|dash|fish)$/.test(basename(t[0] ?? "")) && (t.includes("-") || !t.slice(1).some((x) => !x.startsWith("-")));
  if (stdin && depth < 4 && !codeFromStdin && !STDIN_DATA.has(basename(t[0] ?? ""))) v = worst(v, classifyBashDepth(stdin, ctx, depth + 1));
  if (!t.length) return v;
  const cmd = basename(t[0]);
  const raw = " " + t.join(" ");

  // the architect's secrets: the whole state folder is off limits, by absolute path, relative path or cd
  const stateDir = ctx.archHome + "/state";
  const touchesState = (x: string) => x.includes(stateDir) || x.includes("hook-secret") || /(^|\/)state\/(hook-secret|owner\.json|worker-settings\.json|updates\.json|workers\.json)/.test(x) || ((ctx.cwd === ctx.archHome || ctx.cwd.startsWith(ctx.archHome + "/")) && /^(\.\/)?state(\/|$)/.test(x)) || (cmd === "cd" && (x === "state" || x === ctx.archHome || x === "./state"));
  if (t.some(touchesState)) v = worst(v, deny("служебные секреты архитектора не читаются"));
  if (cmd === "security") {
    const sub = t[1] ?? "";
    if (/^(dump-keychain|export)$/.test(sub)) v = worst(v, deny("выгрузка связки ключей запрещена"));
    // every Keychain item with the architect's service name: token, hook secret, relay key, manager key
    if (/^find-(generic|internet)-password$/.test(sub) && t.some((x) => x.includes(ctx.keychainService) || /^Claude Code/i.test(x)))
      v = worst(v, deny("токены архитектора и Claude из связки ключей не читаются"));
    else if (/^find-(generic|internet)-password$/.test(sub) && !t.includes("-s")) v = worst(v, ask("запрос в связку ключей без имени службы — может вернуть секрет архитектора"));
    // a service name built by substitution ("$(printf archi-telegram)-architect", "$S") would slip past the check above
    else if (/^find-(generic|internet)-password$/.test(sub) && t.slice(2).some((x) => /[$`]/.test(x))) v = worst(v, ask("имя записи связки ключей подставляется командой — может скрывать токен архитектора"));
    if (/^delete-/.test(sub)) v = worst(v, ask("удаление из связки ключей"));
  }

  // direct hosting access
  if (/^(lftp|ftp|sftp|ncftp|curlftpfs|lftp-get)$/.test(cmd)) v = worst(v, deny("прямой доступ к хостингу запрещён — выкладка только конвейерами репозиториев"));
  if (/^(scp|rsync|ssh|sshpass|sftp)$/.test(cmd)) {
    // Refused for the hosting pattern and for any other remote target (an IP, a ~/.ssh/config alias): there is no
    // legitimate deploy over ssh, and the real host can't be told from the string. For ssh the first non-option is the
    // host (for sshpass, after its options and "ssh"); the rest is the remote command.
    const sshHost = (() => {
      let a = t.slice(1);
      if (cmd === "sshpass") a = a.slice(a.indexOf("ssh") + 1);
      let i = 0;
      while (i < a.length && a[i].startsWith("-")) i += /^-[pliJoFbcDEeILmOQRSWw]$/.test(a[i]) ? 2 : 1;
      return a[i] ?? "";
    })();
    const remote = /^(scp|rsync|sftp)$/.test(cmd) ? t.slice(1).some((x) => /^[\w.@-]+:(\S|$)/.test(x) && !/^[a-z]:\\/i.test(x)) : !!sshHost && !/^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(sshHost.replace(/^.*@/, ""));
    if (hosting.test(raw)) v = worst(v, deny("прямой доступ к хостингу запрещён — выкладка только конвейерами репозиториев"));
    else if (remote) v = worst(v, deny("ssh/scp/rsync на удалённые машины запрещены: выкладка только конвейерами репозиториев"));
    else if (cmd === "ssh" && sshHost && depth < 4) {
      // ssh localhost "git push origin main" runs on this same Mac
      const rest = t.slice(t.indexOf(sshHost) + 1).join(" ");
      if (rest) v = worst(v, classifyBashDepth(rest, ctx, depth + 1));
    }
  }
  if (cmd === "curl" || cmd === "wget" || cmd === "http" || cmd === "xh") v = worst(v, curlRules(t, raw, hosting));

  // wrappers: bash -c "…", eval, xargs, find -exec
  if (INTERPRETERS.has(cmd)) {
    const shell = /^(bash|sh|zsh|dash|fish)$/.test(cmd);
    const ci = t.findIndex((x, k) => k > 0 && (x === "-c" || x === "-lc" || x === "-ic"));
    if (shell && ci > 0 && t[ci + 1] && depth < 4) v = worst(v, classifyBashDepth(t[ci + 1], ctx, depth + 1));
    // inline code in another language (-c/-e, or stdin as in python3 - <<EOF) can't be parsed: ask about deletes and
    // the owner's business in it
    const codeIdx = t.findIndex((x, k) => k > 0 && /^(-c|-e|--eval|-p|-r)$/.test(x));
    const code = shell ? "" : [codeIdx > 0 ? t.slice(codeIdx + 1).join(" ") : "", codeFromStdin ? stdin : ""].join("\n").trim();
    if (code && CODE_DELETES.test(code)) v = worst(v, ask("удаление файлов из кода"));
    if (code && CODE_OWNER_DEEDS.test(code)) v = worst(v, ask("код запускает удаление, push, выкладку или письмо"));
    // `… | sh`, `curl … | bash`: what runs is not visible
    if (shell && piped && !t.slice(1).some((x) => !x.startsWith("-"))) v = worst(v, ask("исполнение потока в оболочке — что именно, не видно"));
    const script = t.slice(1).find((x) => !x.startsWith("-"));
    if (script && DEPLOY_SCRIPT.test(script)) v = worst(v, ask("скрипт выкладки"));
  }
  if (cmd === "eval" && depth < 4) v = worst(v, classifyBashDepth(t.slice(1).join(" "), ctx, depth + 1));
  // watch and script run a command of their own (watch "git push origin main")
  if (cmd === "watch" && depth < 4) {
    let i = 1;
    while (i < t.length && t[i].startsWith("-")) i += /^-(n|d|-interval|-differences)$/.test(t[i]) ? 2 : 1;
    if (i < t.length) v = worst(v, classifyBashDepth(t.slice(i).join(" "), ctx, depth + 1));
  }
  if (cmd === "script" && depth < 4) {
    let i = 1;
    while (i < t.length && t[i].startsWith("-")) i += /^-(F|t|T)$/.test(t[i]) ? 2 : 1;
    if (i + 1 < t.length) v = worst(v, commandRules(t.slice(i + 1), ctx, hosting, depth + 1));
  }
  if (cmd === "parallel" || cmd === "expect") v = worst(v, ask(`${cmd} запускает команды — что именно, не разобрать`));
  if (cmd === "xargs") {
    let i = 1;
    while (i < t.length && t[i].startsWith("-")) i += /^-(n|I|P|L|s|d|E)$/.test(t[i]) ? 2 : 1;
    if (i < t.length) v = worst(v, commandRules(t.slice(i), ctx, hosting, depth + 1));
  }
  if (cmd === "find") {
    if (t.includes("-delete")) v = worst(v, ask("удаление файлов"));
    const ei = t.findIndex((x) => x === "-exec" || x === "-execdir" || x === "-ok" || x === "-okdir");
    if (ei > 0) {
      const endI = t.findIndex((x, k) => k > ei && (x === ";" || x === "+"));
      v = worst(v, commandRules(t.slice(ei + 1, endI < 0 ? undefined : endI), ctx, hosting, depth + 1));
    }
  }

  if (DEPLOY_SCRIPT.test(t[0]) && (t[0].includes("/") || /\.(sh|py)$/.test(t[0]))) v = worst(v, ask("скрипт выкладки"));
  if (cmd === "git") v = worst(v, gitRules(t, ctx));
  if (cmd === "gh") v = worst(v, ghRules(t, raw));
  if (["rm", "rmdir", "unlink", "trash", "srm", "shred"].includes(cmd)) {
    const targets = t.slice(1).filter((x) => !x.startsWith("-"));
    if (!targets.length || !targets.every((x) => SAFE_RM.test(x) && !x.split("/").includes(".."))) v = worst(v, ask("удаление файлов"));
  }
  // destruction by other means: mv to /dev/null or over a file, truncate, overwrite, recursive chmod/chown
  if (cmd === "mv") {
    const targets = t.slice(1).filter((x) => !x.startsWith("-"));
    const dest = targets[targets.length - 1] ?? "";
    if (dest === "/dev/null" || targets.length < 2) v = worst(v, ask("удаление через mv"));
    else if (targets.slice(0, -1).some((x) => !SAFE_RM.test(x)) && !/\/$/.test(dest) && !SAFE_RM.test(dest)) v = worst(v, ask("перемещение файла с возможной перезаписью"));
  }
  if (cmd === "truncate" || (cmd === "dd" && t.some((x) => /^of=/.test(x) && !SAFE_RM.test(x.slice(3)) && !/^of=\/dev\/null$/.test(x)))) v = worst(v, ask("перезапись файла"));
  if (cmd === "tee") for (const f of t.slice(1).filter((x) => !x.startsWith("-"))) v = worst(v, t.some((x) => x === "-a" || x === "--append") ? targetVerdict(f, ctx, "дописывание") : targetVerdict(f, ctx, "перезапись")); // tee writes like ">", with -a like ">>"
  if (/^(chmod|chown|chflags)$/.test(cmd) && t.some((x) => /^-[a-zA-Z]*R/.test(x))) v = worst(v, ask("рекурсивная смена прав"));
  // exfiltration through an ordinary request: command substitution or data in an outbound URL
  if (/^(curl|wget|http|xh)$/.test(cmd)) {
    const outbound = t.some((x) => /^(https?:\/\/)?(?!localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)[\w.-]+\.[a-z]{2,}([:/?]|$)/i.test(x) || /^https?:\/\/\d+\.\d+\.\d+\.\d+/.test(x));
    // Data leaving the Mac: command substitution anywhere, or a variable in the query or the request body.
    // A variable in the URL path is an ordinary download (…/$REF/$path).
    const leaks = t.some((x, i) => /\$\(|`/.test(x) || (/\$\{?[A-Za-z_]/.test(x) && (/[?=#&][^\s]*\$\{?[A-Za-z_]/.test(x) || /^(-d|--data(-[\w-]+)?|-F|--form|-T|--upload-file|--json)$/.test(t[i - 1] ?? ""))));
    if (outbound && leaks) v = worst(v, ask("запрос наружу с подстановкой данных"));
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(cmd)) {
    const a1 = t[1] ?? "";
    const script = a1 === "run" || a1 === "run-script" ? t[2] ?? "" : a1;
    if (DEPLOY_WORD.test(script)) v = worst(v, ask("выкладка"));
    if (a1 === "publish" || (cmd === "bun" && a1 === "publish")) v = worst(v, ask("публикация пакета"));
  }
  if (cmd === "npx" || cmd === "bunx" || cmd === "pnpx") v = worst(v, commandRules(t.slice(1).filter((x, k) => k > 0 || !x.startsWith("-")), ctx, hosting, depth + 1));
  if (cmd === "make" && t.slice(1).some((x) => DEPLOY_WORD.test(x))) v = worst(v, ask("выкладка"));
  v = worst(v, deployCli(cmd, t));

  // email and messages to people
  if (["sendmail", "mail", "mailx", "msmtp", "mutt"].includes(cmd)) v = worst(v, ask("письмо людям"));
  if (cmd === "osascript" && /\b(Mail|Messages|Outlook|Telegram|WhatsApp)\b/.test(raw)) v = worst(v, ask("сообщение людям через приложение Mac"));
  if (cmd === "osascript") v = worst(v, osascriptRules(t, ctx, depth));

  // spending
  if (/rapidata.*\b(launch|order|create)\b/i.test(raw)) v = worst(v, ask("трата денег (Rapidata)"));
  if (ctx.spendPattern && new RegExp(ctx.spendPattern, "i").test(raw)) v = worst(v, ask("трата денег"));

  // other sessions and processes, the architect's service, the machine
  if (cmd === "claude" && ["stop", "kill", "rm", "respawn", "purge"].includes(t[1] ?? "")) v = worst(v, ask(`claude ${t[1]} — вмешательство в сессии`));
  if (cmd === "claude" && t[1] === "daemon" && t[2] === "stop") v = worst(v, ask("остановка всех фоновых сессий"));
  if (cmd === "pkill" || cmd === "killall") v = worst(v, ask("массовая остановка процессов"));
  if (cmd === "kill" && t.slice(1).some((x) => x === "-1" || x === "0")) v = worst(v, ask("остановка всех процессов"));
  if (cmd === "launchctl" && /^(bootout|unload|remove|disable|kill|stop)$/.test(t[1] ?? "")) v = worst(v, ask("остановка служб macOS"));
  if ((cmd === "arch" || cmd === "archi" || t[0].endsWith("/bin/arch")) && ["off", "stop", "restart", "token", "pair", "uninstall"].includes(t[1] ?? "")) v = worst(v, ask("управление архитектором"));
  if (t.some((x) => /(^|\/)src\/secret\.ts$/.test(x))) v = worst(v, ask("секреты архитектора"));
  if (["shutdown", "reboot", "halt"].includes(cmd) || (cmd === "diskutil" && /erase|partition|reformat/i.test(raw)) || cmd === "mkfs") v = worst(v, ask("опасная операция с машиной"));
  if (cmd === "crontab" && !t.includes("-l")) v = worst(v, ask("установка расписания без надзора"));
  return v;
}

function classifyBashDepth(command: string, ctx: PolicyContext, depth: number): Verdict {
  const hosting = new RegExp(ctx.hostingPattern, "i");
  const { commands, nested, piped } = parseShell(command);
  let v: Verdict = OK;
  // Variables set in the same line (S="/private/tmp/…" && rm "$S"/*.png) are substituted, so cleaning up drafts in a
  // temp folder needs no button. Values that contain substitutions are not used.
  const vars = new Map<string, string>();
  commands.forEach((c, i) => {
    const sets = c[0] === "export" ? c.slice(1) : c;
    if (sets.length && sets.every((w) => /^[A-Za-z_]\w*=/.test(w)))
      for (const w of sets) {
        const k = w.slice(0, w.indexOf("="));
        const val = w.slice(w.indexOf("=") + 1);
        // $(mktemp -d) without a path template is always a fresh temp folder: writing there needs no question
        const tmp = val.replace(/^\$\(mktemp(?:\s+-d)?(?:\s+-t\s+[\w.-]+)?\)/, "/private/tmp/mktemp");
        if (/[$`]/.test(tmp)) vars.delete(k);
        else vars.set(k, tmp);
      }
    const t = vars.size ? c.map((w) => w.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (m, a, b) => vars.get(a ?? b) ?? m)) : c;
    v = worst(v, commandRules(t, ctx, hosting, depth, piped?.has(i)));
  });
  if (depth < 4) for (const n of nested) v = worst(v, classifyBashDepth(n, ctx, depth + 1));
  return v;
}

export function classifyBash(command: string, ctx: PolicyContext): Verdict {
  return classifyBashDepth(command, ctx, 0);
}

// The verdict of one command from parseShell; the decision brief uses it to find the command in a chain that asks
export function classifyCommand(t: string[], ctx: PolicyContext): Verdict {
  return commandRules(t, ctx, new RegExp(ctx.hostingPattern, "i"), 0);
}

export function classifyTool(tool: string, input: Record<string, unknown>, ctx: PolicyContext): Verdict {
  if (tool === "Bash") return classifyBash(String(input?.command ?? ""), ctx);
  if (!tool.startsWith("mcp__")) return OK;
  const t = tool.toLowerCase();
  if (/(send|reply|forward|post)(_|$)|_(send|reply|forward|post)/.test(t) && /(mail|gmail|message|slack|telegram|whatsapp|sms|email|chat)/.test(t)) return ask("письмо или сообщение людям");
  if (/gmail/.test(t) && /(send|reply|forward)/.test(t)) return ask("письмо людям");
  if (/(delete|remove|drop|destroy|purge|trash)/.test(t)) return ask("удаление через инструмент");
  if (/(purchase|payment|checkout|charge|_pay|pay_|order_create|create_order)/.test(t)) return ask("трата денег");
  return OK;
}

// The current git branch, read synchronously (for a bare "push" and "reset --hard")
export function gitBranchSync(cwd: string): string {
  try {
    const p = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { stdout: "pipe", stderr: "ignore" });
    return p.exitCode === 0 ? p.stdout.toString().trim() : "";
  } catch {
    return "";
  }
}
