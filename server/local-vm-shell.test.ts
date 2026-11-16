import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { runVmExec, vmShellArgs, withVmExecTool } from "./local-vm-shell.ts";

describe("the Local VM's exec tool", () => {
  it("joins Cua Driver's tools in a tools/list answer, once", () => {
    const listed = withVmExecTool(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "screenshot" }] } }));
    expect(JSON.parse(listed).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["screenshot", "exec"]);
    expect(withVmExecTool(listed)).toBe(listed);
  });

  it("leaves every other answer as it came", () => {
    const call = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "\"tools\"" }] } });
    expect(withVmExecTool(call)).toBe(call);
    expect(withVmExecTool("not json \"tools\"")).toBe("not json \"tools\"");
  });

  it("runs the command as one argument in the named container, as the desktop's user", () => {
    const args = vmShellArgs("omb-vm-1", "ssh admin@10.0.0.5 'uptime; id'", ":1");
    expect(args.slice(0, 3)).toEqual(["exec", "-u", "cua"]);
    expect(args).toContain("omb-vm-1");
    expect(args.at(-2)).toBe("ssh admin@10.0.0.5 'uptime; id'");
    expect(args.at(-1)).toBe("120");
  });
});

const dir = mkdtempSync(join(tmpdir(), "omb-vm-exec-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const runtime = join(dir, "runtime");

describe.skipIf(process.platform === "win32")("running exec through the runtime", () => {
  // Stands in for `podman exec ... vm <program...>`: runs what follows the container's name here.
  writeFileSync(runtime, '#!/bin/sh\nwhile [ "$1" != vm ]; do shift; done\nshift\nexec "$@"\n');
  chmodSync(runtime, 0o755);

  it("answers with the exit code, stdout and stderr", async () => {
    const result = await runVmExec(runtime, "vm", ":1", { command: "echo out; echo err >&2" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe("exit code 0\n--- stdout\nout\n\n--- stderr\nerr\n");
  });

  it("marks a failing command as an error", async () => {
    const result = await runVmExec(runtime, "vm", ":1", { command: "exit 3" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/^exit code 3/);
  });

  it("stops a command at its timeout", async () => {
    const result = await runVmExec(runtime, "vm", ":1", { command: "sleep 30", timeout_seconds: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/^stopped after 1 s/);
  });

  it("cuts long output", async () => {
    const result = await runVmExec(runtime, "vm", ":1", { command: "head -c 300000 /dev/zero | tr '\\0' a" });
    expect(result.content[0]!.text).toContain("[output cut at 100 KB]");
    expect(result.content[0]!.text.length).toBeLessThan(110_000);
  });

  it("refuses an empty command", async () => {
    expect((await runVmExec(runtime, "vm", ":1", { command: " " })).isError).toBe(true);
  });
});
