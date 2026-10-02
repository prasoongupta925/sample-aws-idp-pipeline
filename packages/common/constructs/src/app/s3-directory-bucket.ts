import {
  Names,
  RemovalPolicy,
  Stack,
  aws_iam,
  aws_s3express,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface S3DirectoryBucketProps {
  readonly bucketPrefix: string;
  readonly availabilityZoneId: string;
}

export class S3DirectoryBucket extends Construct {
  public readonly bucket: aws_s3express.CfnDirectoryBucket;
  public readonly bucketName: string;
  public readonly bucketArn: string;

  constructor(scope: Construct, id: string, props: S3DirectoryBucketProps) {
    super(scope, id);

    const { bucketPrefix, availabilityZoneId } = props;

    const hash = Names.uniqueId(this).slice(-8).toLowerCase();
    const account = Stack.of(this).account;
    this.bucketName = `${bucketPrefix}-${account}-${hash}--${availabilityZoneId}--x-s3`;

    this.bucket = new aws_s3express.CfnDirectoryBucket(
      this,
      'DirectoryBucket',
      {
        bucketName: this.bucketName,
        dataRedundancy: 'SingleAvailabilityZone',
        locationName: availabilityZoneId,
        // Like S3Bucket: the parts of an upload that never completed (its
        // writer was killed, e.g. at a Lambda timeout) are invisible and kept
        // forever otherwise. No rule expires objects: a completed object can
        // be a live file of a LanceDB table.
        lifecycleConfiguration: {
          rules: [
            {
              id: 'abort-incomplete-mpu',
              status: 'Enabled',
              abortIncompleteMultipartUpload: { daysAfterInitiation: 1 },
            },
          ],
        },
      },
    );

    this.bucket.applyRemovalPolicy(RemovalPolicy.DESTROY);

    // S3 Lifecycle works on a directory bucket only through ReadWrite
    // sessions of its service principal.
    new aws_s3express.CfnBucketPolicy(this, 'LifecyclePolicy', {
      bucket: this.bucket.ref,
      policyDocument: new aws_iam.PolicyDocument({
        statements: [
          new aws_iam.PolicyStatement({
            sid: 'AllowS3LifecycleSessions',
            principals: [
              new aws_iam.ServicePrincipal('lifecycle.s3.amazonaws.com'),
            ],
            actions: ['s3express:CreateSession'],
            resources: [this.bucket.attrArn],
            conditions: {
              StringEquals: { 's3express:SessionMode': 'ReadWrite' },
            },
          }),
        ],
      }),
    });

    this.bucketArn = `arn:aws:s3express:*:*:bucket/${this.bucketName}`;
  }
}
