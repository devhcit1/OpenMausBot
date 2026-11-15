#!/bin/sh
# Prepares this server for the bots' sandbox: installs its seccomp profile and loads its AppArmor profile.
#
#   sudo MAUSBOT_PROFILES_DIR=/opt/openmausbot/box/profiles sh prepare-host.sh
#
# Changes nothing until every check passes. On failure it prints one sentence to stderr and exits 1.
set -eu

PROFILES_DIR="${MAUSBOT_PROFILES_DIR:-}"
ETC_DIR="${MAUSBOT_ETC_DIR:-/etc/mausbot}"
APPARMOR_DIR="${MAUSBOT_APPARMOR_DIR:-/etc/apparmor.d}"
SECCOMP=seccomp-omb-home.json
PROFILE=omb-home-narrow

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

check_profiles() {
  [ -n "$PROFILES_DIR" ] || fail "MAUSBOT_PROFILES_DIR must name the folder holding $SECCOMP and $PROFILE.apparmor."
  [ -s "$PROFILES_DIR/$SECCOMP" ] || fail "The sandbox's seccomp profile is missing from $PROFILES_DIR."
  [ -s "$PROFILES_DIR/$PROFILE.apparmor" ] || fail "The sandbox's AppArmor profile is missing from $PROFILES_DIR."
}

check_root() {
  [ "$(id -u)" = 0 ] || fail "Preparing the server for the bots' sandbox needs root: run it with sudo."
}

check_apparmor() {
  enabled=$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null || true)
  # Debian 12's cloud images run AppArmor in the kernel without its tools; installing them needs no restart.
  if [ "$enabled" = Y ] && ! command -v apparmor_parser >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
    { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq apparmor; } >/dev/null 2>&1 ||
      fail "AppArmor's tools could not be installed. Run: sudo apt-get install -y apparmor  and then run this again."
  fi
  security=$(docker info --format '{{json .SecurityOptions}}' 2>/dev/null || true)
  case "$security" in
    *name=apparmor*name=seccomp* | *name=seccomp*name=apparmor*) ;;
    *) fail "Docker on this server does not apply AppArmor and seccomp profiles, which the bots' sandbox needs. Run: sudo apt-get install -y apparmor  then restart the server and run this again; or install with --no-sandbox, on a server you alone sign in to." ;;
  esac
  if [ "$enabled" != Y ] || ! command -v apparmor_parser >/dev/null 2>&1; then
    fail "This server is missing AppArmor, which the bots' sandbox needs. Run: sudo apt-get install -y apparmor  then restart the server and run this again; or install with --no-sandbox, on a server you alone sign in to."
  fi
}

check_userns() {
  max=$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo 1)
  clone=$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)
  if [ "$max" = 0 ] || [ "$clone" != 1 ]; then
    fail "This server switches off user namespaces, which the bots' sandbox needs. Run: printf 'user.max_user_namespaces=63000\\nkernel.unprivileged_userns_clone=1\\n' | sudo tee /etc/sysctl.d/90-mausbot.conf && sudo sysctl --system  and then run this again."
  fi
}

install_profiles() {
  install -d -m 0755 "$ETC_DIR" "$APPARMOR_DIR"
  install -m 0644 "$PROFILES_DIR/$SECCOMP" "$ETC_DIR/$SECCOMP"
  install -m 0644 "$PROFILES_DIR/$PROFILE.apparmor" "$APPARMOR_DIR/$PROFILE"
  apparmor_parser -r -W "$APPARMOR_DIR/$PROFILE" ||
    fail "AppArmor refused the bots' sandbox profile (its message is above). Run this again; if it still fails, send us that message."
  if [ -r /sys/kernel/security/apparmor/profiles ] && ! grep -q "^$PROFILE " /sys/kernel/security/apparmor/profiles; then
    fail "AppArmor did not load the bots' sandbox profile. Restart the server and run this again."
  fi
}

main() {
  check_profiles
  check_root
  check_apparmor
  check_userns
  install_profiles
  echo "This server is ready for the bots' sandbox."
}

main
