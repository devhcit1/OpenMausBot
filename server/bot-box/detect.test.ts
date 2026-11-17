import { describe, expect, it } from "vitest";

import { startBotBoxAtBoot } from "./boot.ts";
import type { BotBox } from "./box.ts";
import { boxRequired, boxWanted, cloudRole, detectBox, type BoxDetection } from "./detect.ts";

const tools = (found: Record<string, string>) => (name: string) => found[name] ?? null;

describe("deciding whether turns are boxed", () => {
  it("is on by default on a Cloud home, off everywhere else, and OMB_BOT_BOX decides either way", () => {
    expect(boxWanted({})).toBe("default");
    expect(boxWanted({ OMB_BOT_BOX: "0" })).toBe("off");
    expect(boxWanted({ OMB_BOT_BOX: "off" })).toBe("off");
    expect(boxWanted({ OMB_BOT_BOX: "1" })).toBe("on");
    expect(boxWanted({ OMB_BOT_BOX: "bwrap" })).toBe("on");
    expect(cloudRole({ OMB_CLOUD_ROLE: "home" })).toBe(true);
    expect(cloudRole({ OMB_CLOUD_ROLE: "team" })).toBe(true);
    expect(cloudRole({})).toBe(false);
    const working = { platform: "linux" as const, probe: () => true, which: tools({ bwrap: "/usr/bin/bwrap", socat: "/usr/bin/socat" }) };
    expect(detectBox({ env: {}, ...working })).toEqual({ box: "off", reason: "not-cloud", tools: null });
    expect(detectBox({ env: { OMB_CLOUD_ROLE: "home" }, ...working })).toEqual({ box: "bwrap", reason: null, tools: { bwrap: "/usr/bin/bwrap", socat: "/usr/bin/socat" } });
    expect(detectBox({ env: { OMB_CLOUD_ROLE: "home", OMB_BOT_BOX: "0" }, ...working })).toEqual({ box: "off", reason: "switched-off", tools: null });
    expect(detectBox({ env: { OMB_BOT_BOX: "1" }, ...working }).box).toBe("bwrap");
  });

  it("treats required as on, and a server that requires the box refuses to start without it", async () => {
    expect(boxWanted({ OMB_BOT_BOX: "required" })).toBe("on");
    expect(boxRequired({ OMB_BOT_BOX: " Required " })).toBe(true);
    expect(boxRequired({ OMB_BOT_BOX: "1" })).toBe(false);
    const boxThat = (detection: BoxDetection) => ({ start: async () => detection, enabled: () => false }) as unknown as BotBox;
    const off: BoxDetection = { box: "off", reason: "userns-refused", tools: null };
    const boot = (box: BotBox, OMB_BOT_BOX: string) => startBotBoxAtBoot({ dataDir: "/nowhere", port: 1, box, env: { OMB_BOT_BOX }, selfCheck: false, log: () => {} });
    await expect(boot(boxThat(off), "required")).rejects.toThrow("required (OMB_BOT_BOX=required) but off (userns-refused)");
    await expect(boot(boxThat(off), "1")).resolves.toBeUndefined();
    await expect(boot(boxThat({ box: "bwrap", reason: null, tools: { bwrap: "/usr/bin/bwrap", socat: null } }), "required")).resolves.toBeUndefined();
  });

  it("never runs unboxed turns by surprise: no bwrap, a refusing kernel or another platform report off with the reason", () => {
    const env = { OMB_CLOUD_ROLE: "home" };
    expect(detectBox({ env, platform: "darwin", probe: () => true, which: tools({ bwrap: "/x" }) })).toEqual({ box: "off", reason: "not-linux", tools: null });
    expect(detectBox({ env, platform: "linux", probe: () => true, which: tools({}) })).toEqual({ box: "off", reason: "no-bwrap", tools: null });
    expect(detectBox({ env, platform: "linux", probe: () => false, which: tools({ bwrap: "/usr/bin/bwrap" }) })).toEqual({ box: "off", reason: "userns-refused", tools: null });
    expect(detectBox({ env, platform: "linux", probe: () => true, which: tools({ bwrap: "/usr/bin/bwrap" }) }).tools).toEqual({ bwrap: "/usr/bin/bwrap", socat: null });
  });
});
