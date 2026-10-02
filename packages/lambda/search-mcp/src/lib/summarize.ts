import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { bedrockClient } from './clients.js';
import { buildPrompt } from './prompt.js';
import type { HybridResult, SearchAnswer } from '../types.js';

/** In-Region (ap-south-1) and AWS-sold: no cross-Region inference profile. */
const MODEL_ID = process.env.SUMMARIZE_MODEL_ID ?? 'openai.gpt-oss-120b-1:0';

/**
 * Output budget. gpt-oss reasons before it answers, and the reasoning counts
 * against maxTokens: 4096 leaves the answer the 2048 tokens it had before.
 */
const MAX_TOKENS = 4096;

export async function summarizeResults(
  query: string,
  results: HybridResult[],
): Promise<SearchAnswer> {
  const prompt = buildPrompt(query, results);

  const command = new ConverseCommand({
    modelId: MODEL_ID,
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    inferenceConfig: {
      maxTokens: MAX_TOKENS,
    },
  });

  const response = await bedrockClient.send(command);
  // gpt-oss answers with a reasoningContent block first: keep the text blocks.
  const answer = (response.output?.message?.content ?? [])
    .map((block) => block.text ?? '')
    .join('')
    .trim();

  const sources = results.map((r) => ({
    document_id: r.document_id,
    segment_id: r.segment_id,
    qa_id: r.qa_id,
  }));

  return { answer, sources };
}
