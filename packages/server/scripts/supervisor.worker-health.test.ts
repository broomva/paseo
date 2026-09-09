import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import { parseHeartbeatAck, type WorkerHealth } from "./supervisor.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const supervisorPath = fileURLToPath(new URL("./supervisor.ts", import.meta.url));

async function runSupervisorFixture(options: {
  workerSource: string;
  stallThresholdMs: number;
  timeoutMs?: number;
}): Promise<{ code: number | null; log: string; health: WorkerHealth[] }> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "paseo-supervisor-health-"));
  const logPath = path.join(tempDir, "daemon.log");
  const healthPath = path.join(tempDir, "health.jsonl");
  const workerPath = path.join(tempDir, "worker.mjs");
  const runnerPath = path.join(tempDir, "runner.mjs");

  await writeFile(workerPath, options.workerSource);
  await writeFile(
    runnerPath,
    `
      import { appendFileSync } from "node:fs";
      import { runSupervisor } from ${JSON.stringify(pathToFileURL(supervisorPath).href)};

      runSupervisor({
        name: "TestSupervisor",
        startupMessage: "starting fixture",
        resolveWorkerEntry: () => ${JSON.stringify(workerPath)},
        workerArgs: [],
        workerEnv: process.env,
        workerExecArgv: [],
        restartOnCrash: false,
        stallThresholdMs: ${JSON.stringify(options.stallThresholdMs)},
        onWorkerHealthChange: (health) => {
          appendFileSync(${JSON.stringify(healthPath)}, JSON.stringify(health) + "\\n");
        },
        logFile: {
          path: ${JSON.stringify(logPath)},
          rotate: { maxSize: "1m", maxFiles: 2 },
        },
      });
    `,
  );

  const child = spawn(process.execPath, ["--import", "tsx", runnerPath], {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();

  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("supervisor fixture timed out"));
    }, options.timeoutMs ?? 20_000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve(exitCode);
    });
  });

  const log = await readFile(logPath, "utf8");
  const health = existsSync(healthPath)
    ? (await readFile(healthPath, "utf8"))
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as WorkerHealth)
    : [];
  return { code, log, health };
}

/** Worker that acknowledges heartbeats, i.e. behaves like a current daemon. */
const ACKING_WORKER_PRELUDE = `
  process.on("message", (message) => {
    if (message && message.type === "paseo:supervisor-heartbeat") {
      process.send({ type: "paseo:worker-heartbeat-ack", sentAt: message.sentAt });
    }
  });
`;

describe("parseHeartbeatAck", () => {
  test("accepts a well-formed acknowledgement", () => {
    expect(parseHeartbeatAck({ type: "paseo:worker-heartbeat-ack", sentAt: 1234 })).toBe(1234);
  });

  test("rejects anything that is not an acknowledgement", () => {
    expect(parseHeartbeatAck(null)).toBeNull();
    expect(parseHeartbeatAck("paseo:worker-heartbeat-ack")).toBeNull();
    expect(parseHeartbeatAck({ type: "paseo:ready", listen: "x" })).toBeNull();
    expect(parseHeartbeatAck({ sentAt: 1 })).toBeNull();
  });

  test("rejects a malformed sentAt so a stall cannot be masked by garbage", () => {
    for (const sentAt of ["1234", null, undefined, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      expect(parseHeartbeatAck({ type: "paseo:worker-heartbeat-ack", sentAt })).toBeNull();
    }
  });
});

describe("supervisor worker health", () => {
  test("reports a blocked event loop as stalled, then recovered, without restarting", async () => {
    const result = await runSupervisorFixture({
      stallThresholdMs: 300,
      // Heartbeats are sent once a second, and stall detection deliberately
      // requires one prior ack, so the worker must answer at least one
      // heartbeat (t=1000ms) before blocking.
      workerSource: `
        ${ACKING_WORKER_PRELUDE}
        // Block the event loop across several heartbeats, then recover.
        setTimeout(() => {
          const until = Date.now() + 2500;
          while (Date.now() < until) {}
        }, 1500);
        setTimeout(() => process.exit(0), 5500);
      `,
      timeoutMs: 25_000,
    });

    expect(result.code).toBe(0);
    expect(result.log).toContain("Worker event loop stalled");
    expect(result.log).toContain("Worker event loop recovered");
    // The whole point: a stalled worker is alive, so it must not be respawned.
    expect(result.log.split('"msg":"Spawning worker"').length - 1).toBe(1);

    // The leading "healthy" is published on the generation's first ack, so a
    // respawned worker never inherits a previous generation's stalled verdict.
    expect(result.health.map((entry) => entry.state)).toEqual(["healthy", "stalled", "healthy"]);
    const stalledEntry = result.health[1];
    expect(stalledEntry.sinceLastAckMs).toBeGreaterThan(300);
    expect(stalledEntry.workerPid).toBeGreaterThan(0);
  }, 40_000);

  test("never reports a stall for a worker that does not implement the ack", async () => {
    const result = await runSupervisorFixture({
      stallThresholdMs: 200,
      workerSource: `setTimeout(() => process.exit(0), 2500);`,
      timeoutMs: 20_000,
    });

    expect(result.code).toBe(0);
    // Silence from a worker build that predates the ack is unknown, not stalled.
    expect(result.log).not.toContain("Worker event loop stalled");
    expect(result.health).toEqual([]);
  }, 30_000);

  test("does not report a stall while the worker keeps acknowledging", async () => {
    const result = await runSupervisorFixture({
      stallThresholdMs: 500,
      workerSource: `
        ${ACKING_WORKER_PRELUDE}
        setTimeout(() => process.exit(0), 3000);
      `,
      timeoutMs: 20_000,
    });

    expect(result.code).toBe(0);
    expect(result.log).not.toContain("Worker event loop stalled");
    // A healthy worker publishes exactly one verdict: the initial healthy one.
    expect(result.health.map((entry) => entry.state)).toEqual(["healthy"]);
  }, 30_000);
});
