#!/bin/sh
# Архитектор — установка на Mac одной командой:  curl -fsSL __DIST__/i | sh
# Ставит в ~/.archi код хоста и свой config.json, подключает Telegram по QR (src/connect.ts), включает автозапуск.
# Вход в Claude — только окном Anthropic (claude auth login): этот скрипт и сервер его не видят.
# Адреса раздачи и ящика, имя бота-менеджера, его ключ и контрольная сумма кода вшиваются при сборке раздачи
# (bun src/guest.ts dist). Снять всё одной командой: archi uninstall.
# Язык — тот же, что у бота, собравшего раздачу (__LANG__); ARCHI_LANG=en|ru — свой. Он же уходит в config.json.
# Всё тело — в main: если загрузка оборвётся на середине, обрывок не выполнится.
set -eu

main() {
  L="${ARCHI_LANG:-__LANG__}"
  case "$L" in en) ;; *) L=ru ;; esac
  DIST="${ARCHI_DIST:-__DIST__}"
  RELAY="${ARCHI_RELAY:-__RELAY__}"
  MANAGER="__MANAGER__"
  KEY="__KEY__"
  SHA="__SHA256__"
  DIR="$HOME/.archi"
  APP="$DIR/app"
  # Вопросы — с клавиатуры, даже когда сам скрипт пришёл через «| sh»; без терминала спрашивать некого
  TTY=/dev/tty
  (: <"$TTY") 2>/dev/null || die "$(t "Запустите команду в Терминале macOS." "Run the command in macOS Terminal.")"

  printf '\n'; bold "$(t "Архитектор — установка на этот Mac" "Architect — installing on this Mac")"; printf '\n'
  [ "$(uname -s)" = Darwin ] || die "$(t "Нужен macOS." "macOS is required.")"

  # Claude Code — свой, со своим входом
  if ! command -v claude >/dev/null 2>&1; then
    printf '%s' "$(t '  Claude Code не найден. Поставить официальным установщиком Anthropic? Enter — да, Ctrl-C — нет. ' '  Claude Code isn’t installed. Install it with the official Anthropic installer? Enter — yes, Ctrl-C — no. ')"
    read -r _ <"$TTY"
    remote https://claude.ai/install.sh || die "$(t "Claude Code не поставился." "Claude Code didn’t install.")"
    PATH="$HOME/.local/bin:$PATH"
  fi
  if ! claude auth status >/dev/null 2>&1; then
    row "Claude Code  " "$(t "нужен вход — откроется окно Anthropic" "sign-in needed — an Anthropic window will open")"
    claude auth login <"$TTY" || die "$(t "Вход в Claude не выполнен." "Claude sign-in didn’t complete.")"
  fi
  plan="$(claude auth status 2>/dev/null | sed -n 's/.*"subscriptionType" *: *"\([^"]*\)".*/\1/p' | head -n 1 | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"
  ok "Claude Code  " "$(t "вход выполнен${plan:+, подписка $plan}" "signed in${plan:+, $plan plan}")"

  # Bun — среда хоста (нужен 1.2 или новее: текстовый bun.lock)
  if ! command -v bun >/dev/null 2>&1; then
    [ -x "$HOME/.bun/bin/bun" ] || remote https://bun.sh/install >/dev/null 2>&1 || die "$(t "Bun не поставился." "Bun didn’t install.")"
    PATH="$HOME/.bun/bin:$PATH"
  fi
  v="$(bun --version)"
  case "$v" in 0.* | 1.0.* | 1.1.*) die "$(t "Нужен Bun 1.2 или новее, сейчас $v. Обновите: bun upgrade" "Bun 1.2 or newer is required, you have $v. Update it: bun upgrade")" ;; esac
  ok "Bun          " "$v"

  # Код хоста: сверяем контрольную сумму раздачи
  mkdir -p "$DIR" && chmod 700 "$DIR"
  tmp="$(mktemp -d "$DIR/.new.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$DIST/archi.tgz" -o "$tmp/archi.tgz" || die "$(t "Код не скачался." "The code didn’t download.")"
  [ "$(shasum -a 256 "$tmp/archi.tgz" | cut -d' ' -f1)" = "$SHA" ] || die "$(t "Код не совпал с раздачей — установка остановлена." "The code doesn’t match the distribution — installation stopped.")"
  mkdir "$tmp/app" && tar -xzf "$tmp/archi.tgz" -C "$tmp/app"
  (cd "$tmp/app" && bun install --frozen-lockfile --production >"$tmp/install.log" 2>&1) || die "$(t "Не поставились зависимости" "Dependencies didn’t install"): $(tail -n 3 "$tmp/install.log")"
  # Обновление: прежняя версия уходит в app.old целиком и возвращает настройки, состояние, журналы и заметки.
  # Оборвётся посередине — всё лежит в ~/.archi/app.old.
  if [ -d "$APP" ]; then
    "$APP/bin/arch" off >/dev/null 2>&1 || true
    rm -rf "$DIR/app.old" && mv "$APP" "$DIR/app.old"
  fi
  mv "$tmp/app" "$APP" && touch "$APP/.installed-by-archi"
  if [ -d "$DIR/app.old" ]; then
    for k in config.json state logs notes; do
      if [ -e "$DIR/app.old/$k" ]; then mv "$DIR/app.old/$k" "$APP/"; fi
    done
    rm -rf "$DIR/app.old"
  fi
  [ -f "$APP/config.json" ] || cat >"$APP/config.json" <<JSON
{
  "label": "app.archi.host",
  "lang": "$L",
  "keychainService": "archi-telegram",
  "keychainAccount": "archi",
  "hookPort": 47300,
  "roots": ["~"],
  "architect": { "model": "opus", "effort": "high" },
  "workers": { "model": "opus", "effort": "high" },
  "githubOwner": "",
  "sites": [],
  "repos": [],
  "hostingPattern": "",
  "richMessages": true,
  "setupDone": false
}
JSON
  row "$(t "Код          " "Code         ")" "~/.archi/app"
  printf '\n'

  # Telegram — по QR и коду с экрана, ключ бота приходит на этот Mac зашифрованным
  if [ ! -f "$APP/state/owner.json" ]; then
    bun "$APP/src/connect.ts" "$MANAGER" "$KEY" "$RELAY" <"$TTY" || exit 1
  fi

  # Автозапуск при входе в macOS и команда archi (чужую команду с таким именем не трогаем)
  mkdir -p "$HOME/.local/bin"
  link="$HOME/.local/bin/archi"
  if [ ! -e "$link" ] || case "$(readlink "$link" 2>/dev/null)" in "$DIR"/*) true ;; *) false ;; esac; then
    ln -sf "$APP/bin/arch" "$link"
  fi
  out="$("$APP/bin/arch" on 2>&1)" || die "$(t "Архитектор не запустился" "Architect didn’t start"): $out"
  bot="$(sed -n 's/.*"username": *"\([^"]*\)".*/\1/p' "$APP/state/bot.json" 2>/dev/null | head -n 1)"
  printf '\n'
  row "$(t "Бот          " "Bot          ")" "@$bot — $(t "откройте его в Telegram" "open it in Telegram")"
  row "$(t "Автозапуск   " "Autostart    ")" "$(t "при входе в macOS" "at macOS login")"
  row "$(t "Команды      " "Commands     ")" "archi status, archi off, archi uninstall"
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) row "             " "$(t "команда archi лежит в ~/.local/bin — этой папки нет в PATH" "the archi command is in ~/.local/bin — that folder isn’t in your PATH")" ;; esac
  printf '\n'
}

# сообщение — на языке установки: t "по-русски" "in English"
t() { if [ "$L" = en ]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }
# подписи слева выровнены пробелами вручную: printf считает байты, а кириллица — по два байта на букву
bold() { printf '\033[1m%s\033[0m\n' "$1"; }
row() { printf '  %s %s\n' "$1" "$2"; }
ok() { printf '  %s \033[32m%s\033[0m\n' "$1" "$2"; }
die() { printf '\n\033[31m%s\033[0m\n' "$1" >&2; exit 1; }
# Чужой установщик (Anthropic, Bun): сначала целиком скачать, потом запустить — без «curl | bash» и его тихих обрывов
remote() {
  f="$(mktemp)"
  if curl -fsSL "$1" -o "$f"; then bash "$f"; r=$?; else r=1; fi
  rm -f "$f"
  return $r
}

main "$@"
