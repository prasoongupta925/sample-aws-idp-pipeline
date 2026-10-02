import { beforeEach, describe, expect, it, vi } from 'vitest';

// No AWS: the LanceDB / graph Lambdas and Bedrock are fakes (synthetic data).
const { send, invokeLanceDB, invokeGraphService } = vi.hoisted(() => ({
  send: vi.fn(),
  invokeLanceDB: vi.fn(),
  invokeGraphService: vi.fn(),
}));

vi.mock('./lib/clients.js', () => ({
  bedrockClient: { send },
  invokeLanceDB,
  invokeGraphService,
}));

const SEGMENT = {
  segment_id: 'wf_demo_0000',
  qa_id: 'wf_demo_0000_00',
  document_id: 'doc_demo',
  segment_index: 0,
  qa_index: 0,
  content: 'Synthetic salary slip: net pay ₹82,500',
};

/** A gpt-oss answer: the reasoning block comes before the text. */
const ANSWER = {
  output: {
    message: {
      content: [
        { reasoningContent: { reasoningText: { text: 'The user asks...' } } },
        { text: '[Source: document_id=doc_demo, segment_id=wf_demo_0000]\n' },
        { text: 'Net pay ₹82,500' },
      ],
    },
  },
};

interface ConverseInput {
  modelId: string;
  inferenceConfig: { maxTokens: number };
}

function converseInput(): ConverseInput {
  return send.mock.calls[0][0].input as ConverseInput;
}

describe('graph tools (graph off in the lean build)', () => {
  beforeEach(() => {
    send.mockReset().mockResolvedValue(ANSWER);
    invokeLanceDB.mockReset();
    invokeGraphService.mockReset();
  });

  it('graph_keyword asks gpt-oss-120b in-Region and keeps only the answer text', async () => {
    invokeLanceDB
      .mockResolvedValueOnce({ results: [{ name: 'Konkan Softworks' }] })
      .mockResolvedValueOnce({ segments: [SEGMENT] });
    invokeGraphService.mockResolvedValue({
      results: [{ qa_id: SEGMENT.qa_id }],
    });
    const { handler } = await import('./graph-keyword.js');

    const out = await handler({ project_id: 'proj_demo', query: 'net pay' });

    expect(converseInput().modelId).toBe('openai.gpt-oss-120b-1:0');
    expect(converseInput().inferenceConfig.maxTokens).toBe(4096);
    expect(out.answer).toBe(
      '[Source: document_id=doc_demo, segment_id=wf_demo_0000]\nNet pay ₹82,500',
    );
    expect(out.sources.map((s) => s.segment_id)).toEqual(['wf_demo_0000']);
  });

  it('graph_traverse asks gpt-oss-120b in-Region and keeps only the answer text', async () => {
    invokeGraphService.mockResolvedValue({
      entities: [{ id: 'e1', name: 'Konkan Softworks' }],
      segments: [
        {
          id: SEGMENT.segment_id,
          workflow_id: 'wf_demo',
          document_id: SEGMENT.document_id,
          segment_index: 0,
          match_type: 'entity',
        },
      ],
    });
    invokeLanceDB.mockResolvedValue({ segments: [SEGMENT] });
    const { handler } = await import('./graph-traverse.js');

    const out = await handler({ project_id: 'proj_demo', query: 'net pay' });

    expect(converseInput().modelId).toBe('openai.gpt-oss-120b-1:0');
    expect(converseInput().inferenceConfig.maxTokens).toBe(4096);
    expect(out.answer).toBe(
      '[Source: document_id=doc_demo, segment_id=wf_demo_0000]\nNet pay ₹82,500',
    );
    expect(out.sources.map((s) => s.segment_id)).toEqual(['wf_demo_0000']);
  });
});
