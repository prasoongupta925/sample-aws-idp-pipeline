# Lean edition (serverless only)

Same app as the full edition: same UI, document pipeline, agents, file check and eligibility page.
What changes is only what it runs on: no VPC/NAT, no Neptune, no ElastiCache, no Fargate/ALB and,
by default, no WAF. Everything left is pay per use, so the stack costs about $3 a month when idle
(see COST.md).

## Fresh deploy (the normal path)

1. Push the branch. The build clones it from GitHub (`--repo`, default the fork), not from this working copy.
2. Run `deploy/lean/deploy.sh`. It creates the CodeBuild project the first time, bootstraps CDK when the region
   has no bootstrap yet and deploys the 15 stacks. The admin user (`ADMIN_USER_EMAIL`) gets its temporary
   password by email.
3. Seed the demo data (logins, sample loan files) with the demo seed script. It is kept outside this repository
   because it holds the demo users. Run it only after `deploy.sh` has succeeded: it reads the API URL from the
   `IDP-V2-Application` stack outputs.

This account stops every CodeBuild build after 45 minutes, and a fresh deploy can need more than one build.
`deploy.sh` handles that itself. When the cap stops a build, it waits until no stack is mid-operation and starts
the next build with the same settings; stacks that are already deployed are no-ops there. It starts at most
4 builds (`MAX_BUILDS=6 deploy/lean/deploy.sh` for more). For each build it prints the result, the minutes, the
error lines of the log and the stack states, and it exits 0 only when the last build SUCCEEDED. If it stops
early, run it again: finished stacks are skipped.

`deploy.sh` will not start while `deploy/lean/destroy.sh` is running, because the last steps of a destroy delete
the idp-v2 tables, buckets and parameters. It also will not start while another build of the deploy project runs.

## Commands (profile `idp-demo`, region `ap-south-1`)

| What | Command | Needs |
|---|---|---|
| First deploy / full update | `deploy/lean/deploy.sh` | branch pushed to GitHub |
| Code-only update (Lambda, Step Functions, container images) | `deploy/lean/deploy.sh --hotswap` | same |
| Some stacks only | `deploy/lean/deploy.sh --stacks "IDP-V2-Application IDP-V2-Workflow"` | same |
| Web app only | `deploy/lean/update-frontend.sh` (`--no-build` publishes the bundle already built) | local Node 22 + pnpm |
| Destroy everything (keeps the CDK bootstrap) | `deploy/lean/destroy.sh` | - |
| Destroy including CodeBuild project + bootstrap | `deploy/lean/destroy.sh --all` | - |
| CloudFront WAF back on | `deploy/lean/deploy.sh --waf`, on every later deploy too | us-east-1 bootstrap (done by the build) |

A deploy without `--waf` detaches the WAF from CloudFront, but its us-east-1 stack stays (and bills) until
`destroy.sh` removes it.

## Converting a running full edition

`deploy/lean/migrate-from-full.sh` is only for an account that still runs the FULL edition and has to keep its
URL, users and data. It deploys the lean stacks over the old ones, then deletes the Neptune, VPC and us-east-1
WAF stacks. A fresh deploy does not use it.

## What behaves differently from the full edition

- Knowledge graph: switched off. The graph service still answers (empty results), so search, chat and
  the pipeline work unchanged; the graph view is empty.
- Backend: the same FastAPI container runs on Lambda behind the same HTTP API (30 s per request, as before).
- Live updates: WebSocket connections are tracked in a DynamoDB table instead of Valkey.
- Session/agent list cache: off (DynamoDB answers directly).
