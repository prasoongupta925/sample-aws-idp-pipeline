"""Deploy-region guards: deploy/destroy scripts, CodeBuild buildspecs, region
config (stdlib + PyYAML + pytest only).

Run from the repo root:
    python -m pytest -q packages/infra/src/test_deploy_region.py

No AWS calls: the scripts and buildspec commands run against stub `aws`,
`curl` and `npx` executables on PATH, with the real AWS config disabled.
"""

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

INFRA_SRC = Path(__file__).resolve().parent
PACKAGES = INFRA_SRC.parents[1]
REPO = PACKAGES.parent
CONSTRUCTS_SRC = PACKAGES / 'common' / 'constructs' / 'src'
REGION_CONFIG_TS = CONSTRUCTS_SRC / 'core' / 'region-config.ts'

FORK = 'https://github.com/example-owner/sample-aws-idp-pipeline'
FORK_RAW = 'https://raw.githubusercontent.com/example-owner/sample-aws-idp-pipeline'
BASH = shutil.which('bash')

pytestmark = pytest.mark.skipif(BASH is None, reason='bash is required')

# Stub `aws`: logs every call and answers only what the scripts ask.
AWS_STUB = r"""#!/bin/bash
printf '%s\n' "$*" >> "$STUB_LOG"
case "$1 $2" in
  "cloudformation validate-template"|"cloudformation deploy"|"cloudformation delete-stack"|"cloudformation wait")
    exit 0 ;;
  "cloudformation describe-stacks")
    case "$*" in
      *CDKToolkit*)
        if [ -n "$STUB_TOOLKIT_STATUS" ]; then echo "$STUB_TOOLKIT_STATUS"; exit 0; fi
        exit 254 ;;
      *StackStatus*) echo CREATE_COMPLETE ;;
      *ProjectName*) echo stub-project ;;
      *) echo None ;;
    esac
    exit 0 ;;
  "codebuild start-build")
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--environment-variables-override" ]; then
        printf '%s' "$2" > "$STUB_ENV_OVERRIDES"
      fi
      shift
    done
    echo stub-project:build-1
    exit 0 ;;
  "codebuild batch-get-builds")
    case "$*" in *buildStatus*) echo SUCCEEDED ;; *) echo "" ;; esac
    exit 0 ;;
esac
echo "unexpected aws call: $*" >&2
exit 99
"""

# Stub `curl`: records the URL, never writes the -o file.
CURL_STUB = r"""#!/bin/bash
for arg in "$@"; do last="$arg"; done
printf 'curl %s\n' "$last" >> "$STUB_LOG"
exit 0
"""

NPX_STUB = r"""#!/bin/bash
printf 'npx %s\n' "$*" >> "$STUB_LOG"
exit 0
"""


@pytest.fixture
def stub_env(tmp_path):
    bin_dir = tmp_path / 'bin'
    bin_dir.mkdir()
    for name, body in (('aws', AWS_STUB), ('curl', CURL_STUB), ('npx', NPX_STUB)):
        path = bin_dir / name
        path.write_text(body)
        path.chmod(0o755)
    env = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith('AWS_') and k not in ('CDK_CONTEXT_ARGS',)
    }
    env.update(
        PATH=f'{bin_dir}:/usr/bin:/bin',
        STUB_LOG=str(tmp_path / 'calls.log'),
        STUB_ENV_OVERRIDES=str(tmp_path / 'env-overrides.json'),
        AWS_CONFIG_FILE='/dev/null',
        AWS_SHARED_CREDENTIALS_FILE='/dev/null',
        AWS_PROFILE='stub-no-such-profile',
        AWS_DEFAULT_REGION='ap-south-1',
    )
    return env, tmp_path


def _calls(tmp_path):
    log = tmp_path / 'calls.log'
    return log.read_text().splitlines() if log.exists() else []


def _run_script(name, args, env, answer='y\n'):
    return subprocess.run(
        [BASH, str(REPO / name), *args],
        input=answer,
        env=env,
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=60,
    )


# ---------------------------------------------------------------------------
# deploy.sh / destroy.sh: templates from the repo being deployed
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('suffix', ['.git', '', '/', '.git/'])
@pytest.mark.parametrize(
    'script, template, extra',
    [
        ('deploy.sh', 'deploy-codebuild.yml', ['--admin-email', 'a@example.com']),
        ('destroy.sh', 'destroy-codebuild.yml', []),
    ],
)
def test_template_comes_from_repo_url(stub_env, script, template, extra, suffix):
    env, tmp = stub_env
    result = _run_script(
        script, [*extra, '--repo-url', FORK + suffix, '--version', 'main'], env
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert f'curl {FORK_RAW}/main/{template}' in _calls(tmp)
    assert 'aws-samples' not in '\n'.join(_calls(tmp))


def _email_args(script):
    return ['--admin-email', 'a@example.com'] if script == 'deploy.sh' else []


@pytest.mark.parametrize('script', ['deploy.sh', 'destroy.sh'])
def test_template_url_base_override(stub_env, script):
    env, tmp = stub_env
    template = script.replace('.sh', '-codebuild.yml')
    result = _run_script(
        script,
        [
            *_email_args(script),
            '--repo-url',
            'https://git.example.com/idp.git',
            '--template-url-base',
            'https://templates.example.com/idp/',
            '--version',
            'v1',
        ],
        env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert f'curl https://templates.example.com/idp/v1/{template}' in _calls(tmp)


@pytest.mark.parametrize('script', ['deploy.sh', 'destroy.sh'])
def test_non_github_repo_needs_template_url_base(stub_env, script):
    env, tmp = stub_env
    result = _run_script(script, ['--repo-url', 'https://git.example.com/idp.git'], env)
    assert result.returncode == 1
    assert '--template-url-base' in result.stdout
    assert _calls(tmp) == []


@pytest.mark.parametrize('script', ['deploy.sh', 'destroy.sh'])
@pytest.mark.parametrize('bad', ['noequals', 'a=b"c', 'a=b c', '=x', 'a=$(id)'])
def test_invalid_context_is_rejected(stub_env, script, bad):
    env, tmp = stub_env
    result = _run_script(script, ['--repo-url', FORK, '--context', bad], env)
    assert result.returncode == 1
    assert 'Invalid --context' in result.stdout
    assert _calls(tmp) == []


def _env_overrides(tmp):
    data = json.loads((tmp / 'env-overrides.json').read_text())
    return {item['name']: item['value'] for item in data}


def test_deploy_passes_heap_and_context_to_codebuild(stub_env):
    env, tmp = stub_env
    result = _run_script(
        'deploy.sh',
        [
            '--admin-email',
            'a@example.com',
            '--repo-url',
            FORK,
            '--context',
            'lancedbExpressAzId=aps1-az3',
            '--context',
            'enableWebSearch=false',
        ],
        env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    overrides = _env_overrides(tmp)
    assert overrides['NODE_OPTIONS'] == '--max-old-space-size=6144'
    assert overrides['IDP_RESERVED_CONCURRENCY'] == 'off'
    assert overrides['CDK_CONTEXT_ARGS'] == (
        '-c lancedbExpressAzId=aps1-az3 -c enableWebSearch=false'
    )
    assert 'DEPLOY_STACKS' not in overrides


def test_deploy_targeted_stacks_still_passes_heap(stub_env):
    env, tmp = stub_env
    result = _run_script(
        'deploy.sh', ['--repo-url', FORK, '--stacks', 'IDP-V2-Mcp'], env
    )
    assert result.returncode == 0, result.stdout + result.stderr
    overrides = _env_overrides(tmp)
    assert overrides['NODE_OPTIONS'] == '--max-old-space-size=6144'
    assert overrides['DEPLOY_STACKS'] == 'IDP-V2-Mcp'
    assert 'CDK_CONTEXT_ARGS' not in overrides


def test_destroy_gets_the_same_heap_override_as_deploy(stub_env):
    env, tmp = stub_env
    result = _run_script(
        'destroy.sh',
        ['--repo-url', FORK, '--context', 'lancedbExpressAzId=aps1-az1'],
        env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    overrides = _env_overrides(tmp)
    assert overrides['NODE_OPTIONS'] == '--max-old-space-size=6144'
    assert overrides['CDK_CONTEXT_ARGS'] == '-c lancedbExpressAzId=aps1-az1'


@pytest.mark.parametrize('script', ['deploy.sh', 'destroy.sh'])
def test_cancel_makes_no_calls(stub_env, script):
    env, tmp = stub_env
    result = _run_script(
        script, [*_email_args(script), '--repo-url', FORK], env, answer='n\n'
    )
    assert result.returncode == 0
    assert 'cancelled' in result.stdout
    assert f'Template:    {FORK_RAW}/main/' in result.stdout
    assert _calls(tmp) == []


# ---------------------------------------------------------------------------
# Buildspecs
# ---------------------------------------------------------------------------


class _CfnLoader(yaml.SafeLoader):
    """SafeLoader that keeps CloudFormation short-form tags as plain values."""


def _cfn_tag(loader, _suffix, node):
    if isinstance(node, yaml.ScalarNode):
        return loader.construct_scalar(node)
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node)
    return loader.construct_mapping(node)


_CfnLoader.add_multi_constructor('!', _cfn_tag)


def _project(template_name):
    template = yaml.load((REPO / template_name).read_text(), Loader=_CfnLoader)
    project = template['Resources']['CodeBuildProject']['Properties']
    buildspec = yaml.safe_load(project['Source']['BuildSpec'])
    env_names = [v['Name'] for v in project['Environment']['EnvironmentVariables']]
    return buildspec, env_names


def _all_commands(buildspec):
    return [
        cmd
        for phase in buildspec['phases'].values()
        for cmd in phase.get('commands', [])
    ]


@pytest.mark.parametrize('template', ['deploy-codebuild.yml', 'destroy-codebuild.yml'])
def test_buildspec_commands_are_valid_bash(template, tmp_path):
    buildspec, _ = _project(template)
    for i, cmd in enumerate(_all_commands(buildspec)):
        script = tmp_path / f'cmd{i}.sh'
        script.write_text(cmd)
        check = subprocess.run(
            [BASH, '-n', str(script)], capture_output=True, text=True
        )
        assert check.returncode == 0, f'{template} command {i}: {check.stderr}\n{cmd}'


def _us_east_1_bootstrap_command():
    buildspec, _ = _project('deploy-codebuild.yml')
    build = buildspec['phases']['build']['commands']
    matches = [
        i
        for i, c in enumerate(build)
        if 'bootstrap aws://$AWS_ACCOUNT_ID/us-east-1' in c
    ]
    assert len(matches) == 1, 'expected exactly one us-east-1 bootstrap command'
    first_deploy = next(i for i, c in enumerate(build) if 'cdk deploy' in c)
    assert matches[0] < first_deploy, 'us-east-1 must be bootstrapped before cdk deploy'
    return build[matches[0]]


@pytest.mark.parametrize(
    'region, toolkit_status, expect_bootstrap',
    [
        ('ap-south-1', '', True),  # no CDKToolkit in us-east-1
        ('ap-south-1', 'ROLLBACK_COMPLETE', True),
        ('ap-south-1', 'CREATE_COMPLETE', False),
        ('us-east-1', '', False),  # the deploy-region block already covers it
    ],
)
def test_deploy_buildspec_bootstraps_us_east_1_for_waf(
    stub_env, region, toolkit_status, expect_bootstrap
):
    env, tmp = stub_env
    env.update(
        AWS_DEFAULT_REGION=region,
        AWS_ACCOUNT_ID='111111111111',
        STUB_TOOLKIT_STATUS=toolkit_status,
    )
    result = subprocess.run(
        [BASH, '-c', _us_east_1_bootstrap_command()],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    bootstraps = [c for c in _calls(tmp) if c.startswith('npx cdk bootstrap')]
    if expect_bootstrap:
        assert bootstraps == [
            'npx cdk bootstrap aws://111111111111/us-east-1 --require-approval never'
        ]
    else:
        assert bootstraps == []
    for call in _calls(tmp):
        if call.startswith('cloudformation'):
            assert '--region us-east-1' in call, call


def test_deploy_buildspec_passes_cdk_context():
    buildspec, env_names = _project('deploy-codebuild.yml')
    assert 'CDK_CONTEXT_ARGS' in env_names
    deploy_lines = [
        line.strip()
        for cmd in _all_commands(buildspec)
        for line in cmd.splitlines()
        if line.strip().startswith('npx cdk deploy')
    ]
    # Targeted stacks, or --all (no VPC stack to deploy first any more).
    assert len(deploy_lines) == 2
    assert all(line.endswith('$CDK_CONTEXT_ARGS') for line in deploy_lines)
    assert not any('IDP-V2-Vpc' in line or 'IDP-V2-Neptune' in line for line in deploy_lines)


def test_destroy_buildspec_passes_cdk_context():
    buildspec, env_names = _project('destroy-codebuild.yml')
    assert 'CDK_CONTEXT_ARGS' in env_names
    destroy = [c for c in _all_commands(buildspec) if 'cdk destroy' in c]
    assert len(destroy) == 1 and '$CDK_CONTEXT_ARGS' in destroy[0]


# ---------------------------------------------------------------------------
# Region config (TypeScript source checks; tsc/synth run in CodeBuild)
# ---------------------------------------------------------------------------


def _region_block(text, region):
    match = re.search(rf"'{region}': \{{(.*?)\n  \}}", text, re.DOTALL)
    assert match, region
    return match.group(1)


def test_ap_south_1_defaults():
    text = REGION_CONFIG_TS.read_text(encoding='utf-8')
    block = _region_block(text, 'ap-south-1')
    assert "lancedbExpressAzId: 'aps1-az1'" in block
    # Owner decision 2026-10-01 (all-Mumbai build): every model call stays in
    # ap-south-1. Titan Text Embeddings V2 is in-Region; Amazon Rerank and Nova
    # Sonic are not, so re-ranking and the built-in voice chat are off.
    assert "embeddingRegion: 'ap-south-1'" in block
    assert 'rerankEnabled: false' in block
    assert 'rerankRegion' not in re.sub(r'//.*', '', block)
    assert 'voiceChatEnabled: false' in block
    assert "voiceModelRegion: 'ap-south-1'" in block
    # Bedrock Data Automation runs only through a cross-Region profile
    # (apac.data-automation-v1 from ap-south-1): off.
    assert 'bdaEnabled: false' in block
    regions = re.findall(r"^\s*(\w+Region): '([^']*)'", block, re.MULTILINE)
    assert regions and all(value == 'ap-south-1' for _, value in regions), regions
    web = re.search(r'WEB_SEARCH_REGIONS = \[(.*?)\]', text, re.DOTALL)
    assert web and 'ap-south-1' not in web.group(1)
    assert "'us-east-1'" in web.group(1)
    assert "contextBoolean(scope, 'enableWebSearch')" in text


def test_other_regions_keep_their_defaults():
    text = REGION_CONFIG_TS.read_text(encoding='utf-8')
    block = _region_block(text, 'us-east-1')
    assert "embeddingRegion: 'us-east-1'" in block
    assert 'rerankEnabled: true' in block
    assert "rerankRegion: 'us-west-2'" in block
    assert 'voiceChatEnabled: true' in block
    assert 'bdaEnabled: true' in block
    # A region without defaults: embeddings in the stack region (Titan V2 is
    # widely offered), rerank and voice chat on as before. No cross-Region
    # opt-in is offered: the model guard denies model calls outside the stack
    # region.
    assert not re.search(r'-c (embeddingRegion|rerankRegion|voiceModelRegion)=', text)
    assert 'FALLBACK_EMBEDDING_REGION' not in text
    assert re.search(
        r"embeddingRegion:\s*contextString\(scope, 'embeddingRegion'\) \?\?\s*"
        r'defaults\.embeddingRegion \?\?\s*region,',
        text,
    )
    assert "FALLBACK_RERANK_REGION = 'us-west-2'" in text
    assert "contextBoolean(scope, 'enableRerank') ?? defaults.rerankEnabled ?? true" in text
    assert re.search(
        r"contextBoolean\(scope, 'enableVoiceChat'\) \?\?\s*"
        r'defaults\.voiceChatEnabled \?\?\s*true',
        text,
    )


def test_s3_express_az_is_not_hard_coded():
    hits = []
    for root in (INFRA_SRC, CONSTRUCTS_SRC):
        for path in root.rglob('*.ts'):
            if path == REGION_CONFIG_TS or 'node_modules' in path.parts:
                continue
            if path.name.endswith(('.test.ts', '.spec.ts')):
                continue  # test fixtures may name a zone
            if re.search(r"'[a-z]{2,6}\d-az\d+'", path.read_text(encoding='utf-8')):
                hits.append(str(path.relative_to(PACKAGES)))
    assert not hits, hits
    storage = (INFRA_SRC / 'stacks' / 'storage-stack.ts').read_text(encoding='utf-8')
    assert storage.count('regionConfig.lancedbExpressAzId') == 2


def test_web_search_target_is_region_guarded():
    text = (INFRA_SRC / 'stacks' / 'mcp-stack.ts').read_text(encoding='utf-8')
    method = text.index('private addWebSearchTarget(): void {')
    # All web-search resources live in the guarded method ...
    for marker in ("'WebSearchTarget'", "sid: 'InvokeWebSearch'", 'web-search.v1'):
        assert text.index(marker) > method, marker
    # ... which is called exactly once, behind the region flag.
    calls = re.findall(r'\n(.*)\n\s*this\.addWebSearchTarget\(\);', text)
    assert calls == ['    if (getRegionConfig(this).webSearchEnabled) {']


def test_named_buckets_include_region():
    names = []
    for rel in ('app/s3-bucket.ts', 'core/static-website.ts'):
        text = (CONSTRUCTS_SRC / rel).read_text(encoding='utf-8')
        names += re.findall(r'`(idp-v2-[^`]*)`', text)
    code = [n for n in names if '${' in n]
    assert len(code) == 4, names
    assert all(n.endswith('${Aws.ACCOUNT_ID}-${Aws.REGION}') for n in code), names
    # The doc comment shows the same shape.
    assert all(n.endswith('-{region}') for n in names if '${' not in n), names


TITAN_V2 = 'amazon.titan-embed-text-v2:0'


def test_embedding_model_and_region_are_wired_from_config():
    lance = (INFRA_SRC / 'stacks' / 'lance-service-stack.ts').read_text(
        encoding='utf-8'
    )
    assert 'const embeddingModelId = models.embedding;' in lance
    # Embeddings run in the stack's Region; a region config that names another
    # one fails synth (the model guard would deny every embedding call).
    assert 'const embeddingRegion = this.region;' in lance
    assert (
        'const configuredEmbeddingRegion = getRegionConfig(this).embeddingRegion;'
        in lance
    )
    assert re.search(
        r'if \(\s*!Token\.isUnresolved\(embeddingRegion\) &&\s*'
        r'configuredEmbeddingRegion !== embeddingRegion\s*\) \{\s*throw new Error\(',
        lance,
    )
    assert 'EMBEDDING_MODEL_ID: embeddingModelId,' in lance
    assert 'EMBEDDING_REGION: embeddingRegion,' in lance
    # Its own IAM: InvokeModel on that one foundation model in that region only.
    assert (
        '`arn:aws:bedrock:${embeddingRegion}::foundation-model/${embeddingModelId}`'
        in lance
    )
    assert "resources: ['*']" not in lance
    assert 'InvokeModelWithResponseStream' not in lance
    # The service speaks the Titan Text Embeddings V2 format; synth fails for
    # any other model (a different model would also need a re-index).
    titan = re.search(r'const TITAN_TEXT_EMBEDDINGS_V2 = /(.*)/;', lance)
    models = json.loads((INFRA_SRC / 'models.json').read_text(encoding='utf-8'))
    assert models['embedding'] == TITAN_V2
    assert titan and re.fullmatch(titan.group(1), TITAN_V2)

    main_rs = (PACKAGES / 'lambda' / 'lancedb-service' / 'src' / 'main.rs').read_text(
        encoding='utf-8'
    )
    assert 'std::env::var("EMBEDDING_REGION")' in main_rs
    bedrock_rs = (
        PACKAGES / 'lambda' / 'lancedb-service' / 'src' / 'client' / 'bedrock.rs'
    ).read_text(encoding='utf-8')
    assert 'std::env::var("EMBEDDING_MODEL_ID")' in bedrock_rs
    assert f'pub const DEFAULT_MODEL_ID: &str = "{TITAN_V2}";' in bedrock_rs
    assert '#[serde(rename = "inputText")]' in bedrock_rs
    assert 'pub const EMBEDDING_DIMENSION: usize = 1024;' in bedrock_rs
    embeddings_py = (INFRA_SRC / 'functions' / 'shared' / 'embeddings.py').read_text(
        encoding='utf-8'
    )
    assert f"os.environ.get('EMBEDDING_MODEL_ID') or '{TITAN_V2}'" in embeddings_py
    # Every place that holds vectors keeps 1024 dimensions (no schema change).
    model_rs = (
        PACKAGES / 'lambda' / 'lancedb-service' / 'src' / 'db' / 'model.rs'
    ).read_text(encoding='utf-8')
    assert 'const VECTOR_DIMENSION: i32 = 1024;' in model_rs


def test_search_mcp_models_stay_in_region():
    search = (CONSTRUCTS_SRC / 'app' / 'mcp' / 'search-mcp.ts').read_text(
        encoding='utf-8'
    )
    assert "const SUMMARIZE_MODEL_ID = 'openai.gpt-oss-120b-1:0';" in search
    assert 'global.' not in search
    assert (
        '`arn:aws:bedrock:${Stack.of(this).region}::foundation-model/${SUMMARIZE_MODEL_ID}`'
        in search
    )
    # Rerank only where the region config enables it (never in ap-south-1).
    assert 'RERANK_ENABLED: String(rerankRegion !== undefined),' in search
    assert 'RERANK_REGION: getRegionConfig' not in search
    assert search.count("'bedrock:Rerank'") == 1
    assert search.index("actions: ['bedrock:Rerank']") > search.index(
        'if (rerankRegion) {'
    )
    summarize = (
        PACKAGES / 'lambda' / 'search-mcp' / 'src' / 'lib' / 'summarize.ts'
    ).read_text(encoding='utf-8')
    assert "process.env.SUMMARIZE_MODEL_ID ?? 'openai.gpt-oss-120b-1:0'" in summarize
    assert 'global.' not in summarize


def test_gateway_target_descriptions_fit_the_200_char_limit():
    # AgentCore rejects gateway target descriptions over 200 characters at
    # synth time (aws-bedrock-agentcore-alpha GatewayTarget validation).
    text = (INFRA_SRC / 'stacks' / 'mcp-stack.ts').read_text(encoding='utf-8')
    descriptions = re.findall(r"description:\s*'([^']*)'", text)
    assert len(descriptions) >= 6
    too_long = [d for d in descriptions if len(d) > 200]
    assert not too_long, too_long
