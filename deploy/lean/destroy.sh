#!/usr/bin/env bash
# Fast teardown of the lean stack (ap-south-1): stacks deleted in parallel waves, then the resources the
# stacks retain on purpose (buckets, tables, user pool, KMS keys, SSM parameters, log groups).
#   deploy/lean/destroy.sh            # everything except the CDK bootstrap (kept: $0, makes the next deploy faster)
#   deploy/lean/destroy.sh --all      # also the CodeBuild project and the CDK bootstrap
# Only stacks whose relations are real CloudFormation exports have to wait for each other
# (Mcp -> Agent); every other link is an SSM parameter, so most stacks go at the same time.
set -uo pipefail
export AWS_PROFILE="${AWS_PROFILE:-idp-demo}" AWS_REGION="${AWS_REGION:-ap-south-1}" AWS_DEFAULT_REGION="${AWS_REGION:-ap-south-1}"
R=$AWS_REGION
ALL=false; [ "${1:-}" = "--all" ] && ALL=true
ACCT=$(aws sts get-caller-identity --query Account --output text)
T0=$(date +%s)
say() { printf '%4ss  %s\n' "$(( $(date +%s) - T0 ))" "$*"; }
exists() { aws cloudformation describe-stacks --stack-name "$1" >/dev/null 2>&1; }

wave() {  # delete the given stacks together and wait for all of them
  local s started=()
  for s in "$@"; do exists "$s" && aws cloudformation delete-stack --stack-name "$s" && started+=("$s"); done
  [ ${#started[@]} -eq 0 ] && return 0
  say "deleting ${started[*]}"
  for s in "${started[@]}"; do
    ( if aws cloudformation wait stack-delete-complete --stack-name "$s" 2>/dev/null; then say "deleted $s"; else
        say "FAILED $s: $(aws cloudformation describe-stack-events --stack-name "$s" \
          --query "StackEvents[?ResourceStatus=='DELETE_FAILED'] | [0].[LogicalResourceId,ResourceStatusReason]" --output text)"; fi ) &
  done
  wait
}
empty_bucket() {  # every object version and delete marker (boto3), else a plain recursive delete
  "${PYTHON:-python3}" - "$1" <<'PY' 2>/dev/null || aws s3 rm "s3://$1" --recursive --only-show-errors 2>/dev/null
import os, sys, boto3
b = boto3.Session(profile_name=os.environ.get("AWS_PROFILE"), region_name=os.environ.get("AWS_REGION")).resource("s3").Bucket(sys.argv[1])
b.object_versions.delete()
b.objects.all().delete()
PY
}

say "emptying buckets"
for b in $(aws s3 ls | awk '{print $3}' | grep -E '^idp-v2-.*|^idpv2-.*'); do empty_bucket "$b" & done
for b in $(aws s3api list-directory-buckets --query 'Buckets[].Name' --output text 2>/dev/null); do
  case "$b" in lancedb-*|idp-v2-*) aws s3 rm "s3://$b" --recursive --only-show-errors & ;; esac
done
wait

wave IDP-V2-Retention IDP-V2-Application IDP-V2-Workflow IDP-V2-Webcrawler IDP-V2-Webhook IDP-V2-Worker \
     IDP-V2-LanceService IDP-V2-Ocr IDP-V2-Bda IDP-V2-Transcribe IDP-V2-Agent IDP-V2-Websocket IDP-V2-Event \
     IDPV2ApplicationFrontendwaf5A2F87E0
wave IDP-V2-Mcp
wave IDP-V2-Storage
# Leftovers of the old full edition, if any (VPC/NAT and Neptune stacks).
wave IDP-V2-Neptune
wave IDP-V2-Vpc

say "removing retained resources"
for b in $(aws s3 ls | awk '{print $3}' | grep -E '^idp-v2-.*|^idpv2-.*'); do
  ( empty_bucket "$b"; aws s3 rb "s3://$b" --force >/dev/null 2>&1 && say "deleted bucket $b" ) &
done
for b in $(aws s3api list-directory-buckets --query 'Buckets[].Name' --output text 2>/dev/null); do
  case "$b" in lancedb-*|idp-v2-*) ( aws s3 rm "s3://$b" --recursive --only-show-errors; aws s3api delete-bucket --bucket "$b" && say "deleted $b" ) & ;; esac
done
for t in $(aws dynamodb list-tables --query 'TableNames[?starts_with(@,`IDP-V2`) || starts_with(@,`idp-v2`)]' --output text); do
  ( aws dynamodb update-table --table-name "$t" --no-deletion-protection-enabled >/dev/null 2>&1
    aws dynamodb delete-table --table-name "$t" >/dev/null && say "deleted table $t" ) &
done
for id in $(aws cognito-idp list-user-pools --max-results 50 --query "UserPools[?starts_with(Name,'UserIdentity')].Id" --output text); do
  ( d=$(aws cognito-idp describe-user-pool --user-pool-id "$id" --query 'UserPool.Domain' --output text)
    [ "$d" != "None" ] && aws cognito-idp delete-user-pool-domain --user-pool-id "$id" --domain "$d" >/dev/null 2>&1
    aws cognito-idp update-user-pool --user-pool-id "$id" --deletion-protection INACTIVE >/dev/null 2>&1
    aws cognito-idp delete-user-pool --user-pool-id "$id" && say "deleted user pool $id" ) &
done
wait
for k in $(aws kms list-aliases --query "Aliases[?starts_with(AliasName,'alias/idp-v2')].TargetKeyId" --output text); do
  aws kms schedule-key-deletion --key-id "$k" --pending-window-in-days 7 --query DeletionDate --output text | sed "s/^/KMS $k deletes on /"
done
for p in $(aws ssm get-parameters-by-path --path /idp-v2 --recursive --query 'Parameters[].Name' --output text); do
  aws ssm delete-parameter --name "$p"
done
for lg in $(aws logs describe-log-groups --query 'logGroups[].logGroupName' --output text); do
  case "$lg" in *idp-v2*|*IDP-V2*|*IDPV2*|/aws/bedrock-agentcore/*|/aws/codebuild/sample-aws-idp*|/aws/vendedlogs/states/idp*)
    aws logs delete-log-group --log-group-name "$lg" 2>/dev/null ;; esac
done

if $ALL; then
  wave sample-aws-idp-pipeline-codebuild sample-aws-idp-pipeline-destroy-codebuild
  b="cdk-hnb659fds-assets-${ACCT}-${R}"; empty_bucket "$b"
  aws ecr delete-repository --repository-name "cdk-hnb659fds-container-assets-${ACCT}-${R}" --force >/dev/null 2>&1
  wave CDKToolkit
  aws s3 rb "s3://$b" --force >/dev/null 2>&1
  aws ssm delete-parameter --name /cdk-bootstrap/hnb659fds/version >/dev/null 2>&1
fi

say "left in $R:"
aws cloudformation list-stacks --query "StackSummaries[?StackStatus!='DELETE_COMPLETE' && (starts_with(StackName,'IDP') || starts_with(StackName,'CDK') || starts_with(StackName,'sample-aws'))].[StackName,StackStatus]" --output text
say "done in $(( ($(date +%s) - T0) / 60 )) min"
