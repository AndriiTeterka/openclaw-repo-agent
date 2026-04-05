import { buildPathsPayload } from "../state-store.mjs";
import { printCommandReport } from "../ui/report-helpers.mjs";

export async function handlePaths(context, options) {
  const payload = await buildPathsPayload(context);
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  printCommandReport("success", "Paths", [
    { label: "Repo", value: context.repoRoot },
    { label: "Config", value: payload.configFile },
    { label: "Secrets", value: payload.secretsEnvFile },
    { label: "Runtime env", value: payload.runtimeEnvFile },
    { label: "Compose", value: payload.composeFile }
  ]);
}
