import { ArnFormat, Duration, Stack } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import * as path from 'path';
import { SSM_KEYS } from '../../constants/ssm-keys.js';
import { getRegionConfig } from '../../core/region-config.js';

/**
 * Model of the search-result summaries (search___summarize, and the graph
 * tools): in-Region and AWS-sold, so no cross-Region inference profile.
 */
const SUMMARIZE_MODEL_ID = 'openai.gpt-oss-120b-1:0';

/** Amazon Rerank, used only where the region config enables re-ranking. */
const RERANK_MODEL_ID = 'amazon.rerank-v1:0';

export class SearchMcp extends Construct {
  public readonly function: NodejsFunction;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const documentStorageBucketName = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.DOCUMENT_STORAGE_BUCKET_NAME,
    );
    const documentStorageBucket = Bucket.fromBucketName(
      this,
      'DocumentStorageBucket',
      documentStorageBucketName,
    );

    const lancedbFunctionArn = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.LANCE_SERVICE_FUNCTION_ARN,
    );

    const graphServiceFunctionArn = Stack.of(this).formatArn({
      service: 'lambda',
      resource: 'function',
      resourceName: 'idp-v2-graph-service',
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    // ap-south-1 has no reranking model: search___rerank then keeps the
    // LanceDB hybrid order (region config rerankEnabled, context enableRerank).
    const regionConfig = getRegionConfig(this);
    const rerankRegion = regionConfig.rerankEnabled
      ? regionConfig.rerankRegion
      : undefined;

    this.function = new NodejsFunction(this, 'Function', {
      entry: path.resolve(
        process.cwd(),
        '../../packages/lambda/search-mcp/src/handler.ts',
      ),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.minutes(5),
      memorySize: 256,
      environment: {
        LANCEDB_FUNCTION_ARN: lancedbFunctionArn,
        GRAPH_SERVICE_FUNCTION_ARN: graphServiceFunctionArn,
        DOCUMENT_STORAGE_BUCKET: documentStorageBucketName,
        SUMMARIZE_MODEL_ID,
        RERANK_ENABLED: String(rerankRegion !== undefined),
        ...(rerankRegion
          ? { RERANK_MODEL_ID, RERANK_REGION: rerankRegion }
          : {}),
      },
    });

    documentStorageBucket.grantRead(this.function);

    this.function.addToRolePolicy(
      new PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [lancedbFunctionArn, graphServiceFunctionArn],
      }),
    );

    // Bedrock: the summary model in this region, plus Amazon Rerank only where
    // re-ranking is on. AWS-sold models only: the App's BedrockModelGuard adds
    // the deny statements (core/bedrock-model-guard.ts).
    this.function.addToRolePolicy(
      new PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${Stack.of(this).region}::foundation-model/${SUMMARIZE_MODEL_ID}`,
        ],
      }),
    );
    if (rerankRegion) {
      // Rerank authorizes no resource; it also needs InvokeModel on the
      // reranking model.
      this.function.addToRolePolicy(
        new PolicyStatement({ actions: ['bedrock:Rerank'], resources: ['*'] }),
      );
      this.function.addToRolePolicy(
        new PolicyStatement({
          actions: ['bedrock:InvokeModel'],
          resources: [
            `arn:aws:bedrock:${rerankRegion}::foundation-model/${RERANK_MODEL_ID}`,
          ],
        }),
      );
    }

    new StringParameter(this, 'FunctionArnParam', {
      parameterName: SSM_KEYS.SEARCH_MCP_FUNCTION_ARN,
      stringValue: this.function.functionArn,
      description: 'ARN of the Search MCP Lambda function',
    });

    if (this.function.role) {
      new StringParameter(this, 'RoleArnParam', {
        parameterName: SSM_KEYS.SEARCH_MCP_ROLE_ARN,
        stringValue: this.function.role.roleArn,
        description: 'ARN of the Search MCP Lambda role',
      });
    }
  }
}
