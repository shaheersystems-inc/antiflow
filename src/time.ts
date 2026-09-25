/** The current time as an ISO 8601 string, as persisted in records. */
export function now(): string {
  return new Date().toISOString();
}

/** Resolves after `ms` milliseconds. */
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
