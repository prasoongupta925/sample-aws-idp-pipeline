import { Construct } from 'constructs';
import { ArnFormat, Stack } from 'aws-cdk-lib';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { SSM_KEYS } from '../../constants/ssm-keys.js';
import { bedrockModelInvokeResources } from '../../constants/bedrock.js';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { IQueue } from 'aws-cdk-lib/aws-sqs';
import {
  AgentRuntimeArtifact,
  Gateway,
  ProtocolType,
  Runtime,
} from '@aws-cdk/aws-bedrock-agentcore-alpha';

export interface IdpAgentProps {
  agentPath: string;
  agentName: string;
  sessionStorageBucket: IBucket;
  backendTable: ITable;
  gateway?: Gateway;
  bedrockModelId?: string;
  /**
   * Bedrock models the runtime may invoke besides its BEDROCK_MODEL_ID (e.g.
   * the chat models a user may pick). In-Region model ids only: the role may
   * invoke these models in the stack's Region and nothing else.
   */
  modelIds?: readonly string[];
  /** Read the chat model catalog parameter (the agent that validates model ids). */
  chatModelCatalog?: boolean;
  /** AgentCore Browser permissions (the web crawler). */
  browserAccess?: boolean;
  agentStorageBucket?: IBucket;
  /** Document storage bucket for reading/writing documents */
  documentBucket?: IBucket;
  websocketMessageQueue?: IQueue;
  codeInterpreterIdentifier?: string;
  backendUrl?: string;
  /** ARN of the chat agent runtime to invoke as a tool */
  chatAgentRuntimeArn?: string;
  /** Extra environment variables (applied last, so they win) */
  extraEnvironment?: Record<string, string>;
}

export class IdpAgent extends Construct {
  public readonly runtime: Runtime;

  constructor(scope: Construct, id: string, props: IdpAgentProps) {
    super(scope, id);

    const {
      agentPath,
      agentName,
      sessionStorageBucket,
      backendTable,
      gateway,
      bedrockModelId,
      modelIds = [],
      chatModelCatalog = false,
      browserAccess = false,
      agentStorageBucket,
      documentBucket,
      websocketMessageQueue,
      codeInterpreterIdentifier,
      backendUrl,
      chatAgentRuntimeArn,
      extraEnvironment,
    } = props;

    const dockerImage = AgentRuntimeArtifact.fromAsset(agentPath, {
      platform: Platform.LINUX_ARM64,
    });

    const environmentVariables: Record<string, string> = {
      SESSION_STORAGE_BUCKET_NAME: sessionStorageBucket.bucketName,
      BACKEND_TABLE_NAME: backendTable.tableName,
      ...(gateway?.gatewayUrl && { MCP_GATEWAY_URL: gateway.gatewayUrl }),
      ...(bedrockModelId && { BEDROCK_MODEL_ID: bedrockModelId }),
      ...(agentStorageBucket && {
        AGENT_STORAGE_BUCKET_NAME: agentStorageBucket.bucketName,
      }),
      ...(documentBucket && {
        DOCUMENT_BUCKET_NAME: documentBucket.bucketName,
      }),
      ...(websocketMessageQueue && {
        WEBSOCKET_MESSAGE_QUEUE_URL: websocketMessageQueue.queueUrl,
      }),
      ...(codeInterpreterIdentifier && {
        CODE_INTERPRETER_IDENTIFIER: codeInterpreterIdentifier,
      }),
      ...(backendUrl && { BACKEND_URL: backendUrl }),
      ...(chatAgentRuntimeArn && {
        CHAT_AGENT_RUNTIME_ARN: chatAgentRuntimeArn,
      }),
      ...extraEnvironment,
    };

    this.runtime = new Runtime(this, 'Runtime', {
      runtimeName: agentName,
      protocolConfiguration: ProtocolType.HTTP,
      agentRuntimeArtifact: dockerImage,
      environmentVariables,
    });

    if (gateway) {
      gateway.grantInvoke(this.runtime.role);
    }

    // Grant S3 read/write access for session storage
    sessionStorageBucket.grantReadWrite(this.runtime.role);

    // Grant S3 read/write access for agent storage (artifacts)
    if (agentStorageBucket) {
      agentStorageBucket.grantReadWrite(this.runtime.role);
    }

    // Grant S3 read/write access for document storage
    if (documentBucket) {
      documentBucket.grantReadWrite(this.runtime.role);
    }

    // Grant SQS send message for websocket notifications
    if (websocketMessageQueue) {
      websocketMessageQueue.grantSendMessages(this.runtime.role);
    }

    // Grant DynamoDB read/write access for backend table
    backendTable.grantReadWriteData(this.runtime.role);

    // Bedrock: only the models this runtime calls (its BEDROCK_MODEL_ID and
    // modelIds), in-Region foundation models only. The App's BedrockModelGuard
    // adds the deny statements (core/bedrock-model-guard.ts: AWS-sold models
    // only, nothing outside the stack's Region); no AWS Marketplace access is
    // granted. Search re-ranking runs in the search MCP Lambda, not here.
    const defaultModelId = environmentVariables.BEDROCK_MODEL_ID;
    const models = bedrockModelInvokeResources(
      [...(defaultModelId ? [defaultModelId] : []), ...modelIds],
      Stack.of(this).region,
    );
    if (models.length > 0) {
      this.runtime.addToRolePolicy(
        new iam.PolicyStatement({
          actions: [
            'bedrock:InvokeModel',
            'bedrock:InvokeModelWithResponseStream',
          ],
          resources: models,
        }),
      );
    }

    // Read the chat model catalog (created by CDK in AgentStack) to validate a
    // requested model_id against the allowlist.
    if (chatModelCatalog) {
      this.runtime.addToRolePolicy(
        new iam.PolicyStatement({
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
    }

    // AgentCore Browser permissions (complete set for browser automation)
    if (browserAccess) {
      this.runtime.addToRolePolicy(
        new iam.PolicyStatement({
          actions: [
            // Browser instance management
            'bedrock-agentcore:CreateBrowser',
            'bedrock-agentcore:DeleteBrowser',
            'bedrock-agentcore:GetBrowser',
            'bedrock-agentcore:ListBrowsers',
            // Browser session management
            'bedrock-agentcore:StartBrowserSession',
            'bedrock-agentcore:StopBrowserSession',
            'bedrock-agentcore:GetBrowserSession',
            'bedrock-agentcore:ListBrowserSessions',
            // Browser streaming
            'bedrock-agentcore:UpdateBrowserStream',
            'bedrock-agentcore:ConnectBrowserAutomationStream',
            'bedrock-agentcore:ConnectBrowserLiveViewStream',
          ],
          resources: ['*'],
        }),
      );
    }

    // Add API Gateway invoke permissions for backend API
    if (backendUrl) {
      this.runtime.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['execute-api:Invoke'],
          resources: ['arn:aws:execute-api:*:*:*'],
        }),
      );
    }

    // Add AgentCore invoke permissions for chat agent
    if (chatAgentRuntimeArn) {
      this.runtime.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['bedrock-agentcore:InvokeAgentRuntime'],
          resources: [chatAgentRuntimeArn, `${chatAgentRuntimeArn}/*`],
        }),
      );
    }
  }
}
