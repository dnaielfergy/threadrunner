import { createHash } from "node:crypto";
import type { ModelProfile, Provider, RunMode } from "../domain/types.js";

export interface InvocationFields {
  readonly runId: string;
  readonly provider: Provider;
  readonly profile: ModelProfile;
  readonly mode: RunMode;
  readonly prompt: string;
  readonly baseSha: string;
  readonly repoRoot: string;
}

/**
 * SHA-256 over canonical JSON (fixed key order) of exactly what an approval authorizes. The runner
 * recomputes it before starting a write run and refuses on a mismatch. The run's own columns are
 * already immutable, so this is an audit anchor and defense in depth, not the main control.
 */
export function invocationSha256(f: InvocationFields): string {
  const canonical = JSON.stringify({
    run_id: f.runId,
    provider: f.provider,
    profile: f.profile,
    mode: f.mode,
    prompt: f.prompt,
    base_sha: f.baseSha,
    repo_root: f.repoRoot,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
