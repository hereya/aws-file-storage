import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

export class HereyaAwsFileStorageStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucketArn = process.env["bucketArn"];
    if (!bucketArn) {
      throw new Error("bucketArn environment variable is required");
    }

    const bucketName = process.env["bucketName"];
    if (!bucketName) {
      throw new Error("bucketName environment variable is required");
    }

    // Prefix for this app's files. Defaults to the stack name (sanitized).
    const prefix = process.env["prefix"] || this.stackName.toLowerCase();

    // IAM policy scoped to this app's prefix
    const policyDocument = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
          resources: [`${bucketArn}/${prefix}/*`],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["s3:ListBucket"],
          resources: [bucketArn],
          conditions: {
            StringLike: { "s3:prefix": [`${prefix}/*`] },
          },
        }),
      ],
    });

    new cdk.CfnOutput(this, "bucketName", {
      value: bucketName,
      description: "The name of the shared S3 bucket",
    });

    new cdk.CfnOutput(this, "s3Prefix", {
      value: prefix,
      description: "The S3 key prefix assigned to this app",
    });

    new cdk.CfnOutput(this, "awsRegion", {
      value: this.region,
      description: "The AWS region",
    });

    new cdk.CfnOutput(this, "iamPolicyAwsS3Bucket", {
      value: JSON.stringify(policyDocument.toJSON()),
      description:
        "IAM policy document scoped to this app prefix in the shared bucket",
    });
  }
}
