#!/usr/bin/env bash
# Turn a running FULL edition into the lean edition in place: same URL, same Cognito users, same projects
# and documents. Steps:
#   1. lift any extra inline IAM policy we added by hand (it blocks CloudFormation from deleting old roles)
#   2. deploy the lean branch over the same stacks (backend moves to Lambda, Valkey -> DynamoDB, graph off)
#   3. delete the stacks the lean app no longer defines: us-east-1 WAF, Neptune, VPC (VPC last: Lambda
#      network interfaces take a while to be released after the functions leave the VPC)
#   4. put the extra IAM guard back on the roles that remain
# Usage: deploy/lean/migrate-from-full.sh [--guard-script path/to/block-marketplace-models.sh]
set -uo pipefail
export AWS_PROFILE="${AWS_PROFILE:-idp-demo}" AWS_REGION="${AWS_REGION:-ap-south-1}" AWS_DEFAULT_REGION="${AWS_REGION:-ap-south-1}"
HERE="$(cd "$(dirname "$0")" && pwd)"
GUARD=""; [ "${1:-}" = "--guard-script" ] && GUARD="$2"
T0=$(date +%s); say() { printf '%5ss  %s\n' "$(( $(date +%s) - T0 ))" "$*"; }

if [ -n "$GUARD" ]; then say "lifting the extra IAM guard"; "$GUARD" --remove | tail -1; fi

say "deploying the lean branch over the running stacks"
if ! "$HERE/deploy.sh"; then
  say "deploy failed: the old stacks are untouched or rolled back; fix and re-run"; exit 1
fi

del() {  # region stack
  aws cloudformation describe-stacks --region "$1" --stack-name "$2" >/dev/null 2>&1 || return 0
  say "deleting $2 ($1)"
  aws cloudformation delete-stack --region "$1" --stack-name "$2"
  if aws cloudformation wait stack-delete-complete --region "$1" --stack-name "$2" 2>/dev/null; then say "deleted $2"; return 0; fi
  say "delete of $2 not finished: $(aws cloudformation describe-stack-events --region "$1" --stack-name "$2" \
    --query "StackEvents[?ResourceStatus=='DELETE_FAILED'] | [0].ResourceStatusReason" --output text)"
  return 1
}
del us-east-1 IDPV2ApplicationFrontendwaf5A2F87E0 &
del "$AWS_REGION" IDP-V2-Neptune &
wait
for i in 1 2 3 4; do del "$AWS_REGION" IDP-V2-Vpc && break; say "VPC still has network interfaces in use; retry in 5 min ($i/4)"; sleep 300; done

if [ -n "$GUARD" ]; then say "putting the IAM guard back"; "$GUARD" | tail -1; fi
say "migration done in $(( ($(date +%s) - T0) / 60 )) min"
