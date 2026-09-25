/** Engine-wide concurrency caps. Unset means unlimited. */
export interface ConcurrencyOptions {
  /** Most handlers running at once across every run of the engine. */
  global?: number;
  /** Most handlers of one node type running at once, keyed by node type id (`type@version`). */
  perNodeType?: Record<string, number>;
}

/**
 * Dispatches node attempts. The in-process scheduler calls handlers directly; the interface
 * leaves room for a queue-backed scheduler that runs them elsewhere.
 */
export interface Scheduler {
  /**
   * Runs `task` once a slot for `nodeTypeId` is free, resolving or rejecting with its result.
   * If `signal` aborts while the task is still waiting, it never starts and this rejects with
   * the signal's reason.
   */
  run<T>(nodeTypeId: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

/**
 * Runs tasks in this process, starting each waiting task as soon as both the global and its
 * node type's caps allow. A task blocked by its node type's cap doesn't hold back tasks of
 * other node types queued behind it.
 */
export function createInProcessScheduler(options: ConcurrencyOptions = {}): Scheduler {
  const globalCap = checkCap("global", options.global);
  const perNodeType = new Map(
    Object.entries(options.perNodeType ?? {}).map(([id, cap]) => [id, checkCap(`perNodeType["${id}"]`, cap)]),
  );
  const running = new Map<string, number>();
  let runningTotal = 0;
  const waiting: { nodeTypeId: string; start: () => void }[] = [];

  const hasSlot = (nodeTypeId: string) =>
    runningTotal < globalCap && (running.get(nodeTypeId) ?? 0) < (perNodeType.get(nodeTypeId) ?? Infinity);

  const dispatch = () => {
    for (let i = 0; i < waiting.length && runningTotal < globalCap; ) {
      const next = waiting[i]!;
      if (!hasSlot(next.nodeTypeId)) {
        i++;
        continue;
      }
      waiting.splice(i, 1);
      next.start();
    }
  };

  return {
    run(nodeTypeId, task, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const withdraw = () => {
          waiting.splice(waiting.indexOf(entry), 1);
          reject(signal!.reason);
        };
        const entry = {
          nodeTypeId,
          start: () => {
            signal?.removeEventListener("abort", withdraw);
            runningTotal++;
            running.set(nodeTypeId, (running.get(nodeTypeId) ?? 0) + 1);
            task()
              .then(resolve, reject)
              .finally(() => {
                runningTotal--;
                running.set(nodeTypeId, running.get(nodeTypeId)! - 1);
                dispatch();
              });
          },
        };
        waiting.push(entry);
        signal?.addEventListener("abort", withdraw, { once: true });
        dispatch();
      });
    },
  };
}

function checkCap(name: string, cap: number | undefined): number {
  if (cap === undefined) return Infinity;
  if (!Number.isInteger(cap) || cap < 1) {
    throw new RangeError(`Concurrency cap ${name} must be a positive integer, got ${cap}`);
  }
  return cap;
}
