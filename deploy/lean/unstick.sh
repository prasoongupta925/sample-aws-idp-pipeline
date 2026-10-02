#!/usr/bin/env bash
# Reset documents stuck on a status no execution will ever change ("reanalyzing", "in_progress", ...): the
# workflow, its document and its running steps are set to failed, as the failure catcher
# (idp-v2-workflow-failure-catcher) does since its fix. The document can then be re-analyzed.
#
#   deploy/lean/unstick.sh                                       # dry run: list what is stuck, change nothing
#   deploy/lean/unstick.sh --project "Telecaller QA – Sample calls"   # one project (its name or id)
#   deploy/lean/unstick.sh --document <document id>              # one document
#   deploy/lean/unstick.sh --project "Telecaller QA – Sample calls" --apply   # reset what the dry run lists
#
# A workflow is stuck when its status is pending, in_progress, processing or reanalyzing and its execution has
# ended (FAILED, TIMED_OUT, ABORTED), no longer exists, or was never recorded at all for more than --min-age
# minutes (default 30). A RUNNING execution is never touched, nor one that SUCCEEDED (the record disagrees with
# it: check that one by hand). Every write is conditional on the record being unchanged since it was read.
# Needs: AWS CLI profile (default idp-demo) and jq.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-idp-demo}"
export AWS_REGION="${AWS_REGION:-ap-south-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"

APPLY=false; PROJECT=""; DOCUMENT=""; MIN_AGE=30
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=true; shift;;
    --project) PROJECT="${2:?--project needs a project name or id}"; shift 2;;
    --document) DOCUMENT="${2:?--document needs a document id}"; shift 2;;
    --min-age) MIN_AGE="${2:?--min-age needs minutes}"; shift 2;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0;;
    *) echo "unknown option $1 (see --help)"; exit 2;;
  esac
done
case "$MIN_AGE" in ''|*[!0-9]*) echo "--min-age must be a whole number of minutes"; exit 2;; esac
command -v jq >/dev/null || { echo "jq is needed"; exit 2; }

ACTIVE='["pending","in_progress","processing","reanalyzing"]'
NOW=$(date -u +%Y-%m-%dT%H:%M:%S+00:00)
TABLE=$(aws ssm get-parameter --name /idp-v2/backend/table-name --query Parameter.Value --output text) \
  || { echo "backend table parameter /idp-v2/backend/table-name not found (is the stack deployed in $AWS_REGION?)"; exit 1; }

# Projects to look at (all when --project is not given): "id<TAB>name" lines.
PROJECTS=$(aws dynamodb query --table-name "$TABLE" --index-name GSI1 \
  --key-condition-expression 'GSI1PK = :p' --expression-attribute-values '{":p":{"S":"PROJECTS"}}' --output json \
  | jq -r --arg want "$PROJECT" '.Items[] | [.data.M.project_id.S, (.data.M.name.S // "")]
      | select($want == "" or .[0] == $want or .[1] == $want) | @tsv')
if [ -n "$PROJECT" ] && [ -z "$PROJECTS" ]; then echo "no project with the name or id \"$PROJECT\""; exit 1; fi
PROJECT_IDS=$(printf '%s\n' "$PROJECTS" | cut -f1 | jq -R 'select(length > 0)' | jq -s .)

# Workflow records (DOC#/WEB# <id>, WF#<id>) with a status of a run that is still going.
WORKFLOWS=$(aws dynamodb scan --table-name "$TABLE" --output json \
  --filter-expression 'begins_with(SK, :wf) AND (begins_with(PK, :doc) OR begins_with(PK, :web)) AND #d.#s IN (:s1, :s2, :s3, :s4)' \
  --projection-expression 'PK, SK, #d.#s, #d.execution_arn, #d.project_id, updated_at' \
  --expression-attribute-names '{"#d":"data","#s":"status"}' \
  --expression-attribute-values '{":wf":{"S":"WF#"},":doc":{"S":"DOC#"},":web":{"S":"WEB#"},
    ":s1":{"S":"pending"},":s2":{"S":"in_progress"},":s3":{"S":"processing"},":s4":{"S":"reanalyzing"}}' \
  | jq -r --argjson projects "$PROJECT_IDS" --arg doc "$DOCUMENT" --argjson active "$ACTIVE" '.Items[]
      | [.PK.S, .SK.S, .data.M.status.S, (.data.M.execution_arn.S // ""), (.data.M.project_id.S // ""), (.updated_at.S // "")]
      | select(.[2] | IN($active[]))
      | select(.[4] | IN($projects[]))
      | select($doc == "" or (.[0] | sub("^(DOC|WEB)#"; "")) == $doc) | join("\u001f")')

STUCK=0; RESET=0; SEEN=0
# Fields are split on the unit separator: a tab IFS would merge an empty field (no execution ARN) away.
while IFS=$'\x1f' read -r PK SK STATUS ARN PROJ UPDATED <&3; do
  [ -n "$PK" ] || continue
  SEEN=$((SEEN + 1))
  DOC_ID=${PK#*#}; WF_ID=${SK#WF#}
  NAME=$(aws dynamodb get-item --table-name "$TABLE" --output json \
    --key "{\"PK\":{\"S\":\"PROJ#$PROJ\"},\"SK\":{\"S\":\"DOC#$DOC_ID\"}}" \
    --projection-expression '#d.#n' --expression-attribute-names '{"#d":"data","#n":"name"}' \
    | jq -r '.Item.data.M.name.S // "(no document record)"') || NAME="(document record not readable)"
  PROJECT_NAME=$(printf '%s\n' "$PROJECTS" | awk -F'\t' -v id="$PROJ" '$1 == id { print $2; exit }')
  WHAT="$PROJECT_NAME / $NAME (document $DOC_ID, workflow $WF_ID): $STATUS"

  # Why it is stuck, or why it is left alone. Only the execution name is printed (the ARN holds the account id).
  REASON=""
  if [ -z "$ARN" ]; then
    AGE=$(( ($(date -u +%s) - $(date -u -d "${UPDATED:-$NOW}" +%s)) / 60 ))
    if [ "$AGE" -ge "$MIN_AGE" ]; then REASON="no execution was ever recorded (last update $AGE min ago)"
    else echo "skip   $WHAT: no execution recorded yet, updated $AGE min ago (--min-age $MIN_AGE)"; continue; fi
  else
    EXEC_NAME=${ARN##*:}
    if OUT=$(aws stepfunctions describe-execution --execution-arn "$ARN" --output json 2>&1); then
      EXEC_STATUS=$(jq -r '.status' <<<"$OUT")
      case "$EXEC_STATUS" in
        RUNNING) echo "skip   $WHAT: execution $EXEC_NAME is still running"; continue;;
        SUCCEEDED) echo "check  $WHAT: execution $EXEC_NAME SUCCEEDED but the record says $STATUS (left alone)"; continue;;
        *) REASON="execution $EXEC_NAME $EXEC_STATUS: $(jq -r '[.error, .cause] | map(select(. != null and . != "")) | join(": ")' <<<"$OUT" | cut -c1-300)";;
      esac
    elif grep -q 'ExecutionDoesNotExist' <<<"$OUT"; then
      REASON="execution $EXEC_NAME no longer exists"
    else
      echo "error  $WHAT: cannot describe execution $EXEC_NAME: $(tail -1 <<<"$OUT" | sed -E 's/[0-9]{12}/<account>/g')"; continue
    fi
  fi
  STUCK=$((STUCK + 1))
  if ! $APPLY; then echo "stuck  $WHAT: $REASON"; continue; fi

  ERROR="Reset by deploy/lean/unstick.sh: $REASON"
  VALUES=$(jq -n --arg failed failed --arg old "$STATUS" --arg arn "$ARN" --arg err "$ERROR" --arg now "$NOW" \
    '{":failed":{"S":$failed},":old":{"S":$old},":arn":{"S":$arn},":err":{"S":$err},":now":{"S":$now}}')
  # Workflow: only while it still has the status and execution this run read.
  if ! aws dynamodb update-item --table-name "$TABLE" \
      --key "{\"PK\":{\"S\":\"$PK\"},\"SK\":{\"S\":\"$SK\"}}" \
      --update-expression 'SET #d.#s = :failed, #d.#e = :err, updated_at = :now' \
      --condition-expression '#d.#s = :old AND (attribute_not_exists(#d.#x) OR #d.#x = :arn)' \
      --expression-attribute-names '{"#d":"data","#s":"status","#e":"error","#x":"execution_arn"}' \
      --expression-attribute-values "$VALUES" >/dev/null 2>&1; then
    echo "error  $WHAT: changed since it was read (or the write failed): left alone"; continue
  fi
  # Document: its status follows the workflow (only when the document record exists).
  aws dynamodb update-item --table-name "$TABLE" \
    --key "{\"PK\":{\"S\":\"PROJ#$PROJ\"},\"SK\":{\"S\":\"DOC#$DOC_ID\"}}" \
    --update-expression 'SET #d.#s = :failed, updated_at = :now' --condition-expression 'attribute_exists(PK)' \
    --expression-attribute-names '{"#d":"data","#s":"status"}' \
    --expression-attribute-values "$(jq -n --arg now "$NOW" '{":failed":{"S":"failed"},":now":{"S":$now}}')" \
    >/dev/null 2>&1 || echo "note   $WHAT: no document record to update"
  # Steps left in_progress: failed, like the catcher (the segment analyzer's GSI1SK frees the analysis throttle).
  RUNNING_STEPS=$(aws dynamodb get-item --table-name "$TABLE" --output json \
    --key "{\"PK\":{\"S\":\"WF#$WF_ID\"},\"SK\":{\"S\":\"STEP\"}}" \
    | jq -r '(.Item.data.M // {}) | to_entries[] | select(.value.M.status.S? == "in_progress") | .key')
  FAILED_STEPS=""
  for STEP in $RUNNING_STEPS; do
    EXTRA=""; [ "$STEP" = segment_analyzer ] && EXTRA=", GSI1SK = :failed"
    if aws dynamodb update-item --table-name "$TABLE" \
        --key "{\"PK\":{\"S\":\"WF#$WF_ID\"},\"SK\":{\"S\":\"STEP\"}}" \
        --update-expression "SET #d.#step.#s = :failed, #d.#step.#e = :err, #d.current_step = :none, updated_at = :now$EXTRA" \
        --condition-expression '#d.#step.#s = :running' \
        --expression-attribute-names "$(jq -n --arg step "$STEP" '{"#d":"data","#step":$step,"#s":"status","#e":"error"}')" \
        --expression-attribute-values "$(jq -n --arg err "$ERROR" --arg now "$NOW" \
          '{":failed":{"S":"failed"},":running":{"S":"in_progress"},":err":{"S":$err},":none":{"S":""},":now":{"S":$now}}')" \
        >/dev/null 2>&1; then
      FAILED_STEPS="${FAILED_STEPS:+$FAILED_STEPS }$STEP"
    else
      echo "note   $WHAT: step $STEP changed since it was read: left alone"
    fi
  done
  RESET=$((RESET + 1))
  echo "reset  $WHAT -> failed (${REASON}${FAILED_STEPS:+; steps failed: $FAILED_STEPS})"
done 3<<<"$WORKFLOWS"

echo
if $APPLY; then
  echo "$RESET of $STUCK stuck workflow(s) reset to failed ($SEEN still marked running looked at). Re-analyze them in the app."
else
  echo "dry run: $STUCK stuck workflow(s) of $SEEN still marked running. Run again with --apply to reset them to failed."
fi
