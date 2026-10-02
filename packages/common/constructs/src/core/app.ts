import {
  App as _App,
  AppProps,
  AspectPriority,
  Aspects,
  IAspect,
  Stack,
} from 'aws-cdk-lib';
import { IConstruct } from 'constructs';
import { BedrockModelGuard } from './bedrock-model-guard.js';

export class App extends _App {
  constructor(props?: AppProps) {
    super(props);

    Aspects.of(this).add(new MetricsAspect());
    // AWS-sold models only: every policy that allows a Bedrock model call gets
    // the deny statements (core/bedrock-model-guard.ts).
    Aspects.of(this).add(new BedrockModelGuard(), {
      priority: AspectPriority.MUTATING,
    });
  }
}

/**
 * Adds information to CloudFormation stack descriptions to provide usage metrics for @aws/nx-plugin
 */
class MetricsAspect implements IAspect {
  visit(node: IConstruct): void {
    if (node instanceof Stack) {
      const id = 'uksb-4wk0bqpg5s';
      const version = '0.64.1';
      const tags: string[] = ['g8', 'g5', 'g7', 'g6', 'g2', 'g3', 'g1'];
      node.templateOptions.description = `${
        node.templateOptions.description ?? ''
      } (${id}) (version:${version}) (tag:${tags.join(',')})`.trim();
    }
  }
}
