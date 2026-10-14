import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getSnykToken, parseSnykSecret, previousHourWindow, snykGet } from "../src/snyk.ts";
import { createHandler as createGenerator } from "../src/get_snyk_orgs.ts";
import { createHandler as createWorker, type LogEvent, type StatusItem } from "../src/transfer_audit_logs.ts";

const env = {
  SNYK_SECRET_ARN: "arn",
  SNYK_GROUP_ID: "grp",
  SNYK_API_HOST: "https://api.snyk.io",
  SNYK_API_VERSION: "2026-03-25",
  AUDIT_LOG_GROUP: "lg",
  STATUS_TABLE: "tbl",
};

const jsonRes = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  headers: { get: () => null },
  json: async () => body,
});

const asFetch = (fn: (url: string) => unknown) => fn as unknown as typeof fetch;

test("parseSnykSecret reads each accepted JSON key and trims", () => {
  for (const key of ["Snyk_Token", "snyk_token", "SNYK_TOKEN", "token"]) {
    assert.equal(parseSnykSecret(JSON.stringify({ [key]: "  abc  " })), "abc");
  }
});

test("parseSnykSecret accepts a plaintext token", () => {
  assert.equal(parseSnykSecret(" 1234-abcd\n"), "1234-abcd");
});

test("parseSnykSecret rejects empty, malformed, and wrong-shaped secrets", () => {
  assert.throws(() => parseSnykSecret("  "), /empty/);
  assert.throws(() => parseSnykSecret('{"Snyk_Token": '), /malformed/);
  assert.throws(() => parseSnykSecret('{"Snyk_Token": 123}'), /no usable token/);
  assert.throws(() => parseSnykSecret('{"Snyk_Token": ""}'), /no usable token/);
});

test("parseSnykSecret errors name keys but never values", () => {
  assert.throws(
    () => parseSnykSecret('{"other":"s3cret-value"}'),
    (e: Error) => /other/.test(e.message) && !e.message.includes("s3cret-value"),
  );
});

test("getSnykToken parses the injected secret", async () => {
  const expected = randomUUID();
  const token = await getSnykToken("arn", {
    send: async () => ({ SecretString: JSON.stringify({ Snyk_Token: expected }) }),
  });
  assert.equal(token, expected);
});

test("previousHourWindow returns the previous full UTC hour", () => {
  assert.deepEqual(previousHourWindow("2024-01-02T16:30:12Z"), {
    from: "2024-01-02T15:00:00Z",
    to: "2024-01-02T16:00:00Z",
  });
});

test("snykGet retries 429 then succeeds", async () => {
  let calls = 0;
  const fetchImpl = asFetch(async () => (++calls < 3 ? jsonRes({}, 429) : jsonRes({ ok: 1 })));
  const out = await snykGet<{ ok: number }>("https://x/y", "t", { fetchImpl, baseDelayMs: 1 });
  assert.equal(out.ok, 1);
  assert.equal(calls, 3);
});

test("generator follows pagination and omits the token", async () => {
  const pages: Record<string, unknown> = {
    "/rest/groups/grp/orgs?version=2026-03-25&limit=100": {
      data: [{ id: "o1" }],
      links: { next: "/rest/groups/grp/orgs?page=2" },
    },
    "/rest/groups/grp/orgs?page=2": { data: [{ id: "o2" }] },
  };
  const fetchImpl = asFetch(async (url) => jsonRes(pages[new URL(url).pathname + new URL(url).search]));
  const h = createGenerator({ env, getToken: async () => "SECRET", snykOpts: { fetchImpl } });
  const out = await h({ scheduledTime: "2024-01-02T16:30:00Z" });
  assert.deepEqual(
    out.orgs.map((o) => o.SnykOrgId),
    ["o1", "o2"],
  );
  assert.equal(out.orgs[0].from, "2024-01-02T15:00:00Z");
  assert.ok(!JSON.stringify(out).includes("SECRET"));
});

test("worker writes logs and records Completed", async () => {
  const put: unknown[][] = [];
  const prefixes: [string, string][] = [];
  const statuses: Omit<StatusItem, "SnykOrgId">[] = [];
  const fetchImpl = asFetch(async (url) => {
    assert.match(url, /audit_logs\/search/);
    assert.match(url, /from=2024-01-02T15%3A00%3A00Z/);
    return jsonRes({ data: { items: [{ created: "2024-01-02T15:10:00Z", event: "a" }] } });
  });
  const h = createWorker({
    env,
    getToken: async () => "t",
    snykOpts: { fetchImpl },
    logs: {
      createStream: async () => {},
      put: async (...a: [string, string, LogEvent[]]) => {
        put.push(a);
      },
      deleteStream: async () => {
        throw new Error("deleteStream must not be called on success");
      },
      deleteStreamsByPrefix: async (g: string, p: string) => {
        prefixes.push([g, p]);
        return 0;
      },
    },
    putStatus: async (i) => {
      statuses.push(i);
    },
  });
  const out = await h({ SnykOrgId: "o1", from: "2024-01-02T15:00:00Z", to: "2024-01-02T16:00:00Z" });
  assert.equal(out.written, 1);
  assert.equal(put.length, 1);
  assert.equal(prefixes.length, 1);
  assert.equal(prefixes[0][1], "o1/2024-01-02T150000Z/");
  assert.deepEqual(statuses, [
    { OrgID: "o1", from: "2024-01-02T15:00:00Z", to: "2024-01-02T16:00:00Z", status: "Completed" },
  ]);
});

test("worker deletes its log stream, then records Failure and rethrows", async () => {
  const calls: string[] = [];
  const deleted: [string, string][] = [];
  const h = createWorker({
    env,
    getToken: async () => "t",
    snykOpts: { fetchImpl: asFetch(async () => jsonRes({}, 403)) },
    logs: {
      createStream: async () => {},
      put: async () => {},
      deleteStream: async (g, s) => {
        calls.push("delete");
        deleted.push([g, s]);
      },
      deleteStreamsByPrefix: async () => 0,
    },
    putStatus: async (i) => {
      calls.push(i.status);
    },
  });
  await assert.rejects(h({ SnykOrgId: "o1", from: "a", to: "b" }), /403/);
  assert.equal(deleted.length, 1);
  assert.match(deleted[0][1], /^o1\/a\//);
  assert.deepEqual(calls, ["delete", "Failure"]);
});

test("worker still records Failure and rethrows original error when stream delete fails", async () => {
  const statuses: Omit<StatusItem, "SnykOrgId">[] = [];
  const h = createWorker({
    env,
    getToken: async () => "t",
    snykOpts: { fetchImpl: asFetch(async () => jsonRes({}, 403)) },
    logs: {
      createStream: async () => {},
      put: async () => {},
      deleteStream: async () => {
        throw new Error("boom");
      },
      deleteStreamsByPrefix: async () => 0,
    },
    putStatus: async (i) => {
      statuses.push(i);
    },
  });
  await assert.rejects(h({ SnykOrgId: "o1", from: "a", to: "b" }), /403/);
  assert.equal(statuses[0].status, "Failure");
});

test("worker deletes stale streams of the same window before creating its own", async () => {
  const calls: string[] = [];
  const h = createWorker({
    env,
    getToken: async () => "t",
    snykOpts: { fetchImpl: asFetch(async () => jsonRes({ data: { items: [] } })) },
    logs: {
      createStream: async () => {
        calls.push("create");
      },
      put: async () => {},
      deleteStream: async () => {},
      deleteStreamsByPrefix: async () => {
        calls.push("purge");
        return 1;
      },
    },
    putStatus: async () => {},
  });
  await h({ SnykOrgId: "o1", from: "a", to: "b" });
  assert.deepEqual(calls, ["purge", "create"]);
});

test("worker fails (and records Failure) if stale stream cleanup fails, without writing", async () => {
  const statuses: string[] = [];
  let created = false;
  const h = createWorker({
    env,
    getToken: async () => "t",
    snykOpts: { fetchImpl: asFetch(async () => jsonRes({ data: { items: [] } })) },
    logs: {
      createStream: async () => {
        created = true;
      },
      put: async () => {},
      deleteStream: async () => {},
      deleteStreamsByPrefix: async () => {
        throw new Error("denied");
      },
    },
    putStatus: async (i) => {
      statuses.push(i.status);
    },
  });
  await assert.rejects(h({ SnykOrgId: "o1", from: "a", to: "b" }), /denied/);
  assert.equal(created, false);
  assert.deepEqual(statuses, ["Failure"]);
});
