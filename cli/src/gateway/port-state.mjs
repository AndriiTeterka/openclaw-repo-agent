import net from "node:net";

async function resolveGatewayContainerId(context, dockerCompose) {
  const result = await dockerCompose(context, ["ps", "-q", "openclaw-gateway"], { capture: true });
  if (result.code !== 0) return "";
  return result.stdout.trim();
}

export async function gatewayRunning(context, { dockerCompose } = {}) {
  if (typeof dockerCompose !== "function") return false;
  try {
    return Boolean(await resolveGatewayContainerId(context, dockerCompose));
  } catch {
    return false;
  }
}

export async function gatewayHealthy(context, {
  dockerCompose,
  dockerCommand
} = {}) {
  if (typeof dockerCompose !== "function" || typeof dockerCommand !== "function") return false;
  try {
    const containerId = await resolveGatewayContainerId(context, dockerCompose);
    if (!containerId) return false;
    const inspect = await dockerCommand(
      context,
      ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", containerId],
      { capture: true }
    );
    if (inspect.code !== 0) return false;
    const status = inspect.stdout.trim().toLowerCase();
    return status === "healthy" || status === "running";
  } catch {
    return false;
  }
}

export async function canBindPort(port) {
  try {
    await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    });
    return true;
  } catch {
    return false;
  }
}

export async function detectGatewayPortState(context, localEnv, {
  gatewayRunning: isGatewayRunning = async () => false,
  readInstanceRegistry = async () => ({}),
  listInstanceRegistryEntries = () => [],
  canBindPort: canBind = canBindPort
} = {}) {
  const gatewayPort = Number.parseInt(String(localEnv.OPENCLAW_GATEWAY_PORT ?? "").trim(), 10);
  if (!Number.isInteger(gatewayPort)) {
    return {
      ok: false,
      gatewayPort: null,
      portBindable: false,
      registryOnlyConflict: false,
      duplicateAssignment: null,
      message: "Gateway port is not configured."
    };
  }

  if (await isGatewayRunning(context)) {
    return {
      ok: true,
      gatewayPort,
      portBindable: true,
      registryOnlyConflict: false,
      duplicateAssignment: null,
      message: `Gateway port ${gatewayPort} is already in use by this repo's running gateway.`
    };
  }

  const registry = await readInstanceRegistry(context.instanceRegistryFile);
  const duplicateAssignment = listInstanceRegistryEntries(registry).find((entry) =>
    entry.instanceId !== context.instanceId && Number.parseInt(entry.gatewayPort, 10) === gatewayPort
  ) ?? null;
  if (duplicateAssignment) {
    const portBindable = await canBind(gatewayPort);
    return {
      ok: false,
      gatewayPort,
      portBindable,
      registryOnlyConflict: portBindable,
      duplicateAssignment,
      message: portBindable
        ? `Gateway port ${gatewayPort} is only reserved by stale registry entry ${duplicateAssignment.instanceId}.`
        : `Gateway port ${gatewayPort} is already assigned to ${duplicateAssignment.instanceId}.`
    };
  }

  const portBindable = await canBind(gatewayPort);
  return {
    ok: portBindable,
    gatewayPort,
    portBindable,
    registryOnlyConflict: false,
    duplicateAssignment: null,
    message: portBindable
      ? `Gateway port ${gatewayPort} is available.`
      : `Gateway port ${gatewayPort} is already bound by another process.`
  };
}

export function shouldAutoHealGatewayPortConflict(localEnv, portState, {
  shouldManageGatewayPort = () => false,
  legacyComposePort = Number.NaN
} = {}) {
  const gatewayPort = Number.parseInt(String(localEnv?.OPENCLAW_GATEWAY_PORT ?? "").trim(), 10);
  return Boolean(portState?.duplicateAssignment)
    && Boolean(portState?.registryOnlyConflict)
    && (shouldManageGatewayPort(localEnv) || gatewayPort === legacyComposePort);
}
