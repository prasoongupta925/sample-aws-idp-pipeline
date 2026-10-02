import { describe, it, expect } from 'vitest';
import {
  SESSION_NAME_MODEL_ID,
  sessionNameFromContent,
  sessionNameRequest,
} from './generate-session-name';

describe('session names', () => {
  it('use an in-Region model (no cross-Region inference profile)', () => {
    expect(SESSION_NAME_MODEL_ID).toBe('openai.gpt-oss-20b-1:0');
    expect(SESSION_NAME_MODEL_ID).not.toMatch(
      /^(global|us|eu|apac|jp|au|ca|in)\./,
    );
  });

  it('ask on the Flex tier, with room for the reasoning before the title', () => {
    const request = sessionNameRequest('User: hi');
    expect(request.modelId).toBe(SESSION_NAME_MODEL_ID);
    expect(request.serviceTier).toEqual({ type: 'flex' });
    // gpt-oss reasoning counts against maxTokens: 50 would end inside it.
    expect(request.inferenceConfig?.maxTokens).toBeGreaterThanOrEqual(512);
    expect(request.messages).toEqual([
      { role: 'user', content: [{ text: 'User: hi' }] },
    ]);
  });

  it('never take reasoning that arrives inline in the text', () => {
    expect(
      sessionNameFromContent([
        { text: '<reasoning>The user asks about EMI.</reasoning>EMI for Rahul' },
      ]),
    ).toBe('EMI for Rahul');
    // Cut off at maxTokens inside the reasoning: no title.
    expect(
      sessionNameFromContent([{ text: '<reasoning>The user asks about' }]),
    ).toBeNull();
  });

  it('give null when the answer stopped inside the reasoning block', () => {
    expect(
      sessionNameFromContent([
        { reasoningContent: { reasoningText: { text: 'The user' } } },
      ] as unknown as { text?: string }[]),
    ).toBeNull();
  });

  it('take the first text block, after any reasoning block', () => {
    expect(
      sessionNameFromContent([
        { reasoningContent: { reasoningText: { text: 'thinking' } } },
        { text: 'Rahul Deshmukh loan file check' },
      ] as { text?: string }[]),
    ).toBe('Rahul Deshmukh loan file check');
  });

  it('drop wrapping quotes, Markdown emphasis and extra lines', () => {
    expect(sessionNameFromContent([{ text: '"Sneha ki file ready?"' }])).toBe(
      'Sneha ki file ready?',
    );
    expect(
      sessionNameFromContent([{ text: '**EMI for a 6 lakh loan**\n\nNote' }]),
    ).toBe('EMI for a 6 lakh loan');
    expect(
      sessionNameFromContent([{ text: '  PAN mismatch in Amit’s file ' }]),
    ).toBe('PAN mismatch in Amit’s file');
  });

  it('give null when there is no title', () => {
    expect(sessionNameFromContent(undefined)).toBeNull();
    expect(sessionNameFromContent([])).toBeNull();
    expect(sessionNameFromContent([{ text: '  ' }])).toBeNull();
    expect(sessionNameFromContent([{ text: '""' }])).toBeNull();
  });
});
