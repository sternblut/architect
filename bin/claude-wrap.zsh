# Lets the architect restart a Claude Code session in place: same Terminal tab, same conversation, current version.
# Enable with one line in ~/.zshrc:  source "<architect folder>/bin/claude-wrap.zsh"
# The architect writes the session id (and optionally a message) to $dir/<shell pid> and ends the claude process;
# the shell then runs `claude --resume <id> [message]` right here. A `claude attach` tab attaches again after the
# architect restarts its session. Other subcommands (agents, logs, -p, ...) pass through.
claude() {
  local dir="${CLAUDE_RESTART_DIR:-$HOME/.claude/architect/restart}"
  case "$1" in
    attach)
      # The tab follows its background session. To give it the owner's own message (/goal, «принято») the architect
      # restarts it, which ends this attach with "Session … has exited". Before that it writes the session id to
      # $dir/<shell pid>.reattach, and a second line "go" once the session is back; the tab then attaches again.
      command mkdir -p -- "$dir"
      local mark="$dir/$$.attach" again="$dir/$$.reattach" rc i id
      command rm -f -- "$again"
      print -r -- "v1 $2" >| "$mark"   # v1: attaches again after a restart; the host checks this mark
      command claude "$@"
      rc=$?
      while [[ -f $again ]]; do
        for i in {1..120}; do [[ $(command sed -n 2p -- "$again") == go ]] && break; sleep 1; done
        id=$(command sed -n 1p -- "$again")
        command rm -f -- "$again"
        command claude attach "$id"
        rc=$?
      done
      command rm -f -- "$mark"
      return $rc ;;
    agents|logs|stop|kill|rm|respawn|update|upgrade|install|doctor|mcp|plugin|plugins|auth|setup-token|purge|ultrareview|import|auto-mode|gateway|remote-control|-p|--print|-v|--version|-h|--help|--bg|--background)
      command claude "$@"; return ;;
  esac
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
