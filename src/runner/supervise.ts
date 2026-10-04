import type { LaunchSpec, Launcher } from "./process.js";

export type Outcome =
  | { readonly kind: "exited"; readonly exitCode: number; readonly output: string }
  | { readonly kind: "output_limit"; readonly output: string }
  | { readonly kind: "timeout"; readonly output: string }
  | { readonly kind: "signalled"; readonly output: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "aborted" }
  | { readonly kind: "spawn_failed" };

export interface SuperviseOptions {
  readonly launcher: Launcher;
  readonly spec: LaunchSpec;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  /** Polled while the child runs. True means the run was cancelled in the store: kill the child. */
  readonly shouldCancel: () => boolean;
  readonly pollMs: number;
  /** Aborted when the bridge is shutting down. */
  readonly signal?: AbortSignal;
}

/**
 * Run one child under three limits, and resolve exactly once with what happened:
 *  - time: killed at `timeoutMs`
 *  - output: at most `maxOutputBytes` of stdout is ever held; the first byte over the cap kills the child
 *  - cancellation: `shouldCancel` is polled, and a true result kills the child's whole process group
 *
 * Output is returned only for outcomes where a partial result is meaningful. A cancelled or
 * aborted child returns nothing, so nothing it produced can be posted after cancellation.
 */
export async function supervise(options: SuperviseOptions): Promise<Outcome> {
  const { launcher, spec, timeoutMs, maxOutputBytes, shouldCancel, pollMs, signal } = options;
  const chunks: Buffer[] = [];
  let bytes = 0;
  let reason: "output_limit" | "timeout" | "cancelled" | "aborted" | null = null;
  let handle: ReturnType<Launcher> | null = null;

  const stop = (why: NonNullable<typeof reason>): void => {
    if (reason !== null) return;
    reason = why;
    handle?.kill();
  };

  const onStdout = (chunk: Uint8Array): void => {
    if (reason !== null) return;
    const room = maxOutputBytes - bytes;
    if (chunk.length <= room) {
      chunks.push(Buffer.from(chunk));
      bytes += chunk.length;
      return;
    }
    if (room > 0) chunks.push(Buffer.from(chunk.subarray(0, room)));
    bytes = maxOutputBytes;
    stop("output_limit");
  };

  try {
    handle = launcher(spec, onStdout);
  } catch {
    return { kind: "spawn_failed" };
  }

  // A limit hit while the launcher was still returning had no handle to kill yet.
  if (reason !== null) handle.kill();

  const timer = setTimeout(() => stop("timeout"), timeoutMs);
  const poll = setInterval(() => {
    if (shouldCancel()) stop("cancelled");
  }, pollMs);
  const onAbort = (): void => stop("aborted");
  if (signal?.aborted) onAbort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const info = await handle.exited;
    const output = Buffer.concat(chunks).toString("utf8");
    if (reason === "cancelled") return { kind: "cancelled" };
    if (reason === "aborted") return { kind: "aborted" };
    if (reason === "timeout") return { kind: "timeout", output };
    if (reason === "output_limit") return { kind: "output_limit", output };
    if (info.spawnFailed) return { kind: "spawn_failed" };
    if (info.code === null) return { kind: "signalled", output };
    return { kind: "exited", exitCode: info.code, output };
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
    signal?.removeEventListener("abort", onAbort);
  }
}
