import {
  BedrockAgentRuntimeClient,
  RerankCommand,
  type RerankCommandOutput,
  RerankSource,
} from '@aws-sdk/client-bedrock-agent-runtime';
import type { HybridResult } from '../types.js';

/**
 * Amazon Rerank runs only when RERANK_ENABLED is "true" (CDK region config
 * rerankEnabled). It is off in ap-south-1, which has no reranking model:
 * results then keep the LanceDB hybrid order (full-text + vector) and no
 * model is called.
 */
const ENABLED = (process.env.RERANK_ENABLED ?? '').toLowerCase() === 'true';
const MODEL_ID = process.env.RERANK_MODEL_ID ?? 'amazon.rerank-v1:0';
const REGION = process.env.RERANK_REGION ?? process.env.AWS_REGION;

let client: BedrockAgentRuntimeClient | undefined;

function toModelArn(modelId: string): string {
  if (modelId.startsWith('arn:')) return modelId;
  return `arn:aws:bedrock:${REGION}::foundation-model/${modelId}`;
}

export interface RerankResult extends HybridResult {
  rerankScore: number;
}

/** The first `topN` results in hybrid-search order, scored by rank (1 = first). */
function hybridOrder(results: HybridResult[], topN?: number): RerankResult[] {
  return results
    .slice(0, topN ?? results.length)
    .map((r, i) => ({ ...r, rerankScore: 1 - i / results.length }));
}

export async function rerankResults(
  query: string,
  results: HybridResult[],
  topN?: number,
): Promise<RerankResult[]> {
  if (!ENABLED) {
    return hybridOrder(results, topN);
  }

  const sources: RerankSource[] = results.map((r) => ({
    type: 'INLINE' as const,
    inlineDocumentSource: {
      type: 'TEXT' as const,
      textDocument: {
        text: r.content,
      },
    },
  }));

  const command = new RerankCommand({
    queries: [{ type: 'TEXT' as const, textQuery: { text: query } }],
    sources,
    rerankingConfiguration: {
      type: 'BEDROCK_RERANKING_MODEL' as const,
      bedrockRerankingConfiguration: {
        modelConfiguration: {
          modelArn: toModelArn(MODEL_ID),
        },
        numberOfResults: topN ?? results.length,
      },
    },
  });

  let response: RerankCommandOutput;
  try {
    client ??= new BedrockAgentRuntimeClient({ region: REGION });
    response = await client.send(command);
  } catch {
    // Rerank unavailable: keep the hybrid-search order.
    return hybridOrder(results, topN);
  }

  return (response.results ?? [])
    .map((r) => ({
      ...results[r.index ?? 0],
      rerankScore: r.relevanceScore ?? 0,
    }))
    .sort((a, b) => b.rerankScore - a.rerankScore);
}
