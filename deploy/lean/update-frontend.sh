#!/usr/bin/env bash
# Publish only the web app: local Vite build -> S3 -> CloudFront invalidation. No build server, ~1-2 min.
#   deploy/lean/update-frontend.sh            # build + publish
#   deploy/lean/update-frontend.sh --no-build # publish the existing dist/packages/frontend/bundle
# runtime-config.json (Cognito ids, API URLs) is written by the stack and is never overwritten here;
# voicebot-config.json (the voice panel URL) is written here from SSM /idp-v2/voicebot/url.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-idp-demo}" AWS_REGION="${AWS_REGION:-ap-south-1}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUNDLE="$ROOT/dist/packages/frontend/bundle"
cd "$ROOT"
if [ "${1:-}" != "--no-build" ]; then
  T=$(date +%s)
  NODE_OPTIONS=--max-old-space-size=6144 pnpm nx run @idp-v2/frontend:bundle --skip-nx-cache >/dev/null
  echo "built in $(( $(date +%s) - T ))s"
fi
[ -f "$BUNDLE/index.html" ] || { echo "no bundle at $BUNDLE"; exit 1; }
out() { aws cloudformation describe-stacks --stack-name IDP-V2-Application \
  --query "Stacks[0].Outputs[?contains(OutputKey,\`$1\`)].OutputValue" --output text; }
BUCKET=$(out WebsiteBucketName)
DOMAIN=$(out DistributionDomainName)
DIST=$(aws cloudfront list-distributions --query "DistributionList.Items[?DomainName=='$DOMAIN'].Id" --output text)
[ -n "$BUCKET" ] && [ -n "$DIST" ] || { echo "stack outputs not found (is IDP-V2-Application deployed?)"; exit 1; }
# Voice bot panel: voicebot-config.json from the SSM parameter the voice deploy writes. Without the
# parameter (or with an unexpected value) the file is {} and the app shows no Voice Chat entry.
VOICE_URL=$(aws ssm get-parameter --name /idp-v2/voicebot/url --query Parameter.Value --output text 2>/dev/null || true)
if [[ "$VOICE_URL" =~ ^wss://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$ ]]; then
  printf '{"voiceBotUrl": "%s"}\n' "$VOICE_URL" > "$BUNDLE/voicebot-config.json"
  echo "voice bot panel: $VOICE_URL"
else
  [ -z "$VOICE_URL" ] || echo "ignoring /idp-v2/voicebot/url: not a wss:// URL"
  echo '{}' > "$BUNDLE/voicebot-config.json"
  echo "voice bot panel: off (no /idp-v2/voicebot/url)"
fi
# Hashed assets first (long cache), then index.html and the rest (no cache), so no page ever points at a missing file.
# The entry files are always copied: sync would skip an index.html of the same size that is older than the S3 copy
# (e.g. --no-build after a CDK deploy), and the --delete pass would then remove the assets that copy needs.
aws s3 sync "$BUNDLE" "s3://$BUCKET" --exclude "*" --include "assets/*" --cache-control "public,max-age=31536000,immutable" --only-show-errors
aws s3 cp "$BUNDLE" "s3://$BUCKET" --recursive --exclude "assets/*" --exclude "runtime-config.json" --cache-control "no-cache" --only-show-errors
aws s3 sync "$BUNDLE" "s3://$BUCKET" --delete --exclude "runtime-config.json" --only-show-errors
INV=$(aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" --query 'Invalidation.Id' --output text)
echo "published to https://$DOMAIN (invalidation $INV; live in ~1 min)"
