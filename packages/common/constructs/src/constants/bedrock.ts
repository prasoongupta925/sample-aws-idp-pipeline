/**
 * Bedrock model providers that are not sold by AWS (AWS Marketplace or
 * third-party billing). Invocations of their models are explicitly denied on
 * every role that can call Bedrock, so only AWS-sold models can be used.
 */
export const BLOCKED_BEDROCK_MODEL_PROVIDERS = [
  'anthropic',
  'cohere',
  'twelvelabs',
  'stability',
] as const;

/**
 * Resources for the `DenyNonAwsSoldModels` IAM statement: foundation models
 * and (cross-region / global) inference profiles of the blocked providers.
 *
 * Usage:
 *   new iam.PolicyStatement({
 *     sid: 'DenyNonAwsSoldModels',
 *     effect: iam.Effect.DENY,
 *     actions: [
 *       'bedrock:InvokeModel',
 *       'bedrock:InvokeModelWithResponseStream',
 *     ],
 *     resources: BLOCKED_BEDROCK_MODEL_RESOURCES,
 *   });
 */
export const BLOCKED_BEDROCK_MODEL_RESOURCES: string[] =
  BLOCKED_BEDROCK_MODEL_PROVIDERS.flatMap((p) => [
    `arn:aws:bedrock:*::foundation-model/${p}.*`,
    `arn:aws:bedrock:*:*:inference-profile/*${p}.*`,
  ]);

/**
 * Model of the backend's POST /projects/{id}/file-check/ask: Amazon Nova 2
 * Lite (AWS-sold) through its global cross-Region inference profile.
 */
export const FILE_CHECK_ASK_MODEL_ID = 'global.amazon.nova-2-lite-v1:0';

/** Geographic / global prefixes of cross-Region inference profile ids. */
const INFERENCE_PROFILE_PREFIX = /^(global|us|us-gov|eu|apac|jp|au|ca)\./;

/**
 * IAM resources to invoke `modelId` from `region` / `account`: the inference
 * profile (when the id is one) plus the foundation model in every Region the
 * profile may route to. A global profile routes to the Region-less ARN
 * `arn:aws:bedrock:::foundation-model/<model>`, listed explicitly.
 */
export function bedrockModelInvokeResources(
  modelId: string,
  region: string,
  account: string,
): string[] {
  const foundationModelId = modelId.replace(INFERENCE_PROFILE_PREFIX, '');
  const foundationModels = [
    `arn:aws:bedrock:*::foundation-model/${foundationModelId}`,
    `arn:aws:bedrock:::foundation-model/${foundationModelId}`,
  ];
  if (foundationModelId === modelId) {
    return foundationModels;
  }
  return [
    `arn:aws:bedrock:${region}:${account}:inference-profile/${modelId}`,
    ...foundationModels,
  ];
}
