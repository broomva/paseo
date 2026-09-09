import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import { computeRestartDelayMs, type SupervisorRestartPolicy } from "./supervisor.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const supervisorPath = fileURLToPath(new URL("./supervisor.ts", import.meta.url));

interface FixtureResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  log: string;
  stdout: string;
  stderr: string;
  tempDir: string;
}

/**
 * Runs a real supervisor process against a real worker script. The crash-loop
 * tests depend on this being a genuine process: with an unbounded restart loop
 * the supervisor never exits and the fixture times out, which is precisely the
 * regression these tests are guarding.
 */
async function runSupervisorFixture(options: {
  workerSource: string;
  restartOnCrash?: boolean;
  restartPolicy?: SupervisorRestartPolicy;
  timeoutMs?: number;
}): Promise<FixtureResult> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "paseo-supervisor-restart-"));
  const logPath = path.join(tempDir, "daemon.log");
  const workerPath = path.join(tempDir, "worker.mjs");
  const runnerPath = path.join(tempDir, "runner.mjs");

  await writeFile(workerPath, options.workerSource);
  await writeFile(
    runnerPath,
    `
      import { runSupervisor } from ${JSON.stringify(pathToFileURL(supervisorPath).href)};

      runSupervisor({
        name: "TestSupervisor",
        startupMessage: "starting fixture",
        resolveWorkerEntry: () => ${JSON.stringify(workerPath)},
        workerArgs: [],
        workerEnv: { ...process.env, PASEO_FIXTURE_DIR: ${JSON.stringify(tempDir)} },
        workerExecArgv: [],
        restartOnCrash: ${JSON.stringify(options.restartOnCrash ?? true)},
        restartPolicy: ${JSON.stringify(options.restartPolicy ?? {})},
        logFile: {
          path: ${JSON.stringify(logPath)},
          rotate: { maxSize: "1m", maxFiles: 2 },
        },
      });
    `,
  );

  const startedAt = Date.now();
  const child = spawn(process.execPath, ["--import", "tsx", runnerPath], {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("supervisor fixture timed out (restart loop never terminated?)"));
    }, options.timeoutMs ?? 20_000);

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode, exitSignal) => {
      clearTimeout(timeout);
      resolve({ code: exitCode, signal: exitSignal });
    });
  });

  const log = await readFile(logPath, "utf8");
  return { code, signal, elapsedMs: Date.now() - startedAt, log, stdout, stderr, tempDir };
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("computeRestartDelayMs", () => {
  const policy = {
    initialDelayMs: 100,
    maxDelayMs: 1_000,
    factor: 2,
    jitterRatio: 0,
    maxAttempts: 10,
    stableAfterMs: 60_000,
  };

  test("first restart waits the initial delay", () => {
    expect(computeRestartDelayMs(1, policy)).toBe(100);
  });

  test("grows exponentially", () => {
    expect(computeRestartDelayMs(2, policy)).toBe(200);
    expect(computeRestartDelayMs(3, policy)).toBe(400);
    expect(computeRestartDelayMs(4, policy)).toBe(800);
  });

  test("caps at maxDelayMs however many attempts have elapsed", () => {
    expect(computeRestartDelayMs(5, policy)).toBe(1_000);
    expect(computeRestartDelayMs(50, policy)).toBe(1_000);
    // factor ** 1999 overflows to Infinity; the cap must still hold.
    expect(computeRestartDelayMs(2_000, policy)).toBe(1_000);
  });

  test("keeps jitter within the configured ratio and never negative", () => {
    const jittered = { ...policy, jitterRatio: 0.5 };
    for (const random of [() => 0, () => 0.5, () => 0.999999]) {
      const delay = computeRestartDelayMs(1, jittered, random);
      expect(delay).toBeGreaterThanOrEqual(50);
      expect(delay).toBeLessThanOrEqual(150);
    }
    // A pathological jitter ratio must still not produce a negative timeout.
    expect(computeRestartDelayMs(1, { ...policy, jitterRatio: 5 }, () => 0)).toBe(0);
  });
});

describe("supervisor crash-restart policy", () => {
  test("gives up after the crash budget instead of restarting forever", async () => {
    const result = await runSupervisorFixture({
      workerSource: `process.exit(3);`,
      restartOnCrash: true,
      restartPolicy: {
        initialDelayMs: 5,
        maxDelayMs: 10,
        jitterRatio: 0,
        maxAttempts: 3,
        stableAfterMs: 60_000,
      },
    });

    expect(result.code).toBe(1);
    expect(result.log).toContain("Worker crash budget exhausted");
    // maxAttempts restarts were scheduled, then the budget was exhausted.
    expect(countOccurrences(result.log, "Scheduling worker restart after crash")).toBe(3);
    expect(countOccurrences(result.log, '"msg":"Spawning worker"')).toBe(4);
  });

  test("applies exponential backoff between crash restarts", async () => {
    const result = await runSupervisorFixture({
      workerSource: `process.exit(3);`,
      restartOnCrash: true,
      restartPolicy: {
        initialDelayMs: 200,
        maxDelayMs: 2_000,
        factor: 2,
        jitterRatio: 0,
        maxAttempts: 3,
        stableAfterMs: 60_000,
      },
    });

    expect(result.code).toBe(1);
    // Delays are 200 + 400 + 800 = 1400ms of deliberate waiting.
    expect(result.elapsedMs).toBeGreaterThanOrEqual(1_400);
    expect(result.log).toContain('"delayMs":200');
    expect(result.log).toContain('"delayMs":400');
    expect(result.log).toContain('"delayMs":800');
  });

  test("resets the crash budget once a worker stays up long enough", async () => {
    // Three crashes with maxAttempts=2. Each worker lives past stableAfterMs, so
    // every crash must count as a fresh fault; if the reset did not happen the
    // third crash would exhaust the budget and the supervisor would exit 1.
    const result = await runSupervisorFixture({
      workerSource: `
        import { readFileSync, writeFileSync, existsSync } from "node:fs";
        import path from "node:path";
        const counterPath = path.join(process.env.PASEO_FIXTURE_DIR, "generation");
        const generation = existsSync(counterPath)
          ? Number(readFileSync(counterPath, "utf8")) + 1
          : 1;
        writeFileSync(counterPath, String(generation));
        if (generation > 3) {
          // Clean exit ends the run so the fixture terminates.
          process.exit(0);
        }
        // Outlive stableAfterMs (100ms) so this crash resets the counter.
        setTimeout(() => process.exit(3), 250);
      `,
      restartOnCrash: true,
      restartPolicy: {
        initialDelayMs: 5,
        maxDelayMs: 10,
        jitterRatio: 0,
        maxAttempts: 2,
        stableAfterMs: 100,
      },
      timeoutMs: 20_000,
    });

    expect(result.code).toBe(0);
    expect(result.log).not.toContain("Worker crash budget exhausted");
    // Reset before increment means the attempt counter never leaves 1.
    expect(countOccurrences(result.log, '"consecutiveCrashes":1')).toBe(3);
    expect(result.log).not.toContain('"consecutiveCrashes":2');
    expect(countOccurrences(result.log, '"msg":"Spawning worker"')).toBe(4);
  }, 30_000);

  test("a commanded restart is neither delayed nor charged to the crash budget", async () => {
    const result = await runSupervisorFixture({
      workerSource: `
        import { existsSync, writeFileSync } from "node:fs";
        import path from "node:path";
        const marker = path.join(process.env.PASEO_FIXTURE_DIR, "restarted.marker");
        process.on("message", (message) => {
          if (message && message.type === "paseo:graceful-shutdown") {
            process.exit(0);
          }
        });
        if (existsSync(marker)) {
          // Second generation: exit cleanly so the supervisor shuts down.
          process.exit(0);
        } else {
          writeFileSync(marker, "1");
          process.send({ type: "paseo:restart", reason: "fixture_requested_restart" });
        }
      `,
      restartOnCrash: true,
      restartPolicy: { initialDelayMs: 5_000, jitterRatio: 0, maxAttempts: 3 },
    });

    expect(result.code).toBe(0);
    expect(result.log).toContain("Worker requested restart");
    expect(countOccurrences(result.log, '"msg":"Spawning worker"')).toBe(2);
    // The 5s crash backoff must not have been applied to a commanded restart.
    expect(result.log).not.toContain("Scheduling worker restart after crash");
    expect(result.elapsedMs).toBeLessThan(5_000);
  });
});
