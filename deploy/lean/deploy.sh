#!/usr/bin/env bash
# Deploy the lean (serverless-only) stack through CodeBuild and follow it until it ends.
#
#   deploy/lean/deploy.sh                     # first deploy or full update of branch "lean"
#   deploy/lean/deploy.sh --hotswap           # code-only update (Lambda/Step Functions/ECR) in a few minutes
#   deploy/lean/deploy.sh --stacks "IDP-V2-Application IDP-V2-Workflow"
#   deploy/lean/deploy.sh --branch main --waf # other branch, with the optional CloudFront WAF
#
# This account stops every CodeBuild build after 45 minutes. When the cap stops a build, the next one starts
# with the same settings as soon as no stack is mid-operation (stacks already deployed are no-ops), up to
# MAX_BUILDS builds (default 4). Exits 0 only when the last build SUCCEEDED.
# Needs: AWS CLI profile (default idp-demo) with admin rights; the branch pushed to REPO_URL.
# Frontend-only changes: use deploy/lean/update-frontend.sh instead (no build server, ~1-2 min).
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-idp-demo}"
export AWS_REGION="${AWS_REGION:-ap-south-1}" AWS_DEFAULT_REGION="${AWS_REGION:-ap-south-1}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

BRANCH=lean; STACKS=""; HOTSWAP=false; CONTEXT=""
MAX_BUILDS="${MAX_BUILDS:-4}"
REPO_URL="${REPO_URL:-https://github.com/prasoongupta925/sample-aws-idp-pipeline.git}"
ADMIN_USER_EMAIL="${ADMIN_USER_EMAIL:-prasoongupta925@gmail.com}"
while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH="$2"; shift 2;;
    --stacks) STACKS="$2"; shift 2;;
    --hotswap) HOTSWAP=true; shift;;
    --waf) CONTEXT="$CONTEXT -c enableWaf=true"; shift;;
    --context) CONTEXT="$CONTEXT -c $2"; shift 2;;
    --repo) REPO_URL="$2"; shift 2;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0;;
    *) echo "unknown option $1"; exit 2;;
  esac
done
case "$MAX_BUILDS" in ''|*[!0-9]*|0) echo "MAX_BUILDS must be a whole number, 1 or more"; exit 2;; esac

T0=$(date +%s)
say() { printf '%5ss  %s\n' "$(( $(date +%s) - T0 ))" "$*"; }
# One AWS CLI call that rides out short network drops (Wi-Fi, laptop sleep): 6 tries over ~2.5 min.
aws_retry() {
  local n
  for n in 1 2 3 4 5; do aws "$@" 2>/dev/null && return 0; sleep $(( n * 10 )); done
  aws "$@"
}
# IDP-V2 stacks with a CloudFormation operation running. REVIEW_IN_PROGRESS (a change set that never ran)
# is not one: cdk deploy creates such a stack again.
busy_stacks() {
  local q="StackSummaries[?(starts_with(StackName,'IDP-V2') || starts_with(StackName,'IDPV2')) && ends_with(StackStatus,'_IN_PROGRESS') && StackStatus!='REVIEW_IN_PROGRESS'].[StackName,StackStatus]"
  aws_retry cloudformation list-stacks --query "$q" --output text || return 1
  case "$CONTEXT" in *enableWaf=true*) aws_retry cloudformation list-stacks --region us-east-1 --query "$q" --output text || return 1;; esac
}
wait_idle() {  # a build stopped by the cap leaves its last stack operation running; the next build must not start on it
  local busy last=""
  while :; do
    busy=$(busy_stacks | awk 'NF { printf "%s%s %s", (n++ ? ", " : ""), $1, $2 }') || busy="unknown (AWS not reachable)"
    [ -z "$busy" ] && return 0
    if [ "$busy" != "$last" ]; then say "waiting for CloudFormation: $busy"; last="$busy"; fi
    sleep 30
  done
}
stack_summary() {
  local rows
  rows=$(aws_retry cloudformation list-stacks --output text \
    --query "StackSummaries[?starts_with(StackName,'IDP-V2') && StackStatus!='DELETE_COMPLETE'].[StackName,StackStatus]") \
    || { echo "unknown (AWS not reachable)"; return 0; }
  printf '%s\n' "$rows" | awk '$2 ~ /_COMPLETE$/ && $2 !~ /ROLLBACK/ { ok++; next }
    NF { other = other sprintf("%s%s %s", (other ? ", " : "; "), $1, $2) } END { printf "%d complete%s\n", ok, other }'
}

if pgrep -f 'bash .*deploy/lean/destroy\.sh' >/dev/null 2>&1; then
  echo "deploy/lean/destroy.sh is still running: wait until it prints 'done' (its last steps delete the idp-v2 tables, buckets and parameters)."
  exit 1
fi

PROJECT=sample-aws-idp-pipeline-deploy
ACCOUNT=$(aws_retry sts get-caller-identity --query Account --output text)
if [ "$(aws_retry codebuild batch-get-projects --names "$PROJECT" --query 'projects[0].name' --output text)" != "$PROJECT" ]; then
  echo "Creating the CodeBuild project (one time, ~1 min)"
  aws cloudformation deploy --template-file "$ROOT/deploy-codebuild.yml" --stack-name sample-aws-idp-pipeline-codebuild \
    --capabilities CAPABILITY_IAM \
    --parameter-overrides AdminUserEmail="$ADMIN_USER_EMAIL" RepoUrl="$REPO_URL" Version="$BRANCH" >/dev/null
fi
RECENT=$(aws_retry codebuild list-builds-for-project --project-name "$PROJECT" --no-paginate --query 'ids[:5]' --output text)
if [ -n "$RECENT" ] && [ "$RECENT" != "None" ]; then
  RUNNING=$(aws_retry codebuild batch-get-builds --ids $RECENT --query "builds[?buildStatus=='IN_PROGRESS'].id" --output text)
  if [ -n "$RUNNING" ]; then
    echo "build $RUNNING is still running: wait for it to end, or stop it with: aws codebuild stop-build --id $RUNNING"
    exit 1
  fi
fi

ENV=$(python3 - "$ADMIN_USER_EMAIL" "$REPO_URL" "$BRANCH" "$AWS_REGION" "$ACCOUNT" "$STACKS" "$CONTEXT" "$HOTSWAP" <<'PY'
import json, sys
names = ["ADMIN_USER_EMAIL", "REPO_URL", "VERSION", "AWS_DEFAULT_REGION", "AWS_ACCOUNT_ID",
         "DEPLOY_STACKS", "CDK_CONTEXT_ARGS", "HOTSWAP"]
env = [{"name": n, "value": v.strip(), "type": "PLAINTEXT"} for n, v in zip(names, sys.argv[1:])]
# Same as the full edition's deploy.sh: a 6 GB Node heap (the frontend bundle runs out of memory on the
# default one) and no reserved Lambda concurrency.
env += [{"name": "NODE_OPTIONS", "value": "--max-old-space-size=6144", "type": "PLAINTEXT"},
        {"name": "IDP_RESERVED_CONCURRENCY", "value": "off", "type": "PLAINTEXT"}]
print(json.dumps(env))
PY
)
ARGS=(--project-name "$PROJECT" --buildspec-override "$(cat "$HERE/buildspec.yml")" --environment-variables-override "$ENV")
DESC="branch $BRANCH${STACKS:+, stacks: $STACKS}${CONTEXT:+, context:$CONTEXT}"
[ "$HOTSWAP" = true ] && DESC="$DESC, hotswap"

BID=""; N=0; RESULT=""; BUILDS=""
trap 'echo; echo "deploy.sh stopped; build ${BID:-?} keeps running in CodeBuild (stop it with: aws codebuild stop-build --id ${BID:-?})"; exit 130' INT
while :; do
  N=$(( N + 1 ))
  wait_idle
  # The token makes a retried start-build return the same build instead of starting a second one.
  BID=$(aws_retry codebuild start-build "${ARGS[@]}" --idempotency-token "lean-deploy-$T0-$N" --query 'build.id' --output text)
  echo "$BID" > "$HERE/.last-build-id"
  say "build $N/$MAX_BUILDS $BID ($DESC)"
  TB=$(date +%s); LAST=""; STATUS=IN_PROGRESS; PHASE=SUBMITTED; BAD=None; BAD_STATUS=None; GROUP=None; STREAM=None
  Q='phases[?phaseStatus && phaseStatus!=`SUCCEEDED`] | [0]'
  while :; do
    if INFO=$(aws_retry codebuild batch-get-builds --ids "$BID" --output text \
      --query "builds[0].[buildStatus, currentPhase, $Q.phaseType, $Q.phaseStatus, logs.groupName, logs.streamName]"); then
      read -r STATUS PHASE BAD BAD_STATUS GROUP STREAM <<<"$INFO"
    fi
    BUSY=$(busy_stacks | awk 'NF { n++ } END { print n + 0 }') || BUSY="?"
    LINE="$STATUS $PHASE stacks-in-progress=$BUSY"
    if [ "$LINE" != "$LAST" ]; then say "$LINE"; LAST="$LINE"; fi
    [ "$STATUS" = "IN_PROGRESS" ] || break
    sleep 20
  done
  # On this account a build stopped by the cap reports FAILED; only its phase says TIMED_OUT.
  RESULT=$STATUS
  if [ "$STATUS" = "TIMED_OUT" ] || [ "$BAD_STATUS" = "TIMED_OUT" ]; then RESULT=TIMED_OUT; fi
  MIN=$(( ($(date +%s) - TB) / 60 ))
  WHERE=""
  if [ "$BAD" != "None" ]; then WHERE=" ($BAD phase $BAD_STATUS)"; fi
  say "build $N/$MAX_BUILDS ended: $RESULT after $MIN min$WHERE"
  if [ -n "$GROUP" ] && [ "$GROUP" != "None" ]; then
    aws_retry logs get-log-events --log-group-name "$GROUP" --log-stream-name "$STREAM" --limit 200 --query 'events[].message' --output text \
      | tr '\t' '\n' | grep -E "took [0-9]+s|FRONTEND_URL|Admin user|_FAILED|failed:|Error:|error occurred|❌|out of memory|COMMAND_EXECUTION_ERROR" \
      | tail -25 | sed 's/^/        /' || true
  fi
  say "stacks: $(stack_summary)"
  SHORT=${BID#*:}
  BUILDS="$BUILDS${BUILDS:+ | }#$N ${SHORT:0:8} $RESULT ${MIN} min"
  [ "$RESULT" = "TIMED_OUT" ] || break
  if [ "$N" -ge "$MAX_BUILDS" ]; then
    say "stopping after $MAX_BUILDS builds; run deploy.sh again to go on (finished stacks are no-ops)"
    break
  fi
  say "the 45-minute cap stopped build $N; build $(( N + 1 )) starts with the same settings once CloudFormation is idle"
done
trap - INT
echo "builds: $BUILDS"
say "result: $RESULT after $N build(s), $(( ($(date +%s) - T0) / 60 )) min"
[ "$RESULT" = "SUCCEEDED" ]
