# Lean edition (serverless only)

Same app as the full edition: same UI, document pipeline, agents, file check and eligibility page.
What changes is only what it runs on: no VPC/NAT, no Neptune, no ElastiCache, no Fargate/ALB and,
by default, no WAF. Everything left is pay per use, so the stack costs about $3 a month when idle
(see COST.md).

## Commands (profile `idp-demo`, region `ap-south-1`)

| What | Command | Needs |
|---|---|---|
| First deploy / full update | `deploy/lean/deploy.sh` | branch pushed to GitHub |
| Code-only update (Lambda, Step Functions, container images) | `deploy/lean/deploy.sh --hotswap` | same |
| Some stacks only | `deploy/lean/deploy.sh --stacks "IDP-V2-Application IDP-V2-Workflow"` | same |
| Web app only | `deploy/lean/update-frontend.sh` | local Node 22 + pnpm |
| Destroy everything (keeps the CDK bootstrap) | `deploy/lean/destroy.sh` | - |
| Destroy including CodeBuild project + bootstrap | `deploy/lean/destroy.sh --all` | - |
| CloudFront WAF back on | `deploy/lean/deploy.sh --waf` | us-east-1 bootstrap (done by the build) |

`deploy.sh` starts one CodeBuild run with `deploy/lean/buildspec.yml`, prints each phase and how many
stacks are in progress, and ends with the app URL. The admin user gets its temporary password by email.

## What behaves differently from the full edition

- Knowledge graph: switched off. The graph service still answers (empty results), so search, chat and
  the pipeline work unchanged; the graph view is empty.
- Backend: the same FastAPI container runs on Lambda behind the same HTTP API (30 s per request, as before).
- Live updates: WebSocket connections are tracked in a DynamoDB table instead of Valkey.
- Session/agent list cache: off (DynamoDB answers directly).
