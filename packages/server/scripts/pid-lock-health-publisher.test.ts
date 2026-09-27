import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { acquirePidLock, getPidLockInfo } from "../src/server/pid-lock.js";
import { createPidLockHealthPublisher } from "./pid-lock-health-publisher.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function lockedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "paseo-health-publisher-"));
  homes.push(home);
  await acquirePidLock(home, null, { ownerPid: process.pid });
  return home;
}

const stalled = {
  state: "stalled" as const,
  sinceLastAckMs: 7000,
  lastRoundTripMs: 12,
  workerPid: 4242,
};

describe("pid-lock health publisher (the production wiring)", () => {
  test("a worker exit clears a published stalled verdict from the real lock file", async () => {
    const home = await lockedHome();
    const publisher = createPidLockHealthPublisher(home, process.pid, () => {});
    await publisher.onWorkerHealthChange(stalled);
    expect((await getPidLockInfo(home))?.workerHealth?.state).toBe("stalled");

    await publisher.onWorkerExit();
    expect((await getPidLockInfo(home))?.workerHealth).toBeUndefined();
  });

  test("overlapping ready and health writes both survive (serialized read-modify-write)", async () => {
    const home = await lockedHome();
    const publisher = createPidLockHealthPublisher(home, process.pid, () => {});
    await Promise.all([
      publisher.onWorkerReady({ listen: "127.0.0.1:6767" }),
      publisher.onWorkerHealthChange(stalled),
    ]);
    const info = await getPidLockInfo(home);
    expect(info?.listen).toBe("127.0.0.1:6767");
    expect(info?.workerHealth?.state).toBe("stalled");
  });
});

describe("supervisor entrypoint wiring", () => {
  // The publisher's behaviour is tested above against a real lock file; this
  // pins the CALL SITE. Round-3 review: with only the publisher tested, deleting
  // the entrypoint's `onWorkerExit` line left every test green while the stale
  // "stalled" verdict came back in production. A source check is the cheapest
  // guard that fails on exactly that deletion without booting a real daemon.
  test("the entrypoint hands all three publisher hooks to runSupervisor", async () => {
    const source = await readFile(new URL("./supervisor-entrypoint.ts", import.meta.url), "utf8");
    const call = source.slice(source.indexOf("runSupervisor({"));
    expect(call.length).toBeGreaterThan(0);
    expect(source).toMatch(/createPidLockHealthPublisher\(paseoHome, process\.pid\)/);
    for (const hook of ["onWorkerReady", "onWorkerExit", "onWorkerHealthChange"]) {
      expect(call).toMatch(new RegExp(`${hook}:\\s*healthPublisher\\.${hook}\\b`));
    }
  });
});
