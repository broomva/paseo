import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const supervisorPath = fileURLToPath(new URL("./supervisor.ts", import.meta.url));

/**
 * The real daemon worker, pinned to source on purpose.
 *
 * `supervisor-entrypoint.resolveWorkerEntry()` prefers `dist/` over `src/`, so a
 * test that let it resolve normally would silently exercise a stale build and
 * pass while the source was broken. Pinning the entry is what makes this test
 * evidence about the code under review rather than about the last build.
 */
const realWorkerEntry = fileURLToPath(new URL("../src/server/daemon-worker.ts", import.meta.url));

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("real daemon worker heartbeat acknowledgement", () => {
  test("the shipped worker answers supervisor heartbeats, so health is observable", async () => {
    expect(existsSync(realWorkerEntry)).toBe(true);

    const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-real-worker-health-"));
    tempDirs.push(paseoHome);
    const healthPath = path.join(paseoHome, "health.jsonl");
    const runnerPath = path.join(paseoHome, "runner.mjs");
    // A high, unlikely-to-collide port; the daemon only has to bind, not serve.
    const port = 46_000 + Math.floor(Math.random() * 2_000);

    await writeFile(
      runnerPath,
      `
        import { appendFileSync } from "node:fs";
        import { runSupervisor } from ${JSON.stringify(pathToFileURL(supervisorPath).href)};

        const controller = runSupervisor({
          name: "RealWorkerSupervisor",
          startupMessage: "starting real worker",
          resolveWorkerEntry: () => ${JSON.stringify(realWorkerEntry)},
          workerArgs: [],
          workerEnv: {
            ...process.env,
            PASEO_HOME: ${JSON.stringify(paseoHome)},
            PASEO_LISTEN: "127.0.0.1:${port}",
          },
          workerExecArgv: ["--import", "tsx"],
          restartOnCrash: false,
          stallThresholdMs: 5000,
          onWorkerHealthChange: (health) => {
            appendFileSync(${JSON.stringify(healthPath)}, JSON.stringify(health) + "\\n");
            // One healthy verdict is all this test needs; shut down promptly.
            if (health.state === "healthy") {
              controller.requestShutdown("test_complete");
            }
          },
          logFile: {
            path: ${JSON.stringify(path.join(paseoHome, "daemon.log"))},
            rotate: { maxSize: "5m", maxFiles: 1 },
          },
        });
      `,
    );

    const child = spawn(process.execPath, ["--import", "tsx", runnerPath], {
      cwd: repoRoot,
      env: { ...process.env, PASEO_HOME: paseoHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.resume();
    child.stderr.resume();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("real worker never reported healthy within the timeout"));
      }, 45_000);
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    expect(existsSync(healthPath)).toBe(true);
    const health = (await readFile(healthPath, "utf8"))
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { state: string; lastRoundTripMs: number | null });

    // Without the worker's `paseo:worker-heartbeat-ack` reply the supervisor
    // never observes health at all and this file stays empty.
    expect(health.length).toBeGreaterThan(0);
    expect(health[0].state).toBe("healthy");
    expect(health[0].lastRoundTripMs).not.toBeNull();
  }, 60_000);
});
