import { IAspect, Stack } from 'aws-cdk-lib';
import {
  CfnRole,
  Effect,
  ManagedPolicy,
  Policy,
  PolicyDocument,
  PolicyStatement,
} from 'aws-cdk-lib/aws-iam';
import { IConstruct } from 'constructs';
import {
  BEDROCK_MODEL_CALL_ACTIONS,
  BLOCKED_BEDROCK_MODEL_RESOURCES,
  REGION_LOCKED_MODEL_CALL_ACTIONS,
  UNSCOPED_BEDROCK_MODEL_CALL_ACTIONS,
  inRegionFoundationModels,
} from '../constants/bedrock.js';

/** Sid of the deny on the models of the non-AWS-sold providers. */
export const DENY_NON_AWS_SOLD_MODELS_SID = 'DenyNonAwsSoldModels';

/** Sid of the deny on the model calls that IAM cannot limit to a model. */
export const DENY_UNSCOPED_MODEL_CALLS_SID = 'DenyUnscopedModelCalls';

/** Sid of the deny on every model call outside the deploy Region. */
export const DENY_MODEL_CALLS_OUTSIDE_REGION_SID =
  'DenyModelCallsOutsideRegion';

/**
 * The model guard (constants/bedrock.ts) of a policy in `region`:
 * - DenyNonAwsSoldModels: every Bedrock action on the models of the blocked
 *   providers (AWS-sold models only: AWS credits pay every bill);
 * - DenyUnscopedModelCalls: outright, the model calls that IAM cannot limit
 *   to a model;
 * - DenyModelCallsOutsideRegion: every InvokeModel action on anything but a
 *   foundation model of `region` (everything runs in the deploy Region: no
 *   global or geographic inference profile, no model of another Region).
 * The App adds them to every policy that allows a model call
 * (BedrockModelGuard below).
 */
export function bedrockModelGuardStatements(region: string): PolicyStatement[] {
  return [
    new PolicyStatement({
      sid: DENY_NON_AWS_SOLD_MODELS_SID,
      effect: Effect.DENY,
      actions: ['bedrock:*'],
      resources: BLOCKED_BEDROCK_MODEL_RESOURCES,
    }),
    new PolicyStatement({
      sid: DENY_UNSCOPED_MODEL_CALLS_SID,
      effect: Effect.DENY,
      actions: [...UNSCOPED_BEDROCK_MODEL_CALL_ACTIONS],
      resources: ['*'],
    }),
    new PolicyStatement({
      sid: DENY_MODEL_CALLS_OUTSIDE_REGION_SID,
      effect: Effect.DENY,
      actions: [...REGION_LOCKED_MODEL_CALL_ACTIONS],
      notResources: [inRegionFoundationModels(region)],
    }),
  ];
}

/** A statement of an IAM policy document in its JSON form. */
export interface IamStatementJson {
  readonly Sid?: string;
  readonly Effect?: string;
  readonly Action?: unknown;
  readonly NotAction?: unknown;
  readonly Resource?: unknown;
  readonly NotResource?: unknown;
  readonly Condition?: unknown;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

/** The plain strings of a policy field; CloudFormation functions are dropped. */
function strings(value: unknown): string[] {
  return asArray(value).filter((v): v is string => typeof v === 'string');
}

function statementsOf(document: unknown): IamStatementJson[] {
  if (typeof document !== 'object' || document === null) {
    return [];
  }
  return asArray((document as { Statement?: unknown }).Statement).filter(
    (s): s is IamStatementJson => typeof s === 'object' && s !== null,
  );
}

function wildcardRegex(pattern: string, flags: string): RegExp {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regex}$`, flags);
}

/** IAM action matching: case-insensitive, with `*` and `?` wildcards. */
export function iamActionMatches(pattern: string, action: string): boolean {
  return wildcardRegex(pattern, 'i').test(action);
}

/** IAM resource ARN matching: case-sensitive, `*` any characters, `?` one. */
export function iamResourceMatches(pattern: string, arn: string): boolean {
  return wildcardRegex(pattern, '').test(arn);
}

/** The model-call actions (BEDROCK_MODEL_CALL_ACTIONS) a statement covers. */
function modelCallsOf(statement: IamStatementJson): string[] {
  const actions = strings(statement.Action);
  const notActions = strings(statement.NotAction);
  return BEDROCK_MODEL_CALL_ACTIONS.filter((call) =>
    statement.NotAction !== undefined
      ? !notActions.some((pattern) => iamActionMatches(pattern, call))
      : actions.some((pattern) => iamActionMatches(pattern, call)),
  );
}

/** True when an Allow statement covers a Bedrock model call (wildcards too). */
export function allowsBedrockModelCalls(
  statements: readonly IamStatementJson[],
): boolean {
  return statements.some(
    (statement) =>
      statement.Effect === 'Allow' && modelCallsOf(statement).length > 0,
  );
}

/** Adds the guard statements `document` lacks, when it allows a model call. */
function guardDocument(document: PolicyDocument, region: string): void {
  const statements = statementsOf(document.toJSON());
  if (!allowsBedrockModelCalls(statements)) {
    return;
  }
  const sids = new Set(statements.map((statement) => statement.Sid));
  document.addStatements(
    ...bedrockModelGuardStatements(region).filter((s) => !sids.has(s.sid)),
  );
}

/**
 * Adds the model guard to every IAM policy that allows a Bedrock model call:
 * role default policies (addToRolePolicy, grants), attached and managed
 * policies, and inline role policies, with the Region of the policy's stack.
 * App (core/app.ts) applies it to the whole app, so a new role cannot be
 * deployed without the denies; the template checks below
 * (findUnguardedModelPrincipals, findModelGrantsOutsideAllowlist,
 * findModelCallsOutsideRegion) catch what an aspect cannot reach, such as L1
 * roles with plain JSON policies or AWS managed policies, and grants that are
 * wider than the in-Region allowlist of a role.
 */
export class BedrockModelGuard implements IAspect {
  public visit(node: IConstruct): void {
    if (node instanceof Policy || node instanceof ManagedPolicy) {
      guardDocument(node.document, Stack.of(node).region);
    } else if (node instanceof CfnRole && Array.isArray(node.policies)) {
      for (const policy of node.policies) {
        const document = (policy as CfnRole.PolicyProperty).policyDocument;
        if (document instanceof PolicyDocument) {
          guardDocument(document, Stack.of(node).region);
        }
      }
    }
  }
}

/**
 * AWS managed policies that allow Bedrock model calls. The guard cannot be
 * added to them: a principal with one needs the deny in a policy of its own.
 */
const MODEL_CALLING_MANAGED_POLICIES = [
  'AdministratorAccess',
  'PowerUserAccess',
  'AmazonBedrockFullAccess',
  'AmazonBedrockLimitedAccess',
  'AmazonBedrockMarketplaceAccess',
  'AmazonBedrockMantleFullAccess',
  'AmazonBedrockMantleInferenceAccess',
];

/** A resource of a synthesized CloudFormation template. */
export interface TemplateResource {
  readonly Type?: string;
  readonly Properties?: Record<string, unknown>;
}

/** A synthesized CloudFormation template. */
export interface CfnTemplate {
  readonly Resources?: Record<string, TemplateResource>;
}

/** Logical id of a `{ Ref }`, else undefined. */
function refOf(value: unknown): string | undefined {
  const ref =
    typeof value === 'object' && value !== null
      ? (value as { Ref?: unknown }).Ref
      : undefined;
  return typeof ref === 'string' ? ref : undefined;
}

/** NotResource of the Region lock: one foundation-model wildcard of a Region. */
const REGION_LOCK_RESOURCE =
  /^arn:aws:bedrock:[a-z]{2}(-[a-z]+)+-\d+::foundation-model\/\*$/;

/**
 * Guard statements that are missing or incomplete in `statements`; with
 * `region`, the Region lock must name that Region.
 */
function missingGuard(
  statements: readonly IamStatementJson[],
  region?: string,
): string[] {
  const deny = (sid: string) =>
    statements.find(
      (s) => s.Effect === 'Deny' && s.Sid === sid && s.Condition === undefined,
    );
  const scoped = deny(DENY_NON_AWS_SOLD_MODELS_SID);
  const unscoped = deny(DENY_UNSCOPED_MODEL_CALLS_SID);
  const outside = deny(DENY_MODEL_CALLS_OUTSIDE_REGION_SID);
  const missing: string[] = [];
  if (
    !scoped ||
    !strings(scoped.Action).includes('bedrock:*') ||
    BLOCKED_BEDROCK_MODEL_RESOURCES.some(
      (arn) => !strings(scoped.Resource).includes(arn),
    )
  ) {
    missing.push(DENY_NON_AWS_SOLD_MODELS_SID);
  }
  if (
    !unscoped ||
    !strings(unscoped.Resource).includes('*') ||
    UNSCOPED_BEDROCK_MODEL_CALL_ACTIONS.some(
      (action) => !strings(unscoped.Action).includes(action),
    )
  ) {
    missing.push(DENY_UNSCOPED_MODEL_CALLS_SID);
  }
  const notResources = asArray(outside?.NotResource);
  if (
    !outside ||
    outside.Resource !== undefined ||
    REGION_LOCKED_MODEL_CALL_ACTIONS.some(
      (action) => !strings(outside.Action).includes(action),
    ) ||
    notResources.length !== 1 ||
    typeof notResources[0] !== 'string' ||
    !(region
      ? notResources[0] === inRegionFoundationModels(region)
      : REGION_LOCK_RESOURCE.test(notResources[0]))
  ) {
    missing.push(DENY_MODEL_CALLS_OUTSIDE_REGION_SID);
  }
  return missing;
}

/** The identity-policy statements of a template's principals. */
interface PrincipalPolicies {
  /** Statements per principal (logical id, or the JSON of an outside one). */
  readonly statements: Map<string, IamStatementJson[]>;
  /** Principals with an AWS managed policy that allows model calls. */
  readonly awsManaged: Set<string>;
}

/**
 * Reads inline policies, AWS::IAM::Policy and AWS::IAM::ManagedPolicy
 * attachments, and model-calling AWS managed policies of every principal
 * (role, user, group) of a template.
 */
function principalPolicies(template: CfnTemplate): PrincipalPolicies {
  const resources = template.Resources ?? {};
  const statements = new Map<string, IamStatementJson[]>();
  const awsManaged = new Set<string>();
  const add = (key: string, more: IamStatementJson[]) =>
    statements.set(key, [...(statements.get(key) ?? []), ...more]);

  for (const [logicalId, resource] of Object.entries(resources)) {
    const props = resource.Properties ?? {};
    switch (resource.Type) {
      case 'AWS::IAM::Role':
      case 'AWS::IAM::User':
      case 'AWS::IAM::Group':
        add(logicalId, []);
        for (const policy of asArray(props.Policies)) {
          add(
            logicalId,
            statementsOf(
              (policy as { PolicyDocument?: unknown }).PolicyDocument,
            ),
          );
        }
        for (const arn of asArray(props.ManagedPolicyArns)) {
          // A managed policy of this template, attached by the principal.
          const ref = refOf(arn);
          if (ref && resources[ref]?.Type === 'AWS::IAM::ManagedPolicy') {
            add(
              logicalId,
              statementsOf(resources[ref].Properties?.PolicyDocument),
            );
          } else if (
            MODEL_CALLING_MANAGED_POLICIES.some((name) =>
              JSON.stringify(arn).includes(`:policy/${name}"`),
            )
          ) {
            awsManaged.add(logicalId);
          }
        }
        break;
      case 'AWS::IAM::Policy':
      case 'AWS::IAM::ManagedPolicy':
        for (const target of [
          ...asArray(props.Roles),
          ...asArray(props.Users),
          ...asArray(props.Groups),
        ]) {
          add(
            refOf(target) ?? JSON.stringify(target),
            statementsOf(props.PolicyDocument),
          );
        }
        break;
    }
  }
  return { statements, awsManaged };
}

/**
 * Principals (roles, users, groups) of a synthesized CloudFormation template
 * that can call a Bedrock model, by logical id (or the JSON of a principal
 * from outside the template), with the guard statements each one lacks
 * (with `region`, the Region lock must name that Region).
 */
export function modelCallingPrincipals(
  template: CfnTemplate,
  region?: string,
): Map<string, string[]> {
  const { statements, awsManaged } = principalPolicies(template);
  const principals = new Map<string, string[]>();
  for (const [key, list] of statements) {
    if (allowsBedrockModelCalls(list) || awsManaged.has(key)) {
      principals.set(key, missingGuard(list, region));
    }
  }
  return principals;
}

/**
 * Principals of a synthesized template that can call a Bedrock model without
 * the complete guard, as "<logical id>: <reason>" (empty when all are guarded).
 */
export function findUnguardedModelPrincipals(
  template: CfnTemplate,
  region?: string,
): string[] {
  return [...modelCallingPrincipals(template, region)]
    .filter(([, missing]) => missing.length > 0)
    .map(
      ([key, missing]) =>
        `${key}: can call Bedrock models, lacks ${missing.join(', ')}`,
    );
}

/**
 * The model calls the app makes: InvokeModel (Converse) and
 * InvokeModelWithResponseStream (ConverseStream), on in-Region models.
 */
const MODEL_INVOKE_ACTIONS: readonly string[] = [
  'bedrock:InvokeModel',
  'bedrock:InvokeModelWithResponseStream',
];

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The model id of an in-Region foundation-model ARN without a wildcard. */
function inRegionModelId(arn: string, region: string): string | undefined {
  const match = new RegExp(
    `^arn:aws:bedrock:${escapeRegex(region)}::foundation-model/([^*?]+)$`,
  ).exec(arn);
  return match?.[1];
}

/**
 * Model-call grants of a synthesized template that are wider than an
 * in-Region allowlist, as "<principal>: <grant>": every Allow of a model call
 * must be InvokeModel / InvokeModelWithResponseStream on named foundation
 * models of `region` (no `*`, no wildcard Region, no inference profile, no
 * NotResource, no Rerank, batch or other model call), and no principal may
 * have an AWS managed policy that allows model calls.
 */
export function findModelGrantsOutsideAllowlist(
  template: CfnTemplate,
  region: string,
): string[] {
  const { statements, awsManaged } = principalPolicies(template);
  const problems: string[] = [];
  for (const [key, list] of statements) {
    if (awsManaged.has(key)) {
      problems.push(`${key}: an AWS managed policy allows any model call`);
    }
    for (const statement of list) {
      const calls = statement.Effect === 'Allow' ? modelCallsOf(statement) : [];
      if (calls.length === 0) {
        continue;
      }
      const others = calls.filter((c) => !MODEL_INVOKE_ACTIONS.includes(c));
      if (others.length > 0) {
        problems.push(`${key}: allows ${others.join(', ')}`);
      }
      if (statement.NotResource !== undefined) {
        problems.push(`${key}: allows model calls with a NotResource`);
      }
      for (const resource of asArray(statement.Resource)) {
        if (typeof resource !== 'string') {
          problems.push(
            `${key}: allows model calls on ${JSON.stringify(resource)}`,
          );
        } else if (!inRegionModelId(resource, region)) {
          problems.push(`${key}: allows model calls on ${resource}`);
        }
      }
    }
  }
  return problems;
}

/**
 * The in-Region models each principal of a synthesized template may invoke
 * (bedrock:InvokeModel on a named foundation model of `region`), by principal.
 */
export function modelsAllowedInRegion(
  template: CfnTemplate,
  region: string,
): Map<string, string[]> {
  const { statements } = principalPolicies(template);
  const allowed = new Map<string, string[]>();
  for (const [key, list] of statements) {
    const ids = new Set<string>();
    for (const statement of list) {
      if (
        statement.Effect !== 'Allow' ||
        !modelCallsOf(statement).includes('bedrock:InvokeModel')
      ) {
        continue;
      }
      for (const resource of strings(statement.Resource)) {
        const id = inRegionModelId(resource, region);
        if (id && iamAllows(list, 'bedrock:InvokeModel', resource)) {
          ids.add(id);
        }
      }
    }
    if (ids.size > 0) {
      allowed.set(key, [...ids].sort());
    }
  }
  return allowed;
}

/** True when `statement` applies to `action` on `resource`. */
function statementApplies(
  statement: IamStatementJson,
  action: string,
  resource: string,
): boolean {
  const actionHit =
    statement.NotAction !== undefined
      ? !strings(statement.NotAction).some((p) => iamActionMatches(p, action))
      : strings(statement.Action).some((p) => iamActionMatches(p, action));
  if (!actionHit) {
    return false;
  }
  const field =
    statement.NotResource !== undefined
      ? statement.NotResource
      : statement.Resource;
  const values = asArray(field);
  if (values.some((v) => typeof v !== 'string')) {
    // A CloudFormation function: lean towards "allowed" (an Allow applies,
    // a Deny does not).
    return statement.Effect === 'Allow';
  }
  const hit = strings(field).some((p) => iamResourceMatches(p, resource));
  return statement.NotResource !== undefined ? !hit : hit;
}

/**
 * Whether identity-policy `statements` allow `action` on `resource` the way
 * IAM decides within one account: an explicit Deny wins, otherwise an Allow
 * is needed. Conditions are not evaluated (an Allow with one counts, a Deny
 * with one does not), so the answer leans towards "allowed".
 */
export function iamAllows(
  statements: readonly IamStatementJson[],
  action: string,
  resource: string,
): boolean {
  const applies = (effect: 'Allow' | 'Deny') =>
    statements.some(
      (s) =>
        s.Effect === effect &&
        (effect === 'Allow' || s.Condition === undefined) &&
        statementApplies(s, action, resource),
    );
  return !applies('Deny') && applies('Allow');
}

/**
 * Model resources outside `region` that a request may name: global and
 * geographic (APAC, India) inference profiles, an application inference
 * profile, the Region-less model ARN of global profiles, and models of other
 * Regions (Amazon Rerank and Nova 2 Sonic are not offered in ap-south-1),
 * also for each of `modelIds` (the in-Region models a principal may invoke).
 */
export function outsideRegionModelProbes(
  region: string,
  account: string,
  modelIds: readonly string[] = [],
): string[] {
  const other = region === 'us-east-1' ? 'us-west-2' : 'us-east-1';
  const profile = (id: string) =>
    `arn:aws:bedrock:${region}:${account}:inference-profile/${id}`;
  const probes = [
    profile('global.amazon.nova-2-lite-v1:0'),
    profile('apac.amazon.nova-lite-v1:0'),
    profile('in.amazon.nova-lite-v1:0'),
    `arn:aws:bedrock:${region}:${account}:application-inference-profile/a1b2c3d4e5f6`,
    'arn:aws:bedrock:::foundation-model/amazon.nova-2-lite-v1:0',
    `arn:aws:bedrock:${other}::foundation-model/amazon.nova-2-lite-v1:0`,
    'arn:aws:bedrock:ap-northeast-1::foundation-model/amazon.rerank-v1:0',
    'arn:aws:bedrock:ap-northeast-1::foundation-model/amazon.nova-2-sonic-v1:0',
    ...modelIds.flatMap((id) => [
      `arn:aws:bedrock:${other}::foundation-model/${id}`,
      `arn:aws:bedrock:::foundation-model/${id}`,
      profile(`global.${id}`),
      profile(`apac.${id}`),
    ]),
  ];
  return probes.filter(
    (arn) => !arn.startsWith(`arn:aws:bedrock:${region}::foundation-model/`),
  );
}

/**
 * Principals of a synthesized template that IAM would let invoke a model
 * outside `region` (outsideRegionModelProbes, also for the models each one
 * may invoke in-Region), as "<principal>: <action> <resource>". A principal
 * with a model-calling AWS managed policy is taken to allow every call.
 */
export function findModelCallsOutsideRegion(
  template: CfnTemplate,
  region: string,
  account: string,
): string[] {
  const { statements, awsManaged } = principalPolicies(template);
  const allowed = modelsAllowedInRegion(template, region);
  const problems: string[] = [];
  for (const [key, list] of statements) {
    const effective: IamStatementJson[] = awsManaged.has(key)
      ? [...list, { Effect: 'Allow', Action: '*', Resource: '*' }]
      : list;
    if (!allowsBedrockModelCalls(effective)) {
      continue;
    }
    for (const probe of outsideRegionModelProbes(
      region,
      account,
      allowed.get(key),
    )) {
      for (const action of MODEL_INVOKE_ACTIONS) {
        if (iamAllows(effective, action, probe)) {
          problems.push(`${key}: ${action} ${probe}`);
        }
      }
    }
  }
  return problems;
}

/**
 * IAM policy documents of a synthesized template that repeat a statement id:
 * IAM rejects such a policy at deploy time ("<logical id>: <sid>").
 */
export function findDuplicateSids(template: CfnTemplate): string[] {
  const problems: string[] = [];
  for (const [logicalId, resource] of Object.entries(
    template.Resources ?? {},
  )) {
    const props = resource.Properties ?? {};
    const documents =
      resource.Type === 'AWS::IAM::Policy' ||
      resource.Type === 'AWS::IAM::ManagedPolicy'
        ? [props.PolicyDocument]
        : ['AWS::IAM::Role', 'AWS::IAM::User', 'AWS::IAM::Group'].includes(
              resource.Type ?? '',
            )
          ? asArray(props.Policies).map(
              (p) => (p as { PolicyDocument?: unknown }).PolicyDocument,
            )
          : [];
    for (const document of documents) {
      const seen = new Set<string>();
      for (const { Sid } of statementsOf(document)) {
        if (Sid !== undefined && seen.has(Sid)) {
          problems.push(`${logicalId}: ${Sid}`);
        }
        if (Sid !== undefined) {
          seen.add(Sid);
        }
      }
    }
  }
  return problems;
}
