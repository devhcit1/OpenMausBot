import { spawn } from "node:child_process";

export const VM_EXEC_TOOL = {
  name: "exec",
  description: "Run a shell command on this Local VM desktop, as its user, and wait for its result: exit code, then stdout and stderr. "
    + "The desktop has its own network, so ssh, git, curl and package downloads work here even when your own shell has no network. "
    + "Output past 100 KB per stream is cut. Prefer this over typing into a terminal on the screen.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line, run by bash (sh when the desktop has no bash)." },
      timeout_seconds: { type: "integer", description: "Stop the command after this many seconds: default 120, at most 600." },
    },
    required: ["command"],
  },
} as const;

const DEFAULT_SECONDS = 120;
const MAX_SECONDS = 600;
const MAX_STREAM_BYTES = 100_000;
/** coreutils timeout(1): 124 when the command timed out, 137 when it had to be killed after -k. */
const TIMEOUT_EXIT = 124;
const TIMEOUT_KILLED_EXIT = 137;
const BACKSTOP_SECONDS = 15;

/** In the VM: bash when it has one, under coreutils' timeout when it has one. Killing the runtime's exec client
 * (docker, podman) leaves the command running in the container, so the time limit is enforced in there. */
const IN_VM = [
  "s=sh; command -v bash >/dev/null 2>&1 && s=bash",
  'if command -v timeout >/dev/null 2>&1; then exec timeout -k 5 "$2" "$s" -lc "$1"; fi',
  'exec "$s" -lc "$1"',
].join("\n");

/** The runtime's argv for one command in the desktop container, as its desktop user. */
export function vmShellArgs(container: string, command: string, display: string, seconds = DEFAULT_SECONDS): string[] {
  return [
    "exec", "-u", "cua", "-e", "HOME=/home/cua", "-e", `DISPLAY=${display}`, "-w", "/home/cua", container,
    "/bin/sh", "-c", IN_VM, "vm-exec", command, String(seconds),
  ];
}

/** Adds the exec tool to a tools/list answer; any other line passes unchanged. */
export function withVmExecTool(line: string): string {
  if (!line.includes('"tools"')) return line;
  let frame: { result?: { tools?: Array<{ name?: unknown }> } };
  try {
    frame = JSON.parse(line);
  } catch {
    return line;
  }
  const tools = frame?.result?.tools;
  if (!Array.isArray(tools) || tools.some((tool) => tool?.name === VM_EXEC_TOOL.name)) return line;
  tools.push(VM_EXEC_TOOL);
  return JSON.stringify(frame);
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function collect(stream: NodeJS.ReadableStream | null): { text(): string } {
  const chunks: Buffer[] = [];
  let size = 0, cut = false;
  stream?.on("data", (chunk: Buffer) => {
    if (size >= MAX_STREAM_BYTES) { cut = true; return; }
    const room = MAX_STREAM_BYTES - size;
    if (chunk.length > room) cut = true;
    chunks.push(chunk.subarray(0, room));
    size += Math.min(chunk.length, room);
  });
  return { text: () => Buffer.concat(chunks).toString("utf8") + (cut ? "\n[output cut at 100 KB]" : "") };
}

/** Runs the exec tool's arguments through `runtime`; the answer is a tool result, never a thrown error. */
export function runVmExec(runtime: string, container: string, display: string, args: Record<string, unknown>): Promise<ToolResult> {
  const command = typeof args.command === "string" ? args.command : "";
  if (!command.trim()) return Promise.resolve({ content: [{ type: "text", text: "exec needs a command" }], isError: true });
  const asked = typeof args.timeout_seconds === "number" && Number.isFinite(args.timeout_seconds) ? args.timeout_seconds : DEFAULT_SECONDS;
  const seconds = Math.min(MAX_SECONDS, Math.max(1, Math.floor(asked)));
  return new Promise((resolve) => {
    const child = spawn(runtime, vmShellArgs(container, command, display, seconds), { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = collect(child.stdout), stderr = collect(child.stderr);
    let done = false;
    const finish = (status: string, failed: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(backstop);
      const text = [status, `--- stdout\n${stdout.text()}`, `--- stderr\n${stderr.text()}`].join("\n");
      resolve({ content: [{ type: "text", text }], ...(failed ? { isError: true } : {}) });
    };
    const backstop = setTimeout(() => {
      child.kill("SIGKILL");
      finish(`stopped after ${seconds} s`, true);
    }, (seconds + BACKSTOP_SECONDS) * 1000);
    child.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(backstop);
      resolve({ content: [{ type: "text", text: `could not run the command on the Local VM: ${error.message}` }], isError: true });
    });
    child.on("close", (code, signal) => {
      if (code === TIMEOUT_EXIT || code === TIMEOUT_KILLED_EXIT) finish(`stopped after ${seconds} s`, true);
      else finish(signal ? `ended by ${signal}` : `exit code ${code}`, code !== 0);
    });
  });
}
