# Lean edition: cost and deploy time (ap-south-1, Mumbai)

The lean edition runs the same app (same UI, pipeline, agents and file check). It drops the six
resources that bill every hour whether anyone uses the app or not:

| Removed (always on) | What replaced it | Idle cost removed |
|---|---|---|
| NAT gateway + its public IPv4 (VPC stack) | nothing: no Lambda runs in a VPC any more | ~$1.4/day |
| Neptune Serverless (knowledge graph) | graph switched off (graph view stays empty) | ~$2.9/day |
| ElastiCache Serverless (WebSocket connections, list cache) | one DynamoDB on-demand table; list cache off | ~$0.3-3/day |
| ECS Fargate backend (1 vCPU, 2 GB) + load balancer + VPC link | same backend container on Lambda (Lambda Web Adapter) | ~$1.6/day |
| CloudFront WAF (us-east-1 stack) | off by default, `--waf` turns it back on | ~$0.3/day |

Measured on this account in September: the full edition idles at about **$7.6/day (~Rs 20,000/month)**.

## What still costs money when nobody uses it

| Item | Price (Mumbai) | Per month |
|---|---|---|
| 2 customer-managed KMS keys (webhook secrets, data) | $1 per key | $2 |
| S3 + DynamoDB storage of 7 days of demo files | $0.025/GB, DynamoDB 25 GB free | < $0.5 |
| CloudWatch Logs (7-day retention) | $0.67/GB ingested | < $0.5 |
| Cognito (up to 10,000 monthly users), CloudFront (1 TB, 10 M requests), Lambda (1 M requests, 400,000 GB-s) | free tier, always free | $0 |

**Idle: about $3/month (~Rs 260), i.e. ~$0.10/day, 98-99% less than the full edition.**

## Pay per use (only when the team works)

| Service | Mumbai price | Typical use |
|---|---|---|
| Amazon Nova 2 Lite (global profile) | $0.35 per 1 M input tokens, $2.95 per 1 M output | reading a page, facts, Ask answers |
| Lambda (arm64) | $0.0000133334 per GB-second, $0.20 per 1 M requests | pipeline steps, backend API |
| API Gateway HTTP API | $1.05 per 1 M requests | every screen action |
| API Gateway WebSocket | $1 per 1 M messages, $0.25 per 1 M connection-minutes | live progress in the UI |
| DynamoDB on-demand | $0.71 per 1 M writes, $0.1425 per 1 M reads | projects, documents, facts |
| Step Functions (standard) | $0.025 per 1,000 state transitions (4,000 free) | one run per document |
| Amazon Transcribe (batch) | $0.024 per audio minute | call QA |
| AgentCore Runtime | $0.0895 per vCPU-hour, $0.00945 per GB-hour, only while an answer is being produced | chat agents |

The app shows the real Nova cost of every document and every Ask answer (cost meter), so a pilot
reports its own rupees per file.

### Example month for one DSA branch (estimate, ~Rs 88 per USD)

500 loan files x 7 documents (3,500 documents), 2,000 Ask questions, 300 minutes of recorded calls:

| Part | Estimate |
|---|---|
| Nova reading + facts for 3,500 documents (~Rs 1.2 each) | ~Rs 4,200 |
| 2,000 Ask answers (~Rs 0.3 each) | ~Rs 600 |
| 300 call minutes (Transcribe) | ~Rs 630 |
| Lambda, Step Functions, API Gateway, DynamoDB, S3 | ~Rs 500-900 |
| Idle base (KMS, logs, storage) | ~Rs 260 |
| **Total** | **~Rs 6,000-6,600 per month** |

The same month on the full edition costs ~Rs 20,000 before any use.

## Deploy and destroy time

| Action | Full edition | Lean edition |
|---|---|---|
| First deploy | 60-80 min, several 45-min CodeBuild runs | `deploy/lean/deploy.sh`: fewer, faster stacks (no Neptune, NAT, ElastiCache or Fargate); if the 45-min cap stops a build, the script starts the next one itself |
| Code-only update | full CloudFormation update, 30+ min | `deploy.sh --hotswap` (Lambda/Step Functions code in place) |
| Web app only | same as a code update | `update-frontend.sh`, ~1-2 min, no build server |
| Destroy | ~60 min (Neptune, NAT, VPC ENIs, WAF) | `destroy.sh`, stacks in 3 parallel waves |

The lean stack has no VPC, so there are no Lambda network interfaces to wait for on delete, which was
the slowest part of every past teardown. Lean deploy times are not measured yet; `deploy.sh` prints the
minutes of every build, so the first fresh deploy will give the real number.

Prices: AWS Price List API for ap-south-1, 30 Sep 2026 (EC2/Lambda/DynamoDB/API Gateway/S3/KMS/CloudWatch),
AWS pricing pages for Transcribe, Step Functions, Bedrock and AgentCore.
