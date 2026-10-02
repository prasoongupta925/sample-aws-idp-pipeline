"""Workflow Failure Catcher Lambda

Triggered by EventBridge when a Step Functions execution reaches FAILED,
TIMED_OUT or ABORTED. It records the failures the state machine's own catch
(HandleWorkflowError) cannot: a Choice or Pass state that fails
(States.Runtime, e.g. an input field missing at the first state), the 25,000
history event limit, the 24-hour timeout, a stop by hand.

It sets the workflow and its document to failed, and every step left
in_progress to failed (the segment analyzer's step also frees the analysis
throttle), so nothing stays "in_progress" or "reanalyzing" with no execution
behind it.

The workflow id comes from the execution input: from the event itself
(EventBridge includes it unless it is too large), else from DescribeExecution
(the role may describe this state machine's executions).

A late event of an older execution must not fail a newer run, so it acts only
while the workflow record names this execution (or none). The code that
starts an execution records its ARN right after StartExecution, so a run that
fails at once can be reported first: the record is read again a few times
before the event is ignored.
"""
import json
import time

import boto3

from shared.ddb_client import (
    StepName,
    WorkflowStatus,
    get_entity_prefix,
    get_steps,
    get_workflow,
    record_step_error,
    update_document_status,
    update_workflow_status,
)

sfn_client = None

# Workflow statuses of a run that is still going (backend routers/documents.py
# _ACTIVE_WF_STATUSES): only these are set to failed.
ACTIVE_STATUSES = frozenset({'pending', 'in_progress', 'processing', 'reanalyzing'})

# Reads of the workflow record until it names the failed execution.
RECORD_READS = 4
RECORD_READ_INTERVAL_SECONDS = 2.0


def get_sfn_client():
    global sfn_client
    if sfn_client is None:
        sfn_client = boto3.client('stepfunctions')
    return sfn_client


def _execution_input(detail: dict, execution_arn: str) -> dict:
    """The execution input: from the event, else from DescribeExecution."""
    raw = detail.get('input')
    if not isinstance(raw, str) or not raw:
        # Not in the event (too large): read it from the execution. Errors
        # propagate, so the asynchronous invoke is retried.
        raw = get_sfn_client().describe_execution(executionArn=execution_arn).get('input') or '{}'
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def _error_message(detail: dict, status: str, execution_arn: str) -> str:
    error = detail.get('error') or ''
    cause = detail.get('cause') or ''
    if status == 'FAILED' and error:
        message = f'{error}: {cause}' if cause else error
    else:
        message = f'Step Functions execution {status}: {execution_arn}'
    return message[:2000]


def _current_record(document_id: str, workflow_id: str, entity_type: str, execution_arn: str):
    """The workflow record once it names `execution_arn`; else the last read (or None)."""
    record = None
    for attempt in range(RECORD_READS):
        record = get_workflow(document_id, workflow_id, entity_type)
        if record is None or (record.get('data') or {}).get('execution_arn') == execution_arn:
            return record
        if attempt < RECORD_READS - 1:
            time.sleep(RECORD_READ_INTERVAL_SECONDS)
    return record


def _fail_running_steps(workflow_id: str, error_message: str) -> list[str]:
    """Set every step still in_progress to failed; return their names."""
    steps = (get_steps(workflow_id) or {}).get('data') or {}
    failed = []
    for step_name in StepName.ORDER + [StepName.DATASET_PROCESS]:
        step = steps.get(step_name)
        if isinstance(step, dict) and step.get('status') == WorkflowStatus.IN_PROGRESS:
            record_step_error(workflow_id, step_name, error_message)
            failed.append(step_name)
    return failed


def handler(event, context):
    detail = event.get('detail') or {}
    execution_arn = detail.get('executionArn', '')
    status = detail.get('status', '')
    # No input or error text in the log: they may name a document.
    print(f'Execution {status}: {execution_arn}')

    if not execution_arn:
        print('Missing executionArn')
        return {'handled': False}

    sfn_input = _execution_input(detail, execution_arn)
    workflow_id = sfn_input.get('workflow_id', '')
    document_id = sfn_input.get('document_id', '')
    project_id = sfn_input.get('project_id', '')
    file_type = sfn_input.get('file_type', '')

    if not workflow_id or not document_id:
        print('Missing workflow_id or document_id in SFN input')
        return {'handled': False}

    entity_type = get_entity_prefix(file_type)
    record = _current_record(document_id, workflow_id, entity_type, execution_arn)
    if record is None:
        print(f'[{workflow_id}] Workflow record not found (deleted?): nothing to update')
        return {'handled': False, 'workflow_id': workflow_id, 'reason': 'no_workflow'}

    data = record.get('data') or {}
    recorded_arn = data.get('execution_arn') or ''
    if recorded_arn and recorded_arn != execution_arn:
        print(f'[{workflow_id}] Record names another execution ({recorded_arn}): left alone')
        return {'handled': False, 'workflow_id': workflow_id, 'reason': 'other_execution'}

    current_status = data.get('status', '')
    if current_status not in ACTIVE_STATUSES:
        # Already final (e.g. HandleWorkflowError recorded the failure first).
        print(f'[{workflow_id}] Already {current_status}: left alone')
        return {'handled': False, 'workflow_id': workflow_id, 'reason': f'already_{current_status}'}

    error_message = _error_message(detail, status, execution_arn)
    failed_steps = _fail_running_steps(workflow_id, error_message)

    # update_workflow_status also sets the document status (PROJ#/DOC#) when
    # the workflow record has its project id; set it here when it has not.
    update_workflow_status(
        document_id,
        workflow_id,
        WorkflowStatus.FAILED,
        entity_type=entity_type,
        error=error_message,
    )
    record_project_id = data.get('project_id') or ''
    if not record_project_id and project_id:
        update_document_status(project_id, document_id, WorkflowStatus.FAILED)
    print(f'[{workflow_id}] Execution {status}: workflow and document set to failed (steps: {failed_steps})')

    return {
        'handled': True,
        'workflow_id': workflow_id,
        'status': status,
        'failed_steps': failed_steps,
    }
