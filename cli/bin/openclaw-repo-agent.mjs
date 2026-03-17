#!/usr/bin/env node
import { describeCommandFromArgv, main } from "../src/cli.mjs";
import { printFatalError } from "../src/reporting.mjs";

const argv = process.argv.slice(2);

main(argv).catch((error) => {
  const commandLabel = describeCommandFromArgv(argv);
  printFatalError(error instanceof Error ? error.message : String(error), {
    title: commandLabel ? `'${commandLabel.toLowerCase()}' could not be completed` : "command could not be completed"
  });
  process.exit(1);
});
