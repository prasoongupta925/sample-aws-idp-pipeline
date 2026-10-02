import json
import os
import re
from typing import List

import boto3
from botocore.config import Config


_HTML_TAG_RE = re.compile(r'<[^>]+>')
_MD_HEADER_RE = re.compile(r'^#{1,6}\s+', re.MULTILINE)
_WHITESPACE_RE = re.compile(r'\n{3,}')


def strip_markup(text: str) -> str:
    """Strip HTML tags and markdown headers for cleaner embedding input."""
    text = _HTML_TAG_RE.sub(' ', text)
    text = _MD_HEADER_RE.sub('', text)
    text = (
        text.replace('&amp;', '&')
        .replace('&lt;', '<')
        .replace('&gt;', '>')
        .replace('&nbsp;', ' ')
    )
    text = _WHITESPACE_RE.sub('\n\n', text)
    return text.strip()


# Amazon Titan Text Embeddings V2 (AWS-sold, in-Region in ap-south-1). A table
# must only ever hold vectors of one model: a model change needs a re-index.
EMBEDDING_MODEL_ID = os.environ.get('EMBEDDING_MODEL_ID') or 'amazon.titan-embed-text-v2:0'
# Vector size of the LanceDB schema (Vector(1024) in lancedb_client.py).
EMBEDDING_DIMENSION = 1024
# Titan Text Embeddings V2 takes at most 50,000 characters (and 8,192 tokens).
MAX_INPUT_CHARS = 50_000

# Titan V2's on-demand quota is 60 requests a minute: adaptive retries back off
# (and slow the client down) on ThrottlingException.
_RETRY_CONFIG = Config(retries={'max_attempts': 8, 'mode': 'adaptive'})


def bedrock_runtime_client():
    """bedrock-runtime client for the embedding model: EMBEDDING_REGION (CDK
    region config, the stack region by default) wins over the Lambda region."""
    return boto3.client(
        'bedrock-runtime',
        region_name=os.environ.get('EMBEDDING_REGION') or os.environ.get('AWS_REGION'),
        config=_RETRY_CONFIG,
    )


def titan_request_body(text: str) -> str:
    """Titan Text Embeddings V2 request: 1024 dimensions, normalized vector."""
    return json.dumps(
        {
            'inputText': text[:MAX_INPUT_CHARS],
            'dimensions': EMBEDDING_DIMENSION,
            'normalize': True,
        }
    )


def titan_embedding(response: dict) -> List[float]:
    """The vector of a Titan Text Embeddings V2 invoke_model response.

    Raises ValueError for any other shape or size, so a wrong model never
    writes into a table.
    """
    result = json.loads(response['body'].read())
    embedding = result.get('embedding') if isinstance(result, dict) else None
    if not isinstance(embedding, list):
        raise ValueError('unexpected embedding response (not Titan Text Embeddings V2)')
    if len(embedding) != EMBEDDING_DIMENSION:
        raise ValueError(
            f'embedding has {len(embedding)} dimensions, '
            f'the LanceDB schema needs {EMBEDDING_DIMENSION}'
        )
    return embedding


def generate_single_embedding(text: str, client=None) -> List[float]:
    """Titan V2 vector of `text` (markup stripped); zeros for empty text.

    Bedrock errors are raised: a zero vector would be stored as if it were real.
    """
    clean_text = strip_markup(text or '')
    if not clean_text:
        return [0.0] * EMBEDDING_DIMENSION
    client = client or bedrock_runtime_client()
    response = client.invoke_model(
        modelId=EMBEDDING_MODEL_ID,
        body=titan_request_body(clean_text),
        contentType='application/json',
        accept='application/json',
    )
    return titan_embedding(response)
