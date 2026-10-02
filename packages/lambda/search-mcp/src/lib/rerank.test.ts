import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HybridResult } from '../types.js';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@aws-sdk/client-bedrock-agent-runtime', () => ({
  BedrockAgentRuntimeClient: class {
    send = send;
  },
  RerankCommand: class {
    constructor(public input: unknown) {}
  },
}));

const RERANK_ENV = ['RERANK_ENABLED', 'RERANK_REGION', 'RERANK_MODEL_ID'];

function hit(i: number): HybridResult {
  return {
    workflow_id: 'wf_demo',
    document_id: 'doc_demo',
    segment_id: `wf_demo_000${i}`,
    qa_id: `wf_demo_000${i}_00`,
    segment_index: i,
    qa_index: 0,
    question: '',
    content: `synthetic page ${i}`,
    keywords: '',
    score: 1 / (i + 1),
  };
}

/** rerank.ts reads its environment at import: load it fresh. */
async function loadRerank(env: Record<string, string>) {
  vi.resetModules();
  for (const key of RERANK_ENV) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  return import('./rerank.js');
}

describe('rerankResults', () => {
  beforeEach(() => {
    send.mockReset();
  });

  it('keeps the hybrid order and calls no model when RERANK_ENABLED=false', async () => {
    const { rerankResults } = await loadRerank({ RERANK_ENABLED: 'false' });
    const out = await rerankResults('net pay', [hit(0), hit(1), hit(2)], 2);
    expect(out.map((r) => r.qa_id)).toEqual([
      'wf_demo_0000_00',
      'wf_demo_0001_00',
    ]);
    expect(out.map((r) => r.rerankScore)).toEqual([1, 1 - 1 / 3]);
    expect(out[0].content).toBe('synthetic page 0');
    expect(send).not.toHaveBeenCalled();
  });

  it('is off when RERANK_ENABLED is not set', async () => {
    const { rerankResults } = await loadRerank({});
    const out = await rerankResults('net pay', [hit(0), hit(1)]);
    expect(out.map((r) => r.segment_index)).toEqual([0, 1]);
    expect(send).not.toHaveBeenCalled();
  });

  it('re-ranks with Amazon Rerank in RERANK_REGION when enabled', async () => {
    const { rerankResults } = await loadRerank({
      RERANK_ENABLED: 'true',
      RERANK_REGION: 'us-west-2',
      RERANK_MODEL_ID: 'amazon.rerank-v1:0',
    });
    send.mockResolvedValue({
      results: [
        { index: 2, relevanceScore: 0.9 },
        { index: 0, relevanceScore: 0.4 },
      ],
    });
    const out = await rerankResults('net pay', [hit(0), hit(1), hit(2)], 2);
    expect(out.map((r) => r.segment_index)).toEqual([2, 0]);
    expect(out.map((r) => r.rerankScore)).toEqual([0.9, 0.4]);
    const { input } = send.mock.calls[0][0] as {
      input: {
        rerankingConfiguration: {
          bedrockRerankingConfiguration: {
            modelConfiguration: { modelArn: string };
            numberOfResults: number;
          };
        };
      };
    };
    const config = input.rerankingConfiguration.bedrockRerankingConfiguration;
    expect(config.modelConfiguration.modelArn).toBe(
      'arn:aws:bedrock:us-west-2::foundation-model/amazon.rerank-v1:0',
    );
    expect(config.numberOfResults).toBe(2);
  });

  it('falls back to the hybrid order when Rerank fails', async () => {
    const { rerankResults } = await loadRerank({
      RERANK_ENABLED: 'true',
      RERANK_REGION: 'us-west-2',
    });
    send.mockRejectedValue(new Error('AccessDeniedException'));
    const out = await rerankResults('net pay', [hit(0), hit(1)]);
    expect(out.map((r) => r.segment_index)).toEqual([0, 1]);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
