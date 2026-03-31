# hereya-aws-file-storage

Provisions **scoped S3 access** for an app within a shared S3 bucket. Each app gets an isolated prefix (e.g., `my-app/*`) and an IAM policy that restricts access to only that prefix.

This package consumes the shared S3 bucket from `hereya/aws-s3-shared` (Stack 2). Its outputs flow into `hereyaProjectEnv` for the deploy package (`hereya/aws-mcp-app-lambda`), which attaches the scoped IAM policy to the app Lambda's execution role.

## Architecture

```
┌──────────────────────────────────────────┐
│          Shared S3 Bucket                │
│          (from hereya/aws-s3-shared)     │
│                                          │
│  my-app/*        <- This package scopes  │
│                     access to this prefix│
│  other-app/*     <- Other app's prefix   │
│  ...                                     │
└──────────────────────────────────────────┘
```

## AWS Resources Created

None. This package creates no AWS resources -- it only computes and exports a scoped IAM policy document and configuration values.

## Inputs

Configuration is provided via environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `bucketArn` | **Yes** | -- | The ARN of the shared S3 bucket (from `hereya/aws-s3-shared` output). |
| `bucketName` | **Yes** | -- | The name of the shared S3 bucket (from `hereya/aws-s3-shared` output). |
| `prefix` | No | `{stackName}` | The S3 key prefix for this app's files. Defaults to the sanitized stack name. All file operations are scoped to `{prefix}/*`. |

## Outputs

| Output | Description | Example Value |
|--------|-------------|---------------|
| `bucketName` | The name of the shared S3 bucket (pass-through). | `platform-my-stack` |
| `s3Prefix` | The S3 key prefix assigned to this app. Use as the root for all file operations. | `my-app` |
| `awsRegion` | The AWS region. | `us-east-1` |
| `iamPolicyAwsS3Bucket` | JSON-serialized IAM policy document scoped to this app's prefix. Grants `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on `{bucketArn}/{prefix}/*` and `s3:ListBucket` with prefix condition. | `{"Version":"2012-10-17","Statement":[...]}` |

## Usage with Hereya

```bash
hereya add hereya/aws-file-storage -p bucketArn=arn:aws:s3:::my-bucket -p bucketName=my-bucket
```

With custom prefix:

```bash
hereya add hereya/aws-file-storage -p bucketArn=arn:aws:s3:::my-bucket -p bucketName=my-bucket -p prefix=julie/recipes
```

### In a project with shared infrastructure

The `bucketArn` and `bucketName` inputs are automatically provided when `hereya/aws-s3-shared` is a dependency:

```yaml
packages:
  hereya/aws-s3-shared:
    version: 0.1.0
  hereya/aws-file-storage:
    version: 0.1.0
```

## How It Flows to the App Lambda

The `iamPolicyAwsS3Bucket` output key starts with `iamPolicy`, so the deploy package (`hereya/aws-mcp-app-lambda`) automatically detects it and attaches the policy statements to the app Lambda's execution role. The `bucketName` and `s3Prefix` values are passed as plain environment variables to the Lambda.

## Development

```bash
npm install
npm run build    # Compile TypeScript
npm run watch    # Watch mode
npx cdk synth    # Synthesize CloudFormation template
npx cdk deploy   # Deploy stack
```
