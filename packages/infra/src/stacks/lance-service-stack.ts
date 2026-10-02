import { Duration, Stack, StackProps, Token } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { RustFunction } from 'cargo-lambda-cdk';
import { Construct } from 'constructs';
import { SSM_KEYS, getRegionConfig } from ':idp-v2/common-constructs';
import models from '../models.json' with { type: 'json' };

/**
 * Embedding models the LanceDB service can call: lancedb-service
 * src/client/bedrock.rs speaks the Titan Text Embeddings V2 request format
 * (1024 dimensions, the LanceDB schema).
 */
const TITAN_TEXT_EMBEDDINGS_V2 = /^amazon\.titan-embed-text-v2:\d+$/;

export class LanceServiceStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Embeddings: Titan Text Embeddings V2 (models.json "embedding"), called
    // in this stack's Region (Titan V2 is offered in-Region in ap-south-1).
    const embeddingModelId = models.embedding;
    if (!TITAN_TEXT_EMBEDDINGS_V2.test(embeddingModelId)) {
      throw new Error(
        'models.json embedding must be a Titan Text Embeddings V2 model id ' +
          `(lancedb-service sends its request format), got "${embeddingModelId}". ` +
          'A different model also needs a re-index (deploy/lean/reindex.py).',
      );
    }
    const embeddingRegion = this.region;
    // Every model call stays in the stack's Region: the App's model guard
    // denies the others (DenyModelCallsOutsideRegion), so an embeddingRegion
    // that could never be called fails here instead.
    const configuredEmbeddingRegion = getRegionConfig(this).embeddingRegion;
    if (
      !Token.isUnresolved(embeddingRegion) &&
      configuredEmbeddingRegion !== embeddingRegion
    ) {
      throw new Error(
        `Embeddings run in ${embeddingRegion}, but embeddingRegion is ` +
          `${configuredEmbeddingRegion}: model calls outside ` +
          `${embeddingRegion} are denied. Deploy without -c embeddingRegion.`,
      );
    }

    const tokaFunction = new RustFunction(this, 'TokaFunction', {
      functionName: 'idp-v2-toka',
      manifestPath: '../lambda/toka',
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
    });

    new StringParameter(this, 'TokaFunctionNameParam', {
      parameterName: SSM_KEYS.TOKA_FUNCTION_NAME,
      stringValue: tokaFunction.functionName,
    });

    // LanceDB resources (from SSM)
    const lancedbExpressBucketName = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.LANCEDB_EXPRESS_BUCKET_NAME,
    );
    const lancedbLockTableName = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.LANCEDB_LOCK_TABLE_NAME,
    );
    const lancedbLockTable = dynamodb.Table.fromTableName(
      this,
      'LanceDBLockTable',
      lancedbLockTableName,
    );

    const lanceDbServiceFunction = new RustFunction(
      this,
      'LanceDbServiceFunction',
      {
        functionName: 'idp-v2-lance-service',
        manifestPath: '../lambda/lancedb-service',
        architecture: lambda.Architecture.ARM_64,
        memorySize: 1024,
        timeout: Duration.minutes(5),
        environment: {
          TOKA_FUNCTION_NAME: tokaFunction.functionName,
          LANCEDB_EXPRESS_BUCKET_NAME: lancedbExpressBucketName,
          LANCEDB_LOCK_TABLE_NAME: lancedbLockTableName,
          EMBEDDING_MODEL_ID: embeddingModelId,
          EMBEDDING_REGION: embeddingRegion,
        },
        bundling: {
          forcedDockerBundling: true,
          dockerOptions: {
            user: 'root',
          },
          commandHooks: {
            beforeBundling(): string[] {
              return [
                'apt-get update -qq && apt-get install -y -qq protobuf-compiler > /dev/null 2>&1',
              ];
            },
            afterBundling(): string[] {
              return [];
            },
          },
        },
      },
    );

    // Toka Lambda invoke
    tokaFunction.grantInvoke(lanceDbServiceFunction);

    // S3 Express One Zone (LanceDB storage)
    lanceDbServiceFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          's3express:CreateSession',
          's3:GetObject',
          's3:PutObject',
          's3:DeleteObject',
          's3:ListBucket',
        ],
        resources: [
          `arn:aws:s3express:${this.region}:${this.account}:bucket/${lancedbExpressBucketName}`,
          `arn:aws:s3express:${this.region}:${this.account}:bucket/${lancedbExpressBucketName}/*`,
        ],
      }),
    );

    // DynamoDB LanceDB Lock table
    lancedbLockTable.grantReadWriteData(lanceDbServiceFunction);

    // Bedrock: the embedding model only, in this Region (no inference profile,
    // no other Region). The App's BedrockModelGuard adds the deny statements
    // (common-constructs core/bedrock-model-guard.ts): AWS-sold models only,
    // no model call outside this Region.
    lanceDbServiceFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${embeddingRegion}::foundation-model/${embeddingModelId}`,
        ],
      }),
    );

    new StringParameter(this, 'LanceDbServiceFunctionArnParam', {
      parameterName: SSM_KEYS.LANCE_SERVICE_FUNCTION_ARN,
      stringValue: lanceDbServiceFunction.functionArn,
    });
  }
}
