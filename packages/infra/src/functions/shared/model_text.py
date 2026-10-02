"""The answer text of a model call, never the model's reasoning.

The page descriptions and document summaries (models.json describer and
docSummarizer) run on gpt-oss, which reasons before it answers. Bedrock returns
that reasoning in reasoningContent blocks, which are never read here (as in the
facts step, document-facts/extractor.py); reasoning that arrives inline in the
text as <reasoning>...</reasoning> (even cut off) is removed too, as the
backend's Ask does (packages/backend/app/file_check_ask.py).
"""

import re

_INLINE_REASONING = re.compile(r'<reasoning>.*?(?:</reasoning>|\Z)', re.DOTALL)


def strip_reasoning(text: str) -> str:
    """`text` without inline <reasoning> sections, stripped."""
    return _INLINE_REASONING.sub('', text or '').strip()


def agent_answer_text(result) -> str:
    """The answer of a Strands AgentResult: its text blocks only, without reasoning.

    reasoningContent blocks (gpt-oss) are skipped. A result without a message
    falls back to str(result), which also reads text blocks only.
    """
    message = getattr(result, 'message', None)
    if not isinstance(message, dict):
        return strip_reasoning(str(result))
    texts = [
        block['text']
        for block in message.get('content') or []
        if isinstance(block, dict) and isinstance(block.get('text'), str)
    ]
    return strip_reasoning('\n'.join(texts))
