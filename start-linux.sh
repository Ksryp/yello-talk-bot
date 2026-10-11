#!/usr/bin/env bash
# Start the GME adapter, the API and the owner portal together on Linux.
#
#   ./start-linux.sh            dev portal, everything bound to 127.0.0.1
#   ./start-linux.sh --lan      also reachable from other machines on the LAN
#   ./start-linux.sh --prod     build the portal once and serve the production build
#   ./start-linux.sh --waydroid drive the GmeBot Android app in a running Waydroid
#                               session instead of the native Linux adapter
#   ./start-linux.sh --no-adapter | --no-portal
#
# The native adapter reads GME credentials from .env.gme (Git-ignored, created
# on first run); the Waydroid adapter needs none (they live inside the APK).
# The adapter token is read from config.local.json and generated if empty.
# Logs go to logs/<service>.log. Ctrl+C stops all services.
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$root"

bind=127.0.0.1
portal_mode=dev
adapter_kind=native
run_adapter=1
run_portal=1
for arg in "$@"; do
  case "$arg" in
    --lan) bind=0.0.0.0 ;;
    --prod) portal_mode=prod ;;
    --waydroid) adapter_kind=waydroid ;;
    --no-adapter) run_adapter=0 ;;
    --no-portal) run_portal=0 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

api_port="${PORT:-5353}"
portal_port=5254
config=config.local.json
env_file=.env.gme
adapter_bin=adapters/linux-native/build/gme-music-bot-linux

die() { echo "error: $*" >&2; exit 1; }
info() { echo "==> $*"; }

# ---------- preflight ----------
command -v node >/dev/null || die "Node.js 20.9+ is required"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=9)?0:1)' \
  || die "Node.js 20.9+ is required (found $(node --version))"
command -v curl >/dev/null || die "curl is required"
for tool in yt-dlp ffmpeg; do
  command -v "$tool" >/dev/null || echo "warning: $tool not found on PATH; music requests will fail" >&2
done

[[ -d node_modules ]] || { info "Installing API dependencies"; npm ci; }
if (( run_portal )) && [[ ! -d web-portal-2/node_modules ]]; then
  info "Installing portal dependencies"; npm --prefix web-portal-2 ci
fi

if [[ ! -f "$config" ]]; then
  info "Creating $config from config.example.json"
  (umask 077; cp config.example.json "$config")
fi

if (( run_adapter )); then
  if [[ "$adapter_kind" == native ]]; then
    # The native Linux adapter loads GME credentials from its own environment.
    if [[ ! -f "$env_file" ]]; then
      (umask 077; cat > "$env_file" <<'EOF'
# GME app credentials for the Linux adapter (keep this file private).
GME_SDK_APP_ID=
GME_SDK_KEY=
EOF
)
      die "Fill in $env_file with your GME AppID and 16-character key, then run again (or use --no-adapter)"
    fi
    set -a; . "./$env_file"; set +a
    [[ "${GME_SDK_APP_ID:-}" =~ ^[0-9]+$ ]] || die "GME_SDK_APP_ID in $env_file must be numeric"
    [[ ${#GME_SDK_KEY} -eq 16 ]] || die "GME_SDK_KEY in $env_file must be exactly 16 characters"
  else
    # The Waydroid adapter drives the GmeBot Android app, which carries its own
    # GME credentials inside the APK; this process needs no GME_SDK_* vars.
    command -v waydroid >/dev/null || die "waydroid is not installed"
    waydroid status 2>/dev/null | grep -q 'Session:.*RUNNING' \
      || die "Waydroid session is not running — start it with: waydroid session start"
  fi

  # Reuse adapter.token from the config, generating one if it is empty, so the
  # API and the adapter always agree.
  GME_ADAPTER_TOKEN="$(node -e '
    const fs = require("fs"), crypto = require("crypto"), p = process.argv[1];
    const c = JSON.parse(fs.readFileSync(p, "utf8"));
    c.adapter = c.adapter || {};
    if (String(c.adapter.token || "").trim().length < 32) {
      c.adapter.token = crypto.randomBytes(32).toString("hex");
      fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
      console.error("==> Generated a new adapter.token in " + p);
    }
    process.stdout.write(c.adapter.token);' "$config")"
  export GME_ADAPTER_TOKEN
  adapter_port="$(node -e 'const c=require(process.argv[1]);process.stdout.write(new URL(c.adapter?.baseUrl||"http://127.0.0.1:9876").port||"9876")' "$root/$config")"

  if [[ "$adapter_kind" == native && ( ! -x "$adapter_bin" || adapters/linux-native/main_linux.cpp -nt "$adapter_bin" ) ]]; then
    info "Building the Linux GME adapter"
    bash adapters/linux-native/build_linux.sh >/dev/null
  fi
fi

check_port() { ! ss -ltnH "sport = :$1" 2>/dev/null | grep -q . || die "port $1 is already in use"; }
check_port "$api_port"
(( run_portal )) && check_port "$portal_port"
(( run_adapter )) && check_port "$adapter_port"

if (( run_portal )) && [[ "$portal_mode" == prod ]]; then
  info "Building the portal (production)"
  npm --prefix web-portal-2 run build
fi

# ---------- run ----------
mkdir -p logs
pids=()
tail_pid=
start() { # name, command...
  local name="$1"; shift
  : > "logs/$name.log"
  setsid "$@" >>"logs/$name.log" 2>&1 < /dev/null &
  pids+=("$!")
  info "Started $name (pid $!), log: logs/$name.log"
}

stopping=0
cleanup() {
  (( stopping )) && return; stopping=1
  echo; info "Stopping services"
  for pid in "${pids[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || true; done
  for _ in {1..50}; do
    local alive=0
    for pid in "${pids[@]}"; do kill -0 "$pid" 2>/dev/null && alive=1; done
    (( alive )) || break
    sleep 0.1
  done
  for pid in "${pids[@]}"; do kill -KILL -- "-$pid" 2>/dev/null || true; done
  [[ -n "$tail_pid" ]] && kill "$tail_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

wait_http() { # name, url, [header]
  local name="$1" url="$2" header="${3:-x-none: 1}"
  for _ in {1..120}; do
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' -H "$header" "$url" || true)"
    [[ "$code" != 000 ]] && { info "$name is up: $url"; return 0; }
    sleep 0.5
  done
  echo "warning: $name did not answer at $url within 60s; see logs/$name.log" >&2
}

if (( run_adapter )); then
  if [[ "$adapter_kind" == native ]]; then
    start adapter "$adapter_bin" --port "$adapter_port"
    wait_http adapter "http://127.0.0.1:$adapter_port/health" "x-gme-adapter-token: $GME_ADAPTER_TOKEN"
    sdk="$(curl -fs -H "x-gme-adapter-token: $GME_ADAPTER_TOKEN" "http://127.0.0.1:$adapter_port/status" || true)"
    [[ "$sdk" == *'"sdkLoaded":true'* ]] || echo "warning: adapter is up but the GME SDK did not load; see logs/adapter.log" >&2
  else
    start adapter env GME_ADAPTER_TOKEN="$GME_ADAPTER_TOKEN" node adapters/waydroid/server.js --port "$adapter_port"
    wait_http adapter "http://127.0.0.1:$adapter_port/health" "x-gme-adapter-token: $GME_ADAPTER_TOKEN"
  fi
fi
# The adapter only needs GME credentials; keep them out of the other services.
unset GME_SDK_APP_ID GME_SDK_KEY GME_ADAPTER_TOKEN

start api env HOST="$bind" PORT="$api_port" node server.js
wait_http api "http://127.0.0.1:$api_port/"

if (( run_portal )); then
  if [[ "$portal_mode" == prod ]]; then
    start portal bash -c 'cd web-portal-2 && exec node_modules/.bin/next start -p "$1" -H "$2"' _ "$portal_port" "$bind"
  else
    start portal bash -c 'cd web-portal-2 && exec node_modules/.bin/next dev --webpack -p "$1" -H "$2"' _ "$portal_port" "$bind"
  fi
  wait_http portal "http://127.0.0.1:$portal_port/"
fi

echo
(( run_portal )) && info "Portal: http://localhost:$portal_port  (owner token: $root/owner-token.txt)"
[[ "$bind" == 0.0.0.0 ]] && info "LAN mode: portal and API are reachable from other machines on this network"
info "Following logs. Press Ctrl+C to stop everything."
echo
tail -n +1 -F logs/*.log &
tail_pid=$!

# Stop everything as soon as any service exits.
set +e
wait -n "${pids[@]}"
echo "warning: a service exited; shutting down the rest (check logs/)" >&2
exit 1
