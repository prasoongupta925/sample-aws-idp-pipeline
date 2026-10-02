// @vitest-environment node
import { App, Stack } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { getRegionConfig } from './region-config.js';

function configFor(region: string, context: Record<string, string> = {}) {
  const app = new App({ context });
  return getRegionConfig(new Stack(app, 'Test', { env: { region } }));
}

describe('getRegionConfig', () => {
  it('keeps every model call in ap-south-1 (all-Mumbai build)', () => {
    expect(configFor('ap-south-1')).toEqual({
      region: 'ap-south-1',
      lancedbExpressAzId: 'aps1-az1',
      embeddingRegion: 'ap-south-1',
      rerankEnabled: false,
      rerankRegion: undefined,
      voiceModelRegion: 'ap-south-1',
      voiceChatEnabled: false,
      bdaEnabled: false,
      webSearchEnabled: false,
    });
  });

  it('keeps the us-east-1 defaults (rerank in us-west-2, voice chat on)', () => {
    expect(configFor('us-east-1')).toEqual({
      region: 'us-east-1',
      lancedbExpressAzId: 'use1-az4',
      embeddingRegion: 'us-east-1',
      rerankEnabled: true,
      rerankRegion: 'us-west-2',
      voiceModelRegion: 'us-east-1',
      voiceChatEnabled: true,
      bdaEnabled: true,
      webSearchEnabled: true,
    });
  });

  it('embeds in the stack region of a region without defaults', () => {
    const config = configFor('eu-west-1', { lancedbExpressAzId: 'euw1-az1' });
    expect(config.embeddingRegion).toBe('eu-west-1');
    expect(config.rerankEnabled).toBe(true);
    expect(config.rerankRegion).toBe('us-west-2');
    expect(config.voiceModelRegion).toBe('eu-west-1');
    expect(config.voiceChatEnabled).toBe(true);
    expect(config.bdaEnabled).toBe(true);
  });

  it('reads the BDA switch from CDK context', () => {
    // BDA runs through a cross-Region profile: off in ap-south-1 by default.
    expect(configFor('ap-south-1', { enableBda: 'true' }).bdaEnabled).toBe(
      true,
    );
    expect(configFor('us-east-1', { enableBda: 'false' }).bdaEnabled).toBe(
      false,
    );
  });

  it('reads the rerank and voice chat switches from CDK context', () => {
    // us-west-2 offers Amazon Rerank and Nova Sonic in-Region.
    const config = configFor('us-west-2', {
      lancedbExpressAzId: 'usw2-az1',
      enableRerank: 'true',
      rerankRegion: 'us-west-2',
      enableVoiceChat: 'false',
    });
    expect(config.rerankEnabled).toBe(true);
    expect(config.rerankRegion).toBe('us-west-2');
    expect(config.voiceChatEnabled).toBe(false);
    expect(config.voiceModelRegion).toBe('us-west-2');
    expect(
      configFor('ap-south-1', { enableVoiceChat: 'true' }).voiceChatEnabled,
    ).toBe(true);
  });

  it('has no rerank region while rerank is off', () => {
    const config = configFor('us-east-1', {
      enableRerank: 'false',
      rerankRegion: 'us-west-2',
    });
    expect(config.rerankEnabled).toBe(false);
    expect(config.rerankRegion).toBeUndefined();
  });

  it('rejects a flag that is not true or false', () => {
    expect(() => configFor('ap-south-1', { enableVoiceChat: 'yes' })).toThrow(
      'CDK context enableVoiceChat must be true or false (got "yes").',
    );
  });
});
