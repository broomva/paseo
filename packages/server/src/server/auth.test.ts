import { describe, expect, test } from "vitest";

import { AgentMcpCredentials } from "./agent/agent-mcp-credentials.js";
import {
  authenticateAgentMcpRequest,
  extractHttpBearerToken,
  extractWsBearerProtocol,
  extractWsBearerToken,
  hashDaemonPassword,
  isBearerTokenValidAsync,
  isBearerTokenValid,
  resolveAgentMcpCaller,
  shouldBypassBearerAuth,
} from "./auth.js";

const CORRECT_PASSWORD_HASH = "$2b$12$OLxyuuP9uLK30Uzc4wQX0O6liuU/Q1t5P2b0Ebf36mULvpVK3DRZW";

describe("daemon bearer validator", () => {
  test("allows any token when no password is configured", () => {
    expect(isBearerTokenValid({ password: undefined, token: null })).toBe(true);
    expect(isBearerTokenValid({ password: undefined, token: "anything" })).toBe(true);
  });

  test("accepts the plaintext token against the bcrypt hash and rejects missing or wrong tokens", async () => {
    expect(
      await isBearerTokenValidAsync({ password: CORRECT_PASSWORD_HASH, token: "correct-password" }),
    ).toBe(true);
    expect(isBearerTokenValid({ password: CORRECT_PASSWORD_HASH, token: "correct-password" })).toBe(
      true,
    );
    expect(await isBearerTokenValidAsync({ password: CORRECT_PASSWORD_HASH, token: null })).toBe(
      false,
    );
    expect(await isBearerTokenValidAsync({ password: CORRECT_PASSWORD_HASH, token: "wrong" })).toBe(
      false,
    );
  });

  test("hashes a password into a bcrypt value", () => {
    const hash = hashDaemonPassword("correct-password");

    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(isBearerTokenValid({ password: hash, token: "correct-password" })).toBe(true);
  });

  test("extracts HTTP bearer tokens", () => {
    expect(extractHttpBearerToken("Bearer secret")).toBe("secret");
    expect(extractHttpBearerToken("Basic secret")).toBeNull();
    expect(extractHttpBearerToken(undefined)).toBeNull();
  });

  test("extracts WebSocket paseo bearer subprotocol tokens", () => {
    const protocol = extractWsBearerProtocol("chat, paseo.bearer.secret.with.dots");

    expect(protocol).toBe("paseo.bearer.secret.with.dots");
    expect(extractWsBearerToken(protocol)).toBe("secret.with.dots");
    expect(extractWsBearerToken("paseo.other.secret")).toBeNull();
  });

  test("bypasses bearer auth for preflight, liveness, and capability-token routes", () => {
    // Preflight is always bypassed regardless of path.
    expect(shouldBypassBearerAuth("OPTIONS", "/api/status")).toBe(true);
    // Unauthenticated liveness probe.
    expect(shouldBypassBearerAuth("GET", "/api/health")).toBe(true);
    // Guarded by its own single-use download token, not the daemon password.
    expect(shouldBypassBearerAuth("GET", "/api/files/download")).toBe(true);
    // Guarded by per-agent credentials (see authenticateAgentMcpRequest), with the
    // daemon password as the owner fallback.
    expect(shouldBypassBearerAuth("POST", "/mcp/agents")).toBe(true);
    // Everything else stays behind the daemon password.
    expect(shouldBypassBearerAuth("GET", "/api/status")).toBe(false);
    expect(shouldBypassBearerAuth("POST", "/api/files/upload")).toBe(false);
  });
});

describe("agent MCP request authentication", () => {
  function authenticate(input: {
    credentials: AgentMcpCredentials;
    password: string | undefined;
    authorizationHeader: string | undefined;
  }) {
    return authenticateAgentMcpRequest({
      password: input.password,
      resolveAgentCredential: (token) => input.credentials.resolve(token),
      authorizationHeader: input.authorizationHeader,
    });
  }

  test("an agent credential authenticates as exactly that agent", async () => {
    const credentials = new AgentMcpCredentials();
    const tokenA = credentials.issue("agent-a");
    const tokenB = credentials.issue("agent-b");

    for (const password of [CORRECT_PASSWORD_HASH, undefined]) {
      expect(
        await authenticate({ credentials, password, authorizationHeader: `Bearer ${tokenA}` }),
      ).toEqual({ kind: "agent", agentId: "agent-a" });
      expect(
        await authenticate({ credentials, password, authorizationHeader: `Bearer ${tokenB}` }),
      ).toEqual({ kind: "agent", agentId: "agent-b" });
    }
  });

  test("a revoked agent credential is rejected on a password-protected daemon", async () => {
    const credentials = new AgentMcpCredentials();
    const token = credentials.issue("agent-a");
    credentials.revoke("agent-a");

    expect(
      await authenticate({
        credentials,
        password: CORRECT_PASSWORD_HASH,
        authorizationHeader: `Bearer ${token}`,
      }),
    ).toBeNull();
  });

  test("a valid daemon-password bearer authenticates as the owner", async () => {
    expect(
      await authenticate({
        credentials: new AgentMcpCredentials(),
        password: CORRECT_PASSWORD_HASH,
        authorizationHeader: "Bearer correct-password",
      }),
    ).toEqual({ kind: "owner" });
  });

  test("rejects requests with neither an agent credential nor the daemon password", async () => {
    const credentials = new AgentMcpCredentials();
    credentials.issue("agent-a");

    expect(
      await authenticate({
        credentials,
        password: CORRECT_PASSWORD_HASH,
        authorizationHeader: undefined,
      }),
    ).toBeNull();
    expect(
      await authenticate({
        credentials,
        password: CORRECT_PASSWORD_HASH,
        authorizationHeader: "Bearer wrong-token",
      }),
    ).toBeNull();
  });

  test("treats any other caller as the owner when no daemon password is configured", async () => {
    expect(
      await authenticate({
        credentials: new AgentMcpCredentials(),
        password: undefined,
        authorizationHeader: undefined,
      }),
    ).toEqual({ kind: "owner" });
  });
});

describe("agent MCP caller resolution", () => {
  test("an agent acts as itself whether or not it names itself", () => {
    const principal = { kind: "agent", agentId: "agent-a" } as const;

    expect(resolveAgentMcpCaller({ principal, requestedCallerAgentId: undefined })).toEqual({
      callerAgentId: "agent-a",
    });
    expect(resolveAgentMcpCaller({ principal, requestedCallerAgentId: "agent-a" })).toEqual({
      callerAgentId: "agent-a",
    });
  });

  test("an agent cannot name another agent as the caller", () => {
    expect(
      resolveAgentMcpCaller({
        principal: { kind: "agent", agentId: "agent-a" },
        requestedCallerAgentId: "agent-b",
      }),
    ).toBeNull();
  });

  test("the owner may act for a named agent or for no agent", () => {
    const principal = { kind: "owner" } as const;

    expect(resolveAgentMcpCaller({ principal, requestedCallerAgentId: "agent-b" })).toEqual({
      callerAgentId: "agent-b",
    });
    expect(resolveAgentMcpCaller({ principal, requestedCallerAgentId: undefined })).toEqual({
      callerAgentId: undefined,
    });
  });
});
