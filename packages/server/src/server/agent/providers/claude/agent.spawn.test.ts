import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import type {
  Options,
  Query,
  SpawnOptions as ClaudeSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import * as spawnUtils from "../../../../utils/spawn.js";
import { ClaudeAgentClient } from "./agent.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import type { ClaudeQueryInput } from "./query.js";

function createQueryMock(events: unknown[]): Query {
  let index = 0;
  return {
    next: vi.fn(async () =>
      index < events.length
        ? { done: false, value: events[index++] }
        : { done: true, value: undefined },
    ),
    return: vi.fn(async () => ({ done: true, value: undefined })),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  } as Query;
}

function createChildProcessStub(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  return child;
}

const MCP_CREDENTIAL = "agent-mcp-credential-for-argv-test";
const INLINE_MCP_CONFIG = JSON.stringify({
  mcpServers: {
    paseo: {
      type: "http",
      url: "http://127.0.0.1:6767/mcp/agents",
      headers: { Authorization: `Bearer ${MCP_CREDENTIAL}` },
    },
  },
});

async function spawnClaudeWithInlineMcpConfig(
  runtimeSettings?: ProviderRuntimeSettings,
): Promise<{ args: string[]; child: ChildProcess }> {
  let capturedOptions: Options | undefined;
  const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
    capturedOptions = options;
    return createQueryMock([
      {
        type: "system",
        subtype: "init",
        session_id: "claude-spawn-mcp-config-session",
        permissionMode: "default",
        model: "opus",
      },
      {
        type: "result",
        subtype: "success",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
        total_cost_usd: 0,
      },
    ]);
  });
  const child = createChildProcessStub();
  const spawnSpy = vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(child);
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
    runtimeSettings,
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
  try {
    await session.run("mcp config argv");
    capturedOptions?.spawnClaudeCodeProcess?.({
      command: "node",
      args: ["claude.js", "--mcp-config", INLINE_MCP_CONFIG, "--verbose"],
      cwd: process.cwd(),
      env: {},
      signal: new AbortController().signal,
    } satisfies ClaudeSpawnOptions);
  } finally {
    await session.close();
  }
  const call = spawnSpy.mock.calls.find(([, args]) => args[0] === "claude.js");
  if (!call) {
    throw new Error("Claude Code was not spawned");
  }
  return { args: call[1], child };
}

describe("Claude spawn override", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("bypasses the shell when spawning Claude Code", async () => {
    let capturedOptions: Options | undefined;
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      capturedOptions = options;
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "claude-spawn-shell-regression-session",
          permissionMode: "default",
          model: "opus",
        },
        {
          type: "assistant",
          message: { content: "done" },
        },
        {
          type: "result",
          subtype: "success",
          usage: {
            input_tokens: 1,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
          total_cost_usd: 0,
        },
      ]);
    });
    const spawnSpy = vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(createChildProcessStub());
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
    });

    try {
      await session.run("spawn shell regression");
      capturedOptions?.spawnClaudeCodeProcess?.({
        command: "node",
        args: ["claude.js", "--mcp-config", '{"mcpServers":{"paseo":{"type":"http"}}}'],
        cwd: process.cwd(),
        env: {},
        signal: new AbortController().signal,
      } satisfies ClaudeSpawnOptions);
    } finally {
      await session.close();
    }

    const claudeSpawnCall = spawnSpy.mock.calls.find(([, args]) => args[0] === "claude.js");
    expect(claudeSpawnCall).toBeDefined();
    const spawnOptions = claudeSpawnCall?.[2];
    expect(spawnOptions?.shell).toBe(false);
  });
  test("passes MCP configs to Claude Code by file path, keeping credentials out of argv", async () => {
    const { args, child } = await spawnClaudeWithInlineMcpConfig();

    expect(args.join(" ")).not.toContain(MCP_CREDENTIAL);
    const configPath = args[args.indexOf("--mcp-config") + 1];
    expect(readFileSync(configPath, "utf8")).toBe(INLINE_MCP_CONFIG);
    expect(args.slice(-1)).toEqual(["--verbose"]);

    child.emit("exit", 0, null);
    expect(existsSync(configPath)).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "writes the MCP config file readable by its owner only",
    async () => {
      const { args, child } = await spawnClaudeWithInlineMcpConfig();
      const configPath = args[args.indexOf("--mcp-config") + 1];

      expect(statSync(configPath).mode & 0o777).toBe(0o600);

      child.emit("exit", 0, null);
    },
  );
  test("keeps MCP configs inline for a replacement command, which may not share this host's files", async () => {
    const { args, child } = await spawnClaudeWithInlineMcpConfig({
      command: { mode: "replace", argv: ["/opt/claude-wrapper"] },
    });

    expect(args[args.indexOf("--mcp-config") + 1]).toBe(INLINE_MCP_CONFIG);

    child.emit("exit", 0, null);
  });
});
