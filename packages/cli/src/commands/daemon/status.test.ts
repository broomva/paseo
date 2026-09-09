import { describe, expect, test } from "vitest";
import { resolveFreshWorkerHealth, selectRelayStatus } from "./status.js";
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
