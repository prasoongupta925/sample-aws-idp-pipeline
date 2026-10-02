"""Model catalog, AWS-sold-only and region guards (stdlib + pytest only).

Run from the repo root:
    python -m pytest -q packages/infra/src/test_model_catalogs.py

No AWS calls: the bda-start module is imported with dummy credentials and its
boto3 clients are created lazily (never in these tests).
"""
import ast
import importlib.util
import json
import os
import re
import sys
from pathlib import Path

import pytest

os.environ.setdefault('AWS_DEFAULT_REGION', 'ap-south-1')
os.environ.setdefault('AWS_ACCESS_KEY_ID', 'testing')
os.environ.setdefault('AWS_SECRET_ACCESS_KEY', 'testing')
os.environ.setdefault('AWS_SESSION_TOKEN', 'testing')

INFRA_SRC = Path(__file__).resolve().parent
PACKAGES = INFRA_SRC.parents[1]

CHAT_MODELS_JSON = INFRA_SRC / 'chat-models.json'
MODELS_JSON = INFRA_SRC / 'models.json'
FRONTEND_MODELS_TS = (
    PACKAGES / 'frontend' / 'src' / 'components' / 'ChatPanel' / 'models.ts'
)
BACKEND_CHAT_PY = PACKAGES / 'backend' / 'app' / 'routers' / 'chat.py'
AGENT_PY = PACKAGES / 'agents' / 'idp-agent' / 'agents' / 'idp_agent.py'
BDA_START_DIR = INFRA_SRC / 'functions' / 'preprocessing' / 'bda-start'
BEDROCK_TS = PACKAGES / 'common' / 'constructs' / 'src' / 'constants' / 'bedrock.ts'
BACKEND_CONFIG_PY = PACKAGES / 'backend' / 'app' / 'config.py'
BACKEND_ASK_PY = PACKAGES / 'backend' / 'app' / 'file_check_ask.py'
FRONTEND_ASK_TS = PACKAGES / 'frontend' / 'src' / 'lib' / 'fileCheckAsk.ts'
SESSION_NAME_TS = (
    PACKAGES
    / 'lambda'
    / 'session_workers'
    / 'src'
    / 'message_process'
    / 'generate-session-name.ts'
)
WEBCRAWLER_CONFIG_PY = PACKAGES / 'agents' / 'webcrawler-agent' / 'config.py'

EXPECTED_CHAT_IDS = [
    'zai.glm-5',
    'openai.gpt-oss-120b-1:0',
    'deepseek.v3.2',
    'moonshotai.kimi-k2.5',
]
# Pipeline models (models.json): AWS-sold, credit-paid Bedrock models only,
# called in-Region (ap-south-1 model ids, no cross-Region inference profile).
AWS_SOLD_PIPELINE_PREFIXES = (
    'amazon.',
    'openai.gpt-oss-',
    'google.gemma-3-',
    'qwen.',
    'moonshotai.',
    'zai.',
)
# Mumbai has no in-Region model that reads video (only Nova does, through
# cross-Region profiles): the video steps get no model, and video is refused.
NO_MODEL_KEYS = ('videoAnalysis', 'scriptExtractor')
GPT_OSS_120B = 'openai.gpt-oss-120b-1:0'
KIMI_K2_5 = 'moonshotai.kimi-k2.5'
TITAN_EMBED_V2 = 'amazon.titan-embed-text-v2:0'

FORBIDDEN_MODEL_ID = re.compile(
    r'\b(?:global\.|us\.|eu\.|apac\.)?'
    r'(?:(?:anthropic|cohere|twelvelabs|stability|writer|luma|ai21)\.[a-z0-9]|openai\.gpt-[5-9])'
)
# A cross-Region inference profile id (geography or global prefix): everything
# runs in ap-south-1 (Mumbai), so no code may call one.
CROSS_REGION_MODEL_ID = re.compile(
    r'\b(?:global|us|us-gov|eu|apac|jp|au|ca|in)\.'
    r'(?:amazon|anthropic|cohere|meta|mistral|deepseek|openai|qwen|google|moonshotai|moonshot'
    r'|zai|minimax|nvidia|twelvelabs|writer|luma|stability|ai21|xai)\.'
)
SCAN_ROOTS = [
    'agents',
    'backend/app',
    'infra/src',
    'lambda',
    'frontend/src',
    'common/constructs/src',
]
SCAN_SKIP_DIRS = {
    'node_modules',
    'lambda-layers',
    '.venv',
    '__pycache__',
    'dist',
    'target',
}
SCAN_EXTENSIONS = {'.py', '.ts', '.tsx', '.json', '.rs', '.txt', '.md', '.yaml'}
# The deny list is the only place blocked provider names may appear.
SCAN_ALLOWLIST = {
    PACKAGES / 'common' / 'constructs' / 'src' / 'constants' / 'bedrock.ts',
}
# The model guard names cross-Region profiles only as probes of its own deny.
REGION_SCAN_ALLOWLIST = {
    PACKAGES / 'common' / 'constructs' / 'src' / 'core' / 'bedrock-model-guard.ts',
}


def _load_json(path: Path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# chat-models.json (source of the CDK-managed SSM catalog)
# ---------------------------------------------------------------------------


def test_chat_models_json_ids_and_order():
    models = _load_json(CHAT_MODELS_JSON)
    assert isinstance(models, list)
    assert [m['value'] for m in models] == EXPECTED_CHAT_IDS


def test_chat_models_json_entries_complete():
    required = {
        'value',
        'label',
        'description',
        'contextWindow',
        'inputPrice',
        'outputPrice',
        'metrics',
        'supportsReasoning',
    }
    for entry in _load_json(CHAT_MODELS_JSON):
        assert required <= set(entry), entry.get('value')
        for key in required - {'metrics', 'supportsReasoning'}:
            assert isinstance(entry[key], str) and entry[key], (entry, key)
        metrics = entry['metrics']
        assert set(metrics) >= {'intelligence', 'speed', 'context', 'cost'}
        for key in ('intelligence', 'speed', 'context', 'cost'):
            assert isinstance(metrics[key], int), (entry['value'], key)
        assert entry['supportsReasoning'] is False, entry['value']


def test_chat_models_json_fits_ssm_standard_parameter():
    # CDK stores JSON.stringify(chatModels); a standard parameter holds 4 KB.
    raw = json.dumps(_load_json(CHAT_MODELS_JSON), separators=(',', ':'))
    assert len(raw.encode('utf-8')) < 4096


# ---------------------------------------------------------------------------
# models.json (pipeline models): AWS-sold models only
# ---------------------------------------------------------------------------


def test_pipeline_models_are_aws_sold():
    models = _load_json(MODELS_JSON)
    assert isinstance(models, dict) and models
    for key, value in models.items():
        assert isinstance(value, str), key
        if key in NO_MODEL_KEYS:
            # No model: never a cross-Region profile instead.
            assert value == '', key
            continue
        assert value.startswith(AWS_SOLD_PIPELINE_PREFIXES), (key, value)
        assert not FORBIDDEN_MODEL_ID.search(value), (key, value)


def test_pipeline_model_choices():
    models = _load_json(MODELS_JSON)
    # Page images (segment analysis, QA regenerator): Kimi K2.5, the in-Region
    # vision model with tool use (research 2026-10-01: 7/7 slip, 15/15 bank page).
    assert models['analysis'] == KIMI_K2_5
    for key in NO_MODEL_KEYS:
        assert models[key] == '', key
    # Text-only steps: in-Region open-weight models. The graph is off, so the
    # entity steps are never called, but none may name a cross-Region model.
    for key in ('facts', 'extractor', 'entityNormalizer', 'summarizer', 'webcrawler'):
        assert models[key] == GPT_OSS_120B, key
    assert models['describer'] == models['docSummarizer'] == 'google.gemma-3-12b-it'
    # Search embeddings: Titan Text Embeddings V2 (in-Region, 1024 dimensions).
    assert models['embedding'] == TITAN_EMBED_V2


def test_model_catalogs_name_in_region_models_only():
    pipeline = [v for v in _load_json(MODELS_JSON).values() if v]
    chat = [m['value'] for m in _load_json(CHAT_MODELS_JSON)]
    for model_id in pipeline + chat:
        assert not CROSS_REGION_MODEL_ID.search(model_id), model_id
    assert chat[0] == 'zai.glm-5'  # the default chat model


@pytest.mark.parametrize(
    'model_id',
    [
        GPT_OSS_120B,
        'google.gemma-3-12b-it',
        'qwen.qwen3-235b-a22b-2507-v1:0',
        KIMI_K2_5,
        'zai.glm-5',
        TITAN_EMBED_V2,
    ],
)
def test_aws_sold_models_pass_both_guards(model_id):
    assert model_id.startswith(AWS_SOLD_PIPELINE_PREFIXES)
    assert not FORBIDDEN_MODEL_ID.search(model_id)
    assert not CROSS_REGION_MODEL_ID.search(model_id)


@pytest.mark.parametrize(
    'prefix, model',
    [
        ('global', 'amazon.nova-2-lite-v1:0'),
        ('apac', 'amazon.nova-pro-v1:0'),
        ('us', 'meta.llama3-70b-instruct-v1:0'),
        ('in', 'zai.glm-5'),
        ('us-gov', 'amazon.titan-embed-text-v2:0'),
    ],
)
def test_cross_region_profiles_fail_the_region_guard(prefix, model):
    # Built at run time, like the Marketplace ids below.
    model_id = f'{prefix}.{model}'
    assert not model_id.startswith(AWS_SOLD_PIPELINE_PREFIXES)
    assert CROSS_REGION_MODEL_ID.search(model_id)


@pytest.mark.parametrize(
    'provider, model',
    [
        ('anthropic', 'claude-x-v1:0'),
        ('cohere', 'embed-v4:0'),
        ('openai', 'gpt-5.4'),
        ('openai', 'gpt-6-x'),
        ('writer', 'palmyra-x5-v1:0'),
        ('ai21', 'jamba-1-5-mini-v1:0'),
    ],
)
def test_marketplace_models_fail_both_guards(provider, model):
    # Built at run time so the repo scan below does not flag this file.
    model_id = f'{provider}.{model}'
    assert not model_id.startswith(AWS_SOLD_PIPELINE_PREFIXES)
    assert FORBIDDEN_MODEL_ID.search(model_id)


# ---------------------------------------------------------------------------
# Repo scan: no non-AWS-sold model IDs anywhere
# ---------------------------------------------------------------------------


def _iter_scanned_files():
    for root in SCAN_ROOTS:
        base = PACKAGES / root
        if not base.exists():
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            parts = Path(dirpath).parts
            # Skip vendored office-skill helper scripts (.skills/<name>/scripts).
            if '.skills' in parts:
                idx = parts.index('.skills')
                if len(parts) > idx + 2 and parts[idx + 2] == 'scripts':
                    dirnames[:] = []
                    continue
            dirnames[:] = [d for d in dirnames if d not in SCAN_SKIP_DIRS]
            for name in filenames:
                path = Path(dirpath) / name
                if path.suffix in SCAN_EXTENSIONS and path not in SCAN_ALLOWLIST:
                    yield path


def test_repo_has_no_non_aws_sold_model_ids():
    hits = []
    scanned = 0
    for path in _iter_scanned_files():
        scanned += 1
        try:
            text = path.read_text(encoding='utf-8', errors='ignore')
        except OSError:
            continue
        for match in FORBIDDEN_MODEL_ID.finditer(text):
            line_no = text.count('\n', 0, match.start()) + 1
            hits.append(f'{path.relative_to(PACKAGES)}:{line_no}: {match.group(0)}')
    assert scanned > 100, 'repo scan found too few files; wrong root?'
    assert not hits, 'non-AWS-sold model IDs found:\n' + '\n'.join(hits)


def _is_test_or_doc(path: Path) -> bool:
    """Tests and docs may name a cross-Region id (as test data or history)."""
    name = path.name
    if name.startswith('test_') or name.endswith(('.test.ts', '.test.tsx')):
        return True
    if 'tests' in path.parts:
        return True
    # Agent skills (.skills/*/SKILL.md) are prompts, not docs: scanned.
    return path.suffix == '.md' and '.skills' not in path.parts


def test_code_names_no_cross_region_model():
    hits = []
    for path in _iter_scanned_files():
        if _is_test_or_doc(path) or path in REGION_SCAN_ALLOWLIST:
            continue
        try:
            text = path.read_text(encoding='utf-8', errors='ignore')
        except OSError:
            continue
        for match in CROSS_REGION_MODEL_ID.finditer(text):
            line_no = text.count('\n', 0, match.start()) + 1
            hits.append(f'{path.relative_to(PACKAGES)}:{line_no}: {match.group(0)}')
    assert not hits, (
        'cross-Region model ids found (everything runs in ap-south-1):\n'
        + '\n'.join(hits)
    )


def test_deny_list_covers_blocked_providers():
    # Every role that can call a model gets this deny list: checked on the
    # synthesized app by infra/src/bedrock-model-guard.test.ts (vitest).
    text = next(iter(SCAN_ALLOWLIST)).read_text(encoding='utf-8')
    for provider in (
        'anthropic',
        'cohere',
        'twelvelabs',
        'stability',
        'writer',
        'luma',
        'ai21',
    ):
        assert f"'{provider}'" in text, provider
    assert 'foundation-model/${p}.*' in text
    assert 'inference-profile/*${p}.*' in text
    assert 'marketplace/model-endpoint/*' in text
    for action in ('bedrock:CallWithBearerToken', 'bedrock-mantle:*'):
        assert f"'{action}'" in text, action


# ---------------------------------------------------------------------------
# Parity: built-in fallbacks == chat-models.json
# ---------------------------------------------------------------------------


def test_frontend_fallback_matches_chat_models_json():
    text = FRONTEND_MODELS_TS.read_text(encoding='utf-8')
    ids = re.findall(r"^\s*value:\s*'([^']+)'", text, re.MULTILINE)
    assert ids == [m['value'] for m in _load_json(CHAT_MODELS_JSON)]


def test_backend_fallback_matches_chat_models_json():
    text = BACKEND_CHAT_PY.read_text(encoding='utf-8')
    ids = re.findall(r'^\s*"value":\s*"([^"]+)"', text, re.MULTILINE)
    assert ids == [m['value'] for m in _load_json(CHAT_MODELS_JSON)]


def test_agent_fallback_matches_chat_models_json():
    text = AGENT_PY.read_text(encoding='utf-8')
    block = re.search(
        r'_DEFAULT_MODEL_CATALOG: dict\[str, bool\] = \{(.*?)\n\}', text, re.DOTALL
    )
    assert block, '_DEFAULT_MODEL_CATALOG not found'
    entries = re.findall(r'"([^"]+)":\s*(True|False)', block.group(1))
    assert [k for k, _ in entries] == [
        m['value'] for m in _load_json(CHAT_MODELS_JSON)
    ]
    assert all(v == 'False' for _, v in entries)


# ---------------------------------------------------------------------------
# Parity: the file-check Ask model (CDK, backend default, web app default)
# ---------------------------------------------------------------------------


def _ask_prices() -> dict:
    """PRICES_PER_MILLION_USD of the backend's Ask module (a literal dict)."""
    tree = ast.parse(BACKEND_ASK_PY.read_text(encoding='utf-8'))
    for node in tree.body:
        if isinstance(node, ast.AnnAssign):
            target = node.target
        elif isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
        else:
            continue
        if isinstance(target, ast.Name) and target.id == 'PRICES_PER_MILLION_USD':
            return ast.literal_eval(node.value)
    raise AssertionError('PRICES_PER_MILLION_USD not found in file_check_ask.py')


def test_ask_model_is_one_in_region_priced_model():
    cdk = re.search(
        r"export const FILE_CHECK_ASK_MODEL_ID = '([^']+)';",
        BEDROCK_TS.read_text(encoding='utf-8'),
    )
    backend = re.search(
        r'file_check_ask_model_id: str = "([^"]+)"',
        BACKEND_CONFIG_PY.read_text(encoding='utf-8'),
    )
    web_text = FRONTEND_ASK_TS.read_text(encoding='utf-8')
    web = re.search(r"export const ASK_DEFAULT_MODEL_ID = '([^']+)';", web_text)
    assert cdk and backend and web
    # Kimi K2.5: the Mumbai eval's pick for the Ask (gpt-oss-120b misread a
    # closing balance and did not answer Hinglish in Hinglish).
    assert cdk.group(1) == backend.group(1) == web.group(1) == KIMI_K2_5
    # Every Ask model is priced per service tier, in-Region, never Nova.
    prices = _ask_prices()
    assert KIMI_K2_5 in prices
    for model_id, tiers in prices.items():
        assert not CROSS_REGION_MODEL_ID.search(model_id), model_id
        assert model_id.startswith(AWS_SOLD_PIPELINE_PREFIXES), model_id
        assert 'default' in tiers, model_id
    # The web app's fallback pricing is the API's standard price of that model.
    fallback = re.search(
        r'ASK_DEFAULT_PRICING[^{]*\{\s*input_per_million_usd:\s*([0-9.]+),'
        r'\s*output_per_million_usd:\s*([0-9.]+),',
        web_text,
    )
    assert fallback, 'ASK_DEFAULT_PRICING not found in fileCheckAsk.ts'
    assert (float(fallback.group(1)), float(fallback.group(2))) == prices[
        KIMI_K2_5
    ]['default']


# ---------------------------------------------------------------------------
# Parity: a model a function names itself == the model its role may invoke
# ---------------------------------------------------------------------------


def test_session_name_model_is_the_one_the_worker_may_invoke():
    # The session worker names its model in code; CDK grants its role only
    # SESSION_NAME_MODEL_ID (common/constructs app/workers/message-process.ts).
    # A model changed in one place only would be denied: no session names.
    pattern = r"export const SESSION_NAME_MODEL_ID = '([^']+)';"
    worker = re.search(pattern, SESSION_NAME_TS.read_text(encoding='utf-8'))
    cdk = re.search(pattern, BEDROCK_TS.read_text(encoding='utf-8'))
    assert worker and cdk
    assert worker.group(1) == cdk.group(1)
    assert worker.group(1).startswith(AWS_SOLD_PIPELINE_PREFIXES), worker.group(1)
    assert not CROSS_REGION_MODEL_ID.search(worker.group(1)), worker.group(1)


def test_webcrawler_fallback_is_its_models_json_model():
    # AgentStack sets BEDROCK_MODEL_ID (and the role's only model) from
    # models.json `webcrawler`; the config fallback names the same model.
    fallback = re.search(
        r'"BEDROCK_MODEL_ID",\s*"([^"]+)"',
        WEBCRAWLER_CONFIG_PY.read_text(encoding='utf-8'),
    )
    assert fallback, 'BEDROCK_MODEL_ID fallback not found in webcrawler config.py'
    assert fallback.group(1) == _load_json(MODELS_JSON)['webcrawler'] == GPT_OSS_120B


# ---------------------------------------------------------------------------
# bda-start: BDA profile geo prefix from the deploy region
# ---------------------------------------------------------------------------


@pytest.fixture(scope='module')
def bda_start():
    source = (BDA_START_DIR / 'index.py').read_text(encoding='utf-8')
    # The module must not create boto3 clients at import time.
    module_level = [
        line
        for line in source.splitlines()
        if line and not line[0].isspace() and 'boto3.' in line
    ]
    assert not module_level, module_level

    for extra in (str(INFRA_SRC / 'functions'), str(BDA_START_DIR)):
        if extra not in sys.path:
            sys.path.insert(0, extra)
    spec = importlib.util.spec_from_file_location(
        'bda_start_index_under_test', BDA_START_DIR / 'index.py'
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.bda_client is None and module.bda_runtime_client is None
    return module


@pytest.mark.parametrize(
    'region, expected',
    [
        ('ap-south-1', 'apac.data-automation-v1'),
        ('ap-northeast-1', 'apac.data-automation-v1'),
        ('us-east-1', 'us.data-automation-v1'),
        ('us-west-2', 'us.data-automation-v1'),
        ('eu-west-1', 'eu.data-automation-v1'),
        ('ca-central-1', 'us.data-automation-v1'),
        ('', 'us.data-automation-v1'),
    ],
)
def test_bda_profile_id_from_region(bda_start, monkeypatch, region, expected):
    monkeypatch.delenv('BDA_PROFILE_ID', raising=False)
    assert bda_start._bda_profile_id(region) == expected


def test_bda_profile_id_env_override_wins(bda_start, monkeypatch):
    monkeypatch.setenv('BDA_PROFILE_ID', 'custom.data-automation-v1')
    assert bda_start._bda_profile_id('ap-south-1') == 'custom.data-automation-v1'
    assert bda_start._bda_profile_id('us-east-1') == 'custom.data-automation-v1'


# ---------------------------------------------------------------------------
# Agent prompt / skill wiring for the deterministic file check
# ---------------------------------------------------------------------------


def test_system_prompts_route_file_checks_to_the_tool():
    txt = (INFRA_SRC / 'prompts' / 'chat' / 'system_prompt.txt').read_text(
        encoding='utf-8'
    )
    py = (PACKAGES / 'agents' / 'idp-agent' / 'prompts.py').read_text(
        encoding='utf-8'
    )
    heading = '## Loan-file checks (deterministic: AI reads, rules decide)'
    for text in (txt, py):
        assert heading in text
        assert 'filecheck___run_file_check' in text
        assert 'missing_items' in text
        assert 'Exception: loan-file readiness/completeness/consistency' in text
        # The section sits after "Structured vs. Unstructured Data".
        assert text.index('## Structured vs. Unstructured Data') < text.index(
            heading
        )
    # Same section text in both copies.
    def section(text):
        start = text.index(heading)
        return text[start : text.index('\n## ', start + 1)]

    assert section(txt) == section(py)


def test_file_check_skill_front_matter():
    skill = (
        PACKAGES / 'agents' / 'idp-agent' / '.skills' / 'file-check' / 'SKILL.md'
    ).read_text(encoding='utf-8')
    assert skill.startswith('---\nname: file-check\n')
    assert 'filecheck___run_file_check' in skill
    assert 'filecheck___list_checklists' in skill
    assert 'AI reads, rules decide, you explain.' in skill


def test_search_skill_writes_queries_in_english():
    # Titan Text Embeddings V2 (models.json embedding) matched a Hindi
    # (Devanagari) question to the wrong document (research 2026-10-01).
    skill = (
        PACKAGES / 'agents' / 'idp-agent' / '.skills' / 'search' / 'SKILL.md'
    ).read_text(encoding='utf-8')
    assert skill.startswith('---\nname: searching\n')
    assert (
        'Write search queries in English, even when the user writes Hindi or Marathi.'
        in skill
    )
    assert _load_json(MODELS_JSON)['embedding'] == TITAN_EMBED_V2
