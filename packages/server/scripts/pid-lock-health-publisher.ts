import { updatePidLock } from "../src/server/pid-lock.js";
import type { WorkerHealth } from "./supervisor.js";

/**
 * The supervisor hooks that publish worker state into the PID lock, where any
 * out-of-process reader (the CLI, an external watchdog) can see it without
 * asking the worker, whose event loop is exactly what is in question.
 *
 * Extracted from the entrypoint so the production wiring is testable against a
 * real lock file: the round-2 review showed that a test of the supervisor's
 * callback alone stays green with the entrypoint's clear deleted.
 */
export interface PidLockHealthPublisher {
  onWorkerReady(message: { listen: string }): Promise<void>;
  onWorkerHealthChange(health: WorkerHealth): Promise<void>;
  onWorkerExit(): Promise<void>;
}

export function createPidLockHealthPublisher(
  paseoHome: string,
  ownerPid: number,
  reportError: (message: string) => void = (message) => {
    process.stderr.write(message);
  },
): PidLockHealthPublisher {
  // updatePidLock is read-modify-write on one file; the ready, health and exit
  // writes can overlap, so they go through one chain or an update is lost.
  let chain: Promise<void> = Promise.resolve();
  const update = (patch: Parameters<typeof updatePidLock>[1]): Promise<void> => {
    const run = chain.then(() => updatePidLock(paseoHome, patch, { ownerPid }));
    chain = run.catch(() => {});
    return run;
  };
  const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

  return {
    onWorkerReady: async ({ listen }) => {
      await update({ listen });
    },
    onWorkerHealthChange: async (health) => {
      try {
        await update({
          workerHealth: {
            state: health.state,
            observedAt: new Date().toISOString(),
            sinceLastAckMs: health.sinceLastAckMs,
            lastRoundTripMs: health.lastRoundTripMs,
          },
        });
      } catch (error) {
        reportError(`Failed to publish worker health: ${describe(error)}\n`);
      }
    },
    onWorkerExit: async () => {
      // Clear the verdict: the worker it described is gone. Readers then fall
      // back to probing instead of reporting a dead worker as merely busy.
      try {
        await update({ workerHealth: undefined });
      } catch (error) {
        reportError(`Failed to clear worker health: ${describe(error)}\n`);
      }
    },
  };
}
