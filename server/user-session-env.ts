import { statSync } from "node:fs";

type Stat = (path: string) => { uid: number };

/**
 * Rootless Podman reaches the user's systemd manager (where its containers live) through XDG_RUNTIME_DIR and
 * DBUS_SESSION_BUS_ADDRESS. A system service started for a lingering user has neither; this names the ones systemd
 * made for that user, and only when they are the user's own.
 */
export function userSessionEnv(env: Record<string, string | undefined>, uid: number, stat: Stat = statSync): Record<string, string> {
  if (uid === 0) return {};
  const owned = (path: string) => {
    try { return stat(path).uid === uid; } catch { return false; }
  };
  const patch: Record<string, string> = {};
  const fallback = `/run/user/${uid}`;
  if (!env.XDG_RUNTIME_DIR && owned(fallback)) patch.XDG_RUNTIME_DIR = fallback;
  const runtime = env.XDG_RUNTIME_DIR || patch.XDG_RUNTIME_DIR;
  if (!env.DBUS_SESSION_BUS_ADDRESS && runtime && owned(`${runtime}/bus`)) patch.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtime}/bus`;
  return patch;
}

/** Fills the two in this process's environment, which every container runtime it starts inherits. */
export function adoptUserSession(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): void {
  if (platform !== "linux" || typeof process.getuid !== "function") return;
  Object.assign(env, userSessionEnv(env, process.getuid()));
}
