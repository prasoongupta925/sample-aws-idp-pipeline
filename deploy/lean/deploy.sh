#!/usr/bin/env bash
# Deploy the lean (serverless-only) stack through CodeBuild and follow it until it ends.
#
#   deploy/lean/deploy.sh                     # full deploy of branch "lean"
#   deploy/lean/deploy.sh --hotswap           # code-only update (Lambda/Step Functions/ECR) in a few minutes
#   deploy/lean/deploy.sh --stacks "IDP-V2-Application IDP-V2-Workflow"
#   deploy/lean/deploy.sh --branch main --waf # other branch, with the optional CloudFront WAF
#
# Needs: AWS CLI profile (default idp-demo) with admin rights; the branch pushed to REPO_URL.
# Frontend-only changes: use deploy/lean/update-frontend.sh instead (no build server, ~1-2 min).
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-idp-demo}"
export AWS_REGION="${AWS_REGION:-ap-south-1}" AWS_DEFAULT_REGION="${AWS_REGION:-ap-south-1}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

BRANCH=lean; STACKS=""; HOTSWAP=false; CONTEXT=""; COMPUTE=""
REPO_URL="${REPO_URL:-https://github.com/prasoongupta925/sample-aws-idp-pipeline.git}"
ADMIN_USER_EMAIL="${ADMIN_USER_EMAIL:-prasoongupta925@gmail.com}"
while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH="$2"; shift 2;;
    --stacks) STACKS="$2"; shift 2;;
    --hotswap) HOTSWAP=true; shift;;
    --waf) CONTEXT="$CONTEXT -c enableWaf=true"; shift;;
    --context) CONTEXT="$CONTEXT -c $2"; shift 2;;
    --xlarge) COMPUTE=BUILD_GENERAL1_XLARGE; shift;;
    --repo) REPO_URL="$2"; shift 2;;
    -h|--help) sed -n '2,12p' "$0"; exit 0;;
    *) echo "unknown option $1"; exit 2;;
  esac
done

PROJECT=sample-aws-idp-pipeline-deploy
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
if ! aws codebuild batch-get-projects --names "$PROJECT" --query 'projects[0].name' --output text 2>/dev/null | grep -q "$PROJECT"; then
  echo "Creating the CodeBuild project (one time, ~1 min)"
  aws cloudformation deploy --template-file "$ROOT/deploy-codebuild.yml" --stack-name sample-aws-idp-pipeline-codebuild \
    --capabilities CAPABILITY_IAM \
    --parameter-overrides AdminUserEmail="$ADMIN_USER_EMAIL" RepoUrl="$REPO_URL" Version="$BRANCH" >/dev/null
fi

ENV=$(python3 - "$ADMIN_USER_EMAIL" "$REPO_URL" "$BRANCH" "$AWS_REGION" "$ACCOUNT" "$STACKS" "$CONTEXT" "$HOTSWAP" <<'PY'
import json, sys
names = ["ADMIN_USER_EMAIL", "REPO_URL", "VERSION", "AWS_DEFAULT_REGION", "AWS_ACCOUNT_ID",
         "DEPLOY_STACKS", "CDK_CONTEXT_ARGS", "HOTSWAP"]
print(json.dumps([{"name": n, "value": v.strip(), "type": "PLAINTEXT"} for n, v in zip(names, sys.argv[1:])]))
PY
)
ARGS=(--project-name "$PROJECT" --buildspec-override "$(cat "$HERE/buildspec.yml")" --environment-variables-override "$ENV")
[ -n "$COMPUTE" ] && ARGS+=(--compute-type-override "$COMPUTE")
BID=$(aws codebuild start-build "${ARGS[@]}" --query 'build.id' --output text)
echo "$BID" > "$HERE/.last-build-id"
echo "build $BID  (branch $BRANCH${STACKS:+, stacks: $STACKS}${HOTSWAP:+, hotswap=$HOTSWAP})"

T0=$(date +%s); LAST=""
while :; do
  read -r STATUS PHASE < <(aws codebuild batch-get-builds --ids "$BID" --query 'builds[0].[buildStatus,currentPhase]' --output text)
  BUSY=$(aws cloudformation list-stacks --query "StackSummaries[?starts_with(StackName,'IDP-V2') && ends_with(StackStatus,'IN_PROGRESS')].StackName" --output text | wc -w)
  LINE="$STATUS $PHASE stacks-in-progress=$BUSY"
  if [ "$LINE" != "$LAST" ]; then printf '%5ss  %s\n' "$(( $(date +%s) - T0 ))" "$LINE"; LAST="$LINE"; fi
  [ "$STATUS" != "IN_PROGRESS" ] && break
  sleep 20
done
LOG=$(aws codebuild batch-get-builds --ids "$BID" --query 'builds[0].logs.[groupName,streamName]' --output text)
read -r GROUP STREAM <<<"$LOG"
if [ -n "${GROUP:-}" ] && [ "$GROUP" != "None" ]; then
  aws logs get-log-events --log-group-name "$GROUP" --log-stream-name "$STREAM" --limit 200 --query 'events[].message' --output text \
    | tr '\t' '\n' | grep -E "took|FRONTEND_URL|Admin user|failed|Error|UPDATE_FAILED|CREATE_FAILED" | tail -25
fi
echo "result: $STATUS after $(( ($(date +%s) - T0) / 60 )) min"
[ "$STATUS" = "SUCCEEDED" ]
