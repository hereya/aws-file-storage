# hereya-aws-file-storage

Provisions **scoped S3 access** for an app within a shared S3 bucket.
Each app gets an isolated prefix (e.g. `my-stack-name/*`) and an IAM
policy that restricts access to only that prefix. Optionally installs
S3 lifecycle rules under named sub-prefixes so attachment / temp /
report directories auto-expire.

This package consumes the shared S3 bucket from `hereya/aws-s3-shared`
(Stack 2). Its outputs flow into `hereyaProjectEnv` for the deploy
package (`hereya/aws-mcp-app-lambda`), which attaches the scoped IAM
policy to the app Lambda's execution role.

## Architecture

```
┌──────────────────────────────────────────┐
│          Shared S3 Bucket                │
│          (from hereya/aws-s3-shared)     │
│                                          │
│  my-stack/*                              │
│   ├── attachments/   <- 7-day lifecycle  │
│   ├── reports/       <- 30-day lifecycle │
│   └── ...                                │
│  other-stack/*       <- another tenant   │
└──────────────────────────────────────────┘
```

## AWS Resources Created

- An IAM policy document scoped to this app's prefix (output as a
  string for the deploy package to attach to the app Lambda).
- **Optional**: a Lambda + custom resource that read-modify-writes the
  shared bucket's S3 lifecycle config to add this app's rules without
  clobbering other tenants' rules. Only provisioned when `deleteObjects`
  is non-empty.

## Inputs

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `bucketArn` | **Yes** | — | The ARN of the shared S3 bucket (from `hereya/aws-s3-shared` output). |
| `bucketName` | **Yes** | — | The name of the shared S3 bucket (from `hereya/aws-s3-shared` output). |
| `deleteObjects` | No | `[]` | Array of `{after, subPrefix}`. For each entry, an S3 lifecycle rule is installed that expires objects under `{prefix}/{subPrefix}/` after `after` days. See below. |

### `deleteObjects` shape

```yaml
# hereyaconfig/hereyavars/hereya--aws-file-storage.yaml
deleteObjects:
  - after: 7
    subPrefix: attachments
  - after: 30
    subPrefix: reports
```

- `after`: positive integer, in **days**.
- `subPrefix`: string. Leading / trailing slashes are stripped. The
  rule's S3 prefix filter is the package's assigned prefix +
  `/<subPrefix>/`. Empty string is allowed and applies the lifecycle
  rule to the entire prefix.

Rule IDs are namespaced as `{stack-prefix}-{sub-prefix-sanitized}` so
multiple tenants of the same shared bucket can each install their own
rules. On uninstall the package strips only its own rules; rules
belonging to other tenants are preserved.

### Removed in v0.2.0

- `prefix`: previously user-configurable. Now derived from the stack
  name (which hereya guarantees is collision-free across projects +
  workspaces + packages). This change prevents two consumers of the
  same bucket from accidentally claiming the same prefix.

## Outputs

| Output | Description | Example Value |
|--------|-------------|---------------|
| `bucketName` | The name of the shared S3 bucket (pass-through). | `platform-...` |
| `s3Prefix` | The S3 key prefix assigned to this app. Use as the root for all file operations. | `my-stack-dev` |
| `awsRegion` | The AWS region. | `eu-west-1` |
| `iamPolicyAwsS3Bucket` | JSON-serialized IAM policy document scoped to this app's prefix. Grants `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on `{bucketArn}/{prefix}/*` and `s3:ListBucket` with prefix condition. | `{"Version":"2012-10-17",...}` |

## Usage

In a project's `hereya.yaml`:

```yaml
packages:
  hereya/aws-s3-shared:
    version: 0.1.0
  hereya/aws-file-storage:
    version: 0.2.0
```

`bucketArn` and `bucketName` are auto-supplied from
`hereya/aws-s3-shared`'s outputs. Configure `deleteObjects` (if you
want lifecycle rules) in `hereyaconfig/hereyavars/hereya--aws-file-storage.yaml`:

```yaml
deleteObjects:
  - after: 7
    subPrefix: attachments
```

## How outputs flow to the App Lambda

The `iamPolicyAwsS3Bucket` output key starts with `iamPolicy`, so the
deploy package (`hereya/aws-mcp-app-lambda` / `hereya/aws-app-lambda`)
automatically detects it and attaches the policy statements to the app
Lambda's execution role. The `bucketName` and `s3Prefix` values are
passed as plain environment variables.

## Development

```bash
npm install
npm run build    # Compile TypeScript
npm run watch    # Watch mode
npx cdk synth    # Synthesize CloudFormation template
npx cdk deploy   # Deploy stack
```

## Notes on lifecycle implementation

S3's `PutBucketLifecycleConfiguration` is a **replace** operation —
there's no native "add a rule" API. To support multi-tenant shared
buckets, this package's custom resource performs a read-modify-write:

1. `GetBucketLifecycleConfiguration` — read the current rule set.
2. Filter out rules whose ID starts with this stack's prefix
   (`{prefix}-`) — those are ours from a prior deploy.
3. Append the freshly-computed rules from `deleteObjects`.
4. `PutBucketLifecycleConfiguration` — write the merged set.

On stack delete, step 3 is skipped (we only remove our own rules). If
the merged set is empty, the entire lifecycle config is deleted.

This design means concurrent deploys of two different tenants can race
— the second writer wins and may briefly drop the first writer's rules
if their deploy started before the first writer's write landed. The
race window is small (sub-second) and resolves on the next deploy of
the affected tenant. If you need strict serialization, deploy stacks
sequentially.
