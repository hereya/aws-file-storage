#!/usr/bin/env node
import * as cdk from "aws-cdk-lib/core";
import { HereyaAwsFileStorageStack } from "../lib/hereya-aws-file-storage-stack";

const app = new cdk.App();
new HereyaAwsFileStorageStack(app, process.env.STACK_NAME!, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
