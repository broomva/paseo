import { describe, expect, test } from "vitest";
import {
  describeStalledDaemon,
  resolveBlockedForMs,
  resolveFreshWorkerHealth,
  selectRelayStatus,
} from "./status.js";
import type { LocalDaemonWorkerHealth } from "./local-daemon.js";

describe("selectRelayStatus", () => {
  const persisted = {
    enabled: false,
    endpoint: "persisted.internal:443",
    publicEndpoint: "persisted.example.com:443",
    useTls: true,
    publicUseTls: true,
  };

  test("uses the running daemon relay state over persisted config", () => {
    expect(
      selectRelayStatus({
        persisted,
        live: {
          enabled: true,
          endpoint: "live.internal:443",
          publicEndpoint: "live.example.com:443",
          useTls: true,
          publicUseTls: true,
        },
      }),
    ).toBe("wss://live.example.com:443");
  });

  test("falls back to persisted config when the daemon cannot report live state", () => {
    expect(selectRelayStatus({ persisted })).toBe("disabled");
  });
});

describe("resolveFreshWorkerHealth", () => {
  const base: LocalDaemonWorkerHealth = {
    state: "stalled",
    observedAt: new Date().toISOString(),
    sinceLastAckMs: 8_000,
    lastRoundTripMs: 12,
  };

  test("trusts a recent supervisor verdict", () => {
    expect(resolveFreshWorkerHealth(base)).toEqual(base);
  });

  test("ignores a missing verdict", () => {
    expect(resolveFreshWorkerHealth(undefined)).toBeUndefined();
  });

  test("ignores an unparseable timestamp", () => {
    expect(resolveFreshWorkerHealth({ ...base, observedAt: "not-a-date" })).toBeUndefined();
  });

  test("ignores a verdict older than the trust window", () => {
    // A stalled record whose matching recovery write never landed must not
    // outlive its truth; past the window we degrade to the previous behaviour.
    const stale = new Date(Date.now() - 6 * 60_000).toISOString();
    expect(resolveFreshWorkerHealth({ ...base, observedAt: stale })).toBeUndefined();
  });

  test("keeps a verdict just inside the trust window", () => {
    const recent = new Date(Date.now() - 4 * 60_000).toISOString();
    expect(resolveFreshWorkerHealth({ ...base, observedAt: recent })?.state).toBe("stalled");
  });

  test("ignores a verdict from the future beyond clock skew", () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    expect(resolveFreshWorkerHealth({ ...base, observedAt: future })).toBeUndefined();
  });

  test("tolerates small clock skew", () => {
    const slightlyAhead = new Date(Date.now() + 15_000).toISOString();
    expect(resolveFreshWorkerHealth({ ...base, observedAt: slightlyAhead })?.state).toBe("stalled");
  });
});

describe("resolveBlockedForMs", () => {
  const observedAt = "2026-09-09T12:00:00.000Z";
  const observedMs = Date.parse(observedAt);
  const health: LocalDaemonWorkerHealth = {
    state: "stalled",
    observedAt,
    sinceLastAckMs: 6_000,
    lastRoundTripMs: 11,
  };

  test("equals the recorded duration at the instant it was observed", () => {
    expect(resolveBlockedForMs(health, observedMs)).toBe(6_000);
  });

  test("grows as the stall continues", () => {
    // The supervisor writes only on transitions, so the elapsed time since the
    // record was written has to be added or every later call reports 6000ms.
    expect(resolveBlockedForMs(health, observedMs + 30_000)).toBe(36_000);
    expect(resolveBlockedForMs(health, observedMs + 120_000)).toBe(126_000);
  });

  test("never shortens the answer when the clock skews backwards", () => {
    expect(resolveBlockedForMs(health, observedMs - 45_000)).toBe(6_000);
  });

  test("falls back to the recorded duration when the timestamp is unusable", () => {
    expect(resolveBlockedForMs({ ...health, observedAt: "nonsense" }, observedMs)).toBe(6_000);
  });
});

describe("describeStalledDaemon", () => {
  const observedAt = "2026-09-09T12:00:00.000Z";
  const observedMs = Date.parse(observedAt);
  const health: LocalDaemonWorkerHealth = {
    state: "stalled",
    observedAt,
    sinceLastAckMs: 6_000,
    lastRoundTripMs: 11,
  };

  test("reports the current blocked duration, not the transition-time one", () => {
    // Match the surrounding words: "36000ms" trivially contains "6000ms", so a
    // bare substring check would pass even for the stale value.
    expect(describeStalledDaemon(health, observedMs + 30_000)).toContain("blocked for 36000ms");
    expect(describeStalledDaemon(health, observedMs + 30_000)).not.toContain("blocked for 6000ms");
  });

  test("says the daemon is alive and warns against restarting it", () => {
    const note = describeStalledDaemon(health, observedMs);
    expect(note).toContain("alive");
    expect(note).toContain("busy, not dead");
    expect(note).toContain("drop in-flight work");
  });
});
