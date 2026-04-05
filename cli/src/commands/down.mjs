import {
  dockerCompose,
  ensureRenderedRuntimeFiles
} from "../command-runtime.mjs";
import { printCommandReport } from "../ui/report-helpers.mjs";

export async function handleDown(context) {
  await ensureRenderedRuntimeFiles(context);
  await dockerCompose(context, ["down"]);
  printCommandReport("success", "Down complete", [
    { label: "Instance", value: context.instanceId },
    { label: "Compose", value: context.composeProjectName },
    { label: "Result", value: "OpenClaw gateway stopped" }
  ]);
}
