// @vitest-environment node
/**
 * The all-Mumbai build, checked on the whole synthesized CDK app (ap-south-1,
 * every optional feature on). Asset bundling is skipped, so no Docker is
 * needed; the frontend bundle must exist, as for `cdk synth`.
 * - AWS-sold Bedrock models only (every bill is paid by AWS credits) and no
 *   model call outside ap-south-1: each IAM principal that can call a Bedrock
 *   model carries DenyNonAwsSoldModels, DenyUnscopedModelCalls and
 *   DenyModelCallsOutsideRegion (common-constructs core/bedrock-model-guard.ts),
 *   may invoke only named ap-south-1 foundation models of the app's allowlist,
 *   and IAM would deny it every global, APAC and India inference profile and
 *   every model of another Region. The deploy and destroy CodeBuild roles
 *   (PowerUserAccess, outside the app) get the same denies.
 * - No built-in voice chat (Nova Sonic is not offered in ap-south-1) and no
 *   video uploads (no in-Region model reads video).
 * - Re-analyze: the state machine's entry Choices route an input without
 *   processing_type, and the failure catcher may describe the executions.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BLOCKED_BEDROCK_MODEL_RESOURCES,
  type CfnTemplate,
  DENY_MODEL_CALLS_OUTSIDE_REGION_SID,
  FILE_CHECK_ASK_MODEL_ID,
  findDuplicateSids,
  findModelCallsOutsideRegion,
  findModelGrantsOutsideAllowlist,
  findUnguardedModelPrincipals,
  inRegionFoundationModels,
  modelCallingPrincipals,
  modelsAllowedInRegion,
  REGION_LOCKED_MODEL_CALL_ACTIONS,
  SESSION_NAME_MODEL_ID,
  SSM_KEYS,
  UNSCOPED_BEDROCK_MODEL_CALL_ACTIONS,
  VOICE_CHAT_MODEL_ID,
} from ':idp-v2/common-constructs';
import chatModels from './chat-models.json' with { type: 'json' };
import models from './models.json' with { type: 'json' };

const INFRA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const REPO_ROOT = path.resolve(INFRA_DIR, '../..');
const FRONTEND_BUNDLE = path.resolve(
  INFRA_DIR,
  '../../dist/packages/frontend/bundle',
);
const REGION = 'ap-south-1';
const ACCOUNT = '111111111111';
const OPTIONAL_FEATURES = {
  enablePaddleOcrVl: 'true',
  enableWaf: 'true',
  enableImageMcp: 'true',
};

/**
 * The models the app may invoke, all AWS-sold and offered in-Region in
 * ap-south-1 (research mumbai-build.md, section 1): page reading (Kimi K2.5),
 * facts, the Ask and search summaries (gpt-oss-120b), page descriptions,
 * document summaries and chat names (Gemma 3 12B), chat (GLM-5 and the other
 * chat-models.json entries) and search embeddings (Titan Text Embeddings V2).
 * A new model must be checked (AWS-sold, In-Region in Mumbai) before it joins.
 */
const MUMBAI_MODELS = [
  'amazon.titan-embed-text-v2:0',
  'deepseek.v3.2',
  'google.gemma-3-12b-it',
  'moonshotai.kimi-k2.5',
  'openai.gpt-oss-120b-1:0',
  'zai.glm-5',
];

/** Runs `tsx src/main.ts` (cdk.json "app") with extra CDK context into `outdir`. */
function runApp(outdir: string, extraContext: Record<string, unknown>): void {
  const { context } = JSON.parse(
    fs.readFileSync(path.join(INFRA_DIR, 'cdk.json'), 'utf-8'),
  );
  const tsx = createRequire(import.meta.url).resolve('tsx/cli');
  execFileSync(process.execPath, [tsx, 'src/main.ts'], {
    cwd: INFRA_DIR,
    stdio: 'pipe',
    timeout: 280_000,
    env: {
      ...process.env,
      CDK_OUTDIR: outdir,
      CDK_CONTEXT_JSON: JSON.stringify({
        ...context,
        ...extraContext,
        'aws:cdk:bundling-stacks': [],
      }),
      CDK_DEFAULT_ACCOUNT: ACCOUNT,
      CDK_DEFAULT_REGION: REGION,
    },
  });
}

/**
 * Runs the app like `cdk synth` does into `outdir` and returns its templates
 * by stack name.
 */
function synthesize(outdir: string): Map<string, CfnTemplate> {
  try {
    runApp(outdir, OPTIONAL_FEATURES);
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? '';
    throw new Error(`synth failed: ${e}\n${stderr.slice(-4000)}`);
  }
  const templates = new Map<string, CfnTemplate>();
  for (const file of fs.readdirSync(outdir)) {
    if (file.endsWith('.template.json')) {
      templates.set(
        file.replace(/\.template\.json$/, ''),
        JSON.parse(fs.readFileSync(path.join(outdir, file), 'utf-8')),
      );
    }
  }
  return templates;
}

/** A CloudFormation value as text, every intrinsic function as `{token}`. */
function flatten(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  const join = (value as { 'Fn::Join'?: [string, unknown[]] })?.['Fn::Join'];
  return join ? join[1].map(flatten).join(join[0]) : '{token}';
}

/** Resources of `type` in a template, by logical id. */
function resourcesOf(
  template: CfnTemplate,
  type: string,
): [string, Record<string, unknown>][] {
  return Object.entries(template.Resources ?? {})
    .filter(([, resource]) => resource.Type === type)
    .map(([id, resource]) => [id, resource.Properties ?? {}]);
}

/** The one resource of `type` whose logical id starts with `prefix`. */
function resourceOf(
  template: CfnTemplate | undefined,
  type: string,
  prefix: string,
): Record<string, unknown> {
  const found = resourcesOf(template ?? {}, type).filter(([id]) =>
    id.startsWith(prefix),
  );
  expect(
    found.map(([id]) => id),
    `${type} ${prefix}*`,
  ).toHaveLength(1);
  return found[0][1];
}

const environmentOf = (fn: Record<string, unknown>) =>
  ((fn.Environment as { Variables?: Record<string, unknown> })?.Variables ??
    {}) as Record<string, unknown>;

/** The model ids `principal` (a "<stack>/<logical id prefix>") may invoke. */
function modelsOf(
  allowed: Map<string, string[]>,
  principal: string,
): string[] | undefined {
  const hits = [...allowed].filter(([key]) => key.startsWith(principal));
  expect(
    hits.map(([key]) => key),
    principal,
  ).toHaveLength(1);
  return hits[0][1];
}

const unique = (ids: readonly string[]) =>
  [...new Set(ids.filter((id) => id !== ''))].sort();

describe('the all-Mumbai build (synthesized app)', () => {
  let outdir: string;
  let templates: Map<string, CfnTemplate>;

  beforeAll(() => {
    if (!fs.existsSync(FRONTEND_BUNDLE)) {
      throw new Error(
        `${FRONTEND_BUNDLE} is missing: build the frontend first (pnpm nx run @idp-v2/frontend:bundle)`,
      );
    }
    outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-model-guard-'));
    templates = synthesize(outdir);
  }, 300_000);

  afterAll(() => {
    if (outdir) {
      fs.rmSync(outdir, { recursive: true, force: true });
    }
  });

  /** Per stack: "<stack>/<entry>". */
  const all = (check: (template: CfnTemplate) => string[]) =>
    [...templates].flatMap(([stack, template]) =>
      check(template).map((entry) => `${stack}/${entry}`),
    );

  /** In-Region models per principal, as "<stack>/<logical id>". */
  const allowedModels = () =>
    new Map(
      [...templates].flatMap(([stack, template]) =>
        [...modelsAllowedInRegion(template, REGION)].map(
          ([key, ids]) => [`${stack}/${key}`, ids] as [string, string[]],
        ),
      ),
    );

  describe('every role that can call a Bedrock model carries the deny', () => {
    it('finds the model-calling roles, the background workers included', () => {
      expect(templates.size).toBeGreaterThanOrEqual(15);
      const principals = all((t) => [...modelCallingPrincipals(t).keys()]);
      expect(principals.length).toBeGreaterThanOrEqual(30);
      for (const role of [
        'IDP-V2-Worker/MessageProcessFunctionServiceRole',
        'IDP-V2-Agent/IdpAgentRuntimeExecutionRole',
        'IDP-V2-Agent/WebCrawlerAgentRuntimeExecutionRole',
        'IDP-V2-Application/BackendHandlerServiceRole',
        'IDP-V2-Mcp/SearchMcpFunctionServiceRole',
        'IDP-V2-LanceService/LanceDbServiceFunctionServiceRole',
        'IDP-V2-Workflow/DatasetProcessServiceRole',
        'IDP-V2-Workflow/SegmentAnalyzerServiceRole',
      ]) {
        expect(
          principals.some((p) => p.startsWith(role)),
          role,
        ).toBe(true);
      }
    });

    it('gives each of them DenyNonAwsSoldModels, DenyUnscopedModelCalls and the ap-south-1 Region lock', () => {
      // With the Region, DenyModelCallsOutsideRegion must name ap-south-1.
      expect(all((t) => findUnguardedModelPrincipals(t, REGION))).toEqual([]);
    });

    it('lets no role invoke a model outside ap-south-1', () => {
      // Global, APAC and India profiles, application profiles, the Region-less
      // model ARN, other Regions (Rerank, Nova Sonic), for each role's models.
      expect(
        all((t) => findModelCallsOutsideRegion(t, REGION, ACCOUNT)),
      ).toEqual([]);
    });

    it('keeps every IAM policy deployable (no repeated statement id)', () => {
      expect(all(findDuplicateSids)).toEqual([]);
    });
  });

  describe('each role may invoke only the in-Region models it calls', () => {
    it('grants named ap-south-1 foundation models only: no *, no wildcard Region, no profile, no Rerank', () => {
      expect(all((t) => findModelGrantsOutsideAllowlist(t, REGION))).toEqual(
        [],
      );
    });

    it('allows only the Mumbai models of the allowlist', () => {
      const used = unique([...allowedModels().values()].flat());
      expect(used.filter((id) => !MUMBAI_MODELS.includes(id))).toEqual([]);
      for (const id of [
        models.analysis,
        models.embedding,
        models.facts,
        models.describer,
        FILE_CHECK_ASK_MODEL_ID,
        SESSION_NAME_MODEL_ID,
        'zai.glm-5',
      ]) {
        expect(used, id).toContain(id);
      }
      expect(used).not.toContain(VOICE_CHAT_MODEL_ID);
    });

    it('gives each role the models of its own code', () => {
      const allowed = allowedModels();
      const pipeline = unique([
        models.analysis,
        models.videoAnalysis,
        models.scriptExtractor,
        models.describer,
        models.docSummarizer,
        models.facts,
        models.extractor,
        models.entityNormalizer,
      ]);
      expect(
        modelsOf(allowed, 'IDP-V2-Agent/IdpAgentRuntimeExecutionRole'),
      ).toEqual(unique(['zai.glm-5', ...chatModels.map((m) => m.value)]));
      expect(
        modelsOf(allowed, 'IDP-V2-Agent/WebCrawlerAgentRuntimeExecutionRole'),
      ).toEqual([models.webcrawler]);
      expect(
        modelsOf(allowed, 'IDP-V2-Application/BackendHandlerServiceRole'),
      ).toEqual([FILE_CHECK_ASK_MODEL_ID]);
      expect(
        modelsOf(allowed, 'IDP-V2-Worker/MessageProcessFunctionServiceRole'),
      ).toEqual([SESSION_NAME_MODEL_ID]);
      expect(
        modelsOf(
          allowed,
          'IDP-V2-LanceService/LanceDbServiceFunctionServiceRole',
        ),
      ).toEqual([models.embedding]);
      const workflow = [...allowed].filter(([key]) =>
        key.startsWith('IDP-V2-Workflow/'),
      );
      expect(workflow.length).toBeGreaterThanOrEqual(20);
      for (const [key, ids] of workflow) {
        expect(ids, key).toEqual(pipeline);
      }
    });
  });

  describe('voice chat is off (Nova Sonic is not offered in ap-south-1)', () => {
    it('deploys no BidiAgent runtime and no runtime ARN parameter', () => {
      const runtimes = [...templates.values()].flatMap((t) =>
        resourcesOf(t, 'AWS::BedrockAgentCore::Runtime').map(
          ([, props]) => props.AgentRuntimeName,
        ),
      );
      expect(runtimes).toContain('idp_agent');
      expect(runtimes).not.toContain('bidi_agent');
      const parameters = [...templates.values()].flatMap((t) =>
        resourcesOf(t, 'AWS::SSM::Parameter').map(([, props]) => props.Name),
      );
      expect(parameters).toContain(SSM_KEYS.AGENT_RUNTIME_ARN);
      expect(parameters).not.toContain(SSM_KEYS.BIDI_AGENT_RUNTIME_ARN);
      // No stack reads the parameter either (it would fail the deploy).
      const reads = [...templates.values()].flatMap((t) =>
        Object.values(
          (t as { Parameters?: Record<string, { Default?: unknown }> })
            .Parameters ?? {},
        ).map((p) => p.Default),
      );
      expect(reads).toContain(SSM_KEYS.AGENT_RUNTIME_ARN);
      expect(reads).not.toContain(SSM_KEYS.BIDI_AGENT_RUNTIME_ARN);
    });

    it('refuses to send voice to another Region (-c enableVoiceChat=true -c voiceModelRegion=ap-northeast-1)', () => {
      const voiceOut = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-voice-'));
      try {
        let stderr = '';
        try {
          runApp(voiceOut, {
            enableVoiceChat: 'true',
            voiceModelRegion: 'ap-northeast-1',
          });
        } catch (e) {
          stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? String(e);
        }
        expect(stderr).toContain(
          `Voice chat needs ${VOICE_CHAT_MODEL_ID} in ${REGION}, but voiceModelRegion is ap-northeast-1`,
        );
      } finally {
        fs.rmSync(voiceOut, { recursive: true, force: true });
      }
    }, 120_000);
  });

  describe('Bedrock Data Automation is off (it runs through a cross-Region profile)', () => {
    /** Identity-policy statements of every principal, as "<stack>/<id>". */
    const statements = () =>
      [...templates].flatMap(([stack, template]) =>
        Object.entries(template.Resources ?? {}).flatMap(([id, resource]) => {
          const props = resource.Properties ?? {};
          const documents =
            resource.Type === 'AWS::IAM::Policy' ||
            resource.Type === 'AWS::IAM::ManagedPolicy'
              ? [props.PolicyDocument]
              : resource.Type === 'AWS::IAM::Role'
                ? (
                    (props.Policies as { PolicyDocument?: unknown }[]) ?? []
                  ).map((p) => p.PolicyDocument)
                : [];
          return documents.flatMap((d) =>
            (
              ((d as { Statement?: Record<string, unknown>[] })?.Statement ??
                []) as Record<string, unknown>[]
            ).map((st) => ({ where: `${stack}/${id}`, st })),
          );
        }),
      );
    const actionsOf = (st: Record<string, unknown>) =>
      ([] as unknown[]).concat(st.Action ?? []).map(String);

    it('lets no role start a BDA job, and denies it to the BDA Lambdas', () => {
      const allows = statements().filter(
        ({ st }) =>
          st.Effect === 'Allow' &&
          actionsOf(st).some((a) =>
            /^bedrock:(InvokeDataAutomation|\*$)|^\*$/i.test(a),
          ),
      );
      expect(allows.map(({ where }) => where)).toEqual([]);
      const denies = statements()
        .filter(
          ({ st }) =>
            st.Effect === 'Deny' && st.Sid === 'DenyBedrockDataAutomation',
        )
        .map(({ where, st }) => [where, actionsOf(st), st.Resource]);
      expect(denies).toHaveLength(2);
      for (const [where, actions, resource] of denies) {
        expect(where).toMatch(/^IDP-V2-Workflow\/Bda(Start|Check)/);
        expect(actions).toContain('bedrock:InvokeDataAutomation*');
        expect(resource).toBe('*');
      }
    });

    it('skips the step in bda-start', () => {
      const start = resourceOf(
        templates.get('IDP-V2-Workflow'),
        'AWS::Lambda::Function',
        'BdaStart',
      );
      expect(environmentOf(start).BDA_ENABLED).toBe('false');
    });
  });

  describe('the web app config of the Mumbai build', () => {
    /** runtime-config.json as the website deployment writes it. */
    function runtimeConfig(): Record<string, unknown> {
      const deployment = resourceOf(
        templates.get('IDP-V2-Application'),
        'Custom::CDKBucketDeployment',
        'FrontendWebsiteDeployment',
      );
      // Sources in order: the bundle, then Source.jsonData (it wins).
      const keys = (deployment.SourceObjectKeys as string[]).map((key) =>
        path.join(outdir, `asset.${key.replace(/\.zip$/, '')}`),
      );
      const file = path.join(keys[keys.length - 1], 'runtime-config.json');
      const text = fs
        .readFileSync(file, 'utf-8')
        .replace(/<<marker:0xbaba:\d+>>/g, '"{token}"');
      return JSON.parse(text);
    }

    it('has no voice chat runtime, so the web app hides the mic', () => {
      const config = runtimeConfig();
      expect(config).toHaveProperty('agentRuntimeArn');
      expect(config).not.toHaveProperty('bidiAgentRuntimeArn');
    });

    it('has no BDA, so the web app hides the upload option', () => {
      expect(runtimeConfig().bdaEnabled).toBe(false);
    });

    it('refuses video uploads, in the web app and in the backend', () => {
      expect(runtimeConfig().videoUploadsEnabled).toBe(false);
      const backend = resourceOf(
        templates.get('IDP-V2-Application'),
        'AWS::Lambda::Function',
        'BackendHandler',
      );
      expect(environmentOf(backend).VIDEO_UPLOADS_ENABLED).toBe('false');
      // The segment analyzer has no video model to call either.
      const analyzer = resourceOf(
        templates.get('IDP-V2-Workflow'),
        'AWS::Lambda::Function',
        'SegmentAnalyzer',
      );
      expect(environmentOf(analyzer)).toMatchObject({
        BEDROCK_MODEL_ID: models.analysis,
        BEDROCK_VIDEO_MODEL_ID: '',
        NOVA_LITE_MODEL_ID: '',
      });
    });
  });

  describe('the document workflow (Re-analyze)', () => {
    /** The state machine definition (ASL), intrinsic functions as text. */
    function definition(): Asl {
      const machine = resourceOf(
        templates.get('IDP-V2-Workflow'),
        'AWS::StepFunctions::StateMachine',
        'DocumentAnalysisStateMachine',
      );
      return JSON.parse(flatten(machine.DefinitionString));
    }

    const reanalysis = {
      workflow_id: 'wf_AbCdEfGhIjKlMnOpQr',
      document_id: 'doc-1',
      project_id: 'proj-1',
      file_uri: 's3://bucket/projects/proj-1/documents/doc-1/doc-1.wav',
      file_type: 'audio/wav',
      is_reanalysis: true,
      user_instructions: '',
      language: 'en',
    };

    it('routes a Re-analyze input to the re-analysis, with or without processing_type', () => {
      const asl = definition();
      // The input the live backend sent: no processing_type.
      expect(route(asl, reanalysis)).toBe('PrepareReanalysis');
      for (const type of ['document', 'audio', 'image', 'text', 'web']) {
        expect(route(asl, { ...reanalysis, processing_type: type }), type).toBe(
          'PrepareReanalysis',
        );
      }
      expect(route(asl, { ...reanalysis, processing_type: 'dataset' })).toBe(
        'ProcessDataset',
      );
    });

    it('routes uploads as before', () => {
      const asl = definition();
      const upload: Record<string, unknown> = { ...reanalysis };
      delete upload.is_reanalysis;
      expect(route(asl, { ...upload, processing_type: 'document' })).toBe(
        'ParallelPreprocessing',
      );
      expect(route(asl, { ...upload, processing_type: 'dataset' })).toBe(
        'ProcessDataset',
      );
      expect(route(asl, upload)).toBe('ParallelPreprocessing');
    });

    it('checks the presence of every input field its entry Choices compare', () => {
      const states = allStates(definition());
      for (const name of ['IsDataset', 'IsReanalysis', 'ShouldRunWebCrawler']) {
        expect(states[name]?.Type, name).toBe('Choice');
        const choices = states[name].Choices ?? [];
        choices.forEach((rule, index) => {
          if (rule.Variable && rule.IsPresent === undefined) {
            expect(
              choices
                .slice(0, index)
                .some(
                  (r) => r.Variable === rule.Variable && r.IsPresent === false,
                ),
              `${name}: ${rule.Variable}`,
            ).toBe(true);
          }
        });
      }
    });

    it('lets the failure catcher describe the executions (not only the state machine)', () => {
      const workflow = templates.get('IDP-V2-Workflow') ?? {};
      const policy = resourceOf(
        workflow,
        'AWS::IAM::Policy',
        'WorkflowFailureCatcherServiceRoleDefaultPolicy',
      );
      const statements = (
        policy.PolicyDocument as {
          Statement: { Action: unknown; Resource: unknown }[];
        }
      ).Statement.filter((s) =>
        JSON.stringify(s.Action).includes('states:DescribeExecution'),
      );
      expect(statements).toHaveLength(1);
      const resources = [statements[0].Resource].flat().map(flatten);
      expect(resources).toEqual([
        `arn:aws:states:${REGION}:${ACCOUNT}:execution:{token}:*`,
      ]);
      // EventBridge sends it every failed, timed-out and stopped execution.
      const [rule] = resourcesOf(workflow, 'AWS::Events::Rule')
        .map(([, props]) => props)
        .filter((props) =>
          JSON.stringify(props.Targets).includes('WorkflowFailureCatcher'),
        );
      expect(rule.EventPattern).toMatchObject({
        source: ['aws.states'],
        detail: { status: ['FAILED', 'TIMED_OUT', 'ABORTED'] },
      });
    });
  });
});

/** A Choice rule of the ASL (the operators the workflow uses). */
interface ChoiceRule {
  Variable?: string;
  IsPresent?: boolean;
  StringEquals?: string;
  BooleanEquals?: boolean;
  And?: ChoiceRule[];
  Or?: ChoiceRule[];
  Not?: ChoiceRule;
  Next?: string;
}

/** A state of the ASL (the fields these checks read). */
interface AslState {
  Type: string;
  Choices?: ChoiceRule[];
  Default?: string;
  Iterator?: Asl;
  ItemProcessor?: Asl;
  Branches?: Asl[];
}

interface Asl {
  StartAt: string;
  States: Record<string, AslState>;
}

/** Every state of the definition, nested Map and Parallel states included. */
function allStates(asl: Asl): Record<string, AslState> {
  const found: Record<string, AslState> = {};
  const walk = (states: Record<string, AslState>) => {
    for (const [name, state] of Object.entries(states)) {
      found[name] = state;
      for (const inner of [
        state.Iterator,
        state.ItemProcessor,
        ...(state.Branches ?? []),
      ]) {
        if (inner) {
          walk(inner.States);
        }
      }
    }
  };
  walk(asl.States);
  return found;
}

/** Field `variable` ($.a.b) of the state input. */
function lookup(
  input: Record<string, unknown>,
  variable: string,
): { present: boolean; value?: unknown } {
  let value: unknown = input;
  for (const key of variable.replace(/^\$\.?/, '').split('.')) {
    if (typeof value !== 'object' || value === null || !(key in value)) {
      return { present: false };
    }
    value = (value as Record<string, unknown>)[key];
  }
  return { present: true, value };
}

/**
 * Whether a Choice rule matches, as Step Functions decides: a comparison on a
 * missing field fails the execution (States.Runtime, which no Catch handles).
 */
function matches(rule: ChoiceRule, input: Record<string, unknown>): boolean {
  if (rule.And) {
    return rule.And.every((r) => matches(r, input));
  }
  if (rule.Or) {
    return rule.Or.some((r) => matches(r, input));
  }
  if (rule.Not) {
    return !matches(rule.Not, input);
  }
  const { present, value } = lookup(input, rule.Variable ?? '');
  if (rule.IsPresent !== undefined) {
    return present === rule.IsPresent;
  }
  if (!present) {
    throw new Error(
      `States.Runtime: Invalid path '${rule.Variable}': the choice state's condition path references an invalid value.`,
    );
  }
  if (rule.StringEquals !== undefined) {
    return value === rule.StringEquals;
  }
  if (rule.BooleanEquals !== undefined) {
    return value === rule.BooleanEquals;
  }
  throw new Error(`Choice operator not modelled here: ${JSON.stringify(rule)}`);
}

/** The first state after the entry Choices that `input` reaches. */
function route(asl: Asl, input: Record<string, unknown>): string {
  let name = asl.StartAt;
  for (let hops = 0; hops < 20; hops++) {
    const state = asl.States[name];
    if (state?.Type !== 'Choice') {
      return name;
    }
    const next =
      state.Choices?.find((rule) => matches(rule, input))?.Next ??
      state.Default;
    if (!next) {
      throw new Error(`States.NoChoiceMatched in ${name}`);
    }
    name = next;
  }
  throw new Error('Choice loop');
}

describe('the Choice model (route)', () => {
  it('fails an input without processing_type at the old IsDataset, like the live Re-analyze', () => {
    const before: Asl = {
      StartAt: 'IsDataset',
      States: {
        IsDataset: {
          Type: 'Choice',
          Choices: [
            {
              Variable: '$.processing_type',
              StringEquals: 'dataset',
              Next: 'ProcessDataset',
            },
          ],
          Default: 'IsReanalysis',
        },
        ProcessDataset: { Type: 'Task' },
        IsReanalysis: { Type: 'Pass' },
      },
    };
    expect(() => route(before, { is_reanalysis: true })).toThrow(
      "Invalid path '$.processing_type'",
    );
    expect(route(before, { processing_type: 'document' })).toBe('IsReanalysis');
  });
});

/** The lines of the inline policy `- PolicyName: <name>` of a YAML template. */
function yamlPolicy(file: string, name: string): string {
  const lines = fs
    .readFileSync(path.join(REPO_ROOT, file), 'utf-8')
    .split('\n');
  const start = lines.findIndex((l) => l.trim() === `- PolicyName: ${name}`);
  if (start < 0) {
    return '';
  }
  const indent = lines[start].search(/\S/);
  const end = lines.findIndex(
    (l, i) => i > start && l.trim() !== '' && l.search(/\S/) <= indent,
  );
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

describe('the deploy and destroy CodeBuild roles carry the same denies', () => {
  const quoted = (text: string) =>
    [...text.matchAll(/^\s*- '([^']+)'$/gm)].map((m) => m[1]);

  for (const file of ['deploy-codebuild.yml', 'destroy-codebuild.yml']) {
    it(file, () => {
      const policy = yamlPolicy(file, 'DenyNonAwsSoldModels');
      const [models, unscoped = ''] = policy.split(
        '- Sid: DenyUnscopedModelCalls',
      );
      expect(models).toContain('- Sid: DenyNonAwsSoldModels');
      expect(models).toContain("Action: 'bedrock:*'");
      expect(quoted(models)).toEqual(BLOCKED_BEDROCK_MODEL_RESOURCES);
      expect(quoted(unscoped)).toEqual([
        ...UNSCOPED_BEDROCK_MODEL_CALL_ACTIONS,
      ]);
      expect(unscoped).toContain("Resource: '*'");
      expect(policy.match(/^\s*Effect: Deny$/gm)).toHaveLength(2);
      expect(policy).not.toContain('Condition');

      // The Region lock: nothing but the foundation models of the Region the
      // CodeBuild stack runs in (deploy.sh: ap-south-1).
      const lock = yamlPolicy(file, DENY_MODEL_CALLS_OUTSIDE_REGION_SID);
      expect(lock).toContain(`- Sid: ${DENY_MODEL_CALLS_OUTSIDE_REGION_SID}`);
      expect(REGION_LOCKED_MODEL_CALL_ACTIONS).toEqual([
        'bedrock:InvokeModel*',
      ]);
      expect(lock).toContain("Action: 'bedrock:InvokeModel*'");
      expect(lock).toContain(
        `NotResource: !Sub '${inRegionFoundationModels('${AWS::Region}')}'`,
      );
      expect(lock.match(/^\s*Effect: Deny$/gm)).toHaveLength(1);
      expect(lock).not.toMatch(/^\s*Resource:/m);
      expect(lock).not.toContain('Condition');
    });
  }
});
