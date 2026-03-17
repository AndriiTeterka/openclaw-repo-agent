#!/bin/sh
set -eu

# Route bare/npx playwright invocations to the supported Playwright CLI wrapper.
exec /usr/local/bin/playwright-cli "$@"
