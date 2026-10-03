#!/usr/bin/env bash
# Offline check of update-frontend.sh --config-only with a fake aws CLI (no AWS calls):
# a wss:// SSM value is published as voicebot-config.json, a missing or bad one as {}.
#   deploy/lean/tests/update-frontend-config.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/aws" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$*" in
  *describe-stacks*WebsiteBucketName*) echo website-bucket;;
  *describe-stacks*DistributionDomainName*) echo example.cloudfront.net;;
  *list-distributions*) echo DIST1;;
  *get-parameter*) [ -n "$FAKE_URL" ] && echo "$FAKE_URL" || exit 254;;
  *"s3 cp"*) cat "$3" > "$FAKE_PUBLISHED";;
  *create-invalidation*) echo INV1;;
esac
EOF
chmod +x "$TMP/aws"
FAIL=0
check() { # <ssm value> <expected published json>
  : > "$TMP/log"; rm -f "$TMP/published"
  FAKE_LOG="$TMP/log" FAKE_PUBLISHED="$TMP/published" FAKE_URL="$1" PATH="$TMP:$PATH" \
    bash "$ROOT/deploy/lean/update-frontend.sh" --config-only >/dev/null
  local code=$? got; got=$(cat "$TMP/published" 2>/dev/null)
  if [ "$code" = 0 ] && [ "$got" = "$2" ] && grep -q -- '--paths /voicebot-config.json' "$TMP/log" \
    && ! grep -q 'nx run\|s3 sync' "$TMP/log"; then echo "ok   '${1}'"
  else echo "FAIL '${1}': exit $code, published '$got'"; FAIL=1; fi
}
check "wss://voice.example.cloudfront.net/ws" '{"voiceBotUrl": "wss://voice.example.cloudfront.net/ws"}'
check "" '{}'
check "http://voice.example.com/ws" '{}'
check 'wss://x.example.com/ws"}, "a": "' '{}'
[ "$FAIL" = 0 ] && echo "update-frontend --config-only: 4 passed"
exit "$FAIL"
