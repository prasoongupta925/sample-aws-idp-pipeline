// @vitest-environment node
/**
 * The Backend construct's customer upload link wiring: the open /public/
 * route (no authorizer, throttled), every other route behind IAM, the CORS
 * header for the link token, and the PDF unlock Lambda grant and env.
 */
import * as path from 'path';
import { fileURLToPath } from 'url';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Backend,
  PUBLIC_ROUTE_PATH,
  PUBLIC_ROUTE_THROTTLE,
} from './backend.js';
import {
  PDF_UNLOCK_FUNCTION_NAME,
  UPLOAD_RULE_IGNORED_KEYS,
  UPLOAD_TOKEN_HEADER,
} from '../../constants/upload-links.js';

// DockerImageCode.fromImageAsset('../backend') resolves from packages/infra,
// where `cdk synth` runs.
const INFRA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../infra',
);
let previousCwd = '';

beforeAll(() => {
  previousCwd = process.cwd();
  process.chdir(INFRA_DIR);
});

afterAll(() => {
  process.chdir(previousCwd);
});

function synth(props: { dsaName?: string } = {}): Template {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new Stack(app, 'Application', {
    env: { account: '111111111111', region: 'ap-south-1' },
  });
  new Backend(stack, 'Backend', props);
  return Template.fromStack(stack);
}

type Resource = { Properties: Record<string, unknown> };

function routes(template: Template): Map<string, Resource> {
  const byKey = new Map<string, Resource>();
  for (const route of Object.values(
    template.findResources('AWS::ApiGatewayV2::Route'),
  ) as Resource[]) {
    byKey.set(route.Properties.RouteKey as string, route);
  }
  return byKey;
}

/** EventBridge `wildcard` matching: `*` is any run of characters, `/` included. */
function wildcardMatches(pattern: string, value: string): boolean {
  const regex = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${regex}$`).test(value);
}

describe('Backend: customer upload link routes', () => {
  it('opens only GET and POST under /public/ without an authorizer', () => {
    const byKey = routes(synth());

    for (const method of ['GET', 'POST']) {
      const route = byKey.get(`${method} ${PUBLIC_ROUTE_PATH}`);
      expect(route, `${method} ${PUBLIC_ROUTE_PATH}`).toBeDefined();
      expect(route?.Properties.AuthorizationType ?? 'NONE').toBe('NONE');
    }
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      expect(byKey.has(`${method} ${PUBLIC_ROUTE_PATH}`)).toBe(false);
    }
  });

  it('keeps every other non-OPTIONS route behind the IAM authorizer', () => {
    const byKey = routes(synth());
    const open = [...byKey.entries()]
      .filter(([, route]) => route.Properties.AuthorizationType !== 'AWS_IAM')
      .map(([key]) => key)
      .sort();

    expect(open).toEqual(
      [
        `GET ${PUBLIC_ROUTE_PATH}`,
        'OPTIONS /{proxy+}',
        `POST ${PUBLIC_ROUTE_PATH}`,
      ].sort(),
    );
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
      expect(
        byKey.get(`${method} /{proxy+}`)?.Properties.AuthorizationType,
      ).toBe('AWS_IAM');
    }
  });

  it('throttles the public routes on the default stage', () => {
    synth().hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      RouteSettings: {
        [`GET ${PUBLIC_ROUTE_PATH}`]: {
          ThrottlingRateLimit: PUBLIC_ROUTE_THROTTLE.rateLimit,
          ThrottlingBurstLimit: PUBLIC_ROUTE_THROTTLE.burstLimit,
        },
        [`POST ${PUBLIC_ROUTE_PATH}`]: {
          ThrottlingRateLimit: PUBLIC_ROUTE_THROTTLE.rateLimit,
          ThrottlingBurstLimit: PUBLIC_ROUTE_THROTTLE.burstLimit,
        },
      },
    });
  });

  it('creates the public routes before the stage that throttles them', () => {
    const template = synth();
    const publicIds = Object.entries(
      template.findResources('AWS::ApiGatewayV2::Route'),
    )
      .filter(([, r]) =>
        String((r as Resource).Properties.RouteKey).endsWith(PUBLIC_ROUTE_PATH),
      )
      .map(([id]) => id);
    expect(publicIds).toHaveLength(2);

    const stages = Object.values(
      template.findResources('AWS::ApiGatewayV2::Stage', {
        Properties: { StageName: '$default' },
      }),
    ) as { DependsOn?: string[] }[];
    expect(stages).toHaveLength(1);
    expect(stages[0].DependsOn ?? []).toEqual(
      expect.arrayContaining(publicIds),
    );
  });

  it('allows the link token header in CORS', () => {
    synth().hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: {
        AllowHeaders: Match.arrayWith([UPLOAD_TOKEN_HEADER]),
      },
    });
  });
});

describe('Backend: PDF unlock', () => {
  it('passes the unlock function to the backend and may invoke only it', () => {
    const template = synth();
    const arn = {
      'Fn::Join': [
        '',
        [
          'arn:',
          { Ref: 'AWS::Partition' },
          `:lambda:ap-south-1:111111111111:function:${PDF_UNLOCK_FUNCTION_NAME}`,
        ],
      ],
    };

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'idp-v2-backend-api',
      Environment: {
        Variables: Match.objectLike({ PDF_UNLOCK_FUNCTION_NAME: arn }),
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          {
            Sid: 'InvokePdfUnlock',
            Effect: 'Allow',
            Action: 'lambda:InvokeFunction',
            Resource: arn,
          },
        ]),
      },
    });
  });

  it('sets DSA_NAME only when a name is given', () => {
    const env = (template: Template) =>
      (
        Object.values(
          template.findResources('AWS::Lambda::Function', {
            Properties: { FunctionName: 'idp-v2-backend-api' },
          }),
        )[0] as { Properties: { Environment: { Variables: object } } }
      ).Properties.Environment.Variables;

    expect(env(synth())).not.toHaveProperty('DSA_NAME');
    expect(env(synth({ dsaName: 'Asha Verma Finserv' }))).toHaveProperty(
      'DSA_NAME',
      'Asha Verma Finserv',
    );
  });
});

describe('S3 upload rule: ignored keys', () => {
  it('ignores a locked customer PDF but not a document file', () => {
    const doc =
      'projects/proj_abc/documents/0b6f8f1e-1111-4222-8333-944445555666';
    const id = '0b6f8f1e-1111-4222-8333-944445555666';

    expect(
      wildcardMatches(UPLOAD_RULE_IGNORED_KEYS, `${doc}/locked/${id}.pdf`),
    ).toBe(true);
    expect(wildcardMatches(UPLOAD_RULE_IGNORED_KEYS, `${doc}/${id}.pdf`)).toBe(
      false,
    );
    expect(wildcardMatches(UPLOAD_RULE_IGNORED_KEYS, `${doc}/${id}.jpg`)).toBe(
      false,
    );
  });
});
