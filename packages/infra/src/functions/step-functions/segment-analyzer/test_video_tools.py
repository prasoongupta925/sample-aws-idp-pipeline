"""Video tools with no video model (the all-Mumbai build: models.json
videoAnalysis and scriptExtractor are empty). No AWS calls: Bedrock is a fake
that fails the test if it is called; synthetic data only.

Run: python -m pytest -q test_video_tools.py   (from this folder)
"""
import json
import os
import sys

os.environ.setdefault('AWS_DEFAULT_REGION', 'ap-south-1')
os.environ.setdefault('AWS_REGION', 'ap-south-1')
os.environ.setdefault('AWS_ACCESS_KEY_ID', 'testing')
os.environ.setdefault('AWS_SECRET_ACCESS_KEY', 'testing')

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import pytest  # noqa: E402

from tools import script_extractor  # noqa: E402
from tools.script_extractor import create_script_extractor_tool  # noqa: E402
from tools.video_analyzer import create_video_analyzer_tool  # noqa: E402

MODELS_JSON = os.path.abspath(os.path.join(HERE, '..', '..', '..', 'models.json'))
NO_VIDEO_MODEL = 'Video reading is not available in this deployment (no in-Region video model).'
VIDEO_URI = 's3://demo-bucket/projects/proj_demo/documents/doc_demo/call.mp4'


class NoBedrock:
    """Fails the test on any model call."""

    def converse(self, **kwargs):
        raise AssertionError(f'unexpected model call: {kwargs.get("modelId")!r}')


def _call(tool_fn, **kwargs):
    """Runs a strands @tool function directly and returns its text."""
    return tool_fn(**kwargs)


def test_models_json_has_no_video_model():
    with open(MODELS_JSON, encoding='utf-8') as fh:
        models = json.load(fh)
    assert models['videoAnalysis'] == models['scriptExtractor'] == ''


def test_video_analyzer_without_a_model_never_calls_bedrock():
    steps = []
    analyze_video = create_video_analyzer_tool(
        video_uri_getter=lambda: VIDEO_URI,
        analysis_steps=steps,
        model_id='',
        bedrock_client=NoBedrock(),
        bucket_owner_account_id='',
    )
    assert _call(analyze_video, question='What happens on screen?') == NO_VIDEO_MODEL
    assert steps == []


@pytest.mark.parametrize('env', [None, ''])
def test_script_extractor_without_a_model_never_calls_bedrock(monkeypatch, env):
    if env is None:
        monkeypatch.delenv('NOVA_LITE_MODEL_ID', raising=False)
    else:
        monkeypatch.setenv('NOVA_LITE_MODEL_ID', env)

    def no_client(*args, **kwargs):
        raise AssertionError('unexpected Bedrock client')

    monkeypatch.setattr(script_extractor, '_get_converse_client', no_client, raising=False)
    steps = []
    extract_video_script = create_script_extractor_tool(
        video_uri_getter=lambda: VIDEO_URI,
        timecode_getter=lambda: ('00:00:00:00', '00:00:30:00'),
        transcribe_segments=[{'start_time': 0, 'end_time': 3, 'transcript': 'Namaste, main Asha bol rahi hoon.'}],
        analysis_steps=steps,
        region='ap-south-1',
    )
    assert _call(extract_video_script) == NO_VIDEO_MODEL
    assert steps == []
