import { describe, it, expect } from 'vitest';
import {
  SESSION_NAME_MODEL_ID,
  sessionNameFromContent,
} from './generate-session-name';

describe('session names', () => {
  it('use an in-Region model (no cross-Region inference profile)', () => {
    expect(SESSION_NAME_MODEL_ID).toBe('google.gemma-3-12b-it');
    expect(SESSION_NAME_MODEL_ID).not.toMatch(
      /^(global|us|eu|apac|jp|au|ca|in)\./,
    );
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
