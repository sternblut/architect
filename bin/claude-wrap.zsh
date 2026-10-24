# Lets the architect restart a Claude Code session in place: same Terminal tab, same conversation, current version.
# Enable with one line in ~/.zshrc:  source "<architect folder>/bin/claude-wrap.zsh"
# The architect writes the session id (and optionally a message) to $dir/<shell pid> and ends the claude process;
# the shell then runs `claude --resume <id> [message]` right here. Subcommands (agents, attach, logs, -p, ...) pass through.
claude() {
  case "$1" in
    agents|attach|logs|stop|kill|rm|respawn|update|upgrade|install|doctor|mcp|plugin|plugins|auth|setup-token|purge|ultrareview|import|auto-mode|gateway|remote-control|-p|--print|-v|--version|-h|--help|--bg|--background)
      command claude "$@"; return ;;
  esac
  local dir="${CLAUDE_RESTART_DIR:-$HOME/.claude/architect/restart}"
  command mkdir -p -- "$dir"
  local flag="$dir/$$" mark="$dir/$$.tab"
  print -r -- "v2 $PWD" >| "$mark"   # v2: can resume with a message; the host checks this mark
  command claude "$@"
  local rc=$?
  # First line: session id. The rest: an optional message (or /goal …) to resume with, so the owner's words from
  # Telegram arrive as their own message, in the same tab.
  while [[ -f $flag ]]; do
    local sid prompt
    { IFS= read -r sid; prompt=$(command cat) } < "$flag"
    command rm -f -- "$flag"
    command claude --resume "$sid" ${prompt:+"$prompt"}
    rc=$?
  done
  command rm -f -- "$mark"
  return $rc
}

# "archi adopt <name>": move a session from a tab opened before this wrapper into this one, so the architect can
# restart it from the phone. Other archi commands pass through.
archi() {
  if [[ $1 == adopt ]]; then
    shift
    local out
    out=$(command archi adopt-prepare "$*") || { print -r -- "$out"; return 1; }
    cd -- "${out%%$'\t'*}" && claude --resume "${out#*$'\t'}"
    return
  fi
  command archi "$@"
}
