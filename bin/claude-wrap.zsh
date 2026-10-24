# Перезапуск сессии Claude Code на месте — в той же вкладке Терминала, с тем же разговором, на нынешней версии.
# Подключается одной строкой в ~/.zshrc:  source "<папка архитектора>/bin/claude-wrap.zsh"
# Архитектор пишет номер разговора (и, если нужно, реплику) в $dir/<pid оболочки> и завершает процесс claude; оболочка
# сразу поднимает `claude --resume <номер> [реплика]` здесь же. Подкоманды (agents, attach, logs, -p и т. п.) идут как есть.
claude() {
  case "$1" in
    agents|attach|logs|stop|kill|rm|respawn|update|upgrade|install|doctor|mcp|plugin|plugins|auth|setup-token|purge|ultrareview|import|auto-mode|gateway|remote-control|-p|--print|-v|--version|-h|--help|--bg|--background)
      command claude "$@"; return ;;
  esac
  local dir="${CLAUDE_RESTART_DIR:-$HOME/.claude/architect/restart}"
  command mkdir -p -- "$dir"
  local flag="$dir/$$" mark="$dir/$$.tab"
  print -r -- "v2 $PWD" >| "$mark"   # v2 — умеет подниматься с репликой; по метке хост знает, что можно передать
  command claude "$@"
  local rc=$?
  # в файле: первая строка — номер разговора, дальше — необязательная реплика владельца (или /goal …), с которой
  # разговор поднимается: так слово владельца из Telegram приходит сессии его репликой, в её же вкладке
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

# «archi adopt <имя>» — перевести сессию из старой вкладки (открытой до этой обёртки) сюда: старый процесс
# завершается, здесь поднимается тот же разговор, и дальше архитектор перезапускает её с телефона. Остальное — как есть.
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
