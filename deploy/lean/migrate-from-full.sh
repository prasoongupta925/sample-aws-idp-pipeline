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

# The us-east-1 CDK bootstrap existed only for the WAF stack: remove it when nothing else there uses it.
LEFT=$(aws cloudformation list-stacks --region us-east-1 --query "StackSummaries[?StackStatus!='DELETE_COMPLETE' && StackName!='CDKToolkit'].StackName" --output text)
if [ -z "$LEFT" ] && aws cloudformation describe-stacks --region us-east-1 --stack-name CDKToolkit >/dev/null 2>&1; then
  ACCT=$(aws sts get-caller-identity --query Account --output text)
  B="cdk-hnb659fds-assets-${ACCT}-us-east-1"
  "${PYTHON:-python3}" - "$B" <<'PY' 2>/dev/null || aws s3 rm "s3://$B" --recursive --region us-east-1 --only-show-errors
import os, sys, boto3
b = boto3.Session(profile_name=os.environ.get("AWS_PROFILE"), region_name="us-east-1").resource("s3").Bucket(sys.argv[1])
b.object_versions.delete()
b.objects.all().delete()
PY
  aws ecr delete-repository --region us-east-1 --repository-name "cdk-hnb659fds-container-assets-${ACCT}-us-east-1" --force >/dev/null 2>&1
  del us-east-1 CDKToolkit
  aws s3 rb "s3://$B" --force --region us-east-1 >/dev/null 2>&1 && say "deleted the us-east-1 bootstrap bucket"
  aws ssm delete-parameter --region us-east-1 --name /cdk-bootstrap/hnb659fds/version >/dev/null 2>&1
fi
SNAP=$(aws neptune describe-db-cluster-snapshots --query 'DBClusterSnapshots[].DBClusterSnapshotIdentifier' --output text 2>/dev/null)
[ -n "$SNAP" ] && say "Neptune snapshots left (they bill): $SNAP"

if [ -n "$GUARD" ]; then say "putting the IAM guard back"; "$GUARD" | tail -1; fi
say "migration done in $(( ($(date +%s) - T0) / 60 )) min"
