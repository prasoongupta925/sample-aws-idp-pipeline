// @vitest-environment node
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { S3DirectoryBucket } from './s3-directory-bucket.js';

function synth(): Template {
  const stack = new Stack(new App(), 'Storage');
  new S3DirectoryBucket(stack, 'ExpressStorage', {
    bucketPrefix: 'lancedb-ex',
    availabilityZoneId: 'aps1-az1',
  });
  return Template.fromStack(stack);
}

const BUCKET_ID = Match.stringLikeRegexp('^ExpressStorageDirectoryBucket');

describe('S3DirectoryBucket', () => {
  it('only aborts incomplete multipart uploads: no object ever expires', () => {
    const buckets = synth().findResources('AWS::S3Express::DirectoryBucket');
    const [bucket] = Object.values(buckets);

    expect(Object.keys(buckets)).toHaveLength(1);
    // An expiry would delete files that LanceDB tables still use.
    expect(bucket.Properties.LifecycleConfiguration).toEqual({
      Rules: [
        {
          Id: 'abort-incomplete-mpu',
          Status: 'Enabled',
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
        },
      ],
    });
    expect(bucket.DeletionPolicy).toBe('Delete');
  });

  it('lets S3 Lifecycle open ReadWrite sessions on this bucket only', () => {
    const template = synth();

    template.resourceCountIs('AWS::S3Express::BucketPolicy', 1);
    template.hasResourceProperties('AWS::S3Express::BucketPolicy', {
      Bucket: { Ref: BUCKET_ID },
      PolicyDocument: {
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'lifecycle.s3.amazonaws.com' },
            Action: 's3express:CreateSession',
            Resource: { 'Fn::GetAtt': [BUCKET_ID, 'Arn'] },
            Condition: {
              StringEquals: { 's3express:SessionMode': 'ReadWrite' },
            },
          },
        ],
      },
    });
  });
});
