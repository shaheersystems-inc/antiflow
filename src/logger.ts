import type { Logger } from "./types.ts";

/** A logger passing every entry through `map` on its way to `sink`. */
export function mapLogger(
  sink: Logger,
  map: (message: string, fields?: Record<string, unknown>) => [string, Record<string, unknown> | undefined],
): Logger {
  const level =
    (method: keyof Logger) =>
    (message: string, fields?: Record<string, unknown>) =>
      sink[method](...map(message, fields));
  return { debug: level("debug"), info: level("info"), warn: level("warn"), error: level("error") };
}

/** A logger adding `tags` to every entry's fields. */
export function tagLogger(sink: Logger, tags: Record<string, unknown>): Logger {
  return mapLogger(sink, (message, fields) => [message, { ...tags, ...fields }]);
}
