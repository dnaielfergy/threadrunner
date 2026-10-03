import { startBridge } from "./app.js";
import { stderrLogger } from "./log.js";
import { createSlackApi, createSocketTransport } from "./sdk.js";

const result = await startBridge({
  env: process.env,
  log: stderrLogger,
  connect: ({ botToken, appToken }) => ({ api: createSlackApi(botToken), transport: createSocketTransport(appToken) }),
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
    void stop().finally(() => process.exit(0));
  });
}
stderrLogger({ level: "info", code: "bridge_started" });
