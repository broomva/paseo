import { describe, expect, test } from "vitest";

import type { AgentSessionConfig } from "./agent-sdk-types.js";
import {
  stripInternalPaseoMcpServerFromMetadata,
  withRuntimePaseoMcpServer,
} from "./runtime-mcp-config.js";

const BASE_CONFIG: AgentSessionConfig = {
  provider: "claude",
  cwd: "/tmp/agent",
};

describe("withRuntimePaseoMcpServer", () => {
  test("injects the paseo MCP server with the agent's bearer credential and no caller id", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      mcpAuthToken: "agent-credential",
    });

    expect(result.mcpServers?.paseo).toEqual({
      type: "http",
      url: "http://127.0.0.1:6767/mcp/agents",
      headers: { Authorization: "Bearer agent-credential" },
    });
  });

  test("omits the header when no token is available", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      mcpAuthToken: null,
    });

    expect(result.mcpServers?.paseo).toEqual({
      type: "http",
      url: "http://127.0.0.1:6767/mcp/agents",
    });
  });

  test("does not inject when no MCP base URL is configured", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      mcpBaseUrl: null,
      mcpAuthToken: "agent-credential",
    });

    expect(result.mcpServers).toBeUndefined();
  });
});

describe("stripInternalPaseoMcpServerFromMetadata", () => {
  test("drops the injected server and its credential but keeps user servers", () => {
    const result = stripInternalPaseoMcpServerFromMetadata({
      model: "opus",
      mcpServers: {
        paseo: {
          type: "http",
          url: "http://127.0.0.1:6767/mcp/agents",
          headers: { Authorization: "Bearer agent-credential" },
        },
        hub: {
          type: "http",
          url: "https://hub.test/mcp",
          headers: { Authorization: "Bearer hub-credential" },
        },
      },
    });

    expect(result).toEqual({
      model: "opus",
      mcpServers: {
        hub: {
          type: "http",
          url: "https://hub.test/mcp",
          headers: { Authorization: "Bearer hub-credential" },
        },
      },
    });
  });

  test("removes mcpServers entirely when the injected server was the only one", () => {
    const result = stripInternalPaseoMcpServerFromMetadata({
      model: "opus",
      mcpServers: {
        paseo: { type: "http", url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1" },
      },
    });

    expect(result).toEqual({ model: "opus" });
  });

  test("keeps a user server that is merely named paseo", () => {
    const metadata = {
      mcpServers: { paseo: { type: "stdio", command: "my-paseo-mcp" } },
    };

    expect(stripInternalPaseoMcpServerFromMetadata(metadata)).toBe(metadata);
  });
});
