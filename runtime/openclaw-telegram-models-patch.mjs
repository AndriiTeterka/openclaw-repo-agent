#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const distRoot = process.argv[2];
const PATCH_MARKER = "OPENCLAW_TELEGRAM_MODELS_PATCH_V4";

if (!distRoot) {
  throw new Error("Missing OpenClaw dist root path.");
}

async function listJavaScriptFiles(rootDir) {
  const files = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.pop();
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".js")) files.push(entryPath);
    }
  }

  return files;
}

async function readSources(files) {
  return await Promise.all(files.map(async (filePath) => ({
    filePath,
    source: await fs.readFile(filePath, "utf8"),
  })));
}

async function replaceRequired(files, matcher, replacement, label) {
  let replacementCount = 0;

  for (const filePath of files) {
    const source = await fs.readFile(filePath, "utf8");
    const updated = source.replace(matcher, (...args) => {
      replacementCount += 1;
      return typeof replacement === "function" ? replacement(...args) : replacement;
    });
    if (updated !== source) {
      await fs.writeFile(filePath, updated);
    }
  }

  if (replacementCount === 0) {
    throw new Error(`Unable to find expected OpenClaw source for ${label}`);
  }
}

const files = await listJavaScriptFiles(distRoot);
const sources = await readSources(files);
if (sources.some(({ source }) => source.includes(PATCH_MARKER))) {
  process.exit(0);
}

const conversationRouteReplacement = `function resolveTelegramConversationRoute(params) {
\tconst peerId = params.isGroup ? buildTelegramGroupPeerId(params.chatId, params.resolvedThreadId) : resolveTelegramDirectPeerId({
\t\tchatId: params.chatId,
\t\tsenderId: params.senderId
\t});
\tconst parentPeer = buildTelegramParentPeer({
\t\tisGroup: params.isGroup,
\t\tresolvedThreadId: params.resolvedThreadId,
\t\tchatId: params.chatId
\t});
\tlet route = resolveAgentRoute({
\t\tcfg: params.cfg,
\t\tchannel: "telegram",
\t\taccountId: params.accountId,
\t\tpeer: {
\t\t\tkind: params.isGroup ? "group" : "direct",
\t\t\tid: peerId
\t\t},
\t\tparentPeer
\t});
\tconst rawTopicAgentId = params.topicAgentId?.trim();
\tif (rawTopicAgentId) {
\t\tconst topicAgentId = sanitizeAgentId(rawTopicAgentId);
\t\troute = {
\t\t\t...route,
\t\t\tagentId: topicAgentId,
\t\t\tsessionKey: buildAgentSessionKey({
\t\t\t\tagentId: topicAgentId,
\t\t\t\tchannel: "telegram",
\t\t\t\taccountId: params.accountId,
\t\t\t\tpeer: {
\t\t\t\t\tkind: params.isGroup ? "group" : "direct",
\t\t\t\t\tid: peerId
\t\t\t\t},
\t\t\t\tdmScope: params.cfg.session?.dmScope,
\t\t\t\tidentityLinks: params.cfg.session?.identityLinks
\t\t\t}).toLowerCase(),
\t\t\tmainSessionKey: buildAgentMainSessionKey({ agentId: topicAgentId }).toLowerCase(),
\t\t\tlastRoutePolicy: deriveLastRoutePolicy({
\t\t\t\tsessionKey: buildAgentSessionKey({
\t\t\t\t\tagentId: topicAgentId,
\t\t\t\t\tchannel: "telegram",
\t\t\t\t\taccountId: params.accountId,
\t\t\t\t\tpeer: {
\t\t\t\t\t\tkind: params.isGroup ? "group" : "direct",
\t\t\t\t\t\tid: peerId
\t\t\t\t\t},
\t\t\t\t\tdmScope: params.cfg.session?.dmScope,
\t\t\t\t\tidentityLinks: params.cfg.session?.identityLinks
\t\t\t\t}).toLowerCase(),
\t\t\t\tmainSessionKey: buildAgentMainSessionKey({ agentId: topicAgentId }).toLowerCase()
\t\t\t})
\t\t};
\t\tlogVerbose(\`telegram: topic route override: topic=\${params.resolvedThreadId ?? params.replyThreadId} agent=\${topicAgentId} sessionKey=\${route.sessionKey}\`);
\t}
\tconst configuredRoute = resolveConfiguredBindingRoute({
\t\tcfg: params.cfg,
\t\troute,
\t\tconversation: {
\t\t\tchannel: "telegram",
\t\t\taccountId: params.accountId,
\t\t\tconversationId: peerId,
\t\t\tparentConversationId: params.isGroup ? String(params.chatId) : void 0
\t\t}
\t});
\tlet configuredBinding = configuredRoute.bindingResolution;
\tlet configuredBindingSessionKey = configuredRoute.boundSessionKey ?? "";
\troute = configuredRoute.route;
\tconst currentConversationBinding = getSessionBindingService().resolveByConversation({
\t\tchannel: "telegram",
\t\taccountId: params.accountId,
\t\tconversationId: peerId,
\t\tparentConversationId: params.isGroup ? String(params.chatId) : void 0
\t});
\tconst currentBoundSessionKey = currentConversationBinding?.targetSessionKey?.trim();
\tif (currentConversationBinding && currentBoundSessionKey) {
\t\tif (!isPluginOwnedSessionBindingRecord(currentConversationBinding)) route = {
\t\t\t...route,
\t\t\tsessionKey: currentBoundSessionKey,
\t\t\tagentId: resolveAgentIdFromSessionKey(currentBoundSessionKey),
\t\t\tlastRoutePolicy: deriveLastRoutePolicy({
\t\t\t\tsessionKey: currentBoundSessionKey,
\t\t\t\tmainSessionKey: route.mainSessionKey
\t\t\t}),
\t\t\tmatchedBy: "binding.channel"
\t\t};
\t\tconfiguredBinding = null;
\t\tconfiguredBindingSessionKey = "";
\t\tgetSessionBindingService().touch(currentConversationBinding.bindingId);
\t\tlogVerbose(isPluginOwnedSessionBindingRecord(currentConversationBinding) ? \`telegram: plugin-bound conversation \${peerId}\` : \`telegram: routed via current conversation binding \${peerId} -> \${currentBoundSessionKey}\`);
\t}
\tconst threadBindingConversationId = params.replyThreadId != null ? \`\${params.chatId}:topic:\${params.replyThreadId}\` : !params.isGroup ? String(params.chatId) : void 0;
\tif (!currentBoundSessionKey && threadBindingConversationId) {
\t\tconst threadBinding = getSessionBindingService().resolveByConversation({
\t\t\tchannel: "telegram",
\t\t\taccountId: params.accountId,
\t\t\tconversationId: threadBindingConversationId
\t\t});
\t\tconst boundSessionKey = threadBinding?.targetSessionKey?.trim();
\t\tif (threadBinding && boundSessionKey) {
\t\t\tif (!isPluginOwnedSessionBindingRecord(threadBinding)) route = {
\t\t\t\t...route,
\t\t\t\tsessionKey: boundSessionKey,
\t\t\t\tagentId: resolveAgentIdFromSessionKey(boundSessionKey),
\t\t\t\tlastRoutePolicy: deriveLastRoutePolicy({
\t\t\t\t\tsessionKey: boundSessionKey,
\t\t\t\t\tmainSessionKey: route.mainSessionKey
\t\t\t\t}),
\t\t\t\tmatchedBy: "binding.channel"
\t\t\t};
\t\t\tconfiguredBinding = null;
\t\t\tconfiguredBindingSessionKey = "";
\t\t\tgetSessionBindingService().touch(threadBinding.bindingId);
\t\t\tlogVerbose(isPluginOwnedSessionBindingRecord(threadBinding) ? \`telegram: plugin-bound conversation \${threadBindingConversationId}\` : \`telegram: routed via bound conversation \${threadBindingConversationId} -> \${boundSessionKey}\`);
\t\t}
\t}
\treturn {
\t\troute,
\t\tconfiguredBinding,
\t\tconfiguredBindingSessionKey
\t};
}
function resolveTelegramConversationBaseSessionKey`;

const providerDataReplacement = `async function buildModelsProviderData(cfg, agentId) {
\tconst OPENCLAW_TELEGRAM_MODELS_PATCH_V4 = true;
\tconst OPENCLAW_LIVE_MODELS_HELPER = "/opt/openclaw/live-models-provider-data.mjs";
\tconst resolvedDefault = resolveDefaultModelForAgent({
\t\tcfg,
\t\tagentId
\t});
\tconst normalizeAgentId = (value) => typeof value === "string" ? value.trim().toLowerCase() : "";
\tconst defaultAgent = normalizeAgentId(cfg?.acp?.defaultAgent);
\tconst configuredAgents = Array.from(new Set((Array.isArray(cfg?.acp?.allowedAgents) ? cfg.acp.allowedAgents : []).map((value) => normalizeAgentId(value)).filter(Boolean)));
\tconst allowedAgents = configuredAgents.length > 0 ? configuredAgents : defaultAgent ? [defaultAgent] : [];
\tconst fallbackProviderId = (agentIdValue) => {
\t\tif (agentIdValue === "codex") return "openai-codex";
\t\tif (agentIdValue === "copilot") return "github-copilot";
\t\tif (agentIdValue === "gemini") return "google-gemini-cli";
\t\treturn agentIdValue;
\t};
\tconst fallbackLabel = (agentIdValue) => {
\t\tif (agentIdValue === "codex") return "Codex";
\t\tif (agentIdValue === "copilot") return "Copilot";
\t\tif (agentIdValue === "gemini") return "Gemini";
\t\treturn agentIdValue;
\t};
\tconst fallbackReason = (agentIdValue, label) => {
\t\tif (agentIdValue === "codex") return label + " is currently unavailable. Sign in on the host, then run /acp doctor.";
\t\tif (agentIdValue === "copilot") return label + " is currently unavailable. Sign in on the host, then run /acp doctor.";
\t\tif (agentIdValue === "gemini") return label + " is currently unavailable. Sign in on the host, then run /acp doctor.";
\t\treturn label + " is currently unavailable. Fix auth and run /acp doctor.";
\t};
\ttry {
\t\tconst { execFileSync } = await import("node:child_process");
\t\tconst payload = JSON.stringify({
\t\t\tallowedAgents,
\t\t\tdefaultAgent,
\t\t\tauthMode: typeof process?.env?.OPENCLAW_BOOTSTRAP_AUTH_MODE === "string" && process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE.trim().length > 0 ? process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE.trim() : defaultAgent
\t\t});
\t\tconst raw = execFileSync(process.execPath, [OPENCLAW_LIVE_MODELS_HELPER, payload], {
\t\t\tencoding: "utf8",
\t\t\tenv: process.env,
\t\t\tstdio: ["ignore", "pipe", "pipe"]
\t\t}).trim();
\t\tconst parsed = raw ? JSON.parse(raw) : {};
\t\tconst normalizeProviderEntry = (entry) => {
\t\t\tconst models = Array.isArray(entry?.models) ? entry.models.map((value) => String(value ?? "").trim()).filter(Boolean) : [];
\t\t\treturn {
\t\t\t\tagentId: normalizeAgentId(entry?.agentId),
\t\t\t\tproviderId: typeof entry?.providerId === "string" ? entry.providerId.trim().toLowerCase() : "",
\t\t\t\tlabel: typeof entry?.label === "string" && entry.label.trim() ? entry.label.trim() : fallbackLabel(normalizeAgentId(entry?.agentId)),
\t\t\t\tcount: Number(entry?.count ?? models.length) || 0,
\t\t\t\tmodels,
\t\t\t\treason: typeof entry?.reason === "string" ? entry.reason.trim() : ""
\t\t\t};
\t\t};
\t\tconst discoveredAvailableProviders = (Array.isArray(parsed?.availableProviders) ? parsed.availableProviders : []).map(normalizeProviderEntry).filter((entry) => entry.providerId);
\t\tconst discoveredUnavailableProviders = (Array.isArray(parsed?.unavailableProviders) ? parsed.unavailableProviders : []).map(normalizeProviderEntry).filter((entry) => entry.providerId);
\t\tconst byProvider = /* @__PURE__ */ new Map();
\t\tfor (const entry of discoveredAvailableProviders) byProvider.set(entry.providerId, new Set(entry.models));
\t\treturn {
\t\t\tbyProvider,
\t\t\tproviders: discoveredAvailableProviders.map((entry) => entry.providerId),
\t\t\tresolvedDefault,
\t\t\tavailableProviders: discoveredAvailableProviders,
\t\t\tunavailableProviders: discoveredUnavailableProviders
\t\t};
\t} catch {
\t\tconst fallbackUnavailableProviders = allowedAgents.map((agentIdValue) => {
\t\t\tconst label = fallbackLabel(agentIdValue);
\t\t\treturn {
\t\t\t\tagentId: agentIdValue,
\t\t\t\tproviderId: fallbackProviderId(agentIdValue),
\t\t\t\tlabel,
\t\t\t\tcount: 0,
\t\t\t\tmodels: [],
\t\t\t\treason: fallbackReason(agentIdValue, label)
\t\t\t};
\t\t});
\t\treturn {
\t\t\tbyProvider: /* @__PURE__ */ new Map(),
\t\t\tproviders: [],
\t\t\tresolvedDefault,
\t\t\tavailableProviders: [],
\t\t\tunavailableProviders: fallbackUnavailableProviders
\t\t};
\t}
}
function formatProviderLine`;

const providerKeyboardReplacement = `function buildProviderKeyboard(providers) {
\tif (providers.length === 0) return [];
\tconst rows = [];
\tlet currentRow = [];
\tfor (const provider of providers) {
\t\tconst label = typeof provider?.label === "string" && provider.label.trim() ? provider.label.trim() : provider.id;
\t\tconst count = Number(provider?.count ?? 0) || 0;
\t\tconst button = {
\t\t\ttext: provider?.selected ? label + " ✓ (" + count + ")" : label + " (" + count + ")",
\t\t\tcallback_data: "mdl_list_" + provider.id + "_1"
\t\t};
\t\tcurrentRow.push(button);
\t\tif (currentRow.length === 2) {
\t\t\trows.push(currentRow);
\t\t\tcurrentRow = [];
\t\t}
\t}
\tif (currentRow.length > 0) rows.push(currentRow);
\treturn rows;
\t}`;

const modelsKeyboardReplacement = `function buildModelsKeyboard(params) {
\tconst { provider, models, currentModel, currentPage, totalPages } = params;
\tconst pageSize = params.pageSize ?? MODELS_PAGE_SIZE;
\tif (models.length === 0) return [];
\tconst rows = [];
\tconst startIndex = (currentPage - 1) * pageSize;
\tconst endIndex = Math.min(startIndex + pageSize, models.length);
\tconst pageModels = models.slice(startIndex, endIndex);
\tconst currentModelId = currentModel?.includes("/") ? currentModel.split("/").slice(1).join("/") : currentModel;
\tfor (const model of pageModels) {
\t\tconst callbackData = buildModelSelectionCallbackData({
\t\t\tprovider,
\t\t\tmodel
\t\t});
\t\tif (!callbackData) continue;
\t\tconst isCurrentModel = model === currentModelId;
\t\tconst displayText = truncateModelId(model, 38);
\t\tconst text = isCurrentModel ? displayText + " ✓" : displayText;
\t\trows.push([{
\t\t\ttext,
\t\t\tcallback_data: callbackData
\t\t}]);
\t}
\tif (totalPages > 1) {
\t\tconst paginationRow = [];
\t\tif (currentPage > 1) paginationRow.push({
\t\t\ttext: "◀ Prev",
\t\t\tcallback_data: CALLBACK_PREFIX.list + provider + "_" + (currentPage - 1)
\t\t});
\t\tpaginationRow.push({
\t\t\ttext: currentPage + "/" + totalPages,
\t\t\tcallback_data: CALLBACK_PREFIX.list + provider + "_" + currentPage
\t\t});
\t\tif (currentPage < totalPages) paginationRow.push({
\t\t\ttext: "Next ▶",
\t\t\tcallback_data: CALLBACK_PREFIX.list + provider + "_" + (currentPage + 1)
\t\t});
\t\trows.push(paginationRow);
\t}
\trows.push([{
\t\ttext: "<< Back",
\t\tcallback_data: CALLBACK_PREFIX.back
\t}]);
\treturn rows;
\t}`;

const modelsReplyReplacement = `async function resolveModelsCommandReply(params) {
\tconst body = params.commandBodyNormalized.trim();
\tif (!body.startsWith("/models")) return null;
\tlet { provider, page, pageSize, all } = parseModelsArgs(body.replace(/^\\/models\\b/i, "").trim());
\tconst providerData = params.providerData ?? await buildModelsProviderData(params.cfg, params.agentId);
\tconst { byProvider, providers, availableProviders: liveAvailableProviders = [], unavailableProviders: liveUnavailableProviders = [] } = providerData;
\tconst isTelegram = params.surface === "telegram";
\tconst currentModel = [
\t\ttypeof params?.currentModel === "string" ? params.currentModel : "",
\t\ttypeof params?.sessionEntry?.model === "string" ? params.sessionEntry.model : "",
\t\ttypeof params?.sessionState?.model === "string" ? params.sessionState.model : ""
\t].find((value) => typeof value === "string" && value.length > 0) ?? "";
\tconst currentProvider = currentModel.includes("/") ? currentModel.split("/")[0] : "";
\tconst providerButtons = liveAvailableProviders.map((entry) => ({
\t\tid: entry.providerId,
\t\tlabel: entry.label,
\t\tcount: entry.count,
\t\tselected: entry.providerId === currentProvider
\t}));
\tconst availableLines = liveAvailableProviders.length > 0
\t\t? liveAvailableProviders.map((entry) => "- " + entry.providerId + " (" + entry.label + ", " + entry.count + ")")
\t\t: ["- none"];
\tconst unavailableLines = liveUnavailableProviders.map((entry) => "- " + entry.providerId + " (" + entry.label + ") — unavailable. " + entry.reason);
\tif (!provider && providers.length === 1) provider = providers[0];
\tif (!provider) {
\t\tconst lines = ["Providers:", ...availableLines];
\t\tif (unavailableLines.length > 0) lines.push("", "Unavailable providers:", ...unavailableLines);
\t\tif (liveAvailableProviders.length > 0) lines.push("", "Use: /models <provider>");
\t\telse lines.push("", "No providers currently have live models. Fix auth and run /acp doctor.");
\t\tconst reply = { text: lines.join("\\n") };
\t\tif (isTelegram && liveAvailableProviders.length > 1) {
\t\t\treply.channelData = {
\t\t\t\ttelegram: {
\t\t\t\t\tbuttons: buildProviderKeyboard(providerButtons)
\t\t\t\t}
\t\t\t};
\t\t}
\t\treturn reply;
\t}
\tconst selectedAvailableProvider = liveAvailableProviders.find((entry) => entry.providerId === provider);
\tconst selectedUnavailableProvider = liveUnavailableProviders.find((entry) => entry.providerId === provider);
\tif (!selectedAvailableProvider) {
\t\tconst lines = selectedUnavailableProvider
\t\t\t? [
\t\t\t\tselectedUnavailableProvider.label + " (" + selectedUnavailableProvider.providerId + ") is currently unavailable.",
\t\t\t\t"",
\t\t\t\tselectedUnavailableProvider.reason
\t\t\t]
\t\t\t: [
\t\t\t\t"Unknown provider: " + provider,
\t\t\t\t"",
\t\t\t\t"Available providers:",
\t\t\t\t...availableLines
\t\t\t];
\t\tif (liveAvailableProviders.length > 0 && !selectedUnavailableProvider) lines.push("", "Use: /models <provider>");
\t\tconst reply = { text: lines.join("\\n") };
\t\tif (isTelegram && liveAvailableProviders.length > 0) {
\t\t\treply.channelData = {
\t\t\t\ttelegram: {
\t\t\t\t\tbuttons: buildProviderKeyboard(providerButtons)
\t\t\t\t}
\t\t\t};
\t\t}
\t\treturn reply;
\t}
\tconst models = [...byProvider.get(provider) ?? /* @__PURE__ */ new Set()];
\tconst total = models.length;
\tif (total === 0) {
\t\tconst lines = [
\t\t\tselectedAvailableProvider.label + " (" + selectedAvailableProvider.providerId + ") is currently unavailable.",
\t\t\t"",
\t\t\tselectedAvailableProvider.reason || "Fix auth and run /acp doctor."
\t\t];
\t\tconst reply = { text: lines.join("\\n") };
\t\tif (isTelegram && liveAvailableProviders.length > 0) {
\t\t\treply.channelData = {
\t\t\t\ttelegram: {
\t\t\t\t\tbuttons: buildProviderKeyboard(providerButtons)
\t\t\t\t}
\t\t\t};
\t\t}
\t\treturn reply;
\t}
\tif (isTelegram) {
\t\tconst telegramPageSize = getModelsPageSize();
\t\tconst totalPages = calculateTotalPages(total, telegramPageSize);
\t\tconst safePage = Math.max(1, Math.min(page, totalPages));
\t\treturn {
\t\t\ttext: formatModelsAvailableHeader({
\t\t\t\tprovider,
\t\t\t\ttotal,
\t\t\t\tcfg: params.cfg,
\t\t\t\tagentDir: params.agentDir,
\t\t\t\tsessionEntry: params.sessionEntry
\t\t\t}),
\t\t\tchannelData: {
\t\t\t\ttelegram: {
\t\t\t\t\tbuttons: buildModelsKeyboard({
\t\t\t\t\t\tprovider,
\t\t\t\t\t\tmodels,
\t\t\t\t\t\tcurrentModel,
\t\t\t\t\t\tcurrentPage: safePage,
\t\t\t\t\t\ttotalPages,
\t\t\t\t\t\tpageSize: telegramPageSize
\t\t\t\t\t})
\t\t\t\t}
\t\t\t}
\t\t};
\t}
\tconst effectivePageSize = all ? total : pageSize;
\tconst pageCount = effectivePageSize > 0 ? Math.ceil(total / effectivePageSize) : 1;
\tconst safePage = all ? 1 : Math.max(1, Math.min(page, pageCount));
\tif (!all && page !== safePage) return { text: [
\t\t"Page out of range: " + page + " (valid: 1-" + pageCount + ")",
\t\t"",
\t\t"Try: /models " + provider + " " + safePage,
\t\t"All: /models " + provider + " all"
\t].join("\\n") };
\tconst startIndex = (safePage - 1) * effectivePageSize;
\tconst endIndexExclusive = Math.min(total, startIndex + effectivePageSize);
\tconst pageModels = models.slice(startIndex, endIndexExclusive);
\tconst lines = ["Models (" + selectedAvailableProvider.providerId + " · " + selectedAvailableProvider.label + ") — showing " + (startIndex + 1) + "-" + endIndexExclusive + " of " + total + " (page " + safePage + "/" + pageCount + ")"];
\tfor (const id of pageModels) lines.push("- " + provider + "/" + id);
\tlines.push("", "Switch: /model <provider/model>", "Back: /models");
\tif (!all && safePage < pageCount) lines.push("More: /models " + provider + " " + (safePage + 1));
\tif (!all) lines.push("All: /models " + provider + " all");
\treturn { text: lines.join("\\n") };
\t}
\tconst handleModelsCommand =`;

const providersCallbackReplacement = `if (modelCallback.type === "providers" || modelCallback.type === "back") {
\t\t\t\t\tconst currentSessionState = resolveTelegramSessionState({
\t\t\t\t\t\tchatId,
\t\t\t\t\t\tisGroup,
\t\t\t\t\t\tisForum,
\t\t\t\t\t\tmessageThreadId,
\t\t\t\t\t\tresolvedThreadId,
\t\t\t\t\t\tsenderId
\t\t\t\t\t});
\t\t\t\t\tconst currentModel = typeof currentSessionState.model === "string" && currentSessionState.model.length > 0 ? currentSessionState.model : typeof currentSessionState.sessionEntry?.model === "string" ? currentSessionState.sessionEntry.model : "";
\t\t\t\t\tconst providerData = await buildModelsProviderData(cfg, currentSessionState.agentId);
\t\t\t\t\tconst reply = await resolveModelsCommandReply({
\t\t\t\t\t\tcommandBodyNormalized: "/models",
\t\t\t\t\t\tcfg,
\t\t\t\t\t\tagentId: currentSessionState.agentId,
\t\t\t\t\t\tsurface: "telegram",
\t\t\t\t\t\tcurrentModel,
\t\t\t\t\t\tsessionEntry: currentSessionState.sessionEntry,
\t\t\t\t\t\tsessionState: currentSessionState,
\t\t\t\t\t\tagentDir: resolveAgentDir(cfg, currentSessionState.agentId),
\t\t\t\t\t\tproviderData
\t\t\t\t\t});
\t\t\t\t\tawait editMessageWithButtons(reply?.text ?? "No providers available.", reply?.channelData?.telegram?.buttons ?? []);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tif (modelCallback.type === "list") {`;

const listCallbackReplacement = `if (modelCallback.type === "list") {
\t\t\t\t\tconst { provider, page } = modelCallback;
\t\t\t\t\tconst currentSessionState = resolveTelegramSessionState({
\t\t\t\t\t\tchatId,
\t\t\t\t\t\tisGroup,
\t\t\t\t\t\tisForum,
\t\t\t\t\t\tmessageThreadId,
\t\t\t\t\t\tresolvedThreadId,
\t\t\t\t\t\tsenderId
\t\t\t\t\t});
\t\t\t\t\tconst currentModel = typeof currentSessionState.model === "string" && currentSessionState.model.length > 0 ? currentSessionState.model : typeof currentSessionState.sessionEntry?.model === "string" ? currentSessionState.sessionEntry.model : "";
\t\t\t\t\tconst safePage = Number.isFinite(page) && page > 0 ? page : 1;
\t\t\t\t\tconst providerData = await buildModelsProviderData(cfg, currentSessionState.agentId);
\t\t\t\t\tconst reply = await resolveModelsCommandReply({
\t\t\t\t\t\tcommandBodyNormalized: "/models " + provider + " " + safePage,
\t\t\t\t\t\tcfg,
\t\t\t\t\t\tagentId: currentSessionState.agentId,
\t\t\t\t\t\tsurface: "telegram",
\t\t\t\t\t\tcurrentModel,
\t\t\t\t\t\tsessionEntry: currentSessionState.sessionEntry,
\t\t\t\t\t\tsessionState: currentSessionState,
\t\t\t\t\t\tagentDir: resolveAgentDir(cfg, currentSessionState.agentId),
\t\t\t\t\t\tproviderData
\t\t\t\t\t});
\t\t\t\t\tawait editMessageWithButtons(reply?.text ?? ("Unknown provider: " + provider), reply?.channelData?.telegram?.buttons ?? []);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tif (modelCallback.type === "select") {`;

const selectCallbackReplacement = `if (modelCallback.type === "select") {
\t\t\t\t\tconst currentSessionState = resolveTelegramSessionState({
\t\t\t\t\t\tchatId,
\t\t\t\t\t\tisGroup,
\t\t\t\t\t\tisForum,
\t\t\t\t\t\tmessageThreadId,
\t\t\t\t\t\tresolvedThreadId,
\t\t\t\t\t\tsenderId
\t\t\t\t\t});
\t\t\t\t\tconst selection = resolveModelSelection({
\t\t\t\t\t\tcallback: modelCallback,
\t\t\t\t\t\tproviders,
\t\t\t\t\t\tbyProvider
\t\t\t\t\t});
\t\t\t\t\tif (selection.kind !== "resolved") {
\t\t\t\t\t\tconst buttons = buildProviderKeyboard(providers.map((p) => ({
\t\t\t\t\t\t\tid: p,
\t\t\t\t\t\t\tcount: byProvider.get(p)?.size ?? 0
\t\t\t\t\t\t})));
\t\t\t\t\t\tawait editMessageWithButtons(\`Could not resolve model "\${selection.model}".\\n\\nSelect a provider:\`, buttons);
\t\t\t\t\t\treturn;
\t\t\t\t\t}
\t\t\t\t\tif (!byProvider.get(selection.provider)?.has(selection.model)) {
\t\t\t\t\t\tawait editMessageWithButtons(\`❌ Model "\${selection.provider}/\${selection.model}" is not allowed.\`, []);
\t\t\t\t\t\treturn;
\t\t\t\t\t}
\t\t\t\t\tconst resolveSelectedAgentId = (providerId) => {
\t\t\t\t\t\tif (providerId === "openai-codex") return "codex";
\t\t\t\t\t\tif (providerId === "google" || providerId === "google-gemini-cli") return "gemini";
\t\t\t\t\t\tif (providerId === "github-copilot") return "copilot";
\t\t\t\t\t\treturn currentSessionState.agentId;
\t\t\t\t\t};
\t\t\t\t\tconst targetAgentId = resolveSelectedAgentId(selection.provider);
\t\t\t\t\tconst peerId = isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : resolveTelegramDirectPeerId({
\t\t\t\t\t\tchatId,
\t\t\t\t\t\tsenderId
\t\t\t\t\t});
\t\t\t\t\tconst targetBaseSessionKey = buildAgentSessionKey({
\t\t\t\t\t\tagentId: targetAgentId,
\t\t\t\t\t\tchannel: "telegram",
\t\t\t\t\t\taccountId,
\t\t\t\t\t\tpeer: {
\t\t\t\t\t\t\tkind: isGroup ? "group" : "direct",
\t\t\t\t\t\t\tid: peerId
\t\t\t\t\t\t},
\t\t\t\t\t\tdmScope: cfg.session?.dmScope,
\t\t\t\t\t\tidentityLinks: cfg.session?.identityLinks
\t\t\t\t\t}).toLowerCase();
\t\t\t\t\tconst dmThreadId = !isGroup ? messageThreadId : void 0;
\t\t\t\t\tconst targetSessionKey = (dmThreadId != null ? resolveThreadSessionKeys$1({
\t\t\t\t\t\tbaseSessionKey: targetBaseSessionKey,
\t\t\t\t\t\tthreadId: \`\${chatId}:\${dmThreadId}\`
\t\t\t\t\t}) : null)?.sessionKey ?? targetBaseSessionKey;
\t\t\t\t\tconst conversation = {
\t\t\t\t\t\tchannel: "telegram",
\t\t\t\t\t\taccountId,
\t\t\t\t\t\tconversationId: peerId,
\t\t\t\t\t\t...(isGroup ? {
\t\t\t\t\t\t\tparentConversationId: String(chatId)
\t\t\t\t\t\t} : {})
\t\t\t\t\t};
\t\t\t\t\ttry {
\t\t\t\t\t\tconst storePath = telegramDeps.resolveStorePath(cfg.session?.store, { agentId: targetAgentId });
\t\t\t\t\t\tconst resolvedDefault = resolveDefaultModelForAgent({
\t\t\t\t\t\t\tcfg,
\t\t\t\t\t\t\tagentId: targetAgentId
\t\t\t\t\t\t});
\t\t\t\t\t\tconst isDefaultSelection = selection.provider === resolvedDefault.provider && selection.model === resolvedDefault.model;
\t\t\t\t\t\tawait updateSessionStore(storePath, (store) => {
\t\t\t\t\t\t\tconst entry = store[targetSessionKey] ?? {};
\t\t\t\t\t\t\tstore[targetSessionKey] = entry;
\t\t\t\t\t\t\tapplyModelOverrideToSessionEntry({
\t\t\t\t\t\t\t\tentry,
\t\t\t\t\t\t\t\tselection: {
\t\t\t\t\t\t\t\t\tprovider: selection.provider,
\t\t\t\t\t\t\t\t\tmodel: selection.model,
\t\t\t\t\t\t\t\t\tisDefault: isDefaultSelection
\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t});
\t\t\t\t\t\t\tif (entry.agentId !== targetAgentId) {
\t\t\t\t\t\t\t\tentry.agentId = targetAgentId;
\t\t\t\t\t\t\t\tentry.updatedAt = Date.now();
\t\t\t\t\t\t\t}
\t\t\t\t\t\t});
\t\t\t\t\t\tawait getSessionBindingService().bind({
\t\t\t\t\t\t\tconversation,
\t\t\t\t\t\t\ttargetSessionKey,
\t\t\t\t\t\t\ttargetKind: "acp",
\t\t\t\t\t\t\tmetadata: {
\t\t\t\t\t\t\t\tagentId: targetAgentId,
\t\t\t\t\t\t\t\tprovider: selection.provider,
\t\t\t\t\t\t\t\tmodel: selection.model,
\t\t\t\t\t\t\t\tsource: "telegram-model-picker",
\t\t\t\t\t\t\t\tlastActivityAt: Date.now()
\t\t\t\t\t\t\t}
\t\t\t\t\t\t});
\t\t\t\t\t\tconst requestedLiveSwitch = targetAgentId === currentSessionState.agentId && currentSessionState.sessionEntry?.sessionId ? requestLiveSessionModelSwitch({
\t\t\t\t\t\t\tsessionEntry: currentSessionState.sessionEntry,
\t\t\t\t\t\t\tselection: {
\t\t\t\t\t\t\t\tprovider: selection.provider,
\t\t\t\t\t\t\t\tmodel: selection.model
\t\t\t\t\t\t\t}
\t\t\t\t\t\t}) : false;
\t\t\t\t\t\tconst changedAgent = targetAgentId !== currentSessionState.agentId;
\t\t\t\t\t\tconst confirmationLines = [\`✅ Model \${isDefaultSelection ? "reset to default" : \`changed to **\${selection.provider}/\${selection.model}**\`}\`];
\t\t\t\t\t\tif (changedAgent) confirmationLines.push(\`Conversation agent switched to **\${targetAgentId}**.\`);
\t\t\t\t\t\tconfirmationLines.push("");
\t\t\t\t\t\tconfirmationLines.push(requestedLiveSwitch ? "This change is being applied now." : "This model will be used for your next message.");
\t\t\t\t\t\tawait editMessageWithButtons(confirmationLines.join("\\n"), []);
\t\t\t\t\t} catch (err) {
\t\t\t\t\t\tawait editMessageWithButtons(\`❌ Failed to change model: \${String(err)}\`, []);
\t\t\t\t\t}
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\treturn;`;

await replaceRequired(
  files,
  /function resolveTelegramConversationRoute\(params\) \{[\s\S]*?\n\}\nfunction resolveTelegramConversationBaseSessionKey/,
  conversationRouteReplacement,
  "telegram current conversation binding route resolution",
);

await replaceRequired(
  files,
  /async function buildModelsProviderData\(cfg, agentId\) \{[\s\S]*?\n\}\nfunction formatProviderLine/,
  providerDataReplacement,
  "live /models provider discovery bridge",
);

await replaceRequired(
  files,
  /function buildProviderKeyboard\(providers\) \{[\s\S]*?\treturn rows;\n[\t ]*\}/,
  providerKeyboardReplacement,
  "provider keyboard labels and selection state",
);

await replaceRequired(
  files,
  /function buildModelsKeyboard\(params\) \{[\s\S]*?\treturn rows;\n[\t ]*\}/,
  modelsKeyboardReplacement,
  "model keyboard back button",
);

await replaceRequired(
  files,
  /async function resolveModelsCommandReply\(params\) \{[\s\S]*?\n[\t ]*\}\n[\t ]*const handleModelsCommand =/,
  modelsReplyReplacement,
  "provider-first /models reply flow",
);

await replaceRequired(
  files,
  /if \(modelCallback\.type === "providers" \|\| modelCallback\.type === "back"\) \{[\s\S]*?[\t ]*if \(modelCallback\.type === "list"\) \{/,
  providersCallbackReplacement,
  "provider picker callback flow",
);

await replaceRequired(
  files,
  /if \(modelCallback\.type === "list"\) \{[\s\S]*?[\t ]*if \(modelCallback\.type === "select"\) \{/,
  listCallbackReplacement,
  "provider model list callback flow",
);

await replaceRequired(
  files,
  /if \(modelCallback\.type === "select"\) \{[\s\S]*?[\t ]*return;\n[\t ]*\}\n[\t ]*return;/,
  selectCallbackReplacement,
  "provider model selection callback flow",
);
