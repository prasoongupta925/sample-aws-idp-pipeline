import { Construct } from 'constructs';
import {
  ArnFormat,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
} from 'aws-cdk-lib';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { RuntimeConfig } from '../../core/runtime-config.js';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { SSM_KEYS } from '../../constants/ssm-keys.js';
import {
  FILE_CHECK_ASK_MODEL_ID,
  bedrockModelInvokeResources,
} from '../../constants/bedrock.js';
import {
  PDF_UNLOCK_FUNCTION_NAME,
  UPLOAD_TOKEN_HEADER,
} from '../../constants/upload-links.js';
import { getRetentionDays, toLogRetention } from '../retention-config.js';
import { Bucket, IBucket } from 'aws-cdk-lib/aws-s3';
import { Table, ITable } from 'aws-cdk-lib/aws-dynamodb';
import {
  Architecture,
  DockerImageCode,
  DockerImageFunction,
} from 'aws-cdk-lib/aws-lambda';
import {
  CfnApi,
  CfnStage,
  CorsHttpMethod,
  HttpApi,
  HttpMethod,
} from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { Grant, IGrantable, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Distribution } from 'aws-cdk-lib/aws-cloudfront';

function getBucketFromSsm(
  scope: Construct,
  id: string,
  ssmKey: string,
): { bucket: IBucket; bucketName: string } {
  const bucketName = StringParameter.valueForStringParameter(scope, ssmKey);
  const bucket = Bucket.fromBucketName(scope, id, bucketName);
  return { bucket, bucketName };
}

function getTableFromSsm(
  scope: Construct,
  id: string,
  ssmKey: string,
): { table: ITable; tableName: string } {
  const tableName = StringParameter.valueForStringParameter(scope, ssmKey);
  const table = Table.fromTableName(scope, id, tableName);
  return { table, tableName };
}

export interface BackendProps {
  /**
   * Model of POST /projects/{id}/file-check/ask (AWS-sold, in-Region models
   * only): the only model the backend may invoke.
   * @default FILE_CHECK_ASK_MODEL_ID
   */
  fileCheckAskModelId?: string;
  /**
   * Accept video uploads. False when the build has no model that reads video
   * (ap-south-1): the upload check then refuses video files with a message.
   * @default true
   */
  videoUploadsEnabled?: boolean;
  /**
   * Business name a customer upload page shows when the link sets none
   * (env DSA_NAME). Unset: the backend's default ("your loan advisor").
   */
  dsaName?: string;
}

/** Headers the web app sends: SigV4 (staff) and the upload link token (customer page). */
const CORS_ALLOW_HEADERS = [
  'authorization',
  'content-type',
  'x-amz-content-sha256',
  'x-amz-date',
  'x-amz-security-token',
  'x-user-id',
  UPLOAD_TOKEN_HEADER,
];

/** The customer upload page's routes: no authorizer, the link token is checked on every call. */
export const PUBLIC_ROUTE_PATH = '/public/{proxy+}';

/**
 * Throttle of each public route (requests per second, burst). A real customer
 * makes a few calls per file; this caps scripted traffic on the open routes.
 */
export const PUBLIC_ROUTE_THROTTLE = { rateLimit: 10, burstLimit: 20 };

export class Backend extends Construct {
  /** The FastAPI app (packages/backend image) behind the HTTP API. */
  public readonly handler: DockerImageFunction;
  public readonly api: HttpApi;

  constructor(scope: Construct, id: string, props: BackendProps = {}) {
    super(scope, id);

    const fileCheckAskModelId =
      props.fileCheckAskModelId ?? FILE_CHECK_ASK_MODEL_ID;
    const videoUploadsEnabled = props.videoUploadsEnabled ?? true;

    // Logs expire after retentionDays (default 7).
    const logGroup = new LogGroup(this, 'BackendLogGroup', {
      retention: toLogRetention(getRetentionDays(this)),
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const documentStorage = getBucketFromSsm(
      this,
      'DocumentStorageBucket',
      SSM_KEYS.DOCUMENT_STORAGE_BUCKET_NAME,
    );
    const lancedbLockTable = getTableFromSsm(
      this,
      'LancedbLockTable',
      SSM_KEYS.LANCEDB_LOCK_TABLE_NAME,
    );
    const backendTable = getTableFromSsm(
      this,
      'BackendTable',
      SSM_KEYS.BACKEND_TABLE_NAME,
    );
    const lancedbExpressBucketName = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.LANCEDB_EXPRESS_BUCKET_NAME,
    );
    const sessionStorage = getBucketFromSsm(
      this,
      'SessionStorageBucket',
      SSM_KEYS.SESSION_STORAGE_BUCKET_NAME,
    );
    const agentStorage = getBucketFromSsm(
      this,
      'AgentStorageBucket',
      SSM_KEYS.AGENT_STORAGE_BUCKET_NAME,
    );
    const stepFunctionArn = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.STEP_FUNCTION_ARN,
    );
    const qaRegeneratorFunctionArn = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.QA_REGENERATOR_FUNCTION_ARN,
    );
    const lancedbFunctionArn = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.LANCE_SERVICE_FUNCTION_ARN,
    );
    const graphServiceFunctionArn = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.GRAPH_SERVICE_FUNCTION_ARN,
    );
    const graphDeleteQueueUrl = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.GRAPH_DELETE_QUEUE_URL,
    );
    // Deterministic loan-file check Lambda (McpStack, deployed before this
    // stack) behind GET /projects/{id}/checklists and POST .../file-check.
    const fileCheckFunctionArn = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.FILE_CHECK_MCP_FUNCTION_ARN,
    );
    // CRM webhook delivery Lambda (WebhookStack, deployed before this stack)
    // behind POST /projects/{id}/integrations/webhook/test.
    const webhookFunctionArn = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.WEBHOOK_FUNCTION_ARN,
    );
    // KMS key of the webhook signing secrets (WebhookStack): Encrypt only.
    const webhookSecretKeyArn = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.WEBHOOK_SECRET_KEY_ARN,
    );

    // PDF unlock Lambda (WorkflowStack, deployed before this stack).
    const pdfUnlockFunctionArn = Stack.of(this).formatArn({
      service: 'lambda',
      resource: 'function',
      resourceName: PDF_UNLOCK_FUNCTION_NAME,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    // The FastAPI app runs unchanged on Lambda: the Lambda Web Adapter in the
    // image (packages/backend/Dockerfile) passes each API request to uvicorn
    // on port 8000. Nothing runs, or costs, while the API is idle. The HTTP API
    // answers the caller after 30 s, but the function keeps going for up to
    // 15 minutes, as the Fargate task did: a long delete or an applicant erase
    // finishes instead of stopping half way.
    this.handler = new DockerImageFunction(this, 'Handler', {
      functionName: 'idp-v2-backend-api',
      description: 'Backend API (FastAPI on the Lambda Web Adapter)',
      code: DockerImageCode.fromImageAsset('../backend', {
        platform: Platform.LINUX_ARM64,
      }),
      architecture: Architecture.ARM_64,
      memorySize: 2048,
      timeout: Duration.minutes(15),
      logGroup,
      environment: {
        // gzip large JSON answers (chat history, graphs) so they stay far
        // below Lambda's 6 MB response limit.
        AWS_LWA_ENABLE_COMPRESSION: 'true',
        // AWS_REGION is reserved: Lambda sets it to the function's region.
        LANCEDB_LOCK_TABLE_NAME: lancedbLockTable.tableName,
        DOCUMENT_STORAGE_BUCKET_NAME: documentStorage.bucketName,
        BACKEND_TABLE_NAME: backendTable.tableName,
        LANCEDB_EXPRESS_BUCKET_NAME: lancedbExpressBucketName,
        SESSION_STORAGE_BUCKET_NAME: sessionStorage.bucketName,
        AGENT_STORAGE_BUCKET_NAME: agentStorage.bucketName,
        STEP_FUNCTION_ARN: stepFunctionArn,
        QA_REGENERATOR_FUNCTION_ARN: qaRegeneratorFunctionArn,
        LANCEDB_FUNCTION_NAME: lancedbFunctionArn,
        GRAPH_SERVICE_FUNCTION_NAME: graphServiceFunctionArn,
        GRAPH_DELETE_QUEUE_URL: graphDeleteQueueUrl,
        FILE_CHECK_FUNCTION_NAME: fileCheckFunctionArn,
        // File-check Ask: model, and the lifetime of its usage-ledger items
        // (DynamoDB TTL attribute expires_at, see StorageStack).
        FILE_CHECK_ASK_MODEL_ID: fileCheckAskModelId,
        RETENTION_DAYS: String(getRetentionDays(this)),
        WEBHOOK_FUNCTION_NAME: webhookFunctionArn,
        WEBHOOK_SECRET_KEY_ARN: webhookSecretKeyArn,
        // Upload check: refuse video files when the build has no video model.
        VIDEO_UPLOADS_ENABLED: String(videoUploadsEnabled),
        // Customer upload links: unlock password-protected PDFs.
        PDF_UNLOCK_FUNCTION_NAME: pdfUnlockFunctionArn,
        ...(props.dsaName ? { DSA_NAME: props.dsaName } : {}),
      },
    });

    // The function's role gets every permission the Fargate task role had.
    const role = this.handler.grantPrincipal;
    // The web app's S3 transfers are presigned with this role (5 minutes, one
    // object): upload = s3:PutObject on the document bucket, downloads =
    // s3:GetObject on the document and agent buckets. The read/write grants
    // below (needed anyway for listing, reading and deleting documents,
    // sessions, agents and artifacts) cover them; nothing extra is granted.
    documentStorage.bucket.grantReadWrite(role);
    sessionStorage.bucket.grantReadWrite(role);
    agentStorage.bucket.grantReadWrite(role);
    lancedbLockTable.table.grantReadWriteData(role);
    backendTable.table.grantReadWriteData(role);

    // Grant GSI query permissions (fromTableName doesn't include GSI permissions)
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [
          `${backendTable.table.tableArn}/index/GSI1`,
          `${backendTable.table.tableArn}/index/GSI2`,
        ],
      }),
    );

    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['s3express:*'],
        resources: ['*'],
      }),
    );

    // Grant read on the chat model catalog parameter (GET /chat/models). The
    // parameter is created by CDK (AgentStack) from chat-models.json.
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          Stack.of(this).formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: SSM_KEYS.CHAT_MODEL_CATALOG.replace(/^\//, ''),
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ],
      }),
    );

    // Grant Step Functions start execution permission for re-analysis
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['states:StartExecution'],
        resources: [stepFunctionArn],
      }),
    );

    // Grant Lambda invoke permission for QA regenerator, LanceDB, graph-service, graph-builder
    const graphBuilderFunctionArn = Stack.of(this).formatArn({
      service: 'lambda',
      resource: 'function',
      resourceName: 'idp-v2-graph-builder',
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [
          qaRegeneratorFunctionArn,
          lancedbFunctionArn,
          graphServiceFunctionArn,
          graphBuilderFunctionArn,
        ],
      }),
    );

    // Bedrock: the backend calls one model, the file-check Ask (Converse), in
    // this Region. The App's BedrockModelGuard adds the deny statements
    // (core/bedrock-model-guard.ts: AWS-sold models only, no model call
    // outside the Region). Search re-ranking runs in the search MCP Lambda.
    role.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'InvokeFileCheckAskModel',
        actions: ['bedrock:InvokeModel'],
        resources: bedrockModelInvokeResources(
          fileCheckAskModelId,
          Stack.of(this).region,
        ),
      }),
    );

    // File-check integration API: invoke only the file-check function.
    role.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'InvokeFileCheck',
        actions: ['lambda:InvokeFunction'],
        resources: [fileCheckFunctionArn],
      }),
    );

    // Customer upload links: the PDF unlock function only.
    role.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'InvokePdfUnlock',
        actions: ['lambda:InvokeFunction'],
        resources: [pdfUnlockFunctionArn],
      }),
    );

    // CRM webhook test event: invoke only the webhook delivery function.
    role.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'InvokeWebhookDelivery',
        actions: ['lambda:InvokeFunction'],
        resources: [webhookFunctionArn],
      }),
    );
    // New webhook signing secrets are stored encrypted. Encrypt only: the
    // backend never reads a stored secret back (only the webhook Lambda may
    // decrypt it).
    role.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'EncryptWebhookSecrets',
        actions: ['kms:Encrypt'],
        resources: [webhookSecretKeyArn],
        conditions: {
          StringEquals: {
            'kms:EncryptionContext:purpose': 'webhook-signing-secret',
          },
        },
      }),
    );

    // Grant SQS send for graph deletion queue
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['sqs:SendMessage'],
        resources: ['*'],
      }),
    );

    // Grant SageMaker endpoint management permissions
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: [
          'sagemaker:DescribeEndpoint',
          'sagemaker:UpdateEndpointWeightsAndCapacities',
        ],
        resources: ['*'],
      }),
    );

    // Grant CloudWatch alarm management permissions
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['cloudwatch:DescribeAlarms', 'cloudwatch:PutMetricAlarm'],
        resources: ['*'],
      }),
    );

    // HTTP API with IAM auth
    const authorizer = new HttpIamAuthorizer();

    this.api = new HttpApi(this, 'Api', {
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [CorsHttpMethod.ANY],
        allowHeaders: CORS_ALLOW_HEADERS,
      },
    });

    // Lambda proxy integration (payload 2.0); it also grants API Gateway
    // lambda:InvokeFunction for each route below.
    const integration = new HttpLambdaIntegration(
      'LambdaIntegration',
      this.handler,
    );

    this.api.addRoutes({
      path: '/{proxy+}',
      methods: [
        HttpMethod.GET,
        HttpMethod.POST,
        HttpMethod.PUT,
        HttpMethod.DELETE,
        HttpMethod.PATCH,
      ],
      integration,
      authorizer,
    });

    this.api.addRoutes({
      path: '/{proxy+}',
      methods: [HttpMethod.OPTIONS],
      integration,
    });

    // The customer upload page (no Cognito): GET and POST under /public/ only,
    // without an authorizer. The backend checks the link token on every call
    // and its public guard (app/public_guard.py) answers 403 to an
    // unauthenticated request for any other path. More specific than
    // /{proxy+}, so API Gateway picks this route for /public/... paths.
    const publicMethods = [HttpMethod.GET, HttpMethod.POST];
    this.api.addRoutes({
      path: PUBLIC_ROUTE_PATH,
      methods: publicMethods,
      integration,
    });
    const stage = this.api.defaultStage?.node.defaultChild;
    if (!(stage instanceof CfnStage)) {
      throw new Error('Unable to throttle public routes: no default CfnStage');
    }
    // routeSettings is raw JSON: CloudFormation's (PascalCase) key names.
    stage.routeSettings = Object.fromEntries(
      publicMethods.map((method) => [
        `${method} ${PUBLIC_ROUTE_PATH}`,
        {
          ThrottlingRateLimit: PUBLIC_ROUTE_THROTTLE.rateLimit,
          ThrottlingBurstLimit: PUBLIC_ROUTE_THROTTLE.burstLimit,
        },
      ]),
    );

    new CfnOutput(this, 'BackendUrl', {
      value: this.api.url ?? '',
    });

    RuntimeConfig.ensure(this).config.apis = {
      ...RuntimeConfig.ensure(this).config.apis,
      Backend: this.api.url,
    };
  }

  grantInvokeAccess(grantee: IGrantable) {
    Grant.addToPrincipal({
      grantee,
      actions: ['execute-api:Invoke'],
      resourceArns: [this.api.arnForExecuteApi('*', '/*', '*')],
    });
  }

  restrictCorsTo(...websites: { cloudFrontDistribution: Distribution }[]) {
    const allowedOrigins = websites.map(
      ({ cloudFrontDistribution }) =>
        `https://${cloudFrontDistribution.distributionDomainName}`,
    );

    const cfnApi = this.api.node.defaultChild;
    if (!(cfnApi instanceof CfnApi)) {
      throw new Error(
        'Unable to configure CORS: API default child is not a CfnApi instance',
      );
    }

    cfnApi.corsConfiguration = {
      allowOrigins: [
        'http://localhost:4200',
        'http://localhost:4300',
        ...allowedOrigins,
      ],
      allowMethods: [CorsHttpMethod.ANY],
      allowHeaders: CORS_ALLOW_HEADERS,
      allowCredentials: true,
    };
  }
}
