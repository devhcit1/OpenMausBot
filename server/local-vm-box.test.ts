import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "omb-local-vm-box-"));

vi.mock("./bot-box/box.ts", () => ({
  botBox: { enabled: vi.fn(() => false), startOptions: vi.fn(() => ({ dataDir })), lend: vi.fn() },
}));

import { botBox } from "./bot-box/box.ts";
import { containerComputerMcp } from "./local-vm-box.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const owner = { botId: "bot-a", threadId: "thread-1" };

describe("Local VM and the bot box", () => {
  it("runs the computer MCP directly while the bot box is off", async () => {
    vi.mocked(botBox.enabled).mockReturnValue(false);
    const connection = await containerComputerMcp("podman", owner);
    expect(connection.command).toBe(process.execPath);
    expect(connection.args).toContain("podman");
    expect(botBox.lend).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("gives a boxed engine only the relay, never the runtime, while the bot box is on", async () => {
    vi.mocked(botBox.enabled).mockReturnValue(true);
    const connection = await containerComputerMcp("docker", owner);
    expect(connection.command).toBe(process.execPath);
    expect(connection.args[0]).toBe(SPAWNED_PROXIES.desktopBridge);
    expect(connection.args).not.toContain("docker");
    const socket = connection.args[1]!;
    expect(socket.startsWith(join(dataDir, "box"))).toBe(true);
    expect(botBox.lend).toHaveBeenCalledWith(owner.botId, owner.threadId, [socket], "desktop");
  });
});
