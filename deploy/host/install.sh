#!/bin/bash
# Installs OpenMausBot on an Ubuntu server as a systemd service run by the user `maus`, with the bot box (bubblewrap)
# on and rootless Podman for the bots' Local VM desktops. It can bring over the data of a Docker install.
#
#   sudo bash deploy/host/install.sh --public-url https://maus.example.com --proxy-ip 192.168.10.1 [--import-docker]
#
# Run it again to update: it rebuilds from the branch and restarts the service. SERVER-INSTALL.md, part C, explains it.
set -euo pipefail

REPO=https://github.com/devhcit1/OpenMausBot.git
BRANCH=self-hosted-bot-box
CODE=/opt/openmausbot
SERVICE_USER=maus
# The Docker image's HOME: keeping it means the paths saved in the data, and the engines' sessions, which they key by
# folder, stay valid.
SERVICE_HOME=/data
PORT=8080
VOLUME=openmausbot_data
ENGINES="@anthropic-ai/claude-code @openai/codex"
AGENT_BROWSER_VERSION=0.37.0
BROWSER_HOME=/opt/openmausbot-browser
PUBLIC_URL=""
PROXY_IP=""
IMPORT_DOCKER=0
BROWSER=1

say() { printf '\n== %s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
usage: sudo bash deploy/host/install.sh --public-url https://HOST --proxy-ip IP [options]

  --public-url URL     the HTTPS address HAProxy serves (required)
  --proxy-ip IP        the address HAProxy connects from; only it may reach the port (required)
  --port N             the plain-HTTP port HAProxy connects to (default $PORT; the next one carries webhooks)
  --import-docker      stop the Docker install and copy its data volume ($VOLUME) to $SERVICE_HOME
  --volume NAME        the Docker data volume to copy (default $VOLUME)
  --branch NAME        the branch to build (default $BRANCH)
  --repo URL           the repository to build (default $REPO)
  --no-browser         skip the bots' browser (Chrome for Testing)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --public-url) PUBLIC_URL="${2:?}"; shift 2 ;;
    --proxy-ip) PROXY_IP="${2:?}"; shift 2 ;;
    --port) PORT="${2:?}"; shift 2 ;;
    --import-docker) IMPORT_DOCKER=1; shift ;;
    --volume) VOLUME="${2:?}"; shift 2 ;;
    --branch) BRANCH="${2:?}"; shift 2 ;;
    --repo) REPO="${2:?}"; shift 2 ;;
    --no-browser) BROWSER=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

[ "$(id -u)" = 0 ] || die "run it as root: sudo bash $0 ..."
if [ -z "$PUBLIC_URL" ] || [ -z "$PROXY_IP" ]; then usage >&2; exit 2; fi
case "$PUBLIC_URL" in https://*) ;; *) die "--public-url must start with https://" ;; esac
case "$PORT" in ''|*[!0-9]*) die "--port must be a number" ;; esac
if ! command -v systemctl >/dev/null || [ ! -d /run/systemd/system ]; then die "this server does not run systemd"; fi
command -v apt-get >/dev/null || die "this script is for Ubuntu or Debian (apt)"

as_maus() {
  local uid
  uid="$(id -u "$SERVICE_USER")"
  runuser -u "$SERVICE_USER" -- env -i HOME="$SERVICE_HOME" USER="$SERVICE_USER" LOGNAME="$SERVICE_USER" \
    PATH=/usr/local/bin:/usr/bin:/bin XDG_RUNTIME_DIR="/run/user/$uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@"
}

say "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl git bubblewrap socat python3 podman uidmap passt slirp4netns >/dev/null
node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$node_major" -lt 24 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node --version
npm install -g --silent pnpm@10.33.0
pnpm --version

say "the $SERVICE_USER user"
if id "$SERVICE_USER" >/dev/null 2>&1; then
  current_home="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
  [ "$current_home" = "$SERVICE_HOME" ] || die "user $SERVICE_USER exists with home $current_home, not $SERVICE_HOME; remove it or rename it first"
else
  if [ -e "$SERVICE_HOME" ] && [ -n "$(ls -A "$SERVICE_HOME" 2>/dev/null)" ]; then die "$SERVICE_HOME exists and is not empty"; fi
  useradd --home-dir "$SERVICE_HOME" --create-home --shell /bin/bash "$SERVICE_USER"
fi
chown "$SERVICE_USER:$SERVICE_USER" "$SERVICE_HOME"
chmod 700 "$SERVICE_HOME"
# Rootless Podman maps the container's users onto these ranges (newuidmap, shadow-utils).
if ! grep -q "^$SERVICE_USER:" /etc/subuid || ! grep -q "^$SERVICE_USER:" /etc/subgid; then
  start="$(awk -F: 'BEGIN{m=100000} {e=$2+$3; if (e>m) m=e} END{print m}' /etc/subuid /etc/subgid)"
  usermod --add-subuids "$start-$((start + 65535))" --add-subgids "$start-$((start + 65535))" "$SERVICE_USER"
fi
# Without lingering, systemd removes the user's runtime folder, and with it rootless Podman's state, at logout.
loginctl enable-linger "$SERVICE_USER"
uid="$(id -u "$SERVICE_USER")"
for _ in $(seq 1 20); do [ -d "/run/user/$uid" ] && break; sleep 1; done
[ -d "/run/user/$uid" ] || die "systemd did not start $SERVICE_USER's user session (/run/user/$uid)"

say "checks as $SERVICE_USER"
as_maus bwrap --unshare-all --die-with-parent --ro-bind / / --dev /dev --proc /proc true \
  || die "bubblewrap cannot make a sandbox as $SERVICE_USER: the kernel or AppArmor refuses unprivileged user namespaces"
echo "bubblewrap: ok"
[ "$(as_maus podman info --format '{{.Host.Security.Rootless}}')" = true ] || die "rootless Podman does not work as $SERVICE_USER (run: sudo -iu $SERVICE_USER podman info)"
as_maus podman run --rm --quiet docker.io/library/alpine:3.20 true || die "rootless Podman cannot run a container as $SERVICE_USER"
echo "rootless podman: ok"

say "code: $REPO ($BRANCH) in $CODE"
git config --global --add safe.directory "$CODE"
if [ -d "$CODE/.git" ]; then
  git -C "$CODE" fetch -q origin "$BRANCH"
  git -C "$CODE" checkout -q -B "$BRANCH" FETCH_HEAD
else
  git clone -q -b "$BRANCH" "$REPO" "$CODE"
fi
git -C "$CODE" log -1 --format='%h %s'
(
  cd "$CODE"
  export ELECTRON_SKIP_BINARY_DOWNLOAD=1 HOME=/root
  pnpm install --frozen-lockfile --silent
  pnpm build:server >/dev/null
  NODE_OPTIONS=--max-old-space-size=6144 pnpm exec vite build >/dev/null
)
if [ ! -f "$CODE/dist-server/openmausbot.js" ] || [ ! -f "$CODE/dist/index.html" ]; then die "the build did not produce dist-server/ and dist/"; fi
# Security: the server runs this code as maus, and bots can write maus's home; nobody but root may change it.
chown -R root:root "$CODE"
chmod -R go-w "$CODE"
cat > /usr/local/bin/openmausbot <<EOF
#!/bin/sh
export OMB_PORT="\${OMB_PORT:-$PORT}"
exec node $CODE/dist-server/openmausbot.js "\$@"
EOF
chmod 0755 /usr/local/bin/openmausbot

say "engines: $ENGINES"
# Security: with the box on, the server refuses to run programs from maus's home, which bots can write; the engines
# live outside it.
# shellcheck disable=SC2086
npm install -g --silent $ENGINES
for cli in claude codex; do
  if command -v "$cli" >/dev/null; then echo "$cli $("$cli" --version 2>/dev/null | head -1 || true)"; fi
done

browser_env=""
if [ "$BROWSER" = 1 ]; then
  say "the bots' browser"
  if npm install -g --silent "agent-browser@$AGENT_BROWSER_VERSION" \
    && mkdir -p "$BROWSER_HOME" && HOME="$BROWSER_HOME" agent-browser install --with-deps >/dev/null 2>&1; then
    chrome="$(find "$BROWSER_HOME/.agent-browser/browsers" -maxdepth 2 -path '*/chrome-*/chrome' -type f 2>/dev/null | head -1 || true)"
    if [ -n "$chrome" ]; then
      ln -sfn "$chrome" "$BROWSER_HOME/chrome"
      chmod -R go-w "$BROWSER_HOME"
      browser_env="Environment=AGENT_BROWSER_EXECUTABLE_PATH=$BROWSER_HOME/chrome"
      echo "chrome: $chrome"
    fi
  fi
  [ -n "$browser_env" ] || echo "warning: the bots' browser did not install; everything else works. Re-run later, or pass --no-browser."
fi

if [ "$IMPORT_DOCKER" = 1 ]; then
  say "data from the Docker volume $VOLUME"
  [ ! -e "$SERVICE_HOME/.openmausbot" ] || die "$SERVICE_HOME/.openmausbot already exists; this server already has data, so nothing was copied"
  command -v docker >/dev/null || die "--import-docker: docker is not installed here"
  source_dir="$(docker volume inspect -f '{{.Mountpoint}}' "$VOLUME" 2>/dev/null)" || die "no Docker volume named $VOLUME (docker volume ls)"
  server_container="$(docker ps -aq --filter "volume=$VOLUME" | head -1)"
  if [ -n "$server_container" ]; then
    project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$server_container")"
    if [ -n "$project" ]; then docker_containers="$(docker ps -aq --filter "label=com.docker.compose.project=$project" | tr '\n' ' ')"; else docker_containers="$server_container"; fi
    # shellcheck disable=SC2086
    docker update --restart=no $docker_containers >/dev/null
    # shellcheck disable=SC2086
    docker stop $docker_containers >/dev/null
    echo "stopped the Docker install (kept, with its volume, for going back)"
  fi
  cp -a "$source_dir/." "$SERVICE_HOME/"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$SERVICE_HOME"
  echo "copied $(du -sh "$SERVICE_HOME" | cut -f1) to $SERVICE_HOME"
fi

say "the service"
systemctl stop openmausbot 2>/dev/null || true
as_maus node "$CODE/dist-server/openmausbot.js" service install --port "$PORT" --public-url "$PUBLIC_URL" --lan >/dev/null
install -m 644 "$SERVICE_HOME/.openmausbot/openmausbot.service" /etc/systemd/system/openmausbot.service
mkdir -p /etc/systemd/system/openmausbot.service.d
cat > /etc/systemd/system/openmausbot.service.d/host.conf <<EOF
[Unit]
After=user@$uid.service
Wants=user@$uid.service

[Service]
Environment=OMB_BOT_BOX=1
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=XDG_RUNTIME_DIR=/run/user/$uid
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus
Environment="OMB_CLI_PREFIX=sudo -iu $SERVICE_USER openmausbot"
$browser_env
EOF
systemctl daemon-reload
systemctl enable --now openmausbot >/dev/null 2>&1

say "firewall"
webhook_port=$((PORT + 1))
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  for p in "$PORT" "$webhook_port"; do
    ufw allow from "$PROXY_IP" to any port "$p" proto tcp >/dev/null
    ufw deny "$p/tcp" >/dev/null
  done
  echo "ufw: only $PROXY_IP reaches ports $PORT and $webhook_port"
else
  # Security: the server believes X-Forwarded-Proto from whoever reaches the port, so only HAProxy may.
  echo "WARNING: ufw is not active. Allow only $PROXY_IP to reach tcp ports $PORT and $webhook_port, for example:"
  echo "  ufw allow OpenSSH && ufw allow from $PROXY_IP to any port $PORT proto tcp && ufw allow from $PROXY_IP to any port $webhook_port proto tcp && ufw enable"
fi

say "start"
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q openmausbot && break; sleep 2; done
curl -sf "http://127.0.0.1:$PORT/api/health" | grep -q openmausbot || { journalctl -u openmausbot -n 40 --no-pager; die "the server did not answer on port $PORT"; }
echo "health: ok on port $PORT"
for _ in $(seq 1 30); do journalctl -u openmausbot --since "-5min" --no-pager | grep -q "bot box: self-check" && break; sleep 2; done
journalctl -u openmausbot --since "-5min" --no-pager | grep -o "bot box: .*" | tail -2

cat <<EOF

Done. HAProxy's backend stays at this server's address, port $PORT.

  status:    systemctl status openmausbot
  logs:      journalctl -u openmausbot -f
  pair:      sudo -iu $SERVICE_USER openmausbot pair --label "My phone"
  engines:   sudo -iu $SERVICE_USER codex login --device-auth
  update:    sudo bash $CODE/deploy/host/install.sh --public-url $PUBLIC_URL --proxy-ip $PROXY_IP
EOF
if [ -n "${docker_containers:-}" ]; then
  cat <<EOF
  go back:   sudo systemctl disable --now openmausbot
             sudo docker update --restart=unless-stopped $docker_containers && sudo docker start $docker_containers
             (the Docker volume $VOLUME is untouched; delete it only once you are happy)
EOF
fi
