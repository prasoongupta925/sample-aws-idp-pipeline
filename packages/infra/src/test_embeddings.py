"""Titan Text Embeddings V2 in the shared Python modules (functions/shared
embeddings.py and lancedb_client.py). No AWS calls: a fake bedrock-runtime
client answers. Synthetic text only.

Run from the repo root:
    uv run --with pytest python -m pytest -q packages/infra/src/test_embeddings.py
"""

import io
import json
import os
import sys
from pathlib import Path

import pytest

os.environ.setdefault('AWS_ACCESS_KEY_ID', 'testing')
os.environ.setdefault('AWS_SECRET_ACCESS_KEY', 'testing')
os.environ['AWS_REGION'] = 'ap-south-1'
os.environ.pop('EMBEDDING_MODEL_ID', None)
os.environ.pop('EMBEDDING_REGION', None)

FUNCTIONS = Path(__file__).resolve().parent / 'functions'
sys.path.insert(0, str(FUNCTIONS))

from shared import embeddings  # noqa: E402

TITAN_V2 = 'amazon.titan-embed-text-v2:0'


class FakeBedrock:
    """invoke_model answers `body` (a dict) and records each request."""

    def __init__(self, body):
        self.body = body
        self.requests = []

    def invoke_model(self, **kwargs):
        self.requests.append(kwargs)
        return {'body': io.BytesIO(json.dumps(self.body).encode())}


def titan_answer(value=0.5, size=1024):
    return {'embedding': [value] * size, 'inputTextTokenCount': 4}


def test_default_model_is_titan_v2():
    assert embeddings.EMBEDDING_MODEL_ID == TITAN_V2
    assert embeddings.EMBEDDING_DIMENSION == 1024


def test_request_is_titan_v2_with_1024_normalized_dimensions():
    fake = FakeBedrock(titan_answer())
    vector = embeddings.generate_single_embedding('## Net pay\n<b>₹82,500</b>', client=fake)
    assert len(vector) == 1024
    (request,) = fake.requests
    assert request['modelId'] == TITAN_V2
    assert request['contentType'] == 'application/json'
    assert json.loads(request['body']) == {
        'inputText': 'Net pay\n ₹82,500',
        'dimensions': 1024,
        'normalize': True,
    }


def test_long_input_is_cut_to_the_titan_limit():
    body = json.loads(embeddings.titan_request_body('x' * 60_000))
    assert len(body['inputText']) == embeddings.MAX_INPUT_CHARS == 50_000


def test_empty_text_gives_zeros_without_a_call():
    fake = FakeBedrock(titan_answer())
    assert embeddings.generate_single_embedding('  <br>  ', client=fake) == [0.0] * 1024
    assert fake.requests == []


@pytest.mark.parametrize(
    'answer, message',
    [
        # The Nova multimodal embeddings response shape.
        ({'embeddings': [{'embedding': [0.5] * 1024}]}, 'not Titan Text Embeddings V2'),
        ({'embedding': [0.5] * 512}, '512 dimensions'),
    ],
)
def test_other_responses_raise_instead_of_storing_zeros(answer, message):
    with pytest.raises(ValueError, match=message):
        embeddings.generate_single_embedding('net pay', client=FakeBedrock(answer))


def test_client_uses_embedding_region_then_lambda_region(monkeypatch):
    monkeypatch.setenv('EMBEDDING_REGION', 'ap-south-1')
    monkeypatch.setenv('AWS_REGION', 'eu-west-1')
    client = embeddings.bedrock_runtime_client()
    assert client.meta.region_name == 'ap-south-1'
    assert client.meta.config.retries['mode'] == 'adaptive'
    monkeypatch.delenv('EMBEDDING_REGION')
    assert embeddings.bedrock_runtime_client().meta.region_name == 'eu-west-1'


def test_lancedb_embedding_function_is_titan_v2():
    pytest.importorskip('lancedb')
    from lancedb.embeddings import get_registry

    from shared import lancedb_client

    function_class = get_registry().get('bedrock-titan-v2')
    assert function_class is lancedb_client.BedrockEmbeddingFunction
    function = lancedb_client.bedrock_embeddings
    assert function.model_id == TITAN_V2
    assert function.ndims() == 1024

    fake = FakeBedrock(titan_answer(0.25))
    function._client = fake
    vectors = function.generate_embeddings(['net pay ₹82,500', ''])
    assert vectors == [[0.25] * 1024, [0.0] * 1024]
    assert [json.loads(r['body'])['inputText'] for r in fake.requests] == ['net pay ₹82,500']

    function._client = FakeBedrock({'embeddings': [{'embedding': [0.5] * 1024}]})
    with pytest.raises(ValueError, match='not Titan Text Embeddings V2'):
        function.generate_embeddings(['net pay'])
