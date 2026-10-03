/** Providers a task may be routed to. `auto` defers the choice to a later routing layer. */
export const PROVIDERS = ["codex", "claude", "auto"] as const;
export type Provider = (typeof PROVIDERS)[number];

/**
 * Model profiles are bridge-defined aliases. They are never provider model IDs;
 * mapping a profile to a concrete model is a later, provider-specific concern.
 */
export const MODEL_PROFILES = ["fast", "default", "deep"] as const;
export type ModelProfile = (typeof MODEL_PROFILES)[number];

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

export function isModelProfile(value: string): value is ModelProfile {
  return (MODEL_PROFILES as readonly string[]).includes(value);
}
