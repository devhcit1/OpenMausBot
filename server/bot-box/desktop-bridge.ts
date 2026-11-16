// Inside a bot box: carries this process's stdio to the desktop relay socket named on the command line
// (desktop-relay.ts), where the server runs the desktop's MCP bridge.
//   node desktop-bridge.js /path/to/desktop-<id>.sock
import { connect } from "node:net";

const socketPath = process.argv[2];
if (!socketPath) {
  process.stderr.write("desktop bridge: no relay socket given\n");
  process.exit(2);
}

const socket = connect(socketPath);
socket.once("connect", () => {
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.on("error", (error) => {
  process.stderr.write(`desktop bridge: ${error.message}\n`);
  process.exit(1);
});
socket.on("close", () => process.stdin.destroy());
