"""Facts extraction: build the model input from segment data and call Nova 2 Lite.

Pure module (importable without AWS): boto3 is imported lazily and every
Bedrock client is injectable, so tests pass fakes.

The model input is TEXT built from the pipeline's segment data. The original
file and its file name are never sent to the model.
"""
import json
import os
import re

import yaml

from tool_schema import TOOL_DESCRIPTION, TOOL_NAME, TOOL_SCHEMA

# Machine text of a page, in order of preference (PDF text layer first).
MACHINE_TEXT_FIELDS = ('format_parser', 'paddleocr', 'bda_indexer', 'text_content', 'webcrawler_content')
NON_DOCUMENT_TYPES = {'VIDEO', 'AUDIO', 'CHAPTER'}

# A page with less machine text than this falls back to the vision transcription.
MIN_MACHINE_CHARS = 50

_PROMPTS = None
_bedrock_client = None


def _as_text(v) -> str:
    if v is None:
        return ''
    if isinstance(v, str):
        return v
    return json.dumps(v, ensure_ascii=False)


def _vision_text(segment: dict) -> str:
    """Content of the first ai_analysis entry (the page transcription/analysis)."""
    for entry in segment.get('ai_analysis') or []:
        if not isinstance(entry, dict) or entry.get('analysis_query') == 'Analysis error':
            continue
        content = _as_text(entry.get('content'))
        if content.strip():
            return content
    return ''


def build_texts(segments, max_chars):
    """Return (model_text, grounding_text, stats).

    - model_text: per page '--- Page N ---' + the page's machine text (or the
      vision transcription when the machine text has < 50 chars), capped at
      max_chars.
    - grounding_text: ALL non-empty machine text fields of every page, never
      ai_analysis (so grounding only trusts characters printed in the document).
    """
    max_chars = int(max_chars)
    model_parts = []
    grounding_parts = []
    used = 0
    stats = {'pages': 0, 'pages_with_machine_text': 0, 'text_chars': 0, 'truncated': False}

    ordered = sorted(segments or [], key=lambda s: s.get('segment_index', 0) or 0)
    for seg in ordered:
        if seg.get('segment_type') in NON_DOCUMENT_TYPES:
            continue
        stats['pages'] += 1
        index = seg.get('segment_index', 0) or 0

        machine_values = [t for t in (_as_text(seg.get(k)) for k in MACHINE_TEXT_FIELDS) if t.strip()]
        grounding_parts.extend(machine_values)
        machine = machine_values[0] if machine_values else ''
        if machine:
            stats['pages_with_machine_text'] += 1

        page_text = machine
        if len(machine.strip()) < MIN_MACHINE_CHARS:
            page_text = _vision_text(seg) or machine
        if not page_text.strip() or stats['truncated']:
            continue

        chunk = f'--- Page {index + 1} ---\n{page_text.strip()}'
        sep = '\n\n' if model_parts else ''
        room = max_chars - used - len(sep)
        if len(chunk) > room:
            if room > 0:
                model_parts.append(sep + chunk[:room])
                used += len(sep) + room
            stats['truncated'] = True
            continue
        model_parts.append(sep + chunk)
        used += len(sep) + len(chunk)

    grounding_text = '\n'.join(grounding_parts)
    stats['text_chars'] = len(grounding_text)
    return ''.join(model_parts), grounding_text, stats


def load_prompts() -> dict:
    global _PROMPTS
    if _PROMPTS is None:
        path = os.path.join(os.path.dirname(__file__), 'prompts', 'facts_extraction.yaml')
        with open(path, 'r', encoding='utf-8') as f:
            _PROMPTS = yaml.safe_load(f)
    return _PROMPTS


def build_user_prompt(model_text: str) -> str:
    # {tool_name} first, so a literal '{tool_name}' inside the document text is left untouched.
    template = load_prompts()['user_prompt']
    return template.replace('{tool_name}', TOOL_NAME).replace('{document_text}', model_text)


def get_bedrock_client():
    global _bedrock_client
    if _bedrock_client is None:
        import boto3
        from botocore.config import Config
        _bedrock_client = boto3.client(
            'bedrock-runtime',
            region_name=os.environ.get('AWS_REGION'),
            config=Config(retries={'max_attempts': 4, 'mode': 'adaptive'}, read_timeout=120),
        )
    return _bedrock_client


def _parse_json_text(text: str):
    m = re.search(r'\{.*\}', text or '', re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except ValueError:
        return None


def _tool_input(block: dict):
    value = (block.get('toolUse') or {}).get('input')
    if isinstance(value, str):
        value = _parse_json_text(value)
    return value if isinstance(value, dict) else None


def call_nova(model_text: str, model_id: str, client=None) -> tuple:
    """Forced-tool Converse call. Returns (raw fields dict, {input_tokens, output_tokens})."""
    client = client or get_bedrock_client()
    resp = client.converse(
        modelId=model_id,
        system=[{'text': load_prompts()['system_prompt']}],
        messages=[{'role': 'user', 'content': [{'text': build_user_prompt(model_text)}]}],
        toolConfig={
            'tools': [{'toolSpec': {
                'name': TOOL_NAME,
                'description': TOOL_DESCRIPTION,
                'inputSchema': {'json': TOOL_SCHEMA},
            }}],
            'toolChoice': {'tool': {'name': TOOL_NAME}},
        },
        inferenceConfig={'maxTokens': 2000, 'temperature': 0},
    )
    usage = resp.get('usage') or {}
    content = ((resp.get('output') or {}).get('message') or {}).get('content') or []

    fields = None
    for block in content:
        if isinstance(block, dict) and 'toolUse' in block:
            fields = _tool_input(block)
            if fields is not None:
                break
    if fields is None:
        for block in content:
            if isinstance(block, dict) and 'text' in block:
                parsed = _parse_json_text(block['text'])
                if isinstance(parsed, dict):
                    fields = parsed
                    break
    if not isinstance(fields, dict):
        raise ValueError('model returned no structured output')
    return fields, {
        'input_tokens': int(usage.get('inputTokens', 0) or 0),
        'output_tokens': int(usage.get('outputTokens', 0) or 0),
    }
