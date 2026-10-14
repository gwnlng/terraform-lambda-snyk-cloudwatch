# Snyk audit log transfer

EventBridge Scheduler (hourly) -> Step Functions -> `GetSnykOrgs` (generator) -> Map -> `TransferAuditLogs` (worker per org).

- **GetSnykOrgs** calls `GET /rest/groups/{group_id}/orgs` (paginated) and returns `{orgs: [{SnykOrgId, from, to}]}`. The window is the previous full UTC hour relative to the scheduled time, in RFC3339 (e.g. `2024-01-02T15:00:00Z`).
- **TransferAuditLogs** first deletes any existing streams for the window (prefix `<orgId>/<from>/`), then calls `GET /rest/orgs/{org_id}/audit_logs/search?from=&to=`, writes the events to a new stream in the CloudWatch log group `/snyk/<prefix>/audit-logs` (stream `<orgId>/<from>/<requestId>`), then writes `{OrgID, from, to, status}` to DynamoDB. `status` is `Completed` or `Failure`. On a caught failure the Lambda deletes its own stream, writes `Failure`, and rethrows so Step Functions marks that item failed. Other orgs keep processing.
- Both Lambdas run in private subnets with NAT egress, written in TypeScript, bundled with esbuild to Node.js 22 (`lambda/dist`); `@aws-sdk/*` comes from the Lambda runtime.

## Exactly-once delivery
Invariant: a window `[from, to)` has at most one stream under `<orgId>/<from>/`, and it holds data only from a run that succeeded. A retry or re-run replaces the previous stream instead of adding a second copy.

- **Caught failure:** the worker deletes the stream it created *before* writing the `Failure` row, so a `Failure` row means no partial data remains. A failed delete is logged and never masks the original error.
- **Timeout / out-of-memory:** the process dies before any `catch` runs, so nothing is cleaned up at that point. The state machine retries `Lambda.Unknown` and `States.Timeout` (plus the Lambda service errors), and
- **Every attempt starts clean:** before creating its stream, the worker deletes all streams with the prefix `<orgId>/<from>/` (stale partials from a killed run, or the previous copy on a manual re-run). If this cleanup fails the run fails before writing anything.

Cleanup is prefix-based on purpose. Step Functions exposes the failed invocation's RequestId only inside the error `Cause` text (and the Map tolerates item failures), so it can't be relied on to find the stream.

The worker role needs `logs:CreateLogStream`, `logs:PutLogEvents`, `logs:DeleteLogStream` and `logs:DescribeLogStreams` (granted in `lambda.tf`).

## API Access Tokens
Step Functions stores every state input in execution history, so sensitive API tokens will not stored in the Lambda function event at trigger. Both Lambdas read it from Secrets Manager instead. The worker event stores `SnykOrgId`, `from`, `to`.

## Granular Scoped API Calls
For scalability and concurrency design, the transfer_audit_logs Lambda function can switch to use a SnykOrg-scoped service account API token.

## Deploy
The Lambdas must be built before Terraform runs: `make build` zips `lambda/dist` into `lambda/function.zip`, which both modules use via `local_existing_package`.
```
make install                       # npm install in lambda/
make build                         # typecheck + esbuild -> lambda/dist, zipped to lambda/function.zip
terraform init
make plan  SNYK_GROUP_ID=<group-id>
make apply
make plan-destroy
make destroy

aws secretsmanager put-secret-value --secret-id "$(terraform output -raw snyk_secret_arn)" \
  --secret-string '{"Snyk_Token":"<token>"}'
```
The secret may be JSON with the token under `Snyk_Token` (also accepted: `snyk_token`, `SNYK_TOKEN`, `token`) or a plaintext token.

Manual run: `aws stepfunctions start-execution --state-machine-arn $(terraform output -raw state_machine_arn) --input '{"scheduledTime":"2024-01-02T16:30:00Z"}'`

Use `-var snyk_api_host=https://api.eu.snyk.io` (or another regional host) as needed.

## Test
`make test` (`tsc --noEmit` then `node --test` on the TypeScript tests; mocked fetch and AWS clients).

## Notes
- DynamoDB key is `OrgID` (hash) + `from` (range); `from`, `to` and `status` are DynamoDB reserved words, so use expression attribute names when querying.
- Re-running the same window overwrites its row and replaces its log stream (see Exactly-once delivery).
- Limits of the exactly-once guarantee: it is per window at the stream level (CloudWatch has no event-level dedup). If a run is killed and its window is never run again (retries exhausted), the partial stream stays and there is no `Failure` row until that window is next run. Two overlapping runs of the *same* window (e.g. manual starts) can delete each other's stream; the hourly schedule doesn't do this.
- Verify the audit log query parameters and response shape against https://apidocs.snyk.io (version 2026-03-25); the client accepts both `data: [...]` and `data.items`.
