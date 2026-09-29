import { createHash, randomBytes } from "node:crypto";

/**
 * Bearer credentials for the Agent MCP endpoint (/mcp/agents), one per agent.
 *
 * The endpoint derives the calling agent from the credential, so an agent can
 * only act as itself: holding one agent's credential grants nothing about any
 * other agent. Credentials live in daemon memory only, so they last at most one
 * daemon run, and AgentManager revokes them when the agent closes or is
 * archived.
 */
export class AgentMcpCredentials {
  private readonly tokenByAgentId = new Map<string, string>();
  private readonly agentIdByTokenDigest = new Map<string, string>();

  /**
   * Returns the agent's credential, minting one on first use. Reloading an agent
   * keeps its credential so the provider process being replaced never holds a
   * token the daemon has already forgotten.
   */
  issue(agentId: string): string {
    const existing = this.tokenByAgentId.get(agentId);
    if (existing) {
      return existing;
    }
    const token = randomBytes(32).toString("base64url");
    this.tokenByAgentId.set(agentId, token);
    this.agentIdByTokenDigest.set(digestToken(token), agentId);
    return token;
  }

  /** Returns the agent the credential was issued to, or null if it is unknown or revoked. */
  resolve(token: string): string | null {
    return this.agentIdByTokenDigest.get(digestToken(token)) ?? null;
  }

  revoke(agentId: string): void {
    const token = this.tokenByAgentId.get(agentId);
    if (!token) {
      return;
    }
    this.tokenByAgentId.delete(agentId);
    this.agentIdByTokenDigest.delete(digestToken(token));
  }
}

// Look credentials up by digest so lookup time does not depend on how much of a
// guessed token matches a real one.
function digestToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
