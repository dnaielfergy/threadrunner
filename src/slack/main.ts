import { startBridge } from "./app.js";
import { stderrLogger } from "./log.js";
import { installCrashHandlers, shutdown } from "./process-guard.js";
import { createSlackApi, createSocketTransport } from "./sdk.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

installCrashHandlers(process, stderrLogger, (code) => process.exit(code));

const result = await startBridge({
  env: process.env,
  log: stderrLogger,
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
