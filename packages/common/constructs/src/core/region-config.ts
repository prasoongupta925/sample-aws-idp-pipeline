import { Stack, Token } from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Per-region deployment settings. Every value can be overridden with CDK
 * context (`-c <key>=<value>`); otherwise the defaults for the stack region
 * apply. ap-south-1 (Mumbai) keeps every model call in-Region: Titan Text
 * Embeddings V2 is offered there, while Amazon Rerank and Nova Sonic are not,
 * so re-ranking and the built-in voice chat are off. In every region the
 * App's model guard (core/bedrock-model-guard.ts) denies model calls outside
 * the stack region: LanceServiceStack refuses an embeddingRegion other than
 * the stack region, AgentStack (with voice chat on) such a voiceModelRegion,
 * and Amazon Rerank in another region is denied (search then keeps the
 * hybrid order).
 */
export interface RegionConfig {
  region: string;
  lancedbExpressAzId: string;
  /** Region of the embedding model: the stack region (the only one allowed). */
  embeddingRegion: string;
  /**
   * Re-rank search results with Amazon Rerank (context enableRerank). When
   * false, search keeps the LanceDB hybrid order (full-text + vector).
   */
  rerankEnabled: boolean;
  /** Region of Amazon Rerank; undefined when rerankEnabled is false. */
  rerankRegion?: string;
  /** Region of the voice chat model (Nova Sonic): the stack region. */
  voiceModelRegion: string;
  /**
   * Deploy the built-in speech-to-speech voice chat (Nova Sonic BidiAgent)
   * (context enableVoiceChat).
   */
  voiceChatEnabled: boolean;
  /**
   * Offer Bedrock Data Automation, the upload's optional "BDA" preprocessing
   * (context enableBda). BDA runs only through a geographic cross-Region
   * profile (bda-start: us./eu./apac.data-automation-v1), so it is off where
   * every call must stay in the Region: no IAM grant, the step is skipped and
   * the web app hides the option.
   */
  bdaEnabled: boolean;
  /** Create the AgentCore Web Search gateway target (context enableWebSearch). */
  webSearchEnabled: boolean;
}

type RegionDefaults = Omit<RegionConfig, 'region' | 'webSearchEnabled'>;

const REGION_DEFAULTS: Record<string, RegionDefaults> = {
  'us-east-1': {
    lancedbExpressAzId: 'use1-az4',
    embeddingRegion: 'us-east-1',
    rerankEnabled: true,
    rerankRegion: 'us-west-2',
    voiceModelRegion: 'us-east-1',
    voiceChatEnabled: true,
    bdaEnabled: true,
  },
  'ap-south-1': {
    // S3 Express One Zone zones in ap-south-1: aps1-az1 and aps1-az3.
    lancedbExpressAzId: 'aps1-az1',
    // Titan Text Embeddings V2 is offered in-Region.
    embeddingRegion: 'ap-south-1',
    // No reranking model in ap-south-1: search keeps the LanceDB hybrid order
    // (full-text + vector).
    rerankEnabled: false,
    // Nova Sonic is not offered in ap-south-1, so the built-in voice chat is
    // not deployed: the voice bot (Transcribe + an in-Region LLM + Polly) is
    // the voice channel.
    voiceModelRegion: 'ap-south-1',
    voiceChatEnabled: false,
    // Bedrock Data Automation in ap-south-1 runs through the APAC cross-Region
    // profile (apac.data-automation-v1): off.
    bdaEnabled: false,
  },
};

const FALLBACK_RERANK_REGION = 'us-west-2';

/**
 * Regions that offer the AgentCore Web Search Tool (AgentCore Regions page,
 * checked 2026-09-27). ap-south-1 is not one of them.
 */
const WEB_SEARCH_REGIONS = ['us-east-1', 'eu-west-1', 'ap-northeast-1'];

/** Region direction -> AZ ID letters, e.g. ap-south-1 -> aps1-az1. */
const AZ_ID_DIRECTIONS: Record<string, string> = {
  north: 'n',
  south: 's',
  east: 'e',
  west: 'w',
  central: 'c',
  northeast: 'ne',
  northwest: 'nw',
  southeast: 'se',
  southwest: 'sw',
};

function contextString(scope: Construct, key: string): string | undefined {
  const value: unknown = scope.node.tryGetContext(key);
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

function contextBoolean(scope: Construct, key: string): boolean | undefined {
  const text = contextString(scope, key);
  if (text === undefined) {
    return undefined;
  }
  if (text.toLowerCase() === 'true') {
    return true;
  }
  if (text.toLowerCase() === 'false') {
    return false;
  }
  throw new Error(`CDK context ${key} must be true or false (got "${text}").`);
}

/** AZ ID prefix of a region (ap-south-1 -> aps1), undefined if unknown. */
function azIdPrefix(region: string): string | undefined {
  const match = /^([a-z]{2})-([a-z]+)-(\d+)$/.exec(region);
  const direction = match ? AZ_ID_DIRECTIONS[match[2]] : undefined;
  return match && direction ? `${match[1]}${direction}${match[3]}` : undefined;
}

export function getRegionConfig(scope: Construct): RegionConfig {
  const region = Stack.of(scope).region;
  const defaults: Partial<RegionDefaults> = Token.isUnresolved(region)
    ? {}
    : (REGION_DEFAULTS[region] ?? {});

  const lancedbExpressAzId =
    contextString(scope, 'lancedbExpressAzId') ?? defaults.lancedbExpressAzId;
  if (!lancedbExpressAzId) {
    const regionName = Token.isUnresolved(region) ? '(unresolved)' : region;
    throw new Error(
      `No S3 Express availability zone ID is known for region ${regionName}. ` +
        'Pass it as CDK context: -c lancedbExpressAzId=... ' +
        '(an S3 Express zone ID such as aps1-az1).',
    );
  }
  // Catch a zone ID of another region at synth time, not mid-deploy.
  const prefix = Token.isUnresolved(region) ? undefined : azIdPrefix(region);
  if (prefix && !new RegExp(`^${prefix}-az\\d+$`).test(lancedbExpressAzId)) {
    throw new Error(
      `lancedbExpressAzId ${lancedbExpressAzId} is not a zone ID of ` +
        `region ${region} (expected ${prefix}-az<N>).`,
    );
  }

  const rerankEnabled =
    contextBoolean(scope, 'enableRerank') ?? defaults.rerankEnabled ?? true;

  return {
    region,
    lancedbExpressAzId,
    embeddingRegion:
      contextString(scope, 'embeddingRegion') ??
      defaults.embeddingRegion ??
      region,
    rerankEnabled,
    rerankRegion: rerankEnabled
      ? (contextString(scope, 'rerankRegion') ??
        defaults.rerankRegion ??
        FALLBACK_RERANK_REGION)
      : undefined,
    voiceModelRegion:
      contextString(scope, 'voiceModelRegion') ??
      defaults.voiceModelRegion ??
      region,
    voiceChatEnabled:
      contextBoolean(scope, 'enableVoiceChat') ??
      defaults.voiceChatEnabled ??
      true,
    bdaEnabled:
      contextBoolean(scope, 'enableBda') ?? defaults.bdaEnabled ?? true,
    webSearchEnabled:
      contextBoolean(scope, 'enableWebSearch') ??
      (!Token.isUnresolved(region) && WEB_SEARCH_REGIONS.includes(region)),
  };
}
