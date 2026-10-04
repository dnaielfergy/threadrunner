import { createNodeLauncher } from "../runner/launcher.js";
import { startBridge } from "./app.js";
import { stderrLogger } from "./log.js";
import { installCrashHandlers, shutdown } from "./process-guard.js";
import { createSlackApi, createSocketTransport } from "./sdk.js";

// Longer than the 15 second post request timeout, so a hung post times out and is recorded before we give up.
const SHUTDOWN_TIMEOUT_MS = 20_000;

installCrashHandlers(process, stderrLogger, (code) => process.exit(code));

const result = await startBridge({
  env: process.env,
  log: stderrLogger,
  launcher: createNodeLauncher(),
  connect: ({ botToken, appToken }) => ({
    api: createSlackApi(botToken),
    transport: createSocketTransport(appToken, stderrLogger),
  }),
});

if (!result.ok) {
  // Only variable names and codes are printed, never values.
  const detail = result.failure.code === "config" ? ` ${result.failure.errors.map((e) => `${e.variable}:${e.code}`).join(" ")}` : "";
  process.stderr.write(`startup refused: ${result.failure.code}${detail}\n`);
  process.exit(1);
}

const { stop } = result;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(stop, { timeoutMs: SHUTDOWN_TIMEOUT_MS, log: stderrLogger, exit: (code) => process.exit(code) });
  });
}
stderrLogger({ level: "info", code: "bridge_started" });
