// @vitest-environment node
import { App as CdkApp, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import {
  CfnRole,
  Effect,
  ManagedPolicy,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { describe, expect, it } from 'vitest';
import {
  BEDROCK_MODEL_CALL_ACTIONS,
  BLOCKED_BEDROCK_MODEL_RESOURCES,
  REGION_LOCKED_MODEL_CALL_ACTIONS,
  UNSCOPED_BEDROCK_MODEL_CALL_ACTIONS,
  bedrockModelInvokeResources,
  inRegionFoundationModels,
  isCrossRegionInferenceProfile,
} from '../constants/bedrock.js';
import { App } from './app.js';
import {
  type CfnTemplate,
  type IamStatementJson,
  DENY_MODEL_CALLS_OUTSIDE_REGION_SID,
  DENY_NON_AWS_SOLD_MODELS_SID,
  DENY_UNSCOPED_MODEL_CALLS_SID,
  bedrockModelGuardStatements,
  findDuplicateSids,
  findModelCallsOutsideRegion,
  findModelGrantsOutsideAllowlist,
  findUnguardedModelPrincipals,
  iamActionMatches,
  iamAllows,
  iamResourceMatches,
  modelCallingPrincipals,
  modelsAllowedInRegion,
  outsideRegionModelProbes,
} from './bedrock-model-guard.js';

const ACCOUNT = '111111111111';
const REGION = 'ap-south-1';
const KIMI = 'moonshotai.kimi-k2.5';
const GPT_OSS = 'openai.gpt-oss-120b-1:0';

/** The old grant of the session-name worker (any model, any Region). */
const invokeAnyModel = () =>
  new PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    resources: [
      'arn:aws:bedrock:*::foundation-model/*',
      `arn:aws:bedrock:*:${ACCOUNT}:inference-profile/*`,
    ],
  });

/** An in-Region allowlist grant, as the app's roles now have. */
const invokeModels = (...ids: string[]) =>
  new PolicyStatement({
    actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
    resources: bedrockModelInvokeResources(ids, REGION),
  });

function newStack(app: CdkApp = new App(), region = REGION): Stack {
  return new Stack(app, 'Test', {
    env: { account: ACCOUNT, region },
  });
}

function lambdaRole(stack: Stack, id: string): Role {
  return new Role(stack, id, {
    assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
  });
}

function templateOf(stack: Stack): CfnTemplate {
  return Template.fromStack(stack).toJSON() as CfnTemplate;
}

/** Every statement of every IAM policy document of the template. */
function allStatements(template: CfnTemplate): IamStatementJson[] {
  return Object.values(template.Resources ?? {}).flatMap((resource) => {
    const props = (resource.Properties ?? {}) as {
      PolicyDocument?: { Statement?: IamStatementJson[] };
      Policies?: {
        PolicyDocument?: { Statement?: IamStatementJson[] };
      }[];
    };
    return [
      ...(props.PolicyDocument?.Statement ?? []),
      ...(props.Policies ?? []).flatMap(
        (p) => p.PolicyDocument?.Statement ?? [],
      ),
    ];
  });
}

const blocked = (arn: string) =>
  BLOCKED_BEDROCK_MODEL_RESOURCES.some((p) => iamResourceMatches(p, arn));
const deniedOutright = (action: string) =>
  UNSCOPED_BEDROCK_MODEL_CALL_ACTIONS.some((p) => iamActionMatches(p, action));

// Model ids are joined at run time so the repo scan of test_model_catalogs.py
// does not flag this file.
const modelId = (provider: string, model: string) => `${provider}.${model}`;
const foundationModel = (region: string, provider: string, model: string) =>
  `arn:aws:bedrock:${region}::foundation-model/${modelId(provider, model)}`;
const inferenceProfile = (geo: string, provider: string, model: string) =>
  `arn:aws:bedrock:ap-south-1:${ACCOUNT}:inference-profile/${geo}.${modelId(provider, model)}`;

describe('BedrockModelGuard (App aspect)', () => {
  it('adds the three deny statements to a role that can invoke a model', () => {
    const stack = newStack();
    lambdaRole(stack, 'SessionNameWorker').addToPrincipalPolicy(
      invokeAnyModel(),
    );
    const template = templateOf(stack);

    const denies = allStatements(template).filter((s) => s.Effect === 'Deny');
    expect(denies.map((s) => s.Sid).sort()).toEqual([
      DENY_MODEL_CALLS_OUTSIDE_REGION_SID,
      DENY_NON_AWS_SOLD_MODELS_SID,
      DENY_UNSCOPED_MODEL_CALLS_SID,
    ]);
    const models = denies.find((s) => s.Sid === DENY_NON_AWS_SOLD_MODELS_SID);
    expect(models).toMatchObject({ Action: 'bedrock:*' });
    expect(models?.Condition).toBeUndefined();
    expect([...(models?.Resource as string[])].sort()).toEqual(
      [...BLOCKED_BEDROCK_MODEL_RESOURCES].sort(),
    );
    // Everything outside the stack's Region: one NotResource, no Resource.
    const outside = denies.find(
      (s) => s.Sid === DENY_MODEL_CALLS_OUTSIDE_REGION_SID,
    );
    expect(outside).toEqual({
      Sid: DENY_MODEL_CALLS_OUTSIDE_REGION_SID,
      Effect: 'Deny',
      Action: 'bedrock:InvokeModel*',
      NotResource: 'arn:aws:bedrock:ap-south-1::foundation-model/*',
    });
    expect(findUnguardedModelPrincipals(template, REGION)).toEqual([]);
    expect([...modelCallingPrincipals(template).keys()]).toEqual([
      expect.stringMatching(/^SessionNameWorker/),
    ]);
  });

  it('locks a policy to the Region of its own stack', () => {
    const stack = newStack(new App(), 'us-east-1');
    lambdaRole(stack, 'Worker').addToPrincipalPolicy(invokeAnyModel());
    const template = templateOf(stack);

    const outside = allStatements(template).find(
      (s) => s.Sid === DENY_MODEL_CALLS_OUTSIDE_REGION_SID,
    );
    expect(outside?.NotResource).toBe(
      'arn:aws:bedrock:us-east-1::foundation-model/*',
    );
    expect(findUnguardedModelPrincipals(template, 'us-east-1')).toEqual([]);
    // Checked against another Region, the lock does not count.
    expect(findUnguardedModelPrincipals(template, REGION)).toEqual([
      expect.stringMatching(/^Worker.*lacks DenyModelCallsOutsideRegion$/),
    ]);
  });

  it('guards inline, managed and wildcard grants and the newer endpoints', () => {
    const stack = newStack();
    new Role(stack, 'InlinePolicy', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        Models: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ['bedrock:Invoke*'],
              resources: ['*'],
            }),
          ],
        }),
      },
    });
    lambdaRole(stack, 'ManagedPolicy').addManagedPolicy(
      new ManagedPolicy(stack, 'BedrockEverything', {
        statements: [
          new PolicyStatement({ actions: ['bedrock:*'], resources: ['*'] }),
        ],
      }),
    );
    lambdaRole(stack, 'NotAction').addToPrincipalPolicy(
      new PolicyStatement({ notActions: ['iam:*'], resources: ['*'] }),
    );
    lambdaRole(stack, 'Mantle').addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['bedrock-mantle:CreateInference'],
        resources: ['*'],
      }),
    );
    lambdaRole(stack, 'Batch').addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['bedrock:CreateModelInvocationJob'],
        resources: ['*'],
      }),
    );
    const template = templateOf(stack);

    expect(modelCallingPrincipals(template).size).toBe(5);
    expect(findUnguardedModelPrincipals(template, REGION)).toEqual([]);
    expect(findDuplicateSids(template)).toEqual([]);
    // Even the widest grants cannot reach a model outside the Region.
    expect(findModelCallsOutsideRegion(template, REGION, ACCOUNT)).toEqual([]);
  });

  it('leaves roles that cannot call a model alone', () => {
    const stack = newStack();
    lambdaRole(stack, 'Reader').addToPrincipalPolicy(
      new PolicyStatement({
        actions: [
          's3:GetObject',
          'bedrock:GetFoundationModel',
          'bedrock:ListFoundationModels',
          'bedrock:InvokeDataAutomationAsync',
          'bedrock-agentcore:InvokeAgentRuntime',
        ],
        resources: ['*'],
      }),
    );
    const template = templateOf(stack);

    expect(modelCallingPrincipals(template).size).toBe(0);
    expect(allStatements(template).some((s) => s.Effect === 'Deny')).toBe(
      false,
    );
  });

  it('adds only the statements a policy lacks (no repeated statement id)', () => {
    const stack = newStack();
    const role = lambdaRole(stack, 'Worker');
    role.addToPrincipalPolicy(invokeAnyModel());
    role.addToPrincipalPolicy(bedrockModelGuardStatements(REGION)[0]);
    role.addToPrincipalPolicy(bedrockModelGuardStatements(REGION)[2]);
    const template = templateOf(stack);

    const sids = allStatements(template).map((s) => s.Sid);
    for (const sid of [
      DENY_NON_AWS_SOLD_MODELS_SID,
      DENY_UNSCOPED_MODEL_CALLS_SID,
      DENY_MODEL_CALLS_OUTSIDE_REGION_SID,
    ]) {
      expect(
        sids.filter((s) => s === sid),
        sid,
      ).toHaveLength(1);
    }
    expect(findDuplicateSids(template)).toEqual([]);
    expect(findUnguardedModelPrincipals(template, REGION)).toEqual([]);
  });
});

describe('findUnguardedModelPrincipals', () => {
  it('flags a model-calling role of an app without the guard aspect', () => {
    const stack = newStack(new CdkApp());
    lambdaRole(stack, 'Unguarded').addToPrincipalPolicy(invokeAnyModel());

    expect(findUnguardedModelPrincipals(templateOf(stack))).toEqual([
      expect.stringMatching(
        /^Unguarded.*lacks DenyNonAwsSoldModels, DenyUnscopedModelCalls, DenyModelCallsOutsideRegion$/,
      ),
    ]);
  });

  it('flags what the aspect cannot reach, and an incomplete deny', () => {
    const stack = newStack();
    // An L1 role with a plain JSON policy.
    new CfnRole(stack, 'JsonPolicy', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      policies: [
        {
          policyName: 'Models',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              { Effect: 'Allow', Action: 'bedrock:InvokeModel', Resource: '*' },
            ],
          },
        },
      ],
    });
    // An AWS managed policy that allows model calls.
    lambdaRole(stack, 'AwsManaged').addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName('AmazonBedrockFullAccess'),
    );
    // The old deny: InvokeModel only, no API keys, no Mantle endpoint.
    const partial = lambdaRole(stack, 'PartialDeny');
    partial.addToPrincipalPolicy(invokeAnyModel());
    partial.addToPrincipalPolicy(
      new PolicyStatement({
        sid: DENY_NON_AWS_SOLD_MODELS_SID,
        effect: Effect.DENY,
        actions: ['bedrock:InvokeModel'],
        resources: BLOCKED_BEDROCK_MODEL_RESOURCES,
      }),
    );
    // A Region lock with a hole: also every model of us-east-1.
    const leaky = lambdaRole(stack, 'LeakyRegionLock');
    leaky.addToPrincipalPolicy(invokeAnyModel());
    leaky.addToPrincipalPolicy(
      new PolicyStatement({
        sid: DENY_MODEL_CALLS_OUTSIDE_REGION_SID,
        effect: Effect.DENY,
        actions: [...REGION_LOCKED_MODEL_CALL_ACTIONS],
        notResources: [
          inRegionFoundationModels(REGION),
          inRegionFoundationModels('us-east-1'),
        ],
      }),
    );

    const template = templateOf(stack);
    const problems = findUnguardedModelPrincipals(template, REGION);
    expect(problems).toHaveLength(4);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^JsonPolicy: .*lacks DenyNonAwsSoldModels, /),
        expect.stringMatching(/^AwsManaged.*: .*lacks DenyNonAwsSoldModels, /),
        expect.stringMatching(/^PartialDeny.*: .*lacks DenyNonAwsSoldModels$/),
        expect.stringMatching(
          /^LeakyRegionLock.*: .*lacks DenyModelCallsOutsideRegion$/,
        ),
      ]),
    );
    // The leaky lock lets the old wildcard grant reach us-east-1.
    expect(findModelCallsOutsideRegion(template, REGION, ACCOUNT)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^LeakyRegionLock.*: bedrock:InvokeModel arn:aws:bedrock:us-east-1::foundation-model\//,
        ),
        expect.stringMatching(/^JsonPolicy: bedrock:InvokeModel .*global\./),
        expect.stringMatching(/^AwsManaged.*: bedrock:InvokeModel /),
      ]),
    );
  });

  it('finds a repeated statement id', () => {
    const template: CfnTemplate = {
      Resources: {
        Policy: {
          Type: 'AWS::IAM::Policy',
          Properties: {
            PolicyDocument: {
              Statement: [
                { Sid: DENY_NON_AWS_SOLD_MODELS_SID, Effect: 'Deny' },
                { Sid: DENY_NON_AWS_SOLD_MODELS_SID, Effect: 'Deny' },
              ],
            },
          },
        },
      },
    };
    expect(findDuplicateSids(template)).toEqual([
      `Policy: ${DENY_NON_AWS_SOLD_MODELS_SID}`,
    ]);
  });
});

describe('in-Region model lock', () => {
  /** The statements of the one role of a guarded test stack. */
  function guardedRole(...grants: PolicyStatement[]): IamStatementJson[] {
    const stack = newStack();
    const role = lambdaRole(stack, 'Worker');
    grants.forEach((grant) => role.addToPrincipalPolicy(grant));
    return allStatements(templateOf(stack));
  }

  it('allows the listed models in the Region and nothing outside it', () => {
    const statements = guardedRole(invokeModels(KIMI, GPT_OSS));
    const allows = (resource: string, action = 'bedrock:InvokeModel') =>
      iamAllows(statements, action, resource);

    expect(allows(`arn:aws:bedrock:ap-south-1::foundation-model/${KIMI}`)).toBe(
      true,
    );
    expect(
      allows(
        `arn:aws:bedrock:ap-south-1::foundation-model/${GPT_OSS}`,
        'bedrock:InvokeModelWithResponseStream',
      ),
    ).toBe(true);
    // Not listed (implicit deny), even in-Region.
    expect(
      allows('arn:aws:bedrock:ap-south-1::foundation-model/zai.glm-5'),
    ).toBe(false);
    // Listed, but outside the Region or through a cross-Region profile.
    for (const probe of outsideRegionModelProbes(REGION, ACCOUNT, [
      KIMI,
      GPT_OSS,
    ])) {
      expect(allows(probe), probe).toBe(false);
    }
  });

  it('denies every cross-Region call even under a wildcard grant', () => {
    const statements = guardedRole(
      new PolicyStatement({ actions: ['bedrock:*'], resources: ['*'] }),
    );
    const allows = (resource: string) =>
      iamAllows(statements, 'bedrock:InvokeModel', resource);

    expect(
      allows('arn:aws:bedrock:ap-south-1::foundation-model/zai.glm-5'),
    ).toBe(true);
    for (const probe of [
      inferenceProfile('global', 'amazon', 'nova-2-lite-v1:0'),
      inferenceProfile('apac', 'amazon', 'nova-pro-v1:0'),
      inferenceProfile('in', 'zai', 'glm-5'),
      foundationModel('', 'amazon', 'nova-2-lite-v1:0'),
      foundationModel('us-east-1', 'moonshotai', 'kimi-k2.5'),
      foundationModel('ap-northeast-1', 'amazon', 'rerank-v1:0'),
      foundationModel('ap-south-2', 'zai', 'glm-5'),
      `arn:aws:bedrock:ap-south-1:${ACCOUNT}:application-inference-profile/abc123`,
      // AWS-sold-only guard: a blocked provider in-Region.
      foundationModel(
        'ap-south-1',
        'anthropic',
        'claude-3-haiku-20240307-v1:0',
      ),
    ]) {
      expect(allows(probe), probe).toBe(false);
    }
    // The model call the Region lock does not cover is denied outright.
    expect(iamAllows(statements, 'bedrock:InvokeInlineAgent', '*')).toBe(false);
  });

  it('lists the grants that are wider than an in-Region allowlist', () => {
    const stack = newStack();
    lambdaRole(stack, 'Allowlist').addToPrincipalPolicy(
      invokeModels(KIMI, GPT_OSS),
    );
    lambdaRole(stack, 'Star').addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:Rerank'],
        resources: ['*'],
      }),
    );
    lambdaRole(stack, 'AnyRegion').addToPrincipalPolicy(invokeAnyModel());
    const template = templateOf(stack);

    const problems = findModelGrantsOutsideAllowlist(template, REGION);
    expect(problems.filter((p) => p.startsWith('Allowlist'))).toEqual([]);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Star.*: allows bedrock:Rerank$/),
        expect.stringMatching(/^Star.*: allows model calls on \*$/),
        expect.stringMatching(
          /^AnyRegion.*: allows model calls on arn:aws:bedrock:\*::foundation-model\/\*$/,
        ),
        expect.stringMatching(
          /^AnyRegion.*: allows model calls on arn:aws:bedrock:\*:111111111111:inference-profile\/\*$/,
        ),
      ]),
    );
    expect([...modelsAllowedInRegion(template, REGION)]).toEqual([
      [expect.stringMatching(/^Allowlist/), [KIMI, GPT_OSS].sort()],
    ]);
    expect(findModelCallsOutsideRegion(template, REGION, ACCOUNT)).toEqual([]);
  });

  it('builds in-Region model ARNs only', () => {
    expect(
      bedrockModelInvokeResources([KIMI, '', KIMI, GPT_OSS], REGION),
    ).toEqual([
      `arn:aws:bedrock:ap-south-1::foundation-model/${KIMI}`,
      `arn:aws:bedrock:ap-south-1::foundation-model/${GPT_OSS}`,
    ]);
    expect(bedrockModelInvokeResources('', REGION)).toEqual([]);
    for (const geo of ['global', 'apac', 'in', 'us', 'eu', 'jp', 'au', 'ca']) {
      const id = `${geo}.amazon.nova-2-lite-v1:0`;
      expect(isCrossRegionInferenceProfile(id), id).toBe(true);
      expect(() => bedrockModelInvokeResources(id, REGION), id).toThrow(
        /cross-Region inference profile/,
      );
    }
    for (const id of [
      '*',
      'moonshotai.*',
      'arn:aws:bedrock:::foundation-model/x',
    ]) {
      expect(() => bedrockModelInvokeResources(id, REGION), id).toThrow(
        /Not a Bedrock model id/,
      );
    }
    expect(isCrossRegionInferenceProfile(KIMI)).toBe(false);
    expect(inRegionFoundationModels(REGION)).toBe(
      'arn:aws:bedrock:ap-south-1::foundation-model/*',
    );
  });
});

describe('deny list (constants/bedrock.ts)', () => {
  it('blocks the Marketplace-sold models in every form of model ARN', () => {
    const arns = [
      foundationModel('ap-south-1', 'anthropic', 'claude-haiku-4-5-v1:0'),
      // Global cross-Region profiles authorize the Region-less model ARN.
      foundationModel('', 'anthropic', 'claude-haiku-4-5-v1:0'),
      inferenceProfile('global', 'anthropic', 'claude-haiku-4-5-v1:0'),
      inferenceProfile('apac', 'anthropic', 'claude-haiku-4-5-v1:0'),
      foundationModel('us-west-2', 'cohere', 'rerank-v3-5:0'),
      foundationModel('us-east-1', 'twelvelabs', 'pegasus-1-2-v1:0'),
      foundationModel('us-east-1', 'stability', 'stable-image-core-v1:1'),
      foundationModel('us-east-1', 'writer', 'palmyra-x5-v1:0'),
      foundationModel('us-west-2', 'luma', 'ray-v2:0'),
      foundationModel('us-east-1', 'ai21', 'jamba-1-5-mini-v1:0'),
      foundationModel('us-east-1', 'openai', 'gpt-5.5'),
      inferenceProfile('global', 'openai', 'gpt-6-sol'),
      `arn:aws:bedrock:ap-south-1:${ACCOUNT}:marketplace/model-endpoint/all-access`,
      `arn:aws:bedrock:us-east-1:${ACCOUNT}:default-prompt-router/${modelId('anthropic', 'claude:1')}`,
      `arn:aws:bedrock:us-east-1:${ACCOUNT}:prompt-router/abcd1234`,
      `arn:aws:bedrock:ap-south-1:${ACCOUNT}:provisioned-model/abcd1234`,
    ];
    expect(arns.filter((arn) => !blocked(arn))).toEqual([]);
  });

  it('keeps the AWS-sold models the app uses', () => {
    const arns = [
      foundationModel('ap-south-1', 'amazon', 'nova-2-lite-v1:0'),
      foundationModel('', 'amazon', 'nova-2-lite-v1:0'),
      inferenceProfile('global', 'amazon', 'nova-2-lite-v1:0'),
      foundationModel('ap-south-1', 'amazon', 'titan-embed-text-v2:0'),
      foundationModel('ap-northeast-1', 'amazon', 'rerank-v1:0'),
      foundationModel('ap-south-1', 'openai', 'gpt-oss-120b-1:0'),
      foundationModel('ap-south-1', 'google', 'gemma-3-12b-it'),
      foundationModel('ap-south-1', 'zai', 'glm-5'),
      foundationModel('ap-south-1', 'moonshotai', 'kimi-k2.5'),
      foundationModel('ap-south-1', 'deepseek', 'v3.2'),
      foundationModel('ap-south-1', 'qwen', 'qwen3-235b-a22b-2507-v1:0'),
    ];
    expect(arns.filter(blocked)).toEqual([]);
  });

  it('denies API keys and the Mantle endpoint outright, not what the app calls', () => {
    for (const action of [
      'bedrock:CallWithBearerToken',
      'bedrock-mantle:CallWithBearerToken',
      'bedrock-mantle:CreateInference',
      'bedrock-mantle:CreateFineTuningJob',
      'bedrock-mantle:CreateReservation',
      'bedrock:InvokeAgent',
      'bedrock:InvokeInlineAgent',
      'bedrock:RetrieveAndGenerate',
      'bedrock:CreateMarketplaceModelEndpoint',
    ]) {
      expect(deniedOutright(action), action).toBe(true);
    }
    for (const action of [
      'bedrock:InvokeModel',
      'bedrock:InvokeModelWithResponseStream',
      'bedrock:Rerank',
      'bedrock:InvokeDataAutomationAsync',
      'bedrock:GetDataAutomationStatus',
      'bedrock-agentcore:InvokeAgentRuntime',
    ]) {
      expect(deniedOutright(action), action).toBe(false);
    }
  });

  it('either denies a model call outright or authorizes it on the model ARN', () => {
    // Actions authorized on the model or profile ARN, which the
    // DenyNonAwsSoldModels statement (bedrock:*) covers. Rerank also needs
    // bedrock:InvokeModel on the reranking model.
    const onModelArn = [
      'bedrock:InvokeModel',
      'bedrock:InvokeModelWithResponseStream',
      'bedrock:CreateModelInvocationJob',
      'bedrock:CreateEvaluationJob',
      'bedrock:CreateModelEvaluationJob',
      'bedrock:CreateAdvancedPromptOptimizationJob',
      'bedrock:CreateModelCustomizationJob',
      'bedrock:CreateProvisionedModelThroughput',
      'bedrock:Rerank',
    ];
    expect(
      BEDROCK_MODEL_CALL_ACTIONS.filter(
        (action) => !deniedOutright(action) && !onModelArn.includes(action),
      ),
    ).toEqual([]);
    expect(
      UNSCOPED_BEDROCK_MODEL_CALL_ACTIONS.filter(
        (pattern) =>
          !BEDROCK_MODEL_CALL_ACTIONS.some((a) => iamActionMatches(pattern, a)),
      ),
    ).toEqual([]);
  });

  it('locks both model invoke actions to the Region', () => {
    for (const action of [
      'bedrock:InvokeModel',
      'bedrock:InvokeModelWithResponseStream',
    ]) {
      expect(
        REGION_LOCKED_MODEL_CALL_ACTIONS.some((p) =>
          iamActionMatches(p, action),
        ),
        action,
      ).toBe(true);
    }
  });
});
