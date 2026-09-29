import { compare, compareSync, hashSync } from "bcryptjs";
import type { RequestHandler } from "express";

export const DAEMON_PASSWORD_BCRYPT_COST = 12;

export interface DaemonAuthConfig {
  password?: string;
}

export interface BearerAuthRejectContext {
  path: string;
  method: string;
  hasToken: boolean;
}

interface BearerValidationInput {
  password: string | undefined;
  token: string | null;
}

export function isBearerTokenValid(input: BearerValidationInput): boolean {
  return isBearerTokenValidSync(input);
}

export async function isBearerTokenValidAsync(input: BearerValidationInput): Promise<boolean> {
  if (!input.password) {
    return true;
  }
  if (input.token === null) {
    return false;
  }

  return compare(input.token, input.password);
}

export function isBearerTokenValidSync(input: BearerValidationInput): boolean {
  if (!input.password) {
    return true;
  }
  if (input.token === null) {
    return false;
  }

  return compareSync(input.token, input.password);
}

export function hashDaemonPassword(password: string): string {
  return hashSync(password, DAEMON_PASSWORD_BCRYPT_COST);
}

export function extractHttpBearerToken(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const [scheme, ...tokenParts] = value.trim().split(/\s+/);
  if (scheme !== "Bearer" || tokenParts.length !== 1) {
    return null;
  }
  return tokenParts[0] ?? null;
}

export function extractWsBearerProtocol(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  for (const protocol of value.split(",")) {
    const trimmed = protocol.trim();
    const segments = trimmed.split(".");
    if (segments[0] === "paseo" && segments[1] === "bearer" && segments.length >= 3) {
      return trimmed;
    }
  }

  return null;
}

export function extractWsBearerToken(protocol: string | null): string | null {
  if (!protocol) {
    return null;
  }
  const segments = protocol.split(".");
  if (segments[0] !== "paseo" || segments[1] !== "bearer" || segments.length < 3) {
    return null;
  }
  return segments.slice(2).join(".");
}

export function createRequireBearerMiddleware(
  auth: DaemonAuthConfig | undefined,
  onReject?: (context: BearerAuthRejectContext) => void,
): RequestHandler {
  const password = auth?.password;
  return (req, res, next) => {
    if (!password || shouldBypassBearerAuth(req.method, req.path)) {
      next();
      return;
    }

    void (async () => {
      try {
        const token = extractHttpBearerToken(req.header("authorization"));
        if (!(await isBearerTokenValidAsync({ password, token }))) {
          onReject?.({
            path: req.path,
            method: req.method,
            hasToken: token !== null,
          });
          res.status(401).json({ error: "Unauthorized" });
          return;
        }

        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

const SELF_AUTHENTICATING_ROUTES = new Set(["/api/files/download", "/mcp/agents"]);

function isBearerFreeRoute(path: string): boolean {
  return path === "/api/health" || SELF_AUTHENTICATING_ROUTES.has(path);
}

export function shouldBypassBearerAuth(method: string, path: string): boolean {
  if (method === "OPTIONS") {
    return true;
  }
  return isBearerFreeRoute(path);
}

/**
 * Who is calling the Agent MCP endpoint (/mcp/agents). An agent credential
 * identifies exactly one agent. The owner is a daemon-password bearer, or any
 * caller when no password is configured, matching the global middleware.
 */
export type AgentMcpPrincipal = { kind: "agent"; agentId: string } | { kind: "owner" };

/**
 * Authenticates a request to the Agent MCP endpoint, which is exempt from the
 * global daemon-password middleware. Returns null when the request must be
 * rejected.
 */
export async function authenticateAgentMcpRequest(input: {
  password: string | undefined;
  resolveAgentCredential: (token: string) => string | null;
  authorizationHeader: string | undefined;
}): Promise<AgentMcpPrincipal | null> {
  const token = extractHttpBearerToken(input.authorizationHeader);
  const agentId = token === null ? null : input.resolveAgentCredential(token);
  if (agentId !== null) {
    return { kind: "agent", agentId };
  }
  if (await isBearerTokenValidAsync({ password: input.password, token })) {
    return { kind: "owner" };
  }
  return null;
}

/**
 * Resolves the caller agent the MCP tools act for. An agent credential is the
 * caller's identity, so a callerAgentId naming any other agent is rejected
 * (null). The owner already controls every agent and may name one explicitly.
 */
export interface AgentMcpCaller {
  callerAgentId: string | undefined;
}

export function resolveAgentMcpCaller(input: {
  principal: AgentMcpPrincipal;
  requestedCallerAgentId: string | undefined;
}): AgentMcpCaller | null {
  const { principal, requestedCallerAgentId } = input;
  if (principal.kind === "owner") {
    return { callerAgentId: requestedCallerAgentId };
  }
  if (requestedCallerAgentId !== undefined && requestedCallerAgentId !== principal.agentId) {
    return null;
  }
  return { callerAgentId: principal.agentId };
}
