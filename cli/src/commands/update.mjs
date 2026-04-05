import { withObservedStage } from "../../../runtime/observability.mjs";
import {
  buildComposeUpArgs,
  dockerCompose,
  gatewayRunning,
  prepareMaterializedRuntimeState,
  runWithSpinner
} from "../command-runtime.mjs";
import { printCommandReport, buildDashboardUrl } from "../ui/report-helpers.mjs";
import { handleDoctor } from "./doctor.mjs";

export async function handleUpdate(context, options) {
  const eventLogger = options.eventLogger?.child?.({ component: "cli" }) || null;
  let state = await runWithSpinner(
    "Resolving updated runtime state",
    () => withObservedStage(eventLogger, "state.prepare", "state.prepare", () => prepareMaterializedRuntimeState(context, options), {
      buildSuccessData(nextState) {
        return {
          gatewayPort: nextState.localEnv.OPENCLAW_GATEWAY_PORT,
          runtimeCoreImage: nextState.runtimeImages.runtimeCoreImage,
          runtimeCoreDigest: nextState.runtimeImages.runtimeCoreDigest,
          toolingImage: nextState.runtimeImages.toolingImage
        };
      }
    }),
    options
  );
  if (await gatewayRunning(context)) {
    await runWithSpinner(
      "Refreshing running stack",
      () => withObservedStage(eventLogger, "compose.refresh", "compose.refresh", () => dockerCompose(context, buildComposeUpArgs({ forceRecreate: true }), {
        env: state.runtimeCommandEnv ? { ...process.env, ...state.runtimeCommandEnv } : undefined
      }), {
        successData: {
          forceRecreate: true
        }
      }),
      options
    );
  }
  await handleDoctor(context, {
    ...options,
    refresh: false
  });
  if (!options.json) {
    printCommandReport("success", "Update complete", [
      { label: "Repo", value: context.repoRoot },
      { label: "Gateway", value: buildDashboardUrl(state.localEnv.OPENCLAW_GATEWAY_PORT) },
      { label: "Runtime core", value: state.runtimeImages.runtimeCoreDigest || state.runtimeImages.runtimeCoreImage },
      { label: "Tooling image", value: state.runtimeImages.toolingImage }
    ]);
  }
}
