// A desktop driven from inside a real box, where one can run: Linux with an unprivileged bubblewrap. The engine's end
// (desktop-bridge.ts) runs in the box and reaches the server's end only through the socket lent to its conversation.
// Elsewhere the suite says so and skips, like the box's own self-check.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { defaultCodeRoots } from "./box.ts";
import { DesktopRelay } from "./desktop-relay.ts";
import { detectBox } from "./detect.ts";
import { bwrapArgs, planBox } from "./plan.ts";

const detection = detectBox({ env: { ...process.env, OMB_BOT_BOX: "1" } });
const available = detection.box === "bwrap" && detection.tools !== null;
const root = mkdtempSync(join(tmpdir(), "omb-box-desktop-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const home = join(root, "home"), dataDir = join(home, ".openmausbot"), cwd = join(dataDir, "task-workspaces", "bot-a", "t-1");
const env = { PATH: "/usr/bin:/bin", HOME: home };
const ECHO = "process.stdin.setEncoding('utf8');process.stdin.on('data',(d)=>process.stdout.write('desktop:'+d.trim()+'\\n'))";

/** Runs the launch the engine gets inside a box that puts back `rw`; the first line back, or the bridge's error. */
function driveFromBox(launch: { command: string; args: string[] }, rw: string[]): Promise<string> {
  const plan = planBox({ dataDir, home, codeRoots: defaultCodeRoots(), engineRoots: [], bridges: [] }, { command: launch.command, args: launch.args, cwd, env, rw });
  const child = spawn(detection.tools!.bwrap, [...bwrapArgs(plan), "--", launch.command, ...launch.args], { env, stdio: ["pipe", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`no answer through the box: ${out} ${err}`)); }, 20_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      if (!out.includes("\n")) return;
      clearTimeout(timer);
      child.kill();
      resolve(out.split("\n")[0]!);
    });
    child.stderr.on("data", (chunk: string) => { err += chunk; });
    child.on("exit", () => { if (!out.includes("\n")) { clearTimeout(timer); resolve(err.trim()); } });
    child.stdin.write("screenshot\n");
  });
}

describe.skipIf(!available)(`a desktop driven from inside a real box (${available ? "bubblewrap works here" : `skipped: ${detection.reason}`})`, () => {
  it("reaches the server's desktop MCP through the lent socket, and nothing without it", async () => {
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(dataDir, "workspaces", "bot-a"), { recursive: true });
    const lent: string[] = [];
    const relay = new DesktopRelay({
      dir: join(dataDir, "box"),
      bridge: { node: process.execPath, script: SPAWNED_PROXIES.desktopBridge },
      lend: (_bot, _thread, rw) => { lent.splice(0, lent.length, ...rw); },
    });
    try {
      const launch = await relay.attach("bot-a", "t-1", { command: process.execPath, args: ["-e", ECHO], env: {} });
      expect(await driveFromBox(launch, lent)).toBe("desktop:screenshot");
      expect(await driveFromBox(launch, [])).toMatch(/desktop bridge: .*(ENOENT|ECONNREFUSED|EACCES)/);
    } finally {
      relay.closeAll();
    }
  }, 60_000);
});
