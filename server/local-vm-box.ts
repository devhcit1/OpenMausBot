// The Local VM's computer MCP runs the container runtime, which a bot box must never reach (Docker's socket is
// root-equivalent). With the box on, the server runs that MCP itself and the box gets only a relay to it.
import { join } from "node:path";

import { botBox } from "./bot-box/box.ts";
import { DesktopRelay } from "./bot-box/desktop-relay.ts";
import {
  containerComputerMcp as mountContainerComputerMcp,
  type ContainerMcpLaunch,
  type LocalVmTarget,
  SHARED_LOCAL_VM_TARGET,
} from "./container-computer.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";

type Runtime = Parameters<typeof mountContainerComputerMcp>[0];

let relay: DesktopRelay | null = null;

function desktopRelay(dataDir: string): DesktopRelay {
  relay ??= new DesktopRelay({
    dir: join(dataDir, "box"),
    bridge: { node: process.execPath, script: SPAWNED_PROXIES.desktopBridge },
    lend: (botId, threadId, rw) => botBox.lend(botId, threadId, rw, "desktop"),
    log: (line) => console.warn(line),
  });
  return relay;
}

/** The Local VM's computer MCP for one conversation's engine: direct without the bot box, through its relay with it. */
export async function containerComputerMcp(
  runtime: Runtime,
  owner: { botId: string; threadId: string },
  control?: { url: string; token: string },
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
): Promise<ContainerMcpLaunch> {
  const launch = mountContainerComputerMcp(runtime, control, target);
  const dataDir = botBox.enabled() ? botBox.startOptions()?.dataDir : undefined;
  if (!dataDir) return launch;
  return desktopRelay(dataDir).attach(owner.botId, owner.threadId, launch);
}
