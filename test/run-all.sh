#!/usr/bin/env bash
# Run all ts-gogs test suites against a live server.
#   ./test/run-all.sh            # server must already be running on :3000
#   GOGS_URL=... ADMIN_USER=... ADMIN_PASS=... ./test/run-all.sh
set -u
cd "$(dirname "$0")/.."

fail=0
echo "=============================================="
echo " ts-gogs test suites"
echo " target: ${GOGS_URL:-http://127.0.0.1:3000}"
echo "=============================================="

echo ""
echo ">>> API test"
node test/api-test.mjs || fail=1

echo ""
echo ">>> Git test (HTTP / SSH / LFS / webhooks)"
node test/git-test.mjs || fail=1

echo ""
echo ">>> UI test (Chrome via playwright-core)"
node test/ui-test.mjs || fail=1

echo ""
echo "=============================================="
if [ "$fail" -eq 0 ]; then
  echo " ALL SUITES PASSED"
else
  echo " SOME SUITES FAILED"
fi
echo "=============================================="
exit $fail
