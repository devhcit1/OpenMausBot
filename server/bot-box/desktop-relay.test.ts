import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DesktopRelay, type StdioLaunch } from "./desktop-relay.ts";

const BRIDGE = join(import.meta.dirname, "desktop-bridge.ts");
// Stands in for the runtime's MCP: answers each line with the line upper-cased and the launch's MARK.
const ECHO = "process.stdin.setEncoding('utf8');process.stdin.on('data',(d)=>process.stdout.write(d.toUpperCase().trim()+':'+process.env.MARK+'\\n'))";
const echoLaunch = (mark: string): StdioLaunch => ({ command: process.execPath, args: ["-e", ECHO], env: { MARK: mark } });

const dirs: string[] = [];
const processes: ChildProcess[] = [];
let relay: DesktopRelay | null = null;

afterEach(() => {
  relay?.closeAll();
  relay = null;
  for (const child of processes.splice(0)) child.kill();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRelay(spawned: ChildProcess[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "omb-desktop-relay-"));
  dirs.push(dir);
  const lend = vi.fn();
  relay = new DesktopRelay({
    dir,
    bridge: { node: process.execPath, script: BRIDGE },
    lend,
    spawnLaunch: (launch) => {
      const child = spawn(launch.command, launch.args, { env: { ...process.env, ...launch.env }, stdio: ["pipe", "pipe", "pipe"] });
      spawned.push(child);
      return child;
    },
  });
  return { relay, lend, dir };
}

/** Runs the in-box end as an engine would, sends one line and resolves with the first line back. */
function talk(launch: StdioLaunch, line: string): Promise<{ answer: string; bridge: ChildProcess }> {
  const bridge = spawn(launch.command, launch.args, { env: { ...process.env, ...launch.env }, stdio: ["pipe", "pipe", "pipe"] });
  processes.push(bridge);
  return new Promise((resolve, reject) => {
    let out = "";
    bridge.stdout!.setEncoding("utf8");
    bridge.stdout!.on("data", (chunk: string) => {
      out += chunk;
      if (out.includes("\n")) resolve({ answer: out.split("\n")[0]!, bridge });
    });
    bridge.on("error", reject);
    bridge.stdin!.write(`${line}\n`);
  });
}

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(check()).toBe(true);
};

describe.skipIf(process.platform === "win32")("the desktop relay", () => {
  it("carries a boxed engine's stdio to the desktop MCP the server runs, through a private socket lent to that conversation", async () => {
    const { relay, lend, dir } = makeRelay();
    const launch = await relay.attach("bot-a", "thread-1", echoLaunch("a"));
    expect(launch.command).toBe(process.execPath);
    expect(launch.args[0]).toBe(BRIDGE);
    const socket = launch.args[1]!;
    expect(socket.startsWith(dir)).toBe(true);
    expect(statSync(socket).mode & 0o777).toBe(0o600);
    expect(lend).toHaveBeenCalledWith("bot-a", "thread-1", [socket]);
    expect((await talk(launch, "hello")).answer).toBe("HELLO:a");
  });

  it("gives each conversation its own socket, and a new connection the latest turn's launch", async () => {
    const { relay, lend } = makeRelay();
    const first = await relay.attach("bot-a", "thread-1", echoLaunch("turn-1"));
    const other = await relay.attach("bot-a", "thread-2", echoLaunch("other"));
    expect(other.args[1]).not.toBe(first.args[1]);
    const again = await relay.attach("bot-a", "thread-1", echoLaunch("turn-2"));
    expect(again.args[1]).toBe(first.args[1]);
    expect(lend).toHaveBeenCalledTimes(2);
    expect((await talk(again, "x")).answer).toBe("X:turn-2");
  });

  it("opens one socket when two turns of a conversation attach at once", async () => {
    const { relay, lend } = makeRelay();
    const [a, b] = await Promise.all([relay.attach("bot-a", "thread-1", echoLaunch("a")), relay.attach("bot-a", "thread-1", echoLaunch("b"))]);
    expect(a.args[1]).toBe(b.args[1]);
    expect(lend).toHaveBeenCalledTimes(1);
  });

  it("ends the server's MCP when the engine's end goes away", async () => {
    const spawned: ChildProcess[] = [];
    const { relay } = makeRelay(spawned);
    const launch = await relay.attach("bot-a", "thread-1", echoLaunch("a"));
    const { bridge } = await talk(launch, "hi");
    expect(spawned).toHaveLength(1);
    bridge.kill();
    await waitFor(() => spawned[0]!.exitCode !== null || spawned[0]!.signalCode !== null);
  });

  it("takes the socket back from the conversation when closed", async () => {
    const { relay, lend } = makeRelay();
    const launch = await relay.attach("bot-a", "thread-1", echoLaunch("a"));
    relay.closeAll();
    expect(existsSync(launch.args[1]!)).toBe(false);
    expect(lend).toHaveBeenLastCalledWith("bot-a", "thread-1", []);
  });
});
