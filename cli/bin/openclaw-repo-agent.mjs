#!/usr/bin/env node
import { main } from "../src/cli.mjs";
import { printFatalError } from "../src/reporting.mjs";

main(process.argv.slice(2)).catch((error) => {
  printFatalError(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
