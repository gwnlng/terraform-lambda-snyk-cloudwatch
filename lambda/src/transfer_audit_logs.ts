import type { Context } from "aws-lambda";
import { getSnykToken, snykPages, type SnykOpts } from "./snyk.ts";

const MAX_BATCH_EVENTS = 5000; // CloudWatch limit is 10,000; stay well under 1 MB too
const MAX_BATCH_BYTES = 900_000;
const EVENT_OVERHEAD = 26;

export interface WorkerEvent {
  SnykOrgId: string;
  from: string;
  to: string;
}

export interface WorkerResult extends WorkerEvent {
  status: "Completed";
  written: number;
}

export interface LogEvent {
  timestamp: number;
  message: string;
}

export interface StatusItem extends WorkerEvent {
  OrgID: string;
  status: "Completed" | "Failure";
}

interface AuditLogItem {
  created?: string;
  attributes?: { created?: string };
  [key: string]: unknown;
}

export interface LogsClient {
  createStream(logGroupName: string, logStreamName: string): Promise<void>;
  put(logGroupName: string, logStreamName: string, logEvents: LogEvent[]): Promise<void>;
  deleteStream(logGroupName: string, logStreamName: string): Promise<void>;
  deleteStreamsByPrefix(logGroupName: string, logStreamNamePrefix: string): Promise<number>;
}

export interface WorkerDeps {
  env?: Record<string, string | undefined>;
  getToken?: (secretArn: string) => Promise<string>;
  snykOpts?: SnykOpts;
  logs?: LogsClient;
  putStatus?: (item: Omit<StatusItem, "SnykOrgId">) => Promise<void>;
}

// Worker: event = { SnykOrgId, from, to } (RFC3339). Writes the org's audit
// logs for [from, to) to a CloudWatch log stream, then records the outcome.
export function createHandler(deps: WorkerDeps = {}) {
  const env = deps.env ?? process.env;

  const logs = deps.logs ?? lazyLogs();
  const putStatus = deps.putStatus ?? lazyPutStatus(env.STATUS_TABLE!);

  // Removes a failed run's (possibly partial) stream so a retry cannot duplicate events.
  // Never throws: a cleanup problem must not mask the original failure.
  async function deleteAuditLogStream(group: string, stream: string | undefined): Promise<void> {
    if (!stream) return;
    try {
      await logs.deleteStream(group, stream);
      console.log(JSON.stringify({ msg: "log stream deleted", stream }));
    } catch (err) {
      if (err instanceof Error && err.name === "ResourceNotFoundException") return; // never created
      const m = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ msg: "stream delete failed", stream, error: m }));
    }
  }

  return async function handler(
    event: WorkerEvent,
    context: Partial<Context> = {},
  ): Promise<WorkerResult> {
    const { SnykOrgId, from, to } = event ?? ({} as Partial<WorkerEvent>);
    if (!SnykOrgId || !from || !to) {
      throw new Error("event must contain SnykOrgId, from and to");
    }
    const group = env.AUDIT_LOG_GROUP!;

    let written = 0;
    let stream: string | undefined;
    try {
      const token = await (deps.getToken ?? getSnykToken)(env.SNYK_SECRET_ARN!);
      // CloudWatch stream names cannot contain ":"
      const safeFrom = from.replaceAll(":", "");
      const streamName = `${SnykOrgId}/${safeFrom}/${context.awsRequestId ?? Date.now()}`;
      // A timed-out/OOM-killed earlier attempt for this window never ran its catch block and
      // left a partial stream behind. Not swallowed: writing again on top of it would duplicate.
      const stale = await logs.deleteStreamsByPrefix(group, `${SnykOrgId}/${safeFrom}/`);
      if (stale) console.log(JSON.stringify({ msg: "deleted stale streams", SnykOrgId, from, stale }));
      stream = streamName;
      await logs.createStream(group, streamName);

      const first =
        `/rest/orgs/${encodeURIComponent(SnykOrgId)}/audit_logs/search` +
        `?version=${encodeURIComponent(env.SNYK_API_VERSION!)}` +
        `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&size=100&sort_order=ASC`;

      let batch: LogEvent[] = [];
      let bytes = 0;
      const flush = async () => {
        if (!batch.length) return;
        // batch.sort((a, b) => a.timestamp - b.timestamp);
        await logs.put(group, streamName, batch);
        written += batch.length;
        batch = [];
        bytes = 0;
      };

      for await (const page of snykPages<AuditLogItem>(env.SNYK_API_HOST!, first, token, deps.snykOpts)) {
        const items = Array.isArray(page.data) ? page.data : (page.data?.items ?? []);
        for (const item of items) {
          const message = JSON.stringify(item);
          const size = Buffer.byteLength(message) + EVENT_OVERHEAD;
          if (batch.length >= MAX_BATCH_EVENTS || bytes + size > MAX_BATCH_BYTES) await flush();
          const ts = Date.parse(item.created ?? item.attributes?.created ?? "") || Date.now();
          batch.push({ timestamp: ts, message });
          bytes += size;
        }
      }
      await flush();

      await putStatus({ OrgID: SnykOrgId, from, to, status: "Completed" });
      console.log(JSON.stringify({ msg: "transfer completed", SnykOrgId, from, to, written }));
      return { SnykOrgId, from, to, status: "Completed", written };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ msg: "transfer failed", SnykOrgId, from, to, error: message }));
      await deleteAuditLogStream(group, stream);
      try {
        await putStatus({ OrgID: SnykOrgId, from, to, status: "Failure" });
      } catch (statusErr) {
        const m = statusErr instanceof Error ? statusErr.message : String(statusErr);
        console.error(JSON.stringify({ msg: "status write failed", error: m }));
      }
      throw err; // surface to Step Functions
    }
  };
}

function lazyLogs(): LogsClient {
  let cached: Promise<{
    c: import("@aws-sdk/client-cloudwatch-logs").CloudWatchLogsClient;
    sdk: typeof import("@aws-sdk/client-cloudwatch-logs");
  }> | undefined;
  const get = () =>
    (cached ??= import("@aws-sdk/client-cloudwatch-logs").then((sdk) => ({
      c: new sdk.CloudWatchLogsClient({}),
      sdk,
    })));
  return {
    async createStream(logGroupName, logStreamName) {
      const { c, sdk } = await get();
      await c.send(new sdk.CreateLogStreamCommand({ logGroupName, logStreamName }));
    },
    async put(logGroupName, logStreamName, logEvents) {
      const { c, sdk } = await get();
      await c.send(new sdk.PutLogEventsCommand({ logGroupName, logStreamName, logEvents }));
    },
    async deleteStream(logGroupName, logStreamName) {
      const { c, sdk } = await get();
      await c.send(new sdk.DeleteLogStreamCommand({ logGroupName, logStreamName }));
    },
    async deleteStreamsByPrefix(logGroupName, logStreamNamePrefix) {
      const { c, sdk } = await get();
      let deleted = 0;
      let nextToken: string | undefined;
      do {
        const res = await c.send(
          new sdk.DescribeLogStreamsCommand({ logGroupName, logStreamNamePrefix, nextToken }),
        );
        for (const s of res.logStreams ?? []) {
          if (!s.logStreamName) continue;
          await c.send(new sdk.DeleteLogStreamCommand({ logGroupName, logStreamName: s.logStreamName }));
          deleted++;
        }
        nextToken = res.nextToken;
      } while (nextToken);
      return deleted;
    },
  };
}

function lazyPutStatus(table: string): NonNullable<WorkerDeps["putStatus"]> {
  return async (item) => {
    const { DynamoDBClient, PutItemCommand } = await import("@aws-sdk/client-dynamodb");
    await new DynamoDBClient({}).send(
      new PutItemCommand({
        TableName: table,
        Item: {
          OrgID: { S: item.OrgID },
          from: { S: item.from },
          to: { S: item.to },
          status: { S: item.status },
        },
      }),
    );
  };
}

export const handler = createHandler();
