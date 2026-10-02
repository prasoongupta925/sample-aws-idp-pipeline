import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HybridResult } from '../types.js';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('./clients.js', () => ({ bedrockClient: { send } }));

const HIT: HybridResult = {
  workflow_id: 'wf_demo',
  document_id: 'doc_demo',
  segment_id: 'wf_demo_0000',
  qa_id: 'wf_demo_0000_00',
  segment_index: 0,
  qa_index: 0,
  question: 'Net pay?',
  content: 'Synthetic salary slip: net pay ₹82,500',
  keywords: '',
  score: 1,
};

interface ConverseInput {
  modelId: string;
  inferenceConfig: { maxTokens: number };
}

describe('summarizeResults', () => {
  beforeEach(() => {
    send.mockReset();
    vi.resetModules();
    delete process.env.SUMMARIZE_MODEL_ID;
  });

  it('asks gpt-oss-120b in-Region and keeps only the answer text', async () => {
    const { summarizeResults } = await import('./summarize.js');
    send.mockResolvedValue({
      output: {
        message: {
          content: [
            {
              reasoningContent: { reasoningText: { text: 'The user asks...' } },
            },
            {
              text: '[Source: document_id=doc_demo, segment_id=wf_demo_0000]\n',
            },
            { text: 'Net pay ₹82,500' },
          ],
        },
      },
    });

    const out = await summarizeResults('net pay', [HIT]);

    expect(out.answer).toBe(
      '[Source: document_id=doc_demo, segment_id=wf_demo_0000]\nNet pay ₹82,500',
    );
    expect(out.sources).toEqual([
      {
        document_id: 'doc_demo',
        segment_id: 'wf_demo_0000',
        qa_id: 'wf_demo_0000_00',
      },
    ]);
    const { input } = send.mock.calls[0][0] as { input: ConverseInput };
    expect(input.modelId).toBe('openai.gpt-oss-120b-1:0');
    expect(input.inferenceConfig.maxTokens).toBe(4096);
  });

  it('uses SUMMARIZE_MODEL_ID when set', async () => {
    process.env.SUMMARIZE_MODEL_ID = 'qwen.qwen3-235b-a22b-2507-v1:0';
    const { summarizeResults } = await import('./summarize.js');
    send.mockResolvedValue({ output: { message: { content: [] } } });

    const out = await summarizeResults('net pay', [HIT]);

    expect(out.answer).toBe('');
    const { input } = send.mock.calls[0][0] as { input: ConverseInput };
    expect(input.modelId).toBe('qwen.qwen3-235b-a22b-2507-v1:0');
  });
});
