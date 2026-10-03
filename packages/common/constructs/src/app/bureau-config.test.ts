// @vitest-environment node
import { App, Stack } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { getBureauProvider } from './bureau-config.js';

function providerFor(context: Record<string, unknown> = {}) {
  const app = new App({ context });
  return getBureauProvider(new Stack(app, 'Test'));
}

describe('getBureauProvider', () => {
  it('connects no bureau by default', () => {
    expect(providerFor()).toBe('none');
    expect(providerFor({ bureauProvider: '  ' })).toBe('none');
  });

  it('takes none or mock in any case', () => {
    expect(providerFor({ bureauProvider: 'mock' })).toBe('mock');
    expect(providerFor({ bureauProvider: ' MOCK ' })).toBe('mock');
    expect(providerFor({ bureauProvider: 'none' })).toBe('none');
  });

  it('refuses an unknown provider', () => {
    expect(() => providerFor({ bureauProvider: 'cibil' })).toThrow(
      /Invalid CDK context bureauProvider=cibil: expected one of none, mock/,
    );
  });
});
