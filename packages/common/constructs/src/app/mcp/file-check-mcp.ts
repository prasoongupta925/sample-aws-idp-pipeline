import { Duration } from 'aws-cdk-lib';
import {
  Architecture,
  Code,
  Function as LambdaFunction,
  Runtime,
} from 'aws-cdk-lib/aws-lambda';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import * as path from 'path';
import { SSM_KEYS } from '../../constants/ssm-keys.js';

/**
 * File Check MCP Lambda: exposes run_file_check / list_checklists. A
 * deterministic (no LLM) engine loads the per-document facts of a project
 * (PROJ#{pid} DOC# and FACTS# items), groups documents by applicant and applies
 * a bundled loan-product checklist, returning READY / NOT READY with findings
 * that cite document names. Pure Python standard library plus the runtime's
 * boto3, so no layer is needed.
 */
export class FileCheckMcp extends Construct {
  public readonly function: LambdaFunction;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const backendTableName = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.BACKEND_TABLE_NAME,
    );
    const backendTable = Table.fromTableName(
      this,
      'BackendTable',
      backendTableName,
    );

    this.function = new LambdaFunction(this, 'Function', {
      functionName: 'idp-v2-file-check-mcp',
      runtime: Runtime.PYTHON_3_13,
      architecture: Architecture.ARM_64,
      handler: 'index.handler',
      timeout: Duration.seconds(30),
      memorySize: 256,
      code: Code.fromAsset(
        path.resolve(process.cwd(), '../../packages/lambda/file-check-mcp'),
        { exclude: ['test_*.py', '__pycache__', 'convert_checklists.py'] },
      ),
      environment: {
        BACKEND_TABLE_NAME: backendTableName,
      },
    });

    // Base-table Query on PK=PROJ#{pid} only (no GSI access needed).
    backendTable.grantReadData(this.function);
  }
}
