# Installing OpenMausBot on a server behind pfSense + HAProxy

This guide installs OpenMausBot on an Ubuntu server where **pfSense/HAProxy
terminates HTTPS**, so the server itself only speaks plain HTTP on the LAN.

Three ways to run it:

| | A. Docker | B. Local service (systemd) | C. Host service with sandbox and desktops |
|---|---|---|---|
| Bot sandbox | **Yes**: bots can't read the server's keys, settings or each other's files | No: bots run as the service user and can read everything it can | **Yes**, as in A |
| Bot desktops (Local VM) | No | Yes, but unsandboxed | **Yes**, through rootless Podman |
| Version | The `self-hosted-bot-box` branch, built on the server | The published npm release | The `self-hosted-bot-box` branch, built on the server |
| Engines (Claude Code, Codex, Grok) | Baked into the image | Installed by you on the host | Installed by the script |
| Updates | `git pull` + rebuild | `npm install` of the new version | Re-run the script |

Pick **C** if bots need a desktop, otherwise **A**. The rest of this guide
uses these placeholders; replace them everywhere:

| Placeholder | Meaning | Example |
|---|---|---|
| `SERVER_LAN_IP` | This server's LAN address | `192.168.10.20` |
| `PFSENSE_IP` | pfSense's address **as this server sees it** (the interface HAProxy connects from) | `192.168.10.1` |
| `maus02.hcitprofessionals.us` | The public name HAProxy serves | |

---

## A. Docker, with the bot sandbox

### A1. Requirements

- Ubuntu 22.04, 24.04 or newer, x86-64, 2+ CPUs, 4+ GB RAM, 20+ GB free disk.
- Docker 24+ with the Compose plugin (`docker compose version`). Standard Docker,
  not rootless.
- AppArmor on (Ubuntu's default): `cat /sys/module/apparmor/parameters/enabled`
  prints `Y`.
- `git`.

If you ran the one-command installer earlier, remove what it left behind (your
data is kept in `/opt/openmausbot/data`):

```sh
curl -fsSL https://raw.githubusercontent.com/milind-soni/OpenMausBot/main/deploy/install.sh | sudo sh -s -- --uninstall
```

### A2. Get the code and build the server image

```sh
sudo git clone -b self-hosted-bot-box https://github.com/devhcit1/OpenMausBot.git /opt/openmausbot-src
cd /opt/openmausbot-src
sudo docker build -t openmausbot-server:box .
```

The build takes 10 to 15 minutes. It must end without errors.

### A3. Prepare the host for the sandbox

Installs a seccomp profile in `/etc/mausbot` and loads an AppArmor profile.
It checks everything first and changes nothing if a check fails.

```sh
sudo MAUSBOT_PROFILES_DIR=connector/profiles sh deploy/box/prepare-host.sh
```

It must print `This server is ready for the bots' sandbox.`

### A4. Settings

Create `/opt/openmausbot-src/.env`:

```ini
# The bot sandbox, layered over the base Compose file
COMPOSE_FILE=compose.yaml:deploy/box/compose.box.yaml
# The image built in A2
OMB_BASE_IMAGE=openmausbot-server:box

# Plain HTTP on the LAN, for HAProxy only
OMB_BIND_ADDRESS=SERVER_LAN_IP
OMB_HTTP_PORT=8080

# The public HTTPS name, and who may claim it
OMB_PUBLIC_URL=https://maus02.hcitprofessionals.us
OMB_HTTPS_HOST=maus02.hcitprofessionals.us
OMB_TRUSTED_PROXY_CIDRS=PFSENSE_IP/32

# Engine CLIs baked into the image
ENGINES="@anthropic-ai/claude-code @openai/codex"
```

```sh
sudo chmod 600 /opt/openmausbot-src/.env
```

`OMB_TRUSTED_PROXY_CIDRS` must be pfSense's address exactly as this server sees
it. Only requests from there are treated as HTTPS. If it is wrong, the site
loads but sign-in and pairing behave as if on plain HTTP.

### A5. Start

```sh
cd /opt/openmausbot-src
sudo docker compose up -d --build
```

### A6. Check the sandbox is on

```sh
cd /opt/openmausbot-src
sudo docker compose logs omb | grep "bot box"
# expect: bot box: on (bubblewrap, socat bridges, credential broker, seccomp on)
#         bot box: self-check NN/NN ...

sudo docker inspect -f '{{.AppArmorProfile}}' "$(sudo docker compose ps -q omb)"
# expect: omb-home-narrow

sudo docker compose exec omb node dist-server/bot-box/box-check.js --public=none \
  | grep -o '"id":"config-hidden","ok":[a-z]*'
# expect: "id":"config-hidden","ok":true
```

The self-check line should show every check passing (`33/33`). If the log says
`bot box: off (userns-refused)`, the sandbox did not start: re-run A3, then
`sudo docker compose up -d --force-recreate`.

### A7. Allow only pfSense to reach port 8080

Docker's published ports bypass `ufw`, so the rule goes in Docker's own chain:

```sh
sudo iptables -I DOCKER-USER -p tcp -m conntrack --ctorigdstport 8080 --ctdir ORIGINAL ! -s PFSENSE_IP -j DROP
sudo apt-get install -y iptables-persistent && sudo netfilter-persistent save
```

### A8. HAProxy on pfSense

Backend:

- Server: `SERVER_LAN_IP:8080`, plain HTTP, **HTTP mode** (not TCP).
- Pass the client's `Host` header through **unchanged**. Never rewrite it to an
  IP or to `127.0.0.1`.
- Enable **forwardfor** (`X-Forwarded-For`) and set `X-Forwarded-Proto: https`.
- Long timeouts, for the live event stream and WebSockets: `timeout tunnel 1h`,
  and `timeout server` of at least a few minutes.
- No response buffering or compression of `text/event-stream`.
- Raise the request body limit if you will upload large files.

Frontend: your HTTPS frontend for `maus02.hcitprofessionals.us`, with your
certificate, using that backend.

Test from outside: `https://maus02.hcitprofessionals.us/api/health` returns
`{"app":"openmausbot"}`.

### A9. Sign in as the first admin

```sh
cd /opt/openmausbot-src
sudo docker compose exec omb openmausbot pair --label "First admin"
```

It prints a link starting `https://maus02.hcitprofessionals.us/pair#code=…`,
valid once for 10 minutes. Open it in a browser, scan its QR code with your
phone, or paste it into the desktop app under **＋ → Connect to a server**.
Treat it like a password. Run the command again for each extra device.

If the link starts with `http://` instead, `OMB_PUBLIC_URL` was not picked up:
check A4 and run `sudo docker compose up -d`.

### A10. Sign in the AI engines

From the app: **Settings → AI**. Codex and Grok can also sign in from the
server's shell with a device code:

```sh
sudo docker compose exec omb codex login --device-auth
```

Their logins are stored in the data volume and survive restarts and updates.

### A11. Day to day

```sh
cd /opt/openmausbot-src
sudo docker compose ps                 # status
sudo docker compose logs -f omb        # logs
sudo docker compose restart omb        # restart
sudo docker compose stop               # stop
```

**Update:**

```sh
cd /opt/openmausbot-src
sudo git pull
sudo docker build -t openmausbot-server:box .
sudo MAUSBOT_PROFILES_DIR=connector/profiles sh deploy/box/prepare-host.sh
sudo docker compose up -d --build
```

Then repeat A6.

**Back up** the data volume (bots, chats, engine logins, paired devices). Stop
the server first so the database is consistent:

```sh
cd /opt/openmausbot-src
sudo docker compose stop omb
sudo docker run --rm -v openmausbot_data:/data -v "$PWD":/backup debian:bookworm-slim \
  tar czf /backup/openmausbot-data-$(date +%F).tgz -C /data .
sudo docker compose start omb
```

**Never run** `docker compose down -v`: it deletes the data volume.

### Known limitation

Under Docker, bots get no **Local VM** desktop: that would mean handing the
container Docker's socket, which is root on the host. For desktops, use **C**.

---

## B. Local service (systemd), no sandbox

Fewer moving parts, but **no bot sandbox**: anything a bot runs can read the
service user's files, including the server's settings and keys. Use it only if
you alone sign in.

### B1. Node 24 and a service user

As an administrator:

```sh
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo useradd --create-home --shell /bin/bash maus
```

### B2. Install OpenMausBot and the engines as `maus`

```sh
sudo -iu maus
npm install --global --prefix "$HOME/.local" openmausbot@0.1.160
npm install --global --prefix "$HOME/.local" @anthropic-ai/claude-code @openai/codex
export PATH="$HOME/.local/bin:$PATH"
openmausbot --version
```

Sign the engines in now, still as `maus` (`claude`, then `codex login --device-auth`).

Optional, for the bots' browser:

```sh
exit                                                  # back to the admin shell
sudo -H npx --yes openmausbot browser install --with-deps
sudo -iu maus npx --yes openmausbot browser install
```

### B3. Install the service

As `maus`:

```sh
openmausbot service install --public-url https://maus02.hcitprofessionals.us --lan
```

It writes the systemd unit and prints the commands that enable it. Run those
as an administrator, usually:

```sh
sudo systemctl daemon-reload && sudo systemctl enable --now openmausbot
journalctl -u openmausbot -f
```

`--lan` makes the server listen on this machine's private addresses so
HAProxy can reach it, on port **8799**. It answers only connections between
private addresses.

### B4. Firewall and HAProxy

```sh
sudo ufw allow from PFSENSE_IP to any port 8799 proto tcp
sudo ufw deny 8799/tcp
```

HAProxy: as in A8, with the backend at `SERVER_LAN_IP:8799`.

### B5. Pair

As `maus`:

```sh
openmausbot pair --label "First admin"
```

### B6. Update

As `maus`, then restart as an administrator:

```sh
npm install --global --prefix "$HOME/.local" openmausbot@NEW_VERSION
sudo systemctl restart openmausbot
```

Data lives in `/home/maus/.openmausbot`. Stop the service before backing it up.

---

## C. Host service with the bot sandbox and desktops

The server runs on the host as the user `maus`, with the bot sandbox on, and
bots get **Local VM** desktops through rootless Podman. Use it when bots need a
desktop. One script installs it, or moves an **A** install over, data included.

### C1. Requirements

- Ubuntu 24.04 or newer, with systemd. Plus A1's CPU, RAM and disk, and about
  4 GB more disk for each desktop.
- A normal user can run a sandbox. The script checks this and stops if it can't.

### C2. Install, or move from Docker

```sh
sudo git clone -b self-hosted-bot-box https://github.com/devhcit1/OpenMausBot.git /opt/openmausbot
sudo bash /opt/openmausbot/deploy/host/install.sh \
  --public-url https://maus02.hcitprofessionals.us --proxy-ip PFSENSE_IP --import-docker
```

Leave out `--import-docker` on a server without an **A** install. With it, the
script:

1. stops the Docker containers and turns off their restart, leaving the
   containers and the volume as they are;
2. copies the volume to `/data`, which becomes `maus`'s home, as it was inside
   the container. Saved paths and engine logins still work.

The script also:

- installs Node 24, Podman, bubblewrap and the engines;
- builds the branch into `/opt/openmausbot`, owned by root;
- installs the `openmausbot` service on port **8080**, so HAProxy needs no
  change;
- allows only `PFSENSE_IP` through `ufw` to ports 8080 and 8081.

It ends by printing the sandbox's status and self-check. Expect
`bot box: on (...)` and every check passing.

### C3. Use a desktop

In the app, open the bot's **Screen** panel and set **Works on** to **Local VM**. The first
start downloads the desktop image (a few GB), so allow a few minutes. Each
conversation reaches only its own desktop connection.

The desktop is the bot's own computer, with normal network access: it runs
commands there with its `exec` tool, `ssh` included. The bot's own shell stays
in the sandbox, which reaches only the public internet. An SSH key the bot
should use goes in the desktop (`~/.ssh` of its user, `cua`).

### C4. Day to day

```sh
systemctl status openmausbot
journalctl -u openmausbot -f
sudo -iu maus openmausbot pair --label "My phone"
sudo -iu maus codex login --device-auth
sudo -iu maus podman ps                                    # running desktops
```

**Update:** run C2's script again without `--import-docker`. It pulls the
branch, rebuilds and restarts.

**Back up:** `sudo systemctl stop openmausbot`, then archive `/data`.

**Go back to Docker:** the script prints the exact commands at the end. Your
Docker volume is untouched until you delete it.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `https://…/api/health` times out | HAProxy backend address or port, or the `ufw` rule |
| Page loads, pairing link is `http://` | `OMB_PUBLIC_URL` not set (A4) or not passed (B3) |
| Page loads, sign-in fails or loops | `OMB_TRUSTED_PROXY_CIDRS` is not pfSense's address as seen by the server; or HAProxy rewrites `Host` |
| Chat stops updating after a minute | HAProxy timeouts too short, or buffering the event stream |
| `bot box: off (userns-refused)` | Host not prepared (A3), or the container started without `compose.box.yaml` (check `COMPOSE_FILE` in `.env`) |
| `bot box: off (no-bwrap)` | The image was not built from the `self-hosted-bot-box` branch (A2) |
| Self-check fails only `keyring-denied` | The image predates python3 in the server image: update (A11) |

| C: `bubblewrap cannot make a sandbox as maus` | AppArmor refuses user namespaces: `sudo apt-get install --reinstall apparmor bubblewrap`, then `sudo systemctl reload apparmor` |
| C: Local VM won't start | Run `sudo -iu maus podman info`. A `/run/user/...` error means lingering is off: `sudo loginctl enable-linger maus` |

Logs: `sudo docker compose logs omb` (A) or `journalctl -u openmausbot` (B, C).
