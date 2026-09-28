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
