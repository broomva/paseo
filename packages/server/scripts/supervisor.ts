import { fork, spawn, type ChildProcess } from "child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createStream as createRotatingFileStream } from "rotating-file-stream";
import { signalProcessTree } from "../src/utils/tree-kill.js";

const WORKER_HEARTBEAT_INTERVAL_MS = 1_000;
const WORKER_TERMINATION_GRACE_MS = 10_000;

/**
 * Crash-restart defaults.
 *
 * A worker that fails during startup (bad config, port already bound, missing
 * native module) exits immediately every time. Respawning it with no delay turns
 * that into a hot loop bounded only by fork speed, which starves the very host
 * that is usually the underlying cause. Backing off and then giving up surfaces
 * the failure to whatever supervises the supervisor instead of hiding it.
 */
const DEFAULT_RESTART_INITIAL_DELAY_MS = 250;
const DEFAULT_RESTART_MAX_DELAY_MS = 30_000;
const DEFAULT_RESTART_BACKOFF_FACTOR = 2;
const DEFAULT_RESTART_JITTER_RATIO = 0.2;
const DEFAULT_RESTART_MAX_ATTEMPTS = 10;
/** Uptime after which a worker is considered healthy and the crash counter resets. */
const DEFAULT_RESTART_STABLE_AFTER_MS = 60_000;

/**
 * How long the worker may go without acknowledging a heartbeat before the
 * supervisor reports it as stalled.
 *
 * The supervisor is the only observer that can tell a *stalled* worker from a
 * *dead* one: it owns the child handle, so process death arrives as an `exit`
 * event regardless of how blocked the worker's event loop is. Any in-band probe
 * (a websocket handshake, an HTTP health route) is served by that same event
 * loop, so it fails identically in both cases — which is how a merely busy
 * daemon gets misread as dead and restarted.
 */
const DEFAULT_WORKER_STALL_THRESHOLD_MS = 5_000;
// Well inside the CLI's 5-minute trust window for a published verdict.
const DEFAULT_STALLED_REFRESH_MS = 60_000;

export type WorkerHealthState = "healthy" | "stalled";

export interface WorkerHealth {
  state: WorkerHealthState;
  /** Time since the worker last acknowledged a heartbeat. */
  sinceLastAckMs: number;
  /** Round-trip time of the most recent acknowledged heartbeat. */
  lastRoundTripMs: number | null;
  workerPid: number | null;
}

export interface SupervisorRestartPolicy {
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  /** Random +/- ratio applied to each delay, to avoid synchronised restarts. */
  jitterRatio?: number;
  /** Consecutive crashes tolerated before the supervisor gives up. */
  maxAttempts?: number;
  stableAfterMs?: number;
}

interface ResolvedRestartPolicy extends Required<SupervisorRestartPolicy> {}

function resolveRestartPolicy(policy: SupervisorRestartPolicy | undefined): ResolvedRestartPolicy {
  return {
    initialDelayMs: policy?.initialDelayMs ?? DEFAULT_RESTART_INITIAL_DELAY_MS,
    maxDelayMs: policy?.maxDelayMs ?? DEFAULT_RESTART_MAX_DELAY_MS,
    factor: policy?.factor ?? DEFAULT_RESTART_BACKOFF_FACTOR,
    jitterRatio: policy?.jitterRatio ?? DEFAULT_RESTART_JITTER_RATIO,
    maxAttempts: policy?.maxAttempts ?? DEFAULT_RESTART_MAX_ATTEMPTS,
    stableAfterMs: policy?.stableAfterMs ?? DEFAULT_RESTART_STABLE_AFTER_MS,
  };
}

/**
 * Exponential backoff with jitter. `attempt` is 1-based: the first restart after
 * a crash waits `initialDelayMs`.
 */
export function computeRestartDelayMs(
  attempt: number,
  policy: ResolvedRestartPolicy,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const raw = policy.initialDelayMs * policy.factor ** exponent;
  const capped = Math.min(policy.maxDelayMs, raw);
  const jitterSpan = capped * policy.jitterRatio;
  // random() in [0,1) -> offset in [-jitterSpan, +jitterSpan)
  const offset = (random() * 2 - 1) * jitterSpan;
  return Math.max(0, Math.round(capped + offset));
}

interface SupervisorLogFileOptions {
  path: string;
  rotate: {
    maxSize: string;
    maxFiles: number;
  };
}

type WorkerLifecycleMessage =
  | {
      type: "paseo:shutdown";
      reason?: string;
    }
  | {
      type: "paseo:ready";
      listen: string;
    }
  | {
      type: "paseo:restart";
      reason?: string;
    };

interface SupervisorHeartbeatMessage {
  type: "paseo:supervisor-heartbeat";
  seq: number;
  sentAt: number;
}

interface SupervisorGracefulShutdownMessage {
  type: "paseo:graceful-shutdown";
  reason: string;
}

interface SupervisorOptions {
  name: string;
  startupMessage: string;
  resolveWorkerEntry: () => string;
  workerArgs?: string[];
  workerEnv?: NodeJS.ProcessEnv;
  workerExecArgv?: string[];
  resolveWorkerSpawnSpec?: (workerEntry: string) => {
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
  } | null;
  onWorkerReady?: (message: { listen: string }) => Promise<void> | void;
  restartOnCrash?: boolean;
  /** Backoff and give-up policy applied to crash restarts only. */
  restartPolicy?: SupervisorRestartPolicy;
  /** Heartbeat silence after which the worker is reported stalled. */
  stallThresholdMs?: number;
  /**
   * While a worker stays stalled, re-publish the verdict this often. Readers
   * trust a verdict only for a bounded window (so a dead supervisor's last word
   * expires); refreshing keeps a genuinely long stall inside that window.
   */
  stalledRefreshMs?: number;
  /** Called when the worker transitions between healthy and stalled. */
  onWorkerHealthChange?: (health: WorkerHealth) => Promise<void> | void;
  /**
   * Called when a worker exits outside shutdown. A health verdict about a worker
   * that no longer exists must not outlive it: a published "stalled" would keep
   * telling readers "busy, not dead" through the whole restart backoff.
   */
  onWorkerExit?: () => Promise<void> | void;
  onSupervisorExit?: () => Promise<void> | void;
  logFile?: SupervisorLogFileOptions;
}

export interface SupervisorController {
  requestShutdown(reason: string): void;
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ?? (typeof code === "number" ? `code ${code}` : "unknown");
}

function parseLifecycleMessage(msg: unknown): WorkerLifecycleMessage | null {
  if (typeof msg !== "object" || msg === null || !("type" in msg)) {
    return null;
  }
  const type = (msg as { type?: unknown }).type;
  if (type === "paseo:shutdown") {
    const reason = (msg as { reason?: unknown }).reason;
    return {
      type: "paseo:shutdown",
      ...(typeof reason === "string" && reason.trim().length > 0 ? { reason } : {}),
    };
  }
  if (type === "paseo:ready") {
    const listen = (msg as { listen?: unknown }).listen;
    if (typeof listen !== "string" || listen.trim().length === 0) {
      return null;
    }
    return { type: "paseo:ready", listen };
  }
  if (type === "paseo:restart") {
    const reason = (msg as { reason?: unknown }).reason;
    return {
      type: "paseo:restart",
      ...(typeof reason === "string" && reason.trim().length > 0 ? { reason } : {}),
    };
  }
  return null;
}

/**
 * Returns the `sentAt` carried by a worker heartbeat acknowledgement, or null if
 * the message is not one. Malformed acks are ignored rather than trusted, so a
 * worker cannot mask a stall by replying with garbage.
 */
export function parseHeartbeatAck(msg: unknown): number | null {
  if (typeof msg !== "object" || msg === null || !("type" in msg)) {
    return null;
  }
  if ((msg as { type?: unknown }).type !== "paseo:worker-heartbeat-ack") {
    return null;
  }
  const sentAt = (msg as { sentAt?: unknown }).sentAt;
  if (typeof sentAt !== "number" || !Number.isFinite(sentAt)) {
    return null;
  }
  return sentAt;
}

function toRotatingFileStreamSize(size: string): string {
  const trimmed = size.trim();
  const match = trimmed.match(/^(\d+)\s*([bBkKmMgG])?$/);
  if (!match) {
    return trimmed;
  }

  const value = match[1];
  const unit = (match[2] ?? "M").toUpperCase();
  return `${value}${unit}`;
}

function createSupervisorLogStream(options: SupervisorLogFileOptions | undefined) {
  if (!options) {
    return null;
  }

  mkdirSync(path.dirname(options.path), { recursive: true });
  return createRotatingFileStream(path.basename(options.path), {
    path: path.dirname(options.path),
    size: toRotatingFileStreamSize(options.rotate.maxSize),
    maxFiles: options.rotate.maxFiles,
  });
}

export function runSupervisor(options: SupervisorOptions): SupervisorController {
  const restartOnCrash = options.restartOnCrash ?? false;
  const workerArgs = options.workerArgs ?? process.argv.slice(2);
  const workerEnv = options.workerEnv ?? process.env;
  const workerExecArgv = options.workerExecArgv ?? ["--import", "tsx"];
  const resolveWorkerSpawnSpec = options.resolveWorkerSpawnSpec;

  const restartPolicy = resolveRestartPolicy(options.restartPolicy);
  const stallThresholdMs = options.stallThresholdMs ?? DEFAULT_WORKER_STALL_THRESHOLD_MS;
  const stalledRefreshMs = options.stalledRefreshMs ?? DEFAULT_STALLED_REFRESH_MS;

  let child: ChildProcess | null = null;
  let restarting = false;
  let shuttingDown = false;
  let exiting = false;
  let forceKillTimer: NodeJS.Timeout | null = null;
  let restartTimer: NodeJS.Timeout | null = null;
  let consecutiveCrashes = 0;
  let workerStartedAt = 0;
  const logStream = createSupervisorLogStream(options.logFile);

  const writeDurableChunk = (chunk: string | Buffer): void => {
    logStream?.write(chunk);
  };

  const writeLifecycleLog = (message: string, fields: Record<string, unknown> = {}): void => {
    writeDurableChunk(
      `${JSON.stringify({
        level: "info",
        time: new Date().toISOString(),
        pid: process.pid,
        name: options.name,
        msg: message,
        ...fields,
      })}\n`,
    );
  };

  const log = (message: string): void => {
    process.stderr.write(`[${options.name}] ${message}\n`);
    writeLifecycleLog(message);
  };

  const closeLogStream = (): Promise<void> =>
    new Promise((resolve) => {
      if (!logStream) {
        resolve();
        return;
      }
      logStream.end(resolve);
    });

  const exitSupervisor = (code: number): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    clearRestartTimer();
    Promise.resolve(options.onSupervisorExit?.())
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`Supervisor exit cleanup failed: ${message}`);
      })
      .then(closeLogStream)
      .finally(() => {
        process.exit(code);
      });
  };

  const clearForceKillTimer = (): void => {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
  };

  const clearRestartTimer = (): void => {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  };

  const scheduleForceKill = (reason: string): void => {
    if (!child) {
      return;
    }
    const currentChild = child;
    clearForceKillTimer();
    forceKillTimer = setTimeout(() => {
      forceKillTimer = null;
      if (child !== currentChild) {
        return;
      }
      writeLifecycleLog(
        "Worker did not exit after graceful shutdown request; forcing process tree kill",
        {
          reason,
          supervisorPid: process.pid,
          workerPid: currentChild.pid ?? null,
        },
      );
      void signalProcessTree(currentChild, "SIGKILL").catch((error) => {
        writeLifecycleLog("Failed to force-kill worker process tree", {
          error: error instanceof Error ? error.message : String(error),
          supervisorPid: process.pid,
          workerPid: currentChild.pid ?? null,
        });
      });
    }, WORKER_TERMINATION_GRACE_MS);
    forceKillTimer.unref();
  };

  const spawnWorker = () => {
    let workerEntry: string;
    try {
      // Resolve at spawn time so restarts pick up current filesystem state.
      workerEntry = options.resolveWorkerEntry();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Failed to resolve worker entry: ${message}`);
      exitSupervisor(1);
      return;
    }

    const spawnSpec = resolveWorkerSpawnSpec?.(workerEntry) ?? null;
    workerStartedAt = Date.now();
    writeLifecycleLog("Spawning worker", { workerEntry });
    if (spawnSpec) {
      child = spawn(spawnSpec.command, spawnSpec.args, {
        stdio: ["inherit", "pipe", "pipe", "ipc"],
        env: spawnSpec.env ?? workerEnv,
      });
    } else {
      child = fork(workerEntry, workerArgs, {
        stdio: ["inherit", "pipe", "pipe", "ipc"],
        env: workerEnv,
        execArgv: workerExecArgv,
      });
    }

    const currentChild = child;

    // Per-generation heartbeat state: a respawned worker starts from scratch.
    let heartbeatSeq = 0;
    let lastAckAt = Date.now();
    let lastRoundTripMs: number | null = null;
    let hasAcked = false;
    let stalled = false;
    let lastStalledReportAt = 0;
    // Send time of the oldest heartbeat the worker has not answered yet, or null
    // when everything sent so far has been acknowledged. Stalls are measured
    // against this rather than against a raw "time since last ack" gap: the
    // latter is never smaller than the heartbeat interval, so any threshold
    // below that interval would report a permanently healthy worker as stalled.
    let oldestUnackedSentAt: number | null = null;

    const reportHealth = (state: WorkerHealthState, sinceLastAckMs: number): void => {
      const health: WorkerHealth = {
        state,
        sinceLastAckMs,
        lastRoundTripMs,
        workerPid: currentChild.pid ?? null,
      };
      Promise.resolve(options.onWorkerHealthChange?.(health)).catch((error) => {
        writeLifecycleLog("Worker health change handler failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };

    const noteHeartbeatAck = (sentAt: number): void => {
      const now = Date.now();
      lastAckAt = now;
      lastRoundTripMs = Math.max(0, now - sentAt);
      const isFirstAck = !hasAcked;
      hasAcked = true;
      oldestUnackedSentAt = null;
      if (isFirstAck) {
        // Publish a healthy verdict for this worker generation, so a respawned
        // worker never inherits the previous generation's stalled record.
        reportHealth("healthy", 0);
      }
      if (stalled) {
        stalled = false;
        writeLifecycleLog("Worker event loop recovered", {
          workerPid: currentChild.pid ?? null,
          roundTripMs: lastRoundTripMs,
        });
        log(`Worker event loop recovered after ${lastRoundTripMs}ms.`);
        reportHealth("healthy", 0);
      }
    };

    const heartbeat = setInterval(() => {
      if (currentChild.connected) {
        heartbeatSeq += 1;
        const message: SupervisorHeartbeatMessage = {
          type: "paseo:supervisor-heartbeat",
          seq: heartbeatSeq,
          sentAt: Date.now(),
        };
        if (oldestUnackedSentAt === null) {
          oldestUnackedSentAt = message.sentAt;
        }
        currentChild.send?.(message, (error) => {
          if (error) {
            writeLifecycleLog("Worker heartbeat IPC send failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
      } else {
        writeLifecycleLog("Worker heartbeat skipped because IPC channel is disconnected");
      }

      // Only workers that have acknowledged at least once are eligible to be
      // reported stalled. A worker build that predates the ack never replies,
      // and reporting it as permanently stalled would be worse than silence.
      if (stalled) {
        // Still stalled: refresh the verdict so a long stall does not age out
        // of readers' trust window and read as "unresponsive".
        if (Date.now() - lastStalledReportAt >= stalledRefreshMs) {
          lastStalledReportAt = Date.now();
          reportHealth("stalled", Date.now() - lastAckAt);
        }
        return;
      }
      if (!hasAcked || oldestUnackedSentAt === null) {
        return;
      }
      const unansweredForMs = Date.now() - oldestUnackedSentAt;
      if (unansweredForMs > stallThresholdMs) {
        stalled = true;
        const sinceLastAckMs = Date.now() - lastAckAt;
        writeLifecycleLog("Worker event loop stalled", {
          workerPid: currentChild.pid ?? null,
          unansweredForMs,
          sinceLastAckMs,
          stallThresholdMs,
        });
        log(
          `Worker has not acknowledged a heartbeat for ${unansweredForMs}ms. ` +
            `The process is alive; its event loop is blocked.`,
        );
        lastStalledReportAt = Date.now();
        reportHealth("stalled", sinceLastAckMs);
      }
    }, WORKER_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    child.on("disconnect", () => {
      writeLifecycleLog("Worker IPC channel disconnected");
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      writeDurableChunk(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      writeDurableChunk(chunk);
    });

    child.on("message", (msg: unknown) => {
      const ackSentAt = parseHeartbeatAck(msg);
      if (ackSentAt !== null) {
        noteHeartbeatAck(ackSentAt);
        return;
      }

      const lifecycleMessage = parseLifecycleMessage(msg);
      if (!lifecycleMessage) {
        return;
      }

      if (lifecycleMessage.type === "paseo:ready") {
        writeLifecycleLog("Worker ready", { listen: lifecycleMessage.listen });
        Promise.resolve(options.onWorkerReady?.({ listen: lifecycleMessage.listen })).catch(
          (error) => {
            const message = error instanceof Error ? error.message : String(error);
            log(`Worker ready callback failed: ${message}`);
          },
        );
        return;
      }

      if (lifecycleMessage.type === "paseo:shutdown") {
        const reason = lifecycleMessage.reason ?? "worker_requested_shutdown";
        writeLifecycleLog("Worker requested shutdown", { reason });
        requestShutdown(reason);
        return;
      }

      const reason = lifecycleMessage.reason ?? "worker_requested_restart";
      writeLifecycleLog("Worker requested restart", { reason });
      requestRestart(reason);
    });

    child.on("exit", (code, signal) => {
      clearInterval(heartbeat);
      clearForceKillTimer();
      const exitDescriptor = describeExit(code, signal);
      writeLifecycleLog("Worker exited", { code, signal, exit: exitDescriptor });

      if (shuttingDown) {
        log(`Worker exited (${exitDescriptor}). Supervisor shutting down.`);
        exitSupervisor(0);
        return;
      }

      Promise.resolve(options.onWorkerExit?.()).catch((error) => {
        writeLifecycleLog("Worker exit handler failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });

      const crashed =
        restartOnCrash &&
        ((code !== 0 && code !== null) || (signal !== null && signal !== "SIGTERM"));

      // A commanded restart is not a crash: it neither backs off nor counts
      // against the crash budget.
      if (restarting) {
        restarting = false;
        log(`Worker exited (${exitDescriptor}). Restarting worker...`);
        spawnWorker();
        return;
      }

      if (crashed) {
        const uptimeMs = workerStartedAt > 0 ? Date.now() - workerStartedAt : 0;
        if (uptimeMs >= restartPolicy.stableAfterMs) {
          // The worker ran long enough to count as healthy, so this is a fresh
          // fault rather than a continuing crash loop.
          consecutiveCrashes = 0;
        }
        consecutiveCrashes += 1;

        if (consecutiveCrashes > restartPolicy.maxAttempts) {
          writeLifecycleLog("Worker crash budget exhausted", {
            exit: exitDescriptor,
            consecutiveCrashes,
            maxAttempts: restartPolicy.maxAttempts,
            uptimeMs,
          });
          log(
            `Worker crashed (${exitDescriptor}) ${consecutiveCrashes} times in a row ` +
              `(limit ${restartPolicy.maxAttempts}). Supervisor giving up.`,
          );
          exitSupervisor(1);
          return;
        }

        const delayMs = computeRestartDelayMs(consecutiveCrashes, restartPolicy);
        writeLifecycleLog("Scheduling worker restart after crash", {
          exit: exitDescriptor,
          consecutiveCrashes,
          maxAttempts: restartPolicy.maxAttempts,
          delayMs,
          uptimeMs,
        });
        log(
          `Worker crashed (${exitDescriptor}). Restarting worker in ${delayMs}ms ` +
            `(attempt ${consecutiveCrashes}/${restartPolicy.maxAttempts})...`,
        );
        clearRestartTimer();
        // Deliberately not unref'd: while a restart is pending this timer is the
        // only thing keeping the supervisor alive, and dropping it would exit
        // the supervisor silently instead of restarting the worker.
        restartTimer = setTimeout(() => {
          restartTimer = null;
          if (shuttingDown || exiting) {
            return;
          }
          spawnWorker();
        }, delayMs);
        return;
      }

      log(`Worker exited (${exitDescriptor}). Supervisor exiting.`);
      exitSupervisor(typeof code === "number" ? code : 1);
    });
  };

  const requestWorkerShutdown = (reason: string): void => {
    if (!child) {
      return;
    }
    const currentChild = child;
    const message: SupervisorGracefulShutdownMessage = {
      type: "paseo:graceful-shutdown",
      reason,
    };
    writeLifecycleLog("Supervisor requesting graceful worker shutdown", {
      reason,
      supervisorPid: process.pid,
      workerPid: currentChild.pid ?? null,
    });
    if (!currentChild.connected) {
      writeLifecycleLog("Graceful worker shutdown IPC unavailable", {
        reason,
        supervisorPid: process.pid,
        workerPid: currentChild.pid ?? null,
      });
      return;
    }
    currentChild.send?.(message, (error) => {
      if (error) {
        writeLifecycleLog("Graceful worker shutdown IPC send failed", {
          error: error instanceof Error ? error.message : String(error),
          reason,
          supervisorPid: process.pid,
          workerPid: currentChild.pid ?? null,
        });
      }
    });
  };

  const requestRestart = (reason: string) => {
    if (!child || restarting || shuttingDown) {
      return;
    }
    restarting = true;
    writeLifecycleLog("Restart requested", { reason });
    log(`${reason}. Stopping worker for restart...`);
    requestWorkerShutdown(reason);
    scheduleForceKill(reason);
  };

  const requestShutdown = (reason: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    restarting = false;
    writeLifecycleLog("Supervisor shutdown requested", { reason });
    log(`${reason}. Stopping worker...`);
    if (restartTimer) {
      // A crash restart is pending, so `child` still references an already-exited
      // process and there is nothing to signal. Exit through exitSupervisor so
      // the pid lock is still released.
      clearRestartTimer();
      writeLifecycleLog("Cancelled pending worker restart", { reason });
      exitSupervisor(0);
      return;
    }
    if (!child) {
      exitSupervisor(0);
      return;
    }
    requestWorkerShutdown(reason);
    scheduleForceKill(reason);
  };

  const forwardSignal = (signal: NodeJS.Signals) => {
    requestShutdown(`supervisor_received_${signal}`);
  };

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  process.stdout.write(`[${options.name}] ${options.startupMessage}\n`);
  writeLifecycleLog(options.startupMessage);
  spawnWorker();

  return { requestShutdown };
}
