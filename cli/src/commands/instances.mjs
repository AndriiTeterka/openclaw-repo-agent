import { dockerPsByComposeProject } from "../command-runtime.mjs";
import {
  listInstanceRegistryEntries,
  readInstanceRegistry
} from "../instance-registry.mjs";
import {
  buildStatusSection,
  printCommandReport
} from "../ui/report-helpers.mjs";

export async function handleInstancesList(context, options) {
  const registry = await readInstanceRegistry(context.instanceRegistryFile);
  const instances = [];

  for (const entry of listInstanceRegistryEntries(registry)) {
    const containers = await dockerPsByComposeProject(entry.composeProjectName, {
      all: true,
      cwd: context.repoRoot,
      context
    });
    instances.push({
      ...entry,
      running: containers.some((container) => /^up\b/i.test(container.status)),
      containers
    });
  }

  if (options.json) {
    console.log(JSON.stringify({
      ok: true,
      registryPath: context.instanceRegistryFile,
      instances
    }, null, 2));
    return;
  }

  if (instances.length === 0) {
    printCommandReport("info", "Instances", [
      { label: "Instance registry", value: context.instanceRegistryFile },
      { label: "Instances", value: 0 }
    ], [
      buildStatusSection("Notes", "info", ["No repo instances are registered on this machine yet."])
    ]);
    return;
  }

  printCommandReport("info", "Instances", [
    { label: "Instance registry", value: context.instanceRegistryFile },
    { label: "Instances", value: instances.length }
  ], instances.map((entry) => ({
    title: entry.instanceId,
    status: entry.running ? "success" : "info",
    rows: [
      { label: "Status", value: entry.running ? "running" : "stopped" },
      { label: "Repo", value: entry.repoRoot },
      { label: "Compose", value: entry.composeProjectName },
      { label: "Port", value: `${entry.gatewayPort || "(unset)"} ${entry.portManaged ? "[managed]" : "[manual]"}` },
      { label: "Containers", value: entry.containers.map((container) => `${container.name} [${container.status}]`) }
    ]
  })));
}
