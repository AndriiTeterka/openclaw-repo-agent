import assert from "node:assert/strict";
import test from "node:test";

import { __private__, streamCopilotSdkTurn } from "../runtime/copilot-sdk-provider.mjs";

class FakeSession {
  constructor() {
    this.handlers = new Set();
    this.sentPrompts = [];
    this.handledToolCalls = [];
    this.rpc = {
      model: {
        switchTo: async () => {},
      },
      tools: {
        handlePendingToolCall: async ({ requestId, result, error }) => {
          this.handledToolCalls.push({ requestId, result, error });
          queueMicrotask(() => {
            this.emit({
              type: "assistant.usage",
              data: {
                inputTokens: 20,
                outputTokens: 4,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                cost: 1,
              },
            });
            this.emit({
              type: "assistant.message",
              data: {
                messageId: "assistant-final",
                content: `DONE: ${result ?? error}`,
                toolRequests: [],
              },
            });
            this.emit({ type: "session.idle", data: {} });
          });
        },
      },
    };
  }

  on(handler) {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(event) {
    for (const handler of [...this.handlers]) handler(event);
  }

  async send({ prompt }) {
    this.sentPrompts.push(prompt);
    queueMicrotask(() => {
      this.emit({
        type: "assistant.usage",
        data: {
          inputTokens: 10,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 1,
        },
      });
      this.emit({
        type: "assistant.message",
        data: {
          messageId: "assistant-tool",
          content: "",
          toolRequests: [{
            toolCallId: "call_echo",
            name: "echo_test",
            arguments: { value: "hello" },
            type: "function",
          }],
        },
      });
      this.emit({
        type: "external_tool.requested",
        data: {
          requestId: "request_echo",
          sessionId: "session-1",
          toolCallId: "call_echo",
          toolName: "echo_test",
          arguments: { value: "hello" },
        },
      });
    });
    return "message-id";
  }

  async abort() {}
}

function createBaseParams(sessionState, context) {
  return {
    providerContext: {
      provider: "github-copilot",
      modelId: "gpt-5.4",
      workspaceDir: "/workspace",
      thinkingLevel: "high",
    },
    model: {
      id: "gpt-5.4",
      api: "openai-responses",
      provider: "github-copilot",
    },
    context,
    deps: {
      resolveSessionState: async () => sessionState,
      toolUseQuietMs: 0,
    },
  };
}

test("copilot SDK stream turns external tool requests into toolUse responses", async () => {
  const session = new FakeSession();
  const sessionState = {
    session,
    pendingRequests: new Map(),
  };
  const stream = streamCopilotSdkTurn(createBaseParams(sessionState, {
    messages: [{
      role: "user",
      content: "Call echo_test with hello.",
      timestamp: 1,
    }],
    tools: [{
      name: "echo_test",
      description: "Echo text",
      parameters: {
        type: "object",
        properties: {
          value: { type: "string" },
        },
      },
    }],
  }));

  const result = await stream.result();

  assert.equal(session.sentPrompts[0], "Call echo_test with hello.");
  assert.equal(result.stopReason, "toolUse");
  assert.equal(result.content.length, 1);
  assert.deepEqual(result.content[0], {
    type: "toolCall",
    id: "call_echo",
    name: "echo_test",
    arguments: { value: "hello" },
  });
  assert.equal(sessionState.pendingRequests.get("call_echo")?.requestId, "request_echo");
});

test("copilot SDK stream feeds tool results back into the paused session", async () => {
  const session = new FakeSession();
  const sessionState = {
    session,
    pendingRequests: new Map([
      ["call_echo", { requestId: "request_echo", toolName: "echo_test" }],
    ]),
  };
  const stream = streamCopilotSdkTurn(createBaseParams(sessionState, {
    messages: [{
      role: "toolResult",
      toolCallId: "call_echo",
      toolName: "echo_test",
      content: [{ type: "text", text: "hello" }],
      isError: false,
      timestamp: 2,
    }],
    tools: [{
      name: "echo_test",
      description: "Echo text",
      parameters: {
        type: "object",
        properties: {
          value: { type: "string" },
        },
      },
    }],
  }));

  const result = await stream.result();

  assert.deepEqual(session.handledToolCalls, [{
    requestId: "request_echo",
    result: "hello",
    error: undefined,
  }]);
  assert.equal(result.stopReason, "stop");
  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.content[0]?.text, "DONE: hello");
  assert.equal(sessionState.pendingRequests.size, 0);
});

test("copilot SDK stream ignores read-only Copilot session-state directories", async () => {
  const mkdirCalls = [];

  const created = await __private__.ensureSessionStateDirectories(
    "session-1",
    { HOME: "/home/node" },
    async (targetPath, options) => {
      mkdirCalls.push({ targetPath, options });
      throw Object.assign(new Error("read only file system"), { code: "EROFS" });
    },
  );

  assert.equal(created, false);
  assert.equal(mkdirCalls.length, 1);
  assert.match(mkdirCalls[0]?.targetPath ?? "", /[\\/]home[\\/]node[\\/]\.copilot[\\/]session-state$/);
});

test("copilot SDK tools explicitly override built-in tool names", () => {
  const [tool] = __private__.normalizePiTools([{
    name: "edit",
    description: "Edit a file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
    },
  }]);

  assert.equal(tool?.name, "edit");
  assert.equal(tool?.overridesBuiltInTool, true);
});

test("copilot SDK session config keeps host MCP tools available", () => {
  const approveAll = () => {};
  const sessionConfig = __private__.buildSessionConfig({
    providerContext: {
      provider: "github-copilot",
      workspaceDir: "/workspace",
    },
    model: {
      id: "gpt-5.4",
      api: "openai-responses",
      provider: "github-copilot",
    },
    context: {
      systemPrompt: "You are helpful.",
      tools: [{
        name: "echo_test",
        description: "Echo text",
        parameters: {
          type: "object",
          properties: {
            value: { type: "string" },
          },
        },
      }],
    },
    runtime: {
      sdkModule: { approveAll },
    },
    env: {
      HOME: "/home/node",
    },
    reasoningEffort: "high",
  });

  assert.equal(sessionConfig.availableTools, undefined);
  assert.equal(sessionConfig.onPermissionRequest, approveAll);
  assert.match(sessionConfig.configDir ?? "", /[\\/]home[\\/]node[\\/]\.copilot$/);
  assert.deepEqual(sessionConfig.tools.map((tool) => tool.name), ["echo_test"]);
});
