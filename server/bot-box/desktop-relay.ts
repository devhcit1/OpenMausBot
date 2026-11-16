// How a boxed engine drives its conversation's desktop without the container runtime, which is root-equivalent under
// Docker: the server runs the desktop's stdio MCP bridge itself, outside the box, once per connection to a unix socket
// lent only to that conversation's boxes. Inside, desktop-bridge.ts carries the engine's stdio to that socket.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

export interface StdioLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface DesktopRelayOptions {
  /** A folder the box hides (inside the data folder); the sockets are made here. */
  dir: string;
  /** The in-box end: node and desktop-bridge's path, both readable inside the box. */
  bridge: { node: string; script: string };
  /** Lends the socket to every box of one conversation, or takes it back with none. */
  lend(botId: string, threadId: string, rw: readonly string[]): void;
  log?(line: string): void;
  /** Tests stand in for the runtime here. */
  spawnLaunch?(launch: StdioLaunch): ChildProcess;
}

/** A conversation's engines may hold this many desktop connections at once; any more are closed. */
const MAX_CONNECTIONS = 4;

interface Attached {
  botId: string;
  threadId: string;
  socketPath: string;
  server: Server;
  /** What the next connection runs: each turn's attach replaces it, so a new connection carries that turn's control. */
  launch: StdioLaunch;
  children: Set<ChildProcess>;
}

export function desktopSocketName(botId: string, threadId: string): string {
  return `desktop-${createHash("sha256").update(`${botId}/${threadId}`).digest("hex").slice(0, 24)}.sock`;
}

export class DesktopRelay {
  private readonly attached = new Map<string, Attached>();
  private readonly opening = new Map<string, Promise<Attached>>();
  private readonly options: DesktopRelayOptions;

  constructor(options: DesktopRelayOptions) { this.options = options; }

  /** The launch to give the engine in place of `launch`, which the server then runs for each of its connections. */
  async attach(botId: string, threadId: string, launch: StdioLaunch): Promise<StdioLaunch> {
    const key = `${botId}/${threadId}`;
    const pending = this.opening.get(key);
    const current = this.attached.get(key) ?? (pending ? await pending : undefined);
    if (current) {
      current.launch = launch;
      return this.inBox(current.socketPath);
    }
    const opened = this.open(botId, threadId, launch);
    this.opening.set(key, opened);
    try {
      const entry = await opened;
      this.attached.set(key, entry);
      this.options.lend(botId, threadId, [entry.socketPath]);
      return this.inBox(entry.socketPath);
    } finally {
      this.opening.delete(key);
    }
  }

  /** Closes every conversation's socket and ends the bridges it started. */
  closeAll(): void {
    for (const entry of this.attached.values()) this.close(entry);
    this.attached.clear();
  }

  private inBox(socketPath: string): StdioLaunch {
    return { command: this.options.bridge.node, args: [this.options.bridge.script, socketPath], env: { ELECTRON_RUN_AS_NODE: "1" } };
  }

  private async open(botId: string, threadId: string, launch: StdioLaunch): Promise<Attached> {
    mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
    const socketPath = join(this.options.dir, desktopSocketName(botId, threadId));
    rmSync(socketPath, { force: true });
    const entry: Attached = { botId, threadId, socketPath, server: createServer(), launch, children: new Set() };
    entry.server.on("connection", (socket) => this.serve(entry, socket));
    await new Promise<void>((resolve, reject) => {
      entry.server.once("error", reject);
      entry.server.listen(socketPath, () => {
        entry.server.off("error", reject);
        resolve();
      });
    });
    chmodSync(socketPath, 0o600);
    return entry;
  }

  private serve(entry: Attached, socket: Socket): void {
    socket.on("error", () => {});
    if (entry.children.size >= MAX_CONNECTIONS) return void socket.destroy();
    const launch = entry.launch;
    const child = this.options.spawnLaunch?.(launch) ?? spawn(launch.command, launch.args, { env: { ...process.env, ...launch.env }, stdio: ["pipe", "pipe", "pipe"] });
    entry.children.add(child);
    child.stdin?.on("error", () => {});
    child.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf8").trim().slice(0, 500);
      if (line) this.options.log?.(`desktop relay: ${line}`);
    });
    if (child.stdin) socket.pipe(child.stdin);
    child.stdout?.pipe(socket);
    socket.on("close", () => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    child.on("error", (error) => {
      this.options.log?.(`desktop relay: the desktop bridge did not start (${error.message})`);
      socket.destroy();
    });
    child.on("exit", () => {
      entry.children.delete(child);
      socket.end();
    });
  }

  private close(entry: Attached): void {
    entry.server.close();
    for (const child of entry.children) child.kill();
    entry.children.clear();
    rmSync(entry.socketPath, { force: true });
    this.options.lend(entry.botId, entry.threadId, []);
  }
}
