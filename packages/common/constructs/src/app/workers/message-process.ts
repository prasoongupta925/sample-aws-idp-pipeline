import { Duration, Stack } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { S3EventSourceV2 } from 'aws-cdk-lib/aws-lambda-event-sources';
import { IBucket, EventType } from 'aws-cdk-lib/aws-s3';
import { IQueue } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import * as path from 'path';
import {
  SESSION_NAME_MODEL_ID,
  bedrockModelInvokeResources,
} from '../../constants/bedrock.js';

export interface MessageProcessProps {
  bucket: IBucket;
  websocketMessageQueue: IQueue;
}

export class MessageProcess extends Construct {
  public readonly function: NodejsFunction;

  constructor(scope: Construct, id: string, props: MessageProcessProps) {
    super(scope, id);

    this.function = new NodejsFunction(this, 'Function', {
      entry: path.resolve(
        process.cwd(),
        '../../packages/lambda/session_workers/src/message_process/index.ts',
      ),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(30),
      environment: {
        WEBSOCKET_MESSAGE_QUEUE_URL: props.websocketMessageQueue.queueUrl,
      },
    });

    props.bucket.grantReadWrite(this.function);
    props.websocketMessageQueue.grantSendMessages(this.function);

    // Session names (generate-session-name.ts): its one model, in this Region.
    // The App's BedrockModelGuard adds the deny statements
    // (core/bedrock-model-guard.ts: AWS-sold models only, no model call
    // outside the Region).
    this.function.addToRolePolicy(
      new PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: bedrockModelInvokeResources(
          SESSION_NAME_MODEL_ID,
          Stack.of(this).region,
        ),
      }),
    );

    this.function.addEventSource(
      new S3EventSourceV2(props.bucket, {
        events: [EventType.OBJECT_CREATED],
        filters: [{ prefix: 'sessions/', suffix: '.json' }],
      }),
    );
  }
}
