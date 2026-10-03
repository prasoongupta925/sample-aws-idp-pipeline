import {
  Backend,
  Frontend,
  RuntimeConfig,
  UserIdentity,
  SSM_KEYS,
  getRegionConfig,
} from ':idp-v2/common-constructs';
import { Stack, StackProps } from 'aws-cdk-lib';
import { PolicyStatement, Role } from 'aws-cdk-lib/aws-iam';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { VIDEO_ANALYSIS_ENABLED } from '../video-analysis.js';

export class ApplicationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // The web app only names the document bucket in the s3:// references it
    // sends to the agent (which reads them with its own role); the browser
    // itself has no S3 access.
    const documentStorageBucketName = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.DOCUMENT_STORAGE_BUCKET_NAME,
    );
    RuntimeConfig.ensure(this).config.documentStorageBucketName =
      documentStorageBucketName;

    const agentRuntimeArn = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.AGENT_RUNTIME_ARN,
    );
    RuntimeConfig.ensure(this).config.agentRuntimeArn = agentRuntimeArn;

    // The built-in voice chat (BidiAgent) exists only where region config
    // voiceChatEnabled says so (AgentStack then creates it and this
    // parameter). Without it the web app gets no bidiAgentRuntimeArn and hides
    // the mic and the Voice Chat item.
    if (getRegionConfig(this).voiceChatEnabled) {
      const bidiAgentRuntimeArn = StringParameter.valueForStringParameter(
        this,
        SSM_KEYS.BIDI_AGENT_RUNTIME_ARN,
      );
      RuntimeConfig.ensure(this).config.bidiAgentRuntimeArn =
        bidiAgentRuntimeArn;
    }

    // No video model in this build (video-analysis.ts): the web app leaves
    // video out of its upload picker and the backend refuses video uploads.
    RuntimeConfig.ensure(this).config.videoUploadsEnabled =
      VIDEO_ANALYSIS_ENABLED;

    // Bedrock Data Automation runs through a cross-Region profile: where
    // region config bdaEnabled is false (ap-south-1) the web app hides the
    // upload's BDA option (the workflow skips the step anyway).
    RuntimeConfig.ensure(this).config.bdaEnabled =
      getRegionConfig(this).bdaEnabled;

    const websocketCallbackUrl = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.WEBSOCKET_CALLBACK_URL,
    );
    RuntimeConfig.ensure(this).config.websocketUrl = websocketCallbackUrl;

    const userIdentity = new UserIdentity(this, 'UserIdentity');

    // Add post-confirmation trigger to save user data to DynamoDB
    const backendTableName = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.BACKEND_TABLE_NAME,
    );
    const backendTable = TableV2.fromTableName(
      this,
      'BackendTable',
      backendTableName,
    );
    userIdentity.addPostAuthenticationTrigger(backendTable);

    const backend = new Backend(this, 'Backend', {
      videoUploadsEnabled: VIDEO_ANALYSIS_ENABLED,
      // Customer upload links: the business name their page shows (context dsaName).
      dsaName: this.node.tryGetContext('dsaName'),
    });

    const frontend = new Frontend(this, 'Frontend');
    // Publish a new web app only after the backend function it calls runs the
    // new code (CloudFormation waits for the Lambda update to finish), so a new
    // bundle never goes live against an old backend.
    frontend.bucketDeployment.node.addDependency(backend.handler);

    new StringParameter(this, 'BackendUrlParam', {
      parameterName: SSM_KEYS.BACKEND_URL,
      stringValue: backend.api.url ?? '',
      description: 'Backend API URL',
    });

    // Grant SearchMcp Lambda access to Backend API
    const searchMcpRoleArn = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.SEARCH_MCP_ROLE_ARN,
    );
    const searchMcpRole = Role.fromRoleArn(
      this,
      'SearchMcpRole',
      searchMcpRoleArn,
    );
    backend.grantInvokeAccess(searchMcpRole);

    backend.restrictCorsTo(frontend);

    // Caller roles (app/caller.py): the backend reads the signed-in user's
    // Cognito groups (admin / handler / viewer) from this pool only.
    backend.handler.addEnvironment(
      'USER_POOL_ID',
      userIdentity.userPool.userPoolId,
    );
    userIdentity.userPool.grant(
      backend.handler,
      'cognito-idp:ListUsers',
      'cognito-idp:AdminListGroupsForUser',
      // Admin Users page (app/admin_users.py), checked as admin-only in the API.
      'cognito-idp:ListUsersInGroup',
      'cognito-idp:AdminGetUser',
      'cognito-idp:AdminCreateUser',
      'cognito-idp:AdminDisableUser',
      'cognito-idp:AdminEnableUser',
      'cognito-idp:AdminUserGlobalSignOut',
      'cognito-idp:AdminResetUserPassword',
      'cognito-idp:AdminAddUserToGroup',
      'cognito-idp:AdminRemoveUserFromGroup',
    );

    // Cognito authenticated role (every signed-in user). It has NO S3
    // permissions: uploads and downloads use presigned URLs that the backend
    // issues for one object after its checks (project prefix, caller's
    // artifact prefix, file type and size; 5-minute expiry). What it keeps:
    // - execute-api:Invoke on the backend API (all app data goes through it);
    // - AgentCore InvokeAgentRuntime(+WebSocketStream) for chat and voice;
    // - execute-api on the WebSocket API for live status updates.
    backend.grantInvokeAccess(userIdentity.identityPool.authenticatedRole);

    // Grant Bedrock Agentcore invoke permission
    userIdentity.identityPool.authenticatedRole.addToPrincipalPolicy(
      new PolicyStatement({
        actions: [
          'bedrock-agentcore:InvokeAgentRuntime',
          'bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream',
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/*`,
        ],
      }),
    );

    // Grant WebSocket API manage connections permission
    const websocketApiId = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.WEBSOCKET_API_ID,
    );

    userIdentity.identityPool.authenticatedRole.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['execute-api:Invoke', 'execute-api:ManageConnections'],
        resources: [
          `arn:aws:execute-api:${this.region}:${this.account}:${websocketApiId}/*`,
        ],
      }),
    );

    // Grant WebSocket connect Lambda access to Cognito AdminGetUser
    const websocketConnectRoleArn = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.WEBSOCKET_CONNECT_ROLE_ARN,
    );
    const websocketConnectRole = Role.fromRoleArn(
      this,
      'WebSocketConnectRole',
      websocketConnectRoleArn,
      { mutable: true },
    );
    userIdentity.userPool.grant(
      websocketConnectRole,
      'cognito-idp:AdminGetUser',
    );
  }
}
