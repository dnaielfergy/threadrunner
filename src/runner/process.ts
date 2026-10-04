/**
 * The only seam between the runner and the operating system. Nothing outside `launcher.ts`
 * knows how a process is started, so every other module is tested with a fake.
 */
export interface LaunchSpec {
  /** Absolute path to the provider executable, from configuration. */
  readonly command: string;
  /** Structured arguments. Never joined into a string, never passed through a shell. */
  readonly args: readonly string[];
  /** The canonical repository root. */
  readonly cwd: string;
  /** The complete child environment; nothing is inherited. */
  readonly env: Readonly<Record<string, string>>;
  /** Written to the child's standard input, which is then closed. */
  readonly stdin: string;
}

export interface ExitInfo {
  /** Null when the process ended by signal. */
  readonly code: number | null;
  readonly signal: string | null;
  /** The process could not be started at all. */
  readonly spawnFailed?: boolean;
}

export interface ProcessHandle {
  /** Resolves once, after the process and its output pipe are finished (or abandoned after a kill). */
  readonly exited: Promise<ExitInfo>;
  /** Terminate the process and everything it started. Idempotent. */
  kill(): void;
}

/** Start a process. `onStdout` receives raw chunks. Standard error is discarded, never buffered. */
export type Launcher = (spec: LaunchSpec, onStdout: (chunk: Uint8Array) => void) => ProcessHandle;
