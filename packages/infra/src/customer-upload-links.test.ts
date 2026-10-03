// @vitest-environment node
/**
 * Customer upload links in the synthesized CDK app (ap-south-1, asset
 * bundling skipped; the frontend bundle must exist, as for `cdk synth`):
 * - the PDF unlock Lambda (WorkflowStack) may read and delete only locked
 *   copies, write only document keys, and is the one the backend invokes;
 * - type detection may move an unflagged encrypted PDF to its locked key;
 * - the S3 upload rule ignores locked copies;
 * - the backend's /public/ routes have no authorizer, all others IAM.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PDF_UNLOCK_FUNCTION_NAME,
  UPLOAD_RULE_IGNORED_KEYS,
} from ':idp-v2/common-constructs';

const INFRA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

type Statement = {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: unknown;
};
// CloudFormation properties, read by known paths only.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resource = { Type: string; Properties: Record<string, any> };
type Template = { Resources: Record<string, Resource> };

let outdir = '';
const templates = new Map<string, Template>();

beforeAll(() => {
  outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-upload-links-'));
  const { context } = JSON.parse(
    fs.readFileSync(path.join(INFRA_DIR, 'cdk.json'), 'utf-8'),
  );
  const tsx = createRequire(import.meta.url).resolve('tsx/cli');
  try {
    execFileSync(process.execPath, [tsx, 'src/main.ts'], {
      cwd: INFRA_DIR,
      stdio: 'pipe',
      timeout: 280_000,
      env: {
        ...process.env,
        CDK_OUTDIR: outdir,
        CDK_CONTEXT_JSON: JSON.stringify({
          ...context,
          'aws:cdk:bundling-stacks': [],
        }),
        CDK_DEFAULT_ACCOUNT: '111111111111',
        CDK_DEFAULT_REGION: 'ap-south-1',
      },
    });
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? '';
    throw new Error(`synth failed: ${e}\n${stderr.slice(-4000)}`);
  }
  for (const file of fs.readdirSync(outdir)) {
    if (file.endsWith('.template.json')) {
      templates.set(
        file.replace(/\.template\.json$/, ''),
        JSON.parse(fs.readFileSync(path.join(outdir, file), 'utf-8')),
      );
    }
  }
}, 300_000);

afterAll(() => {
  if (outdir) {
    fs.rmSync(outdir, { recursive: true, force: true });
  }
});

function template(name: string): Template {
  const found = templates.get(name);
  if (!found) {
    throw new Error(`no template ${name}`);
  }
  return found;
}

function resources(t: Template, type: string): [string, Resource][] {
  return Object.entries(t.Resources).filter(([, r]) => r.Type === type);
}

function functionNamed(t: Template, name: string): [string, Resource] {
  const found = resources(t, 'AWS::Lambda::Function').find(
    ([, r]) => r.Properties.FunctionName === name,
  );
  if (!found) {
    throw new Error(`no function ${name}`);
  }
  return found;
}

/** Statements of every inline policy attached to the function's role. */
function roleStatements(t: Template, fn: Resource): Statement[] {
  const roleId = fn.Properties.Role['Fn::GetAtt'][0];
  return resources(t, 'AWS::IAM::Policy')
    .filter(([, p]) =>
      (p.Properties.Roles as { Ref: string }[]).some((r) => r.Ref === roleId),
    )
    .flatMap(([, p]) => p.Properties.PolicyDocument.Statement as Statement[]);
}

/** A resource as text, every intrinsic function as `{token}`. */
function flatten(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  const join = (value as { 'Fn::Join'?: [string, unknown[]] })?.['Fn::Join'];
  return join ? join[1].map(flatten).join(join[0]) : '{token}';
}

function bySid(statements: Statement[], sid: string): Statement {
  const found = statements.find((s) => s.Sid === sid);
  if (!found) {
    throw new Error(`no statement ${sid}`);
  }
  return found;
}

describe('PDF unlock Lambda', () => {
  it('runs with its own pypdf layer and only the bucket name in its env', () => {
    const [, fn] = functionNamed(
      template('IDP-V2-Workflow'),
      PDF_UNLOCK_FUNCTION_NAME,
    );

    expect(fn.Properties.Handler).toBe('index.handler');
    expect(fn.Properties.Timeout).toBe(60);
    expect(fn.Properties.Layers).toHaveLength(1);
    expect(Object.keys(fn.Properties.Environment.Variables)).toEqual([
      'DOCUMENT_STORAGE_BUCKET_NAME',
    ]);
  });

  it('may read and delete only locked copies and write document keys', () => {
    const t = template('IDP-V2-Workflow');
    const [, fn] = functionNamed(t, PDF_UNLOCK_FUNCTION_NAME);
    const statements = roleStatements(t, fn);

    const read = bySid(statements, 'ReadAndDeleteLockedPdfs');
    expect([read.Action].flat().sort()).toEqual([
      's3:DeleteObject',
      's3:DeleteObjectVersion',
      's3:GetObject',
    ]);
    expect(flatten(read.Resource)).toMatch(
      /:s3:::\{token\}\/projects\/\*\/documents\/\*\/locked\/\*$/,
    );
    const write = bySid(statements, 'WriteUnlockedPdfs');
    expect(write.Action).toBe('s3:PutObject');
    expect(flatten(write.Resource)).toMatch(/\/projects\/\*\/documents\/\*$/);
    // Nothing else touches S3.
    const s3Actions = statements
      .flatMap((s) => [s.Action].flat())
      .filter((a) => a.startsWith('s3:'))
      .sort();
    expect(s3Actions).toEqual(
      [
        's3:DeleteObject',
        's3:DeleteObjectVersion',
        's3:GetObject',
        's3:ListBucketVersions',
        's3:PutObject',
      ].sort(),
    );
  });

  it('is the function the backend may invoke', () => {
    const t = template('IDP-V2-Application');
    const [, backend] = functionNamed(t, 'idp-v2-backend-api');
    const statement = bySid(roleStatements(t, backend), 'InvokePdfUnlock');

    expect(flatten(statement.Resource)).toMatch(
      new RegExp(`:function:${PDF_UNLOCK_FUNCTION_NAME}$`),
    );
    expect(
      flatten(
        backend.Properties.Environment.Variables.PDF_UNLOCK_FUNCTION_NAME,
      ),
    ).toMatch(new RegExp(`:function:${PDF_UNLOCK_FUNCTION_NAME}$`));
  });
});

describe('Type detection: unflagged encrypted customer PDFs', () => {
  it('may write locked copies and delete document versions only', () => {
    const t = template('IDP-V2-Event');
    const [, fn] = functionNamed(t, 'idp-v2-type-detection');
    const statements = roleStatements(t, fn);

    expect(
      flatten(bySid(statements, 'HoldEncryptedCustomerPdfs').Resource),
    ).toMatch(/\/projects\/\*\/documents\/\*\/locked\/\*$/);
    expect(
      flatten(bySid(statements, 'DeleteUnflaggedEncryptedPdfs').Resource),
    ).toMatch(/\/projects\/\*\/documents\/\*$/);
    expect(bySid(statements, 'ListDocumentVersions').Condition).toEqual({
      StringLike: { 's3:prefix': ['projects/*/documents/*'] },
    });
  });

  it('keeps the upload rule ignoring keys below a document folder', () => {
    const rules = resources(template('IDP-V2-Event'), 'AWS::Events::Rule')
      .map(([, r]) => r)
      .filter((r) => r.Properties.Name === 'idp-v2-s3-upload-preprocess');

    expect(rules).toHaveLength(1);
    expect(rules[0].Properties.EventPattern.detail.object.key).toEqual([
      { 'anything-but': { wildcard: UPLOAD_RULE_IGNORED_KEYS } },
    ]);
  });
});

describe('Backend HTTP API', () => {
  it('opens only GET/POST /public/{proxy+} (and CORS preflight)', () => {
    const open = resources(
      template('IDP-V2-Application'),
      'AWS::ApiGatewayV2::Route',
    )
      .filter(([, r]) => r.Properties.AuthorizationType !== 'AWS_IAM')
      .map(([, r]) => r.Properties.RouteKey)
      .sort();

    expect(open).toEqual(
      [
        'GET /public/{proxy+}',
        'OPTIONS /{proxy+}',
        'POST /public/{proxy+}',
      ].sort(),
    );
  });
});
