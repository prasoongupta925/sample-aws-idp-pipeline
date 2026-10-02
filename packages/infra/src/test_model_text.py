"""Page descriptions and document summaries keep the answer, never gpt-oss's reasoning.

The describer and docSummarizer models (models.json, gpt-oss-20b on Flex) reason
before they answer. shared/model_text.py reads only the text blocks of a Strands
result and removes inline <reasoning> text; the page-description generator and
the document summarizer use it. No AWS calls: a fake Strands agent answers.
Synthetic text only.

Run from the repo root:
    uv run --frozen --with pytest python -m pytest -q packages/infra/src/test_model_text.py
"""

import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest

os.environ.setdefault('AWS_ACCESS_KEY_ID', 'testing')
os.environ.setdefault('AWS_SECRET_ACCESS_KEY', 'testing')
os.environ['AWS_REGION'] = 'ap-south-1'

SRC = Path(__file__).resolve().parent
FUNCTIONS = SRC / 'functions'
STEP_FUNCTIONS = FUNCTIONS / 'step-functions'
sys.path.insert(0, str(FUNCTIONS))

from shared.model_text import agent_answer_text, strip_reasoning  # noqa: E402

MODELS = json.loads((SRC / 'models.json').read_text(encoding='utf-8'))
GPT_OSS_20B = 'openai.gpt-oss-20b-1:0'
REASONING = {'reasoningContent': {'reasoningText': {'text': 'REASONING: the user wants a page description'}}}


class FakeResult:
    """A Strands AgentResult: the assistant message; str() joins its text blocks."""

    def __init__(self, content):
        self.message = {'role': 'assistant', 'content': content}

    def __str__(self):
        return ''.join(b['text'] + '\n' for b in self.message['content'] if 'text' in b)


class FakeBedrockModel:
    instances = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        FakeBedrockModel.instances.append(self)


class FakeAgent:
    """Answers every prompt with a reasoning block, then text with inline reasoning."""

    prompts = []

    def __init__(self, model=None, system_prompt=None, callback_handler=None):
        self.model = model

    def __call__(self, prompt):
        FakeAgent.prompts.append(prompt)
        n = len(FakeAgent.prompts)
        return FakeResult([REASONING, {'text': f'<reasoning>inline thoughts {n}</reasoning>Answer {n}.'}])


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def fakes(monkeypatch):
    FakeBedrockModel.instances = []
    FakeAgent.prompts = []
    monkeypatch.setenv('BEDROCK_SERVICE_TIER', 'flex')
    return monkeypatch


def test_describer_and_summarizer_are_gpt_oss_20b():
    assert MODELS['describer'] == MODELS['docSummarizer'] == GPT_OSS_20B


def test_text_blocks_only_without_reasoning():
    result = FakeResult([
        REASONING,
        {'text': '<reasoning>step 1, step 2</reasoning>Bank statement of a made-up customer.'},
        {'text': 'Page 2 continues the table.'},
    ])
    text = agent_answer_text(result)
    assert text == 'Bank statement of a made-up customer.\nPage 2 continues the table.'
    assert 'REASONING' not in text and 'step 1' not in text


def test_reasoning_cut_off_inline_leaves_nothing():
    assert strip_reasoning('<reasoning>the answer was cut at maxTokens') == ''
    assert agent_answer_text(FakeResult([REASONING])) == ''
    assert strip_reasoning('  plain answer  ') == 'plain answer'
    assert strip_reasoning(None) == ''


def test_a_result_without_a_message_falls_back_to_its_string():
    class Plain:
        def __str__(self):
            return ' <reasoning>x</reasoning>Summary text \n'

    assert agent_answer_text(Plain()) == 'Summary text'


def test_page_description_keeps_only_the_answer(fakes):
    fakes.setenv('PAGE_DESCRIPTION_MODEL_ID', GPT_OSS_20B)
    module = _load('page_description_index', STEP_FUNCTIONS / 'page-description-generator' / 'index.py')
    fakes.setattr(module, 'Agent', FakeAgent)
    fakes.setattr(module, 'BedrockModel', FakeBedrockModel)

    segment = {'format_parser': 'Salary slip, August 2026, net pay Rs 52,000 (synthetic)'}
    description = module.generate_page_description(segment, 1, 'English')

    assert description == 'Answer 1.'
    (model,) = FakeBedrockModel.instances
    assert model.kwargs['model_id'] == GPT_OSS_20B
    assert model.kwargs['service_tier'] == 'flex'
    assert model.kwargs['max_tokens'] == module.MAX_OUTPUT_TOKENS >= 2048


def test_document_summary_keeps_only_the_answer(fakes):
    module = _load('document_summarizer_index', STEP_FUNCTIONS / 'document-summarizer' / 'index.py')
    fakes.setattr(module, 'Agent', FakeAgent)
    fakes.setattr(module, 'BedrockModel', FakeBedrockModel)

    pages = [{'page': 1, 'description': 'Loan application form (synthetic).'}]
    summary = module.generate_document_summary(GPT_OSS_20B, 'ap-south-1', 'English', pages, 1)

    assert summary == 'Answer 1.'
    assert all(m.kwargs['service_tier'] == 'flex' for m in FakeBedrockModel.instances)
    assert all(m.kwargs['model_id'] == GPT_OSS_20B for m in FakeBedrockModel.instances)


def test_batched_summary_and_its_merge_keep_only_the_answers(fakes):
    module = _load('document_summarizer_batches', STEP_FUNCTIONS / 'document-summarizer' / 'index.py')
    fakes.setattr(module, 'Agent', FakeAgent)
    fakes.setattr(module, 'BedrockModel', FakeBedrockModel)
    fakes.setattr(module, 'BATCH_SIZE', 2)
    fakes.setattr(module, 'BATCH_OVERLAP', 0)

    pages = [{'page': i, 'description': f'Page {i} of a synthetic bank statement.'} for i in range(1, 5)]
    summary = module.generate_document_summary(GPT_OSS_20B, 'ap-south-1', 'English', pages, 4)

    # Two batches, then the merge call: its answer is the summary.
    assert len(FakeAgent.prompts) == 3
    assert summary == 'Answer 3.'
    merge_prompt = FakeAgent.prompts[-1]
    assert 'reasoning' not in merge_prompt.lower() and 'REASONING' not in merge_prompt
    assert '[Pages 1-2]' in merge_prompt and '[Pages 3-4]' in merge_prompt
