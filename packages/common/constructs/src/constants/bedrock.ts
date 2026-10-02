/**
 * Bedrock model providers that are not sold by AWS (AWS Marketplace or
 * third-party billing). Invocations of their models are explicitly denied on
 * every role that can call Bedrock, so only AWS-sold models can be used.
 * Checked 2026-10-01 on every model of ap-south-1, us-east-1 and us-west-2
 * (aws bedrock list-foundation-model-agreement-offers): only these providers
 * and OpenAI's GPT models have an AWS Marketplace offer, and their model cards
 * say "offered and billed through AWS Marketplace". AI21 Labs (Jamba) is one.
 */
export const BLOCKED_BEDROCK_MODEL_PROVIDERS = [
  'anthropic',
  'cohere',
  'twelvelabs',
  'stability',
  'writer',
  'luma',
  'ai21',
] as const;

/**
 * OpenAI's own GPT models on Bedrock are sold by OpenAI (Marketplace); only the
 * open-weight gpt-oss models are sold by AWS, so those stay allowed.
 */
const BLOCKED_OPENAI_MODEL_PATTERNS = ['openai.gpt-5', 'openai.gpt-6'] as const;

/**
 * Resources of the `DenyNonAwsSoldModels` statement (core/bedrock-model-guard.ts),
 * which denies every Bedrock action on them, the way AWS stops the use of a
 * model (https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html):
 * - foundation models and (cross-Region / global) inference profiles of the
 *   blocked providers. Inference profiles also authorize the foundation models
 *   they route to, and the `*` Region also matches the Region-less model ARN of
 *   global profiles (IAM policy simulator, 2026-10-01), so profiles cannot get
 *   around it. Batch, evaluation, customization and Provisioned Throughput
 *   requests are authorized on the model ARN too.
 *   https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html
 *   https://docs.aws.amazon.com/bedrock/latest/userguide/batch-inference-permissions.html
 * - model resources that do not show their provider and that the app does not
 *   use: Bedrock Marketplace endpoints, prompt routers (AWS's default routers
 *   serve Anthropic models) and Provisioned Throughput.
 */
export const BLOCKED_BEDROCK_MODEL_RESOURCES: string[] =
  BLOCKED_BEDROCK_MODEL_PROVIDERS.flatMap((p) => [
    `arn:aws:bedrock:*::foundation-model/${p}.*`,
    `arn:aws:bedrock:*:*:inference-profile/*${p}.*`,
  ])
    .concat(
      BLOCKED_OPENAI_MODEL_PATTERNS.flatMap((m) => [
        `arn:aws:bedrock:*::foundation-model/${m}*`,
        `arn:aws:bedrock:*:*:inference-profile/*${m}*`,
      ]),
    )
    .concat([
      'arn:aws:bedrock:*:*:marketplace/model-endpoint/*',
      'arn:aws:bedrock:*:*:default-prompt-router/*',
      'arn:aws:bedrock:*:*:prompt-router/*',
      'arn:aws:bedrock:*:*:provisioned-model/*',
    ]);

/**
 * Model calls that IAM cannot limit to a model, and that the app does not use:
 * denied outright on every guarded role (statement `DenyUnscopedModelCalls`).
 * Service Authorization Reference, checked 2026-10-01:
 * https://docs.aws.amazon.com/service-authorization/latest/reference/list_bedrock.html
 * https://docs.aws.amazon.com/service-authorization/latest/reference/list_bedrock-mantle.html
 * - Bedrock API keys (bearer tokens) on both endpoints; AWS: "To fully prevent
 *   all API key-based access, you must deny both actions."
 *   https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-permissions.html
 * - The OpenAI-compatible bedrock-mantle endpoint (Responses, Chat Completions,
 *   Anthropic Messages): its inference (CreateInference), fine-tuning and
 *   capacity reservations authorize a project, not a model, and it serves
 *   Anthropic models and OpenAI's GPT models (GPT-5.5 only there).
 *   https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints.html
 *   https://docs.aws.amazon.com/bedrock/latest/userguide/models-endpoint-availability.html
 * - Agents, flows and knowledge bases: their own service role runs the model
 *   (Retrieve also runs the knowledge base's embedding and reranking models).
 * - No resource type at all: inline agents, RetrieveAndGenerate, agentic
 *   retrieval, GenerateQuery, prompt optimization, the conversational builder,
 *   and CreateMarketplaceModelEndpoint (deploys a Marketplace model).
 */
export const UNSCOPED_BEDROCK_MODEL_CALL_ACTIONS = [
  'bedrock:CallWithBearerToken',
  'bedrock-mantle:*',
  'bedrock:InvokeAgent',
  'bedrock:InvokeFlow',
  'bedrock:StartFlowExecution',
  'bedrock:Retrieve',
  'bedrock:RetrieveAndGenerate',
  'bedrock:AgenticRetrieveStream',
  'bedrock:InvokeInlineAgent',
  'bedrock:GenerateQuery',
  'bedrock:OptimizePrompt',
  'bedrock:InvokeBuilder',
  'bedrock:CreateMarketplaceModelEndpoint',
] as const;

/**
 * Actions that run a model, or buy model capacity: a role allowed any of them
 * (also through a wildcard) gets the AWS-sold-only guard. The Service
 * Authorization Reference maps every newer inference API onto them:
 * bedrock:InvokeModel authorizes Converse, InvokeModelWithBidirectionalStream
 * (Nova Sonic voice), StartAsyncInvoke and the OpenAI-compatible Chat
 * Completions and Responses APIs of bedrock-runtime; InvokeModelWithResponseStream
 * authorizes ConverseStream. Rerank also needs bedrock:InvokeModel on the
 * reranking model. CountTokens is left out: it runs no inference and is free.
 * https://docs.aws.amazon.com/bedrock/latest/userguide/inference-prereq.html
 * https://docs.aws.amazon.com/bedrock/latest/userguide/rerank-prereq.html
 * https://docs.aws.amazon.com/bedrock/latest/userguide/count-tokens.html
 */
export const BEDROCK_MODEL_CALL_ACTIONS = [
  'bedrock:InvokeModel',
  'bedrock:InvokeModelWithResponseStream',
  'bedrock:CreateModelInvocationJob',
  'bedrock:CreateEvaluationJob',
  'bedrock:CreateModelEvaluationJob',
  'bedrock:CreateAdvancedPromptOptimizationJob',
  'bedrock:CreateModelCustomizationJob',
  'bedrock:CreateProvisionedModelThroughput',
  'bedrock:Rerank',
  ...UNSCOPED_BEDROCK_MODEL_CALL_ACTIONS.filter((a) => !a.endsWith('*')),
  'bedrock-mantle:CreateInference',
  'bedrock-mantle:CreateFineTuningJob',
  'bedrock-mantle:CreateReservation',
  'bedrock-mantle:CallWithBearerToken',
] as const;

/**
 * Model of the backend's POST /projects/{id}/file-check/ask: Moonshot AI
 * Kimi K2.5 (AWS-sold), called in-Region in ap-south-1. In the Mumbai eval
 * (2026-10-02) it answered every grounded and not-in-file question right and
 * Hinglish in Hinglish; gpt-oss-120b misread a closing balance. Keep it equal
 * to the backend's config default and the web app's ASK_DEFAULT_MODEL_ID, and
 * priced in backend/app/file_check_ask.py.
 */
export const FILE_CHECK_ASK_MODEL_ID = 'moonshotai.kimi-k2.5';

/**
 * Model of the chat names the session worker generates
 * (lambda/session_workers/src/message_process/generate-session-name.ts, which
 * names it itself): Google Gemma 3 12B, in-Region. The worker may invoke only
 * this model (app/workers/message-process.ts).
 */
export const SESSION_NAME_MODEL_ID = 'google.gemma-3-12b-it';

/**
 * Model of the built-in voice chat (agents/bidi-agent/config.py
 * NOVA_SONIC_MODEL_ID): Amazon Nova 2 Sonic. Not offered in ap-south-1, so the
 * Mumbai build has no voice chat (region config voiceChatEnabled).
 */
export const VOICE_CHAT_MODEL_ID = 'amazon.nova-2-sonic-v1:0';

/** Geographic / global prefixes of cross-Region inference profile ids. */
const INFERENCE_PROFILE_PREFIX = /^(global|us|us-gov|eu|apac|jp|au|ca|in)\./;

/**
 * True when `modelId` is a cross-Region inference profile id (`global.`,
 * `apac.`, `in.`, ...): such a profile may serve a request in another Region.
 */
export function isCrossRegionInferenceProfile(modelId: string): boolean {
  return INFERENCE_PROFILE_PREFIX.test(modelId);
}

/**
 * Actions of the `DenyModelCallsOutsideRegion` statement
 * (core/bedrock-model-guard.ts): every InvokeModel action. bedrock:InvokeModel
 * also authorizes Converse, the bidirectional stream (voice), StartAsyncInvoke
 * and the OpenAI-compatible APIs of bedrock-runtime, and Rerank's call of the
 * reranking model; bedrock:InvokeModelWithResponseStream authorizes
 * ConverseStream.
 */
export const REGION_LOCKED_MODEL_CALL_ACTIONS = [
  'bedrock:InvokeModel*',
] as const;

/**
 * The only resources a model may be invoked on: the foundation models of the
 * deploy Region. `DenyModelCallsOutsideRegion` (NotResource) denies every
 * other one, so no request is served outside `region`: no global or
 * geographic (APAC, India, ...) inference profile, no application inference
 * profile, no model of another Region.
 */
export function inRegionFoundationModels(region: string): string {
  return `arn:aws:bedrock:${region}::foundation-model/*`;
}

/**
 * IAM resources to invoke `modelIds` in `region`: the in-Region foundation
 * model ARN of each model, never a wildcard (an empty id, a step a build has
 * no model for, is skipped). Everything runs in the deploy Region, so a
 * cross-Region inference profile id is an error here, and
 * DenyModelCallsOutsideRegion would deny its calls anyway.
 */
export function bedrockModelInvokeResources(
  modelIds: string | readonly string[],
  region: string,
): string[] {
  const ids = new Set(typeof modelIds === 'string' ? [modelIds] : modelIds);
  ids.delete('');
  return [...ids].map((modelId) => {
    if (isCrossRegionInferenceProfile(modelId)) {
      throw new Error(
        `Bedrock model ${modelId} is a cross-Region inference profile: ` +
          `every model call must stay in ${region} (use the in-Region model id).`,
      );
    }
    if (!/^[a-z0-9-]+\.[A-Za-z0-9.:_-]+$/.test(modelId)) {
      throw new Error(`Not a Bedrock model id: ${modelId}`);
    }
    return `arn:aws:bedrock:${region}::foundation-model/${modelId}`;
  });
}
