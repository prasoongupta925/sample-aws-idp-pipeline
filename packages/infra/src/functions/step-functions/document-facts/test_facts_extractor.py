"""Unit tests for extractor.py and tool_schema.py (synthetic data, fake Bedrock client).

Run: python -m pytest -q   (from this folder)
"""
import os
import sys

os.environ['BACKEND_TABLE_NAME'] = 'test-table'
os.environ['AWS_DEFAULT_REGION'] = 'ap-south-1'
os.environ['AWS_REGION'] = 'ap-south-1'
os.environ['AWS_ACCESS_KEY_ID'] = 'testing'
os.environ['AWS_SECRET_ACCESS_KEY'] = 'testing'

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', '..')))
sys.path.insert(0, HERE)

import pytest  # noqa: E402

import extractor  # noqa: E402
from extractor import build_texts, build_user_prompt, call_nova, load_prompts  # noqa: E402
from tool_schema import (  # noqa: E402
    DEBIT_CATEGORIES, DEBIT_CHANNELS, DOC_TYPES, FIELD_NAMES, LIST_FIELDS, NUMERIC_FIELDS, TOOL_NAME, TOOL_SCHEMA)

PLAN_B_SYSTEM_PROMPT = (
    'You extract fields from Indian loan-file documents for a DSA (loan agent) file check. '
    'Classify the document and fill the tool fields using ONLY what is printed in the document. '
    'Copy PAN, names and employer names character-for-character (do not correct typos). '
    'Numbers must be plain numbers without commas or currency symbols (e.g. 82500). '
    'Omit any field that is not present on this document. Never guess.'
)
OBLIGATIONS_PROMPT = (
    ' Bank statements: list every salary credit and every obligation debit (loan EMI, rent, '
    'SIP / mutual fund / RD, insurance premium, utility or phone bill, credit-card payment) as its '
    "own entry with that row's date and withdrawal amount, in every month of the statement; skip "
    'everyday spending. Loan applications: copy each existing loan / EMI from the existing-obligations '
    'section; a credit card paid monthly is not an EMI.'
)

PDF_TEXT = ('Salary Slip for the month of August 2026 - Konkan Softworks Pvt Ltd - '
            'Employee Rahul Vijay Deshmukh PAN BQXPD4821K Gross 95,000 Net 82,500')
OCR_TEXT = 'OCR READING OF THE SAME PAGE: Salary S1ip August 2026 Konkan Softw0rks Gross 95,000'
VISION_TEXT = 'VISION TRANSCRIPTION: identity sheet of Sneha Anil Kulkarni, PAN CKRPK7314M'


def _page(index, **kw):
    seg = {'segment_index': index, 'segment_type': 'PAGE'}
    seg.update(kw)
    return seg


# --------------------------------------------------------------------------- #
# tool schema
# --------------------------------------------------------------------------- #
def _types(node):
    if isinstance(node, dict):
        if 'type' in node:
            yield node['type']
        for v in node.values():
            yield from _types(v)
    elif isinstance(node, list):
        for v in node:
            yield from _types(v)


def test_tool_schema_shape():
    assert DOC_TYPES == ['loan_application', 'identity_details', 'salary_slip',
                         'bank_statement', 'form16_itr', 'other']
    assert TOOL_NAME == 'record_loan_document'
    assert TOOL_SCHEMA['required'] == ['doc_type']
    assert TOOL_SCHEMA['properties']['doc_type']['enum'] == DOC_TYPES
    assert TOOL_SCHEMA['properties']['financial_year']['type'] == 'string'
    assert NUMERIC_FIELDS == ('gross_salary', 'net_salary', 'declared_net_salary',
                              'declared_total_existing_emi', 'loan_amount', 'loan_tenure_months')
    assert LIST_FIELDS == ('salary_credits', 'recurring_debits', 'declared_existing_emis')
    assert FIELD_NAMES == [
        'doc_type', 'applicant_name', 'pan', 'masked_aadhaar_last4', 'employer', 'month',
        'gross_salary', 'net_salary', 'statement_from', 'statement_to', 'salary_credits',
        'recurring_debits', 'declared_net_salary', 'declared_existing_emis',
        'declared_total_existing_emi', 'loan_amount', 'loan_tenure_months', 'product', 'financial_year']
    for t in _types(TOOL_SCHEMA):
        assert isinstance(t, str), f'union type found: {t}'
        assert t != 'null'


def test_obligation_fields_in_tool_schema():
    props = TOOL_SCHEMA['properties']
    debit = props['recurring_debits']['items']
    assert debit['required'] == ['date', 'amount', 'narration', 'category']
    assert debit['properties']['channel']['enum'] == DEBIT_CHANNELS == ['ACH', 'NACH', 'ECS', 'SI', 'UPI', 'other']
    assert debit['properties']['category']['enum'] == DEBIT_CATEGORIES == [
        'loan_emi', 'rent', 'investment', 'utility', 'credit_card', 'insurance', 'other']
    emi = props['declared_existing_emis']['items']
    assert set(emi['properties']) == {'lender', 'loan_type', 'amount'}
    assert emi['required'] == ['amount']
    assert props['declared_total_existing_emi']['type'] == 'number'
    assert props['loan_tenure_months']['type'] == 'number'


# --------------------------------------------------------------------------- #
# build_texts
# --------------------------------------------------------------------------- #
def test_prefers_format_parser_over_paddleocr():
    model_text, grounding_text, stats = build_texts(
        [_page(0, format_parser=PDF_TEXT, paddleocr=OCR_TEXT)], 60000)
    assert model_text == f'--- Page 1 ---\n{PDF_TEXT}'
    assert OCR_TEXT not in model_text
    assert PDF_TEXT in grounding_text and OCR_TEXT in grounding_text
    assert stats == {'pages': 1, 'pages_with_machine_text': 1,
                     'text_chars': len(grounding_text), 'truncated': False}


def test_uses_first_non_empty_machine_field_in_order():
    model_text, _, _ = build_texts([_page(0, format_parser='', paddleocr=OCR_TEXT, bda_indexer='B' * 80)], 60000)
    assert OCR_TEXT in model_text
    assert 'B' * 80 not in model_text


def test_falls_back_to_vision_when_machine_text_is_short():
    seg = _page(0, format_parser='  short  ', ai_analysis=[
        {'analysis_query': 'Page 1 Analysis', 'content': VISION_TEXT},
        {'analysis_query': 'Q2', 'content': 'second answer'}])
    model_text, grounding_text, stats = build_texts([seg], 60000)
    assert model_text == f'--- Page 1 ---\n{VISION_TEXT}'
    assert 'second answer' not in model_text
    assert grounding_text == '  short  '
    assert stats['pages_with_machine_text'] == 1


def test_grounding_text_never_contains_ai_analysis():
    segs = [
        _page(0, format_parser=PDF_TEXT, ai_analysis=[{'analysis_query': 'a', 'content': 'AI-ONLY-ONE'}]),
        _page(1, ai_analysis=[{'analysis_query': 'a', 'content': 'AI-ONLY-TWO ' + VISION_TEXT}]),
    ]
    model_text, grounding_text, stats = build_texts(segs, 60000)
    assert 'AI-ONLY' not in grounding_text
    assert 'AI-ONLY-TWO' in model_text  # page 2 has no machine text -> vision text is model input
    assert stats['pages'] == 2 and stats['pages_with_machine_text'] == 1


def test_analysis_error_entries_are_not_used():
    seg = _page(0, ai_analysis=[{'analysis_query': 'Analysis error', 'content': 'Analysis failed: boom'}])
    model_text, _, stats = build_texts([seg], 60000)
    assert model_text == ''
    assert stats['pages'] == 1


def test_pages_sorted_and_media_segments_skipped():
    segs = [
        _page(2, format_parser='third page ' * 6),
        {'segment_index': 0, 'segment_type': 'VIDEO', 'text_content': 'VIDEO TEXT ' * 10},
        _page(1, format_parser='second page ' * 6),
        {'segment_index': 3, 'segment_type': 'CHAPTER', 'ai_analysis': [{'content': 'chapter'}]},
        {'segment_index': 4, 'segment_type': 'AUDIO', 'paddleocr': 'AUDIO TEXT ' * 10},
    ]
    model_text, grounding_text, stats = build_texts(segs, 60000)
    assert model_text.index('--- Page 2 ---') < model_text.index('--- Page 3 ---')
    assert 'VIDEO' not in model_text + grounding_text
    assert 'AUDIO' not in model_text + grounding_text
    assert stats['pages'] == 2


def test_only_media_segments_give_empty_texts():
    model_text, grounding_text, stats = build_texts(
        [{'segment_index': 0, 'segment_type': 'VIDEO', 'ai_analysis': [{'content': 'scene'}]}], 60000)
    assert (model_text, grounding_text) == ('', '')
    assert stats['pages'] == 0


def test_truncation_sets_flag_and_caps_length():
    segs = [_page(i, format_parser=f'page {i} ' + 'x' * 400) for i in range(10)]
    model_text, grounding_text, stats = build_texts(segs, 1000)
    assert stats['truncated'] is True
    assert len(model_text) <= 1000
    assert '--- Page 1 ---' in model_text
    assert '--- Page 10 ---' not in model_text
    # grounding still covers every page
    assert all(f'page {i} ' in grounding_text for i in range(10))


def test_single_huge_page_is_truncated_not_dropped():
    model_text, _, stats = build_texts([_page(0, text_content='y' * 5000)], 1000)
    assert len(model_text) == 1000
    assert model_text.startswith('--- Page 1 ---\n')
    assert stats['truncated'] is True


def test_no_truncation_when_it_fits():
    _, _, stats = build_texts([_page(0, format_parser=PDF_TEXT)], 60000)
    assert stats['truncated'] is False


# --------------------------------------------------------------------------- #
# prompts
# --------------------------------------------------------------------------- #
def test_prompt_yaml_loads_with_placeholders():
    prompts = load_prompts()
    assert '{document_text}' in prompts['user_prompt']
    assert '{tool_name}' in prompts['user_prompt']
    assert prompts['system_prompt'] == (
        PLAN_B_SYSTEM_PROMPT + ' The input is the machine-extracted text of one document; '
        'page markers are not part of the document.' + OBLIGATIONS_PROMPT)


def test_user_prompt_uses_replace_not_format():
    text = 'Literal braces {not_a_key} {0} and a planted {tool_name} token'
    prompt = build_user_prompt(text)
    assert text in prompt
    assert f'by calling {TOOL_NAME}.' in prompt
    assert '{document_text}' not in prompt


# --------------------------------------------------------------------------- #
# call_nova with a fake Bedrock client
# --------------------------------------------------------------------------- #
class FakeBedrock:
    def __init__(self, content, usage=None):
        self.content = content
        self.usage = usage if usage is not None else {'inputTokens': 1200, 'outputTokens': 150}
        self.calls = []

    def converse(self, **kwargs):
        self.calls.append(kwargs)
        return {'output': {'message': {'role': 'assistant', 'content': self.content}},
                'usage': self.usage, 'stopReason': 'tool_use'}


RAW = {'doc_type': 'salary_slip', 'applicant_name': 'Rahul Vijay Deshmukh', 'pan': 'BQXP4821K',
       'gross_salary': 95000, 'net_salary': 82500}


def test_call_nova_request_and_tool_use_response():
    fake = FakeBedrock([{'text': 'thinking...'}, {'toolUse': {'toolUseId': 't1', 'name': TOOL_NAME, 'input': RAW}}])
    fields, usage = call_nova('--- Page 1 ---\nhello', 'global.amazon.nova-2-lite-v1:0', client=fake)
    assert fields == RAW
    assert usage == {'input_tokens': 1200, 'output_tokens': 150}

    (req,) = fake.calls
    assert req['modelId'] == 'global.amazon.nova-2-lite-v1:0'
    assert req['system'] == [{'text': load_prompts()['system_prompt']}]
    assert req['inferenceConfig'] == {'maxTokens': 8000, 'temperature': 0}
    tool_config = req['toolConfig']
    assert tool_config['toolChoice'] == {'tool': {'name': 'record_loan_document'}}
    (tool,) = tool_config['tools']
    spec = tool['toolSpec']
    assert spec['name'] == 'record_loan_document'
    assert spec['description'] == 'Record the structured fields of one loan-file document.'
    assert spec['inputSchema']['json'] is TOOL_SCHEMA
    for t in _types(spec['inputSchema']['json']):
        assert isinstance(t, str) and t != 'null'
    (message,) = req['messages']
    assert message['role'] == 'user'
    assert message['content'] == [{'text': build_user_prompt('--- Page 1 ---\nhello')}]
    assert all('document' not in block for block in message['content'])  # text only, no file bytes


def test_call_nova_falls_back_to_json_in_text():
    fake = FakeBedrock([{'text': 'Here you go:\n```json\n{"doc_type": "bank_statement", "applicant_name": "X"}\n```'}],
                       usage={})
    fields, usage = call_nova('text', 'm', client=fake)
    assert fields == {'doc_type': 'bank_statement', 'applicant_name': 'X'}
    assert usage == {'input_tokens': 0, 'output_tokens': 0}


def test_call_nova_tool_use_wins_over_earlier_text_json():
    fake = FakeBedrock([{'text': '{"doc_type": "other"}'}, {'toolUse': {'input': RAW}}])
    fields, _ = call_nova('text', 'm', client=fake)
    assert fields == RAW


def test_call_nova_raises_without_structured_output():
    with pytest.raises(ValueError, match='model returned no structured output'):
        call_nova('text', 'm', client=FakeBedrock([{'text': 'I cannot help with that.'}]))
    with pytest.raises(ValueError, match='model returned no structured output'):
        call_nova('text', 'm', client=FakeBedrock([]))


def test_default_client_is_lazy_and_uses_region_and_retries(monkeypatch):
    created = {}

    class FakeBoto3:
        @staticmethod
        def client(name, region_name=None, config=None):
            created.update(name=name, region_name=region_name, config=config)
            return FakeBedrock([{'toolUse': {'input': RAW}}])

    monkeypatch.setitem(sys.modules, 'boto3', FakeBoto3)
    monkeypatch.setattr(extractor, '_bedrock_client', None)
    fields, _ = call_nova('text', 'm')
    assert fields == RAW
    assert created['name'] == 'bedrock-runtime'
    assert created['region_name'] == 'ap-south-1'
    assert created['config'].retries == {'max_attempts': 4, 'mode': 'adaptive'}
    assert created['config'].read_timeout == 120


@pytest.mark.parametrize('env_value, expected', [
    (None, 8000), ('12000', 12000), ('0', 8000), ('-5', 8000), ('lots', 8000)])
def test_max_output_tokens_env_override(monkeypatch, env_value, expected):
    if env_value is None:
        monkeypatch.delenv('FACTS_MAX_OUTPUT_TOKENS', raising=False)
    else:
        monkeypatch.setenv('FACTS_MAX_OUTPUT_TOKENS', env_value)
    fake = FakeBedrock([{'toolUse': {'input': RAW}}])
    call_nova('text', 'm', client=fake)
    assert fake.calls[0]['inferenceConfig']['maxTokens'] == expected


class TruncatingBedrock(FakeBedrock):
    def converse(self, **kwargs):
        resp = super().converse(**kwargs)
        resp['stopReason'] = 'max_tokens'
        return resp


def test_call_nova_flags_output_cut_at_max_tokens():
    fake = TruncatingBedrock([{'toolUse': {'toolUseId': 't1', 'name': TOOL_NAME, 'input': RAW}}])
    fields, usage = call_nova('text', 'm', client=fake)
    assert fields == RAW
    assert usage == {'input_tokens': 1200, 'output_tokens': 150, 'output_truncated': True}
