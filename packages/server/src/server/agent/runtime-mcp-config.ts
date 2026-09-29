import type { AgentMetadata, AgentSessionConfig } from "./agent-sdk-types.js";

const PASEO_MCP_SERVER_NAME = "paseo";
const PASEO_MCP_PATHNAME = "/mcp/agents";

export function stripInternalPaseoMcpServer(config: AgentSessionConfig): AgentSessionConfig {
  const mcpServers = config.mcpServers;
  if (!mcpServers) {
    return config;
  }

  const paseoServer = mcpServers[PASEO_MCP_SERVER_NAME];
  if (!paseoServer || !isInternalPaseoMcpServer(paseoServer)) {
    return config;
  }

  const nextMcpServers = { ...mcpServers };
  delete nextMcpServers[PASEO_MCP_SERVER_NAME];

  const next = { ...config };
  if (Object.keys(nextMcpServers).length > 0) {
    next.mcpServers = nextMcpServers;
  } else {
    delete next.mcpServers;
  }
  return next;
}

/**
 * Removes the injected Paseo server from provider persistence metadata. Some
 * providers echo their launch config into the persistence handle, and the
 * daemon injects the server with the agent's credential on every launch, so
 * persisting it would only write that credential to disk.
 */
export function stripInternalPaseoMcpServerFromMetadata(metadata: AgentMetadata): AgentMetadata {
  const mcpServers = metadata.mcpServers;
  if (!isRecord(mcpServers) || !isInternalPaseoMcpServer(mcpServers[PASEO_MCP_SERVER_NAME])) {
    return metadata;
  }

  const nextMcpServers = { ...mcpServers };
  delete nextMcpServers[PASEO_MCP_SERVER_NAME];

  const next = { ...metadata };
  if (Object.keys(nextMcpServers).length > 0) {
    next.mcpServers = nextMcpServers;
  } else {
    delete next.mcpServers;
  }
  return next;
}

export function withRuntimePaseoMcpServer(params: {
  config: AgentSessionConfig;
  mcpBaseUrl: string | null;
  /**
   * The launching agent's own Agent MCP credential. The endpoint derives the
   * caller agent from it, so the URL carries no caller identity.
   */
  mcpAuthToken: string | null;
}): AgentSessionConfig {
  const storedConfig = stripInternalPaseoMcpServer(params.config);
  if (!params.mcpBaseUrl || storedConfig.mcpServers?.[PASEO_MCP_SERVER_NAME]) {
    return storedConfig;
  }

  return {
    ...storedConfig,
    mcpServers: {
      [PASEO_MCP_SERVER_NAME]: {
        type: "http",
        url: params.mcpBaseUrl,
        ...(params.mcpAuthToken
          ? { headers: { Authorization: `Bearer ${params.mcpAuthToken}` } }
          : {}),
      },
      ...storedConfig.mcpServers,
    },
  };
}

function isInternalPaseoMcpServer(config: unknown): boolean {
  if (!isRecord(config) || (config.type !== "http" && config.type !== "sse")) {
    return false;
  }
  if (typeof config.url !== "string") {
    return false;
  }

  try {
    return new URL(config.url).pathname === PASEO_MCP_PATHNAME;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
