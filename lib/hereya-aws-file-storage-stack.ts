import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { Provider } from "aws-cdk-lib/custom-resources";

interface DeleteObjectsRule {
  /** Days to retain objects before S3 deletes them. */
  after: number;
  /**
   * Sub-prefix beneath this app's official prefix. Appended to the
   * fixed `<stackPrefix>/` to form the lifecycle rule's S3 prefix
   * filter `<stackPrefix>/<subPrefix>/`. Leading / trailing slashes
   * are trimmed.
   *
   * Example: subPrefix = "attachments" with stackPrefix "myapp-dev"
   *          → rule filter prefix "myapp-dev/attachments/".
   */
  subPrefix: string;
}

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

    // Prefix is deliberately NOT user-configurable — the package picks
    // it from the (collision-free, hereya-supplied) stack name so two
    // consumers of the same shared bucket can't accidentally claim the
    // same prefix by setting the same value.
    const prefix = this.stackName.toLowerCase();

    // Optional: lifecycle rules to apply under our prefix. Hereya
    // serializes complex parameters as JSON when passing them through
    // env vars; we parse here so callers can write structured YAML.
    const deleteObjects = parseDeleteObjects(process.env["deleteObjects"]);

    // IAM policy scoped to this app's prefix. Read/write at the object
    // level; list at the bucket level with a prefix condition.
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

    // Lifecycle rules — only provisioned if the consumer asked for any.
    // We do read-modify-write against the bucket's lifecycle config via
    // a Lambda-backed custom resource so multiple tenants of the same
    // shared bucket can each maintain their own rules without
    // clobbering each other. Rule IDs are prefixed with this stack's
    // prefix so on Delete we remove only OUR rules.
    if (deleteObjects.length > 0) {
      const lifecycleHandler = new lambda.Function(this, "LifecycleHandler", {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: "index.handler",
        timeout: cdk.Duration.seconds(60),
        // Inline so the package has zero asset wiring. ~1.5 KB — well
        // under the 4 KB Code.fromInline ceiling.
        code: lambda.Code.fromInline(LIFECYCLE_LAMBDA_CODE),
      });
      lifecycleHandler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: [
            "s3:GetLifecycleConfiguration",
            "s3:PutLifecycleConfiguration",
          ],
          resources: [bucketArn],
        }),
      );
      const provider = new Provider(this, "LifecycleProvider", {
        onEventHandler: lifecycleHandler,
      });
      const rulesForLambda = deleteObjects.map((d, i) => {
        const sub = d.subPrefix.replace(/^\/+|\/+$/g, "");
        const idTail = sub
          ? sub.replace(/[^a-zA-Z0-9-]/g, "_")
          : `root-${i}`;
        return {
          id: `${prefix}-${idTail}`,
          filterPrefix: sub ? `${prefix}/${sub}/` : `${prefix}/`,
          days: d.after,
        };
      });
      new cdk.CustomResource(this, "LifecycleRules", {
        serviceToken: provider.serviceToken,
        // CFN re-runs the CR on any property change — re-computes our
        // rule set fresh every time.
        properties: {
          bucketName,
          stackPrefix: prefix,
          rules: rulesForLambda,
          // Bump this whenever the inline Lambda code changes to force
          // CFN to recreate the resource (no-op otherwise).
          codeVersion: "1",
        },
      });
    }

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

function parseDeleteObjects(raw: string | undefined): DeleteObjectsRule[] {
  if (!raw || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `deleteObjects must be a JSON array (hereya serializes structured ` +
        `params as JSON when passing via env); failed to parse: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("deleteObjects must be an array");
  }
  return parsed.map((r, i) => {
    const after = (r as { after?: unknown }).after;
    const subPrefix = (r as { subPrefix?: unknown }).subPrefix;
    if (typeof after !== "number" || !Number.isFinite(after) || after < 1) {
      throw new Error(
        `deleteObjects[${i}].after must be a positive number (days), got ${JSON.stringify(after)}`,
      );
    }
    if (typeof subPrefix !== "string") {
      throw new Error(
        `deleteObjects[${i}].subPrefix must be a string, got ${JSON.stringify(subPrefix)}`,
      );
    }
    return { after, subPrefix };
  });
}

// Read-modify-write the bucket's lifecycle config. Other tenants' rules
// are preserved (we identify "ours" by an ID prefix); on Delete we strip
// only our rules. NodeJS 22 runtime ships the AWS SDK v3 at the top
// level so we can require it directly.
const LIFECYCLE_LAMBDA_CODE = `
const {
  S3Client,
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  DeleteBucketLifecycleCommand,
} = require('@aws-sdk/client-s3');

exports.handler = async (event) => {
  const { RequestType, ResourceProperties } = event;
  const { bucketName, stackPrefix, rules } = ResourceProperties;
  const s3 = new S3Client({ region: process.env.AWS_REGION });

  let existing = { Rules: [] };
  try {
    existing = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucketName }));
  } catch (err) {
    if (err.name !== 'NoSuchLifecycleConfiguration') throw err;
  }
  const myIdPrefix = stackPrefix + '-';
  const otherRules = (existing.Rules || []).filter(
    r => !(r.ID || '').startsWith(myIdPrefix),
  );

  let finalRules;
  if (RequestType === 'Delete') {
    finalRules = otherRules;
  } else {
    const ours = (rules || []).map(r => ({
      ID: r.id,
      Filter: { Prefix: r.filterPrefix },
      Status: 'Enabled',
      Expiration: { Days: r.days },
    }));
    finalRules = otherRules.concat(ours);
  }

  if (finalRules.length === 0) {
    try {
      await s3.send(new DeleteBucketLifecycleCommand({ Bucket: bucketName }));
    } catch (err) {
      if (err.name !== 'NoSuchLifecycleConfiguration') throw err;
    }
  } else {
    await s3.send(new PutBucketLifecycleConfigurationCommand({
      Bucket: bucketName,
      LifecycleConfiguration: { Rules: finalRules },
    }));
  }

  return {
    PhysicalResourceId: stackPrefix + '-lifecycle',
    Data: { applied: String(RequestType === 'Delete' ? 0 : (rules || []).length) },
  };
};
`;
