import { describe, expect, test } from "vitest";

import { AgentMcpCredentials } from "./agent-mcp-credentials.js";

describe("AgentMcpCredentials", () => {
  test("issues a distinct credential per agent that resolves only to that agent", () => {
    const credentials = new AgentMcpCredentials();

    const tokenA = credentials.issue("agent-a");
    const tokenB = credentials.issue("agent-b");

    expect(tokenA).not.toBe(tokenB);
    expect(credentials.resolve(tokenA)).toBe("agent-a");
    expect(credentials.resolve(tokenB)).toBe("agent-b");
    expect(credentials.resolve("not-a-credential")).toBeNull();
  });

  test("keeps an agent's credential stable until it is revoked", () => {
    const credentials = new AgentMcpCredentials();

    expect(credentials.issue("agent-a")).toBe(credentials.issue("agent-a"));
  });

  test("revoking an agent invalidates only its credential, and re-issuing mints a new one", () => {
    const credentials = new AgentMcpCredentials();
    const revokedToken = credentials.issue("agent-a");
    const otherToken = credentials.issue("agent-b");

    credentials.revoke("agent-a");

    expect(credentials.resolve(revokedToken)).toBeNull();
    expect(credentials.resolve(otherToken)).toBe("agent-b");

    const reissuedToken = credentials.issue("agent-a");
    expect(reissuedToken).not.toBe(revokedToken);
    expect(credentials.resolve(reissuedToken)).toBe("agent-a");
    expect(credentials.resolve(revokedToken)).toBeNull();
  });
});
