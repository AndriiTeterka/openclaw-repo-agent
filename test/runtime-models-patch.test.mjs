import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

const PATCH_SCRIPT = path.resolve("runtime/openclaw-telegram-models-patch.mjs");
const PATCH_MARKER = "OPENCLAW_TELEGRAM_MODELS_PATCH_V4";
const PREVIOUS_PATCH_MARKER = "OPENCLAW_TELEGRAM_MODELS_PATCH_V3";
const LEGACY_PATCH_MARKER = "OPENCLAW_LIVE_MODELS_HELPER";

const DIST_FIXTURE = `function resolveTelegramConversationRoute(params) {
\treturn {
\t\troute: {
\t\t\tagentId: "codex",
\t\t\tsessionKey: "telegram:codex",
\t\t\tmainSessionKey: "codex:main",
\t\t\tmatchedBy: "route"
\t\t},
\t\tconfiguredBinding: null,
\t\tconfiguredBindingSessionKey: ""
\t};
}
function resolveTelegramConversationBaseSessionKey() {
\treturn "telegram:codex";
}
async function buildModelsProviderData(cfg, agentId) {
\tconst resolvedDefault = resolveDefaultModelForAgent({
\t\tcfg,
\t\tagentId
\t});
\tconst allowed = buildAllowedModelSet({
\t\tcfg,
\t\tcatalog: await loadModelCatalog({ config: cfg }),
\t\tdefaultProvider: resolvedDefault.provider,
\t\tdefaultModel: resolvedDefault.model,
\t\tagentId
\t});
\tconst aliasIndex = buildModelAliasIndex({
\t\tcfg,
\t\tdefaultProvider: resolvedDefault.provider
\t});
\tconst byProvider = /* @__PURE__ */ new Map();
\tconst add = (p, m) => {
\t\tconst key = normalizeProviderId(p);
\t\tconst set = byProvider.get(key) ?? /* @__PURE__ */ new Set();
\t\tset.add(m);
\t\tbyProvider.set(key, set);
\t};
\tfor (const entry of allowed.allowedCatalog) add(entry.provider, entry.id);
\tadd(resolvedDefault.provider, resolvedDefault.model);
\treturn {
\t\tbyProvider,
\t\tproviders: [...byProvider.keys()].toSorted(),
\t\tresolvedDefault
\t};
}
function formatProviderLine(params) {
\treturn \`- \${params.provider} (\${params.count})\`;
}
function buildProviderKeyboard(providers) {
\tif (providers.length === 0) return [];
\tconst rows = [];
\tlet currentRow = [];
\tfor (const provider of providers) {
\t\tconst button = {
\t\t\ttext: \`\${provider.id} (\${provider.count})\`,
\t\t\tcallback_data: \`mdl_list_\${provider.id}_1\`
\t\t};
\t\tcurrentRow.push(button);
\t\tif (currentRow.length === 2) {
\t\t\trows.push(currentRow);
\t\t\tcurrentRow = [];
\t\t}
\t}
\tif (currentRow.length > 0) rows.push(currentRow);
\treturn rows;
\t}
function buildModelsKeyboard(params) {
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
\t\tconst text = isCurrentModel ? \`\${displayText} ✓\` : displayText;
\t\trows.push([{
\t\t\ttext,
\t\t\tcallback_data: callbackData
\t\t}]);
\t}
\tif (totalPages > 1) {
\t\tconst paginationRow = [];
\t\tif (currentPage > 1) paginationRow.push({
\t\t\ttext: "◀ Prev",
\t\t\tcallback_data: \`\${CALLBACK_PREFIX.list}\${provider}_\${currentPage - 1}\`
\t\t});
\t\tpaginationRow.push({
\t\t\ttext: \`\${currentPage}/\${totalPages}\`,
\t\t\tcallback_data: \`\${CALLBACK_PREFIX.list}\${provider}_\${currentPage}\`
\t\t});
\t\tif (currentPage < totalPages) paginationRow.push({
\t\t\ttext: "Next ▶",
\t\t\tcallback_data: \`\${CALLBACK_PREFIX.list}\${provider}_\${currentPage + 1}\`
\t\t});
\t\trows.push(paginationRow);
\t}
\treturn rows;
\t}
async function resolveModelsCommandReply(params) {
\tconst body = params.commandBodyNormalized.trim();
\tif (!body.startsWith("/models")) return null;
\tlet { provider, page, pageSize, all } = parseModelsArgs(body.replace(/^\\/models\\b/i, "").trim());
\tconst { byProvider, providers } = await buildModelsProviderData(params.cfg, params.agentId);
\tconst isTelegram = params.surface === "telegram";
\tif (!provider && isTelegram) {
\t\tconst currentModel = (() => {
\t\t\tconst sessionStateModelCandidates = [];
\t\t\tif (typeof params.currentModel === "string") sessionStateModelCandidates.push(params.currentModel);
\t\t\treturn sessionStateModelCandidates.find((value) => typeof value === "string" && value.length > 0) ?? "";
\t\t})();
\t\tconst modelProvider = currentModel.includes("/") ? currentModel.split("/")[0] : "";
\t\tif (modelProvider && providers.includes(modelProvider)) provider = modelProvider;
\t\telse if (providers.length > 0) provider = providers[0];
\t}
\tif (!provider && providers.length === 1) provider = providers[0];
\tif (!provider) {
\t\treturn { text: [
\t\t\t"Providers:",
\t\t\t...providers.map((p) => formatProviderLine({
\t\t\t\tprovider: p,
\t\t\t\tcount: byProvider.get(p)?.size ?? 0
\t\t\t})),
\t\t\t"",
\t\t\t"Use: /models <provider>"
\t\t].join("\\n") };
\t}
\tif (!byProvider.has(provider)) return { text: [
\t\t\`Unknown provider: \${provider}\`,
\t\t"",
\t\t"Available providers:",
\t\t...providers.map((p) => \`- \${p}\`),
\t\t"",
\t\t"Use: /models <provider>"
\t].join("\\n") };
\tconst models = [...byProvider.get(provider) ?? /* @__PURE__ */ new Set()].toSorted();
\tconst total = models.length;
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
\t\t\tchannelData: { telegram: { buttons: buildModelsKeyboard({
\t\t\t\tprovider,
\t\t\t\tmodels,
\t\t\t\tcurrentModel: params.currentModel,
\t\t\t\tcurrentPage: safePage,
\t\t\t\ttotalPages,
\t\t\t\tpageSize: telegramPageSize
\t\t\t}).filter((row) => !row.some((button) => button.callback_data === CALLBACK_PREFIX.back || button.text === "<< Back")) } }
\t\t};
\t}
\treturn { text: "ok" };
}
\tconst handleModelsCommand = async () => {};
async function handleTelegramCallbacks() {
\t\t\t\tif (modelCallback.type === "providers" || modelCallback.type === "back") {
\t\t\t\t\tif (availableProviders.length === 0) {
\t\t\t\t\t\tawait editMessageWithButtons("No providers available.", []);
\t\t\t\t\t\treturn;
\t\t\t\t\t}
\t\t\t\t\t{
\t\t\t\t\t\tconst currentSessionState = resolveTelegramSessionState({
\t\t\t\t\t\t\tchatId,
\t\t\t\t\t\t\tisGroup,
\t\t\t\t\t\t\tisForum,
\t\t\t\t\t\t\tmessageThreadId,
\t\t\t\t\t\t\tresolvedThreadId,
\t\t\t\t\t\t\tsenderId
\t\t\t\t\t\t});
\t\t\t\t\t\tconst currentModel = typeof currentSessionState.model === "string" && currentSessionState.model.length > 0 ? currentSessionState.model : typeof currentSessionState.sessionEntry?.model === "string" ? currentSessionState.sessionEntry.model : "";
\t\t\t\t\t\tconst buttons = buildProviderKeyboard(availableProviders.map((entry) => ({
\t\t\t\t\t\t\tid: entry.providerId,
\t\t\t\t\t\t\tlabel: entry.label,
\t\t\t\t\t\t\tcount: entry.count,
\t\t\t\t\t\t\tselected: entry.providerId === currentModel.split("/")[0]
\t\t\t\t\t\t})));
\t\t\t\t\t\tawait editMessageWithButtons("Select a provider:", buttons);
\t\t\t\t\t\treturn;
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tif (modelCallback.type === "list") {
\t\t\t\t\tconst { provider, page } = modelCallback;
\t\t\t\t\tconst modelSet = byProvider.get(provider);
\t\t\t\t\tif (!modelSet || modelSet.size === 0) {
\t\t\t\t\t\tconst buttons = buildProviderKeyboard(availableProviders.map((entry) => ({
\t\t\t\t\t\t\tid: entry.providerId,
\t\t\t\t\t\t\tlabel: entry.label,
\t\t\t\t\t\t\tcount: entry.count,
\t\t\t\t\t\t\tselected: entry.providerId === provider
\t\t\t\t\t\t})));
\t\t\t\t\t\tawait editMessageWithButtons(\`Unknown provider: \${provider}\\n\\nSelect a provider:\`, buttons);
\t\t\t\t\t\treturn;
\t\t\t\t\t}
\t\t\t\t\tconst buttons = buildModelsKeyboard({
\t\t\t\t\t\tprovider,
\t\t\t\t\t\tmodels: [...modelSet].toSorted(),
\t\t\t\t\t\tcurrentModel: sessionState.model,
\t\t\t\t\t\tcurrentPage: page,
\t\t\t\t\t\ttotalPages: 1,
\t\t\t\t\t\tpageSize: getModelsPageSize()
\t\t\t\t\t}).filter((row) => !row.some((button) => button.callback_data === CALLBACK_PREFIX.back || button.text === "<< Back"));
\t\t\t\t\tawait editMessageWithButtons("models", buttons);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tif (modelCallback.type === "select") {
\t\t\t\t\ttry {
\t\t\t\t\t\tawait editMessageWithButtons("selected", []);
\t\t\t\t\t} catch (err) {
\t\t\t\t\t\tawait editMessageWithButtons(String(err), []);
\t\t\t\t\t}
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\treturn;
}
`;

test("telegram /models patch rewrites the provider picker flow and is idempotent", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-models-patch-"));
  const distDir = path.join(tempDir, "dist");
  const distFile = path.join(distDir, "bundle.js");

  await fs.mkdir(distDir, { recursive: true });
  await fs.writeFile(distFile, DIST_FIXTURE);

  execFileSync(process.execPath, [PATCH_SCRIPT, distDir], { stdio: "pipe" });
  const patched = await fs.readFile(distFile, "utf8");

  assert.match(patched, new RegExp(PATCH_MARKER));
  assert.match(patched, /OPENCLAW_LIVE_MODELS_HELPER/);
  assert.match(patched, /live-models-provider-data\.mjs/);
  assert.match(patched, /provider\?\.selected \? label \+ " ✓ \("/);
  assert.match(patched, /callback_data: CALLBACK_PREFIX\.back/);
  assert.match(patched, /Unavailable providers:/);
  assert.match(patched, /const providerData = await buildModelsProviderData\(cfg, currentSessionState\.agentId\);/);
  assert.match(patched, /providerData\s*\n\t+\}\);/);
  assert.doesNotMatch(patched, /providerData: \{\s*byProvider,\s*providers,\s*availableProviders,\s*unavailableProviders\s*\}/);
  assert.doesNotMatch(patched, /\bavailableProviders\.(length|map|find)\b/);
  assert.match(patched, /telegram: routed via current conversation binding/);
  assert.match(patched, /const targetAgentId = resolveSelectedAgentId\(selection\.provider\);/);
  assert.match(patched, /targetKind: "acp"/);
  assert.match(patched, /Conversation agent switched to \*\*/);
  assert.match(patched, /commandBodyNormalized: "\/models"/);
  assert.match(patched, /commandBodyNormalized: "\/models " \+ provider \+ " " \+ safePage/);
  assert.doesNotMatch(patched, /const models = \[\.\.\.byProvider\.get\(provider\).*?toSorted\(\)/);
  assert.doesNotMatch(patched, /models: \[\.\.\.modelSet\]\.toSorted\(\)/);

  execFileSync(process.execPath, [PATCH_SCRIPT, distDir], { stdio: "pipe" });
  const patchedAgain = await fs.readFile(distFile, "utf8");
  assert.equal(patchedAgain, patched);
});

test("telegram /models patch upgrades dist files that carry the previous patch marker", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-models-patch-prev-"));
  const distDir = path.join(tempDir, "dist");
  const distFile = path.join(distDir, "bundle.js");

  await fs.mkdir(distDir, { recursive: true });
  await fs.writeFile(distFile, DIST_FIXTURE);

  execFileSync(process.execPath, [PATCH_SCRIPT, distDir], { stdio: "pipe" });
  const currentPatched = await fs.readFile(distFile, "utf8");
  const previousPatched = currentPatched.replaceAll(PATCH_MARKER, PREVIOUS_PATCH_MARKER);
  await fs.writeFile(distFile, previousPatched);

  execFileSync(process.execPath, [PATCH_SCRIPT, distDir], { stdio: "pipe" });
  const patched = await fs.readFile(distFile, "utf8");

  assert.match(patched, new RegExp(PATCH_MARKER));
  assert.doesNotMatch(patched, new RegExp(PREVIOUS_PATCH_MARKER));
});

test("telegram /models patch upgrades dist files that still carry the legacy marker", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-models-patch-legacy-"));
  const distDir = path.join(tempDir, "dist");
  const distFile = path.join(distDir, "bundle.js");

  await fs.mkdir(distDir, { recursive: true });
  await fs.writeFile(distFile, `/* ${LEGACY_PATCH_MARKER} */\n${DIST_FIXTURE}`);

  execFileSync(process.execPath, [PATCH_SCRIPT, distDir], { stdio: "pipe" });
  const patched = await fs.readFile(distFile, "utf8");

  assert.match(patched, new RegExp(PATCH_MARKER));
  assert.doesNotMatch(patched, /\bavailableProviders\.(length|map|find)\b/);
});

test("telegram /models patch tolerates upstream indentation before handleModelsCommand", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-models-patch-indent-"));
  const distDir = path.join(tempDir, "dist");
  const distFile = path.join(distDir, "bundle.js");
  const indentedFixture = DIST_FIXTURE.replace(
    "const handleModelsCommand = async () => {};",
    "\tconst handleModelsCommand = async () => {};"
  );

  await fs.mkdir(distDir, { recursive: true });
  await fs.writeFile(distFile, indentedFixture);

  execFileSync(process.execPath, [PATCH_SCRIPT, distDir], { stdio: "pipe" });
  const patched = await fs.readFile(distFile, "utf8");

  assert.match(patched, new RegExp(PATCH_MARKER));
  assert.doesNotMatch(patched, /\bavailableProviders\.(length|map|find)\b/);
});
