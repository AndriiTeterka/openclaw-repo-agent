import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  copilotClientSdkCandidates,
  resolveCopilotCliArgs,
  resolveCopilotCliPath,
  resolveCopilotHome,
  resolveUserHomeDir,
} from "./copilot-installation.mjs";

const CLIENT_NAME = "openclaw-repo-agent";
const DEFAULT_TOOL_USE_QUIET_MS = 25;
const REASONING_LEVEL_ORDER = ["minimal", "low", "medium", "high", "xhigh"];
const GLOBAL_STATE_SYMBOL = Symbol.for("openclaw.copilotSdkProviderState");

function getGlobalState() {
  const existing = globalThis[GLOBAL_STATE_SYMBOL];
  if (existing) return existing;

  const created = {
    runtimePromise: null,
    runtime: null,
    sessions: new Map(),
    exitHookInstalled: false,
  };
  globalThis[GLOBAL_STATE_SYMBOL] = created;
  return created;
}

class EventStream {
  constructor(isComplete, extractResult) {
    this.isComplete = isComplete;
    this.extractResult = extractResult;
    this.queue = [];
    this.waiting = [];
    this.done = false;
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event) {
    if (this.done) return;

    if (this.isComplete(event)) {
      this.done = true;
      this.resolveFinalResult(this.extractResult(event));
    }

    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }

    this.queue.push(event);
  }

  end(result) {
    this.done = true;
    if (result !== undefined) this.resolveFinalResult(result);
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      waiter({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift();
        continue;
      }
      if (this.done) return;
      const next = await new Promise((resolve) => this.waiting.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }

  result() {
    return this.finalResultPromise;
  }
}

class AssistantMessageEventStream extends EventStream {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => (event.type === "done" ? event.message : event.error),
    );
  }
}

function createEmptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function createAssistantMessage(model, stopReason = "stop") {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createEmptyUsage(),
    stopReason,
    timestamp: Date.now(),
  };
}

function normalizeReasoningLevel(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return REASONING_LEVEL_ORDER.includes(normalized) ? normalized : "";
}

function flattenTextContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const textParts = [];
  const structuredParts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
      continue;
    }
    structuredParts.push(block);
  }

  if (structuredParts.length === 0) return textParts.join("\n\n");
  if (textParts.length === 0) return JSON.stringify(structuredParts);
  return `${textParts.join("\n\n")}\n\n${JSON.stringify(structuredParts)}`;
}

function findLastUserMessage(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message;
  }
  return null;
}

function normalizePiTools(tools = []) {
  return (Array.isArray(tools) ? tools : [])
    .map((tool) => ({
      name: String(tool?.name ?? "").trim(),
      description: String(tool?.description ?? "").trim(),
      overridesBuiltInTool: true,
      parameters: tool?.parameters && typeof tool.parameters === "object"
        ? tool.parameters
        : { type: "object", properties: {} },
    }))
    .filter((tool) => Boolean(tool.name));
}

function createMessageKey(message) {
  if (!message || typeof message !== "object") return "";
  if (message.role === "toolResult") {
    return `tool:${String(message.toolCallId ?? "").trim()}:${String(message.timestamp ?? "")}`;
  }
  if (message.role === "user") {
    return `user:${String(message.timestamp ?? "")}:${flattenTextContent(message.content)}`;
  }
  return `${String(message.role ?? "unknown")}:${String(message.timestamp ?? "")}`;
}

function resolveSessionKey(providerContext, context, options = {}) {
  const explicitSessionId = String(options?.sessionId ?? "").trim();
  if (explicitSessionId) return explicitSessionId;

  const firstUserMessage = Array.isArray(context?.messages)
    ? context.messages.find((message) => message?.role === "user")
    : null;
  const hashInput = JSON.stringify({
    workspaceDir: providerContext?.workspaceDir ?? "",
    provider: providerContext?.provider ?? "",
    modelId: providerContext?.modelId ?? providerContext?.model?.id ?? "",
    firstUserMessageKey: createMessageKey(firstUserMessage),
  });
  return `openclaw-copilot-${crypto.createHash("sha1").update(hashInput).digest("hex").slice(0, 24)}`;
}

function buildCliEnv(env = process.env) {
  const copilotHome = resolveCopilotHome(env);
  const homeDir = resolveUserHomeDir(env);
  return {
    ...process.env,
    ...env,
    ...(copilotHome ? { COPILOT_HOME: copilotHome } : {}),
    ...(homeDir ? { HOME: homeDir } : {}),
  };
}

async function ensureSessionStateDirectories(sessionKey, env = process.env, mkdirImpl = fs.mkdir) {
  const copilotHome = resolveCopilotHome(env);
  if (!copilotHome) return false;

  try {
    await mkdirImpl(path.join(copilotHome, "session-state"), { recursive: true });
    await mkdirImpl(path.join(copilotHome, "session-state", sessionKey), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function buildUsage(eventData = {}) {
  const input = Number(eventData.inputTokens ?? 0);
  const output = Number(eventData.outputTokens ?? 0);
  const cacheRead = Number(eventData.cacheReadTokens ?? 0);
  const cacheWrite = Number(eventData.cacheWriteTokens ?? 0);
  const totalTokens = input + output + cacheRead + cacheWrite;
  const totalCost = Number(eventData.cost ?? 0);

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: Number.isFinite(totalCost) ? totalCost : 0,
    },
  };
}

function resolveReasoningEffort(modelId, thinkingLevel, modelMetadataById) {
  const desired = normalizeReasoningLevel(thinkingLevel);
  if (!desired) return undefined;

  const modelInfo = modelMetadataById.get(String(modelId ?? "").trim());
  if (modelInfo?.capabilities?.supports?.reasoningEffort !== true) return undefined;

  const supported = (Array.isArray(modelInfo.supportedReasoningEfforts) ? modelInfo.supportedReasoningEfforts : [])
    .map((level) => normalizeReasoningLevel(level))
    .filter(Boolean);
  if (supported.length === 0) return desired === "xhigh" ? "high" : desired;
  if (supported.includes(desired)) return desired;

  const desiredIndex = REASONING_LEVEL_ORDER.indexOf(desired);
  for (let index = desiredIndex; index >= 0; index -= 1) {
    if (supported.includes(REASONING_LEVEL_ORDER[index])) return REASONING_LEVEL_ORDER[index];
  }

  return supported[0];
}

async function loadCopilotSdkRuntime(env = process.env, importModule = async (moduleUrl) => await import(moduleUrl)) {
  const cliPath = resolveCopilotCliPath(env);
  if (!cliPath) {
    throw new Error("GitHub Copilot CLI is not installed in the runtime.");
  }

  const sdkCandidates = copilotClientSdkCandidates(env);
  if (sdkCandidates.length === 0) {
    throw new Error("GitHub Copilot SDK could not be located in the runtime.");
  }

  for (const sdkPath of sdkCandidates) {
    try {
      const sdkModule = await importModule(pathToFileURL(sdkPath).href);
      if (typeof sdkModule?.CopilotClient !== "function" || typeof sdkModule?.approveAll !== "function") continue;
      return {
        sdkModule,
        sdkPath,
        cliPath,
      };
    } catch {
      // try the next SDK candidate
    }
  }

  throw new Error("GitHub Copilot SDK could not be loaded in the runtime.");
}

async function stopCopilotRuntimeClient(client) {
  if (!client) return;
  try {
    await client.stop?.();
  } catch {
    try {
      await client.forceStop?.();
    } catch {
      // ignore best-effort shutdown failures
    }
  }
}

async function ensureRuntime(providerContext, deps = {}) {
  const globalState = getGlobalState();
  if (globalState.runtime) return globalState.runtime;
  if (globalState.runtimePromise) return await globalState.runtimePromise;

  const {
    env = process.env,
    importModule,
    createClient,
    listModels,
  } = deps;

  globalState.runtimePromise = (async () => {
    const runtimeInfo = await loadCopilotSdkRuntime(env, importModule);
    const discoveryEnv = buildCliEnv(env);
    const cliArgs = resolveCopilotCliArgs(env);

    const client = createClient
      ? await createClient({
        providerContext,
        cliPath: runtimeInfo.cliPath,
        cliArgs,
        sdkModule: runtimeInfo.sdkModule,
        env: discoveryEnv,
      })
      : new runtimeInfo.sdkModule.CopilotClient({
        cliPath: runtimeInfo.cliPath,
        ...(cliArgs.length > 0 ? { cliArgs } : {}),
        cwd: process.cwd(),
        env: discoveryEnv,
        logLevel: "error",
      });

    await client.start();

    let listedModels = [];
    try {
      listedModels = listModels ? await listModels(client) : await client.listModels();
    } catch {
      listedModels = [];
    }

    const modelMetadataById = new Map(
      (Array.isArray(listedModels) ? listedModels : [])
        .filter((model) => model && typeof model === "object" && typeof model.id === "string")
        .map((model) => [model.id, model]),
    );

    const runtime = {
      ...runtimeInfo,
      client,
      modelMetadataById,
    };

    if (!globalState.exitHookInstalled) {
      globalState.exitHookInstalled = true;
      process.once("exit", () => {
        void stopCopilotRuntimeClient(globalState.runtime?.client);
      });
    }

    globalState.runtime = runtime;
    return runtime;
  })();

  try {
    return await globalState.runtimePromise;
  } finally {
    globalState.runtimePromise = null;
  }
}

async function syncSessionModel(session, modelId, reasoningEffort) {
  if (!session?.rpc?.model?.switchTo) {
    if (typeof session?.setModel === "function") await session.setModel(modelId);
    return;
  }

  try {
    await session.rpc.model.switchTo({
      modelId,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
  } catch {
    if (typeof session?.setModel === "function") await session.setModel(modelId);
  }
}

async function resolveSessionState({ providerContext, model, context, options, deps = {} }) {
  if (typeof deps.resolveSessionState === "function") {
    return await deps.resolveSessionState({ providerContext, model, context, options });
  }

  const env = deps.env ?? process.env;
  const runtime = await ensureRuntime(providerContext, deps);
  const sessionKey = resolveSessionKey(providerContext, context, options);
  const globalState = getGlobalState();
  const existingState = globalState.sessions.get(sessionKey);
  const tools = normalizePiTools(context?.tools);
  const reasoningEffort = resolveReasoningEffort(model.id, providerContext?.thinkingLevel, runtime.modelMetadataById);

  if (existingState) {
    existingState.toolNames = new Set(tools.map((tool) => tool.name));
    if (typeof existingState.session?.registerTools === "function") {
      existingState.session.registerTools(tools);
    }
    await syncSessionModel(existingState.session, model.id, reasoningEffort);
    return existingState;
  }

  await ensureSessionStateDirectories(sessionKey, env);

  const sessionConfig = {
    clientName: CLIENT_NAME,
    model: model.id,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(context?.systemPrompt
      ? {
        systemMessage: {
          mode: "append",
          content: context.systemPrompt,
        },
      }
      : {}),
    tools,
    availableTools: tools.map((tool) => tool.name),
    onPermissionRequest: runtime.sdkModule.approveAll,
    workingDirectory: providerContext?.workspaceDir || process.cwd(),
    configDir: resolveCopilotHome(env) || undefined,
    streaming: true,
    infiniteSessions: { enabled: false },
  };

  let session = null;
  try {
    session = await runtime.client.resumeSession(sessionKey, sessionConfig);
  } catch {
    session = await runtime.client.createSession({
      ...sessionConfig,
      sessionId: sessionKey,
    });
  }

  const createdState = {
    sessionKey,
    session,
    pendingRequests: new Map(),
    toolNames: new Set(tools.map((tool) => tool.name)),
  };
  globalState.sessions.set(sessionKey, createdState);
  await syncSessionModel(session, model.id, reasoningEffort);
  return createdState;
}

function isIgnorableSessionError(event) {
  const errorType = String(event?.data?.errorType ?? "").trim().toLowerCase();
  return errorType === "persistence";
}

function serializeToolResult(message) {
  const serialized = flattenTextContent(message?.content);
  return serialized || (message?.isError ? "Tool execution failed." : "");
}

async function applyPendingToolResults(sessionState, messages = []) {
  if (!(sessionState?.pendingRequests instanceof Map) || sessionState.pendingRequests.size === 0) return false;

  const matchingResults = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== "toolResult") continue;
    const toolCallId = String(message.toolCallId ?? "").trim();
    if (!toolCallId || !sessionState.pendingRequests.has(toolCallId)) continue;
    matchingResults.set(toolCallId, message);
  }

  if (matchingResults.size === 0) {
    throw new Error("GitHub Copilot is waiting for tool results, but none were provided.");
  }

  for (const [toolCallId, entry] of [...sessionState.pendingRequests.entries()]) {
    const toolResult = matchingResults.get(toolCallId);
    if (!toolResult) continue;
    const payload = serializeToolResult(toolResult);
    await sessionState.session.rpc.tools.handlePendingToolCall(
      toolResult.isError
        ? { requestId: entry.requestId, error: payload || "Tool execution failed." }
        : { requestId: entry.requestId, result: payload },
    );
    sessionState.pendingRequests.delete(toolCallId);
  }

  return true;
}

function ensureUsage(output, usage) {
  if (!usage) return;
  output.usage = usage;
}

export function streamCopilotSdkTurn({ providerContext, model, context, options = {}, deps = {} }) {
  const stream = new AssistantMessageEventStream();
  const output = createAssistantMessage(model);
  const toolUseQuietMs = Number.isFinite(deps.toolUseQuietMs) ? Math.max(0, deps.toolUseQuietMs) : DEFAULT_TOOL_USE_QUIET_MS;

  (async () => {
    let sessionState = null;
    let unsubscribe = () => {};
    let abortListener = null;
    let finalized = false;
    let started = false;
    let textIndex = -1;
    let textClosed = false;
    let thinkingIndex = -1;
    let thinkingClosed = false;
    let toolUseTimer = null;
    let latestUsage = null;

    const cleanup = () => {
      if (toolUseTimer) clearTimeout(toolUseTimer);
      toolUseTimer = null;
      try {
        unsubscribe();
      } catch {}
      if (abortListener) {
        options?.signal?.removeEventListener?.("abort", abortListener);
      }
      abortListener = null;
    };

    const ensureStarted = () => {
      if (started) return;
      started = true;
      stream.push({ type: "start", partial: output });
    };

    const ensureTextBlock = () => {
      ensureStarted();
      if (textIndex >= 0) return;
      output.content.push({ type: "text", text: "" });
      textIndex = output.content.length - 1;
      stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
    };

    const ensureThinkingBlock = () => {
      ensureStarted();
      if (thinkingIndex >= 0) return;
      output.content.push({ type: "thinking", thinking: "" });
      thinkingIndex = output.content.length - 1;
      stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
    };

    const appendText = (text) => {
      if (!text) return;
      ensureTextBlock();
      output.content[textIndex].text += text;
      stream.push({ type: "text_delta", contentIndex: textIndex, delta: text, partial: output });
    };

    const syncFullText = (text) => {
      if (!text) return;
      ensureTextBlock();
      const current = output.content[textIndex].text;
      if (text === current) return;
      if (text.startsWith(current)) {
        appendText(text.slice(current.length));
        return;
      }
      output.content[textIndex].text = text;
      stream.push({ type: "text_delta", contentIndex: textIndex, delta: text, partial: output });
    };

    const closeText = () => {
      if (textIndex < 0 || textClosed) return;
      textClosed = true;
      stream.push({
        type: "text_end",
        contentIndex: textIndex,
        content: output.content[textIndex].text,
        partial: output,
      });
    };

    const appendThinking = (text) => {
      if (!text) return;
      ensureThinkingBlock();
      output.content[thinkingIndex].thinking += text;
      stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta: text, partial: output });
    };

    const syncFullThinking = (text) => {
      if (!text) return;
      ensureThinkingBlock();
      const current = output.content[thinkingIndex].thinking;
      if (text === current) return;
      if (text.startsWith(current)) {
        appendThinking(text.slice(current.length));
        return;
      }
      output.content[thinkingIndex].thinking = text;
      stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta: text, partial: output });
    };

    const closeThinking = () => {
      if (thinkingIndex < 0 || thinkingClosed) return;
      thinkingClosed = true;
      stream.push({
        type: "thinking_end",
        contentIndex: thinkingIndex,
        content: output.content[thinkingIndex].thinking,
        partial: output,
      });
    };

    const emitToolCall = (toolCall) => {
      ensureStarted();
      const normalized = {
        type: "toolCall",
        id: String(toolCall?.toolCallId ?? "").trim(),
        name: String(toolCall?.toolName ?? "").trim(),
        arguments: toolCall?.arguments && typeof toolCall.arguments === "object" ? toolCall.arguments : {},
      };
      if (!normalized.id || !normalized.name) return;
      if (output.content.some((entry) => entry?.type === "toolCall" && entry.id === normalized.id)) return;

      output.content.push(normalized);
      const contentIndex = output.content.length - 1;
      stream.push({ type: "toolcall_start", contentIndex, partial: output });
      stream.push({ type: "toolcall_end", contentIndex, toolCall: normalized, partial: output });
    };

    const finalize = (reason, errorMessage = "") => {
      if (finalized) return;
      finalized = true;
      cleanup();
      ensureUsage(output, latestUsage);
      closeThinking();
      closeText();
      output.stopReason = reason;
      output.timestamp = Date.now();
      if (reason === "error" || reason === "aborted") {
        if (errorMessage) output.errorMessage = errorMessage;
        stream.push({ type: "error", reason, error: output });
        return;
      }
      stream.push({ type: "done", reason, message: output });
    };

    const scheduleToolUseDone = () => {
      if (toolUseTimer) clearTimeout(toolUseTimer);
      toolUseTimer = setTimeout(() => finalize("toolUse"), toolUseQuietMs);
    };

    const handleSessionEvent = (event) => {
      if (!event || finalized) return;

      switch (event.type) {
        case "assistant.usage":
          latestUsage = buildUsage(event.data);
          ensureUsage(output, latestUsage);
          return;
        case "assistant.reasoning_delta":
          appendThinking(String(event?.data?.deltaContent ?? ""));
          return;
        case "assistant.message_delta":
          appendText(String(event?.data?.deltaContent ?? ""));
          return;
        case "assistant.message":
          syncFullThinking(String(event?.data?.reasoningText ?? ""));
          syncFullText(String(event?.data?.content ?? ""));
          return;
        case "external_tool.requested": {
          const toolCallId = String(event?.data?.toolCallId ?? "").trim();
          if (!toolCallId) return;
          sessionState.pendingRequests.set(toolCallId, {
            requestId: String(event?.data?.requestId ?? "").trim(),
            toolName: String(event?.data?.toolName ?? "").trim(),
          });
          emitToolCall(event.data);
          scheduleToolUseDone();
          return;
        }
        case "external_tool.completed": {
          const requestId = String(event?.data?.requestId ?? "").trim();
          if (!requestId) return;
          for (const [toolCallId, pending] of sessionState.pendingRequests.entries()) {
            if (pending.requestId === requestId) sessionState.pendingRequests.delete(toolCallId);
          }
          return;
        }
        case "session.error":
          if (isIgnorableSessionError(event)) return;
          finalize("error", String(event?.data?.message ?? "GitHub Copilot session failed."));
          return;
        case "session.idle":
          finalize("stop");
          return;
        default:
      }
    };

    try {
      sessionState = await resolveSessionState({ providerContext, model, context, options, deps });
      unsubscribe = sessionState.session.on(handleSessionEvent);

      abortListener = () => {
        void sessionState.session.abort?.().catch(() => {});
        finalize("aborted", "GitHub Copilot request aborted.");
      };
      options?.signal?.addEventListener?.("abort", abortListener, { once: true });
      if (options?.signal?.aborted) {
        abortListener();
        return;
      }

      const handledToolResults = await applyPendingToolResults(sessionState, context?.messages);
      if (handledToolResults) return;

      const lastUserMessage = findLastUserMessage(context?.messages);
      if (!lastUserMessage) {
        throw new Error("GitHub Copilot SDK stream requires a trailing user message.");
      }

      await sessionState.session.send({
        prompt: flattenTextContent(lastUserMessage.content),
      });
    } catch (error) {
      finalize("error", error instanceof Error ? error.message : String(error));
    }
  })();

  return stream;
}

export function createCopilotSdkProviderStreamWrapper(providerContext, deps = {}) {
  return (model, context, options) => streamCopilotSdkTurn({
    providerContext,
    model,
    context,
    options,
    deps,
  });
}

export const __private__ = Object.freeze({
  AssistantMessageEventStream,
  applyPendingToolResults,
  buildCliEnv,
  buildUsage,
  defaultToolUseQuietMs: DEFAULT_TOOL_USE_QUIET_MS,
  ensureSessionStateDirectories,
  findLastUserMessage,
  flattenTextContent,
  normalizePiTools,
  resolveReasoningEffort,
  resolveSessionKey,
});
