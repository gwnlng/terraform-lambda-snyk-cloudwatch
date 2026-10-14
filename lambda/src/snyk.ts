// Shared Snyk REST helpers. Uses built-in fetch; the AWS SDK v3 clients come
// from the Node.js Lambda runtime (external to the bundle) and are imported
// lazily so unit tests can inject fakes instead.

const MAX_ATTEMPTS = 5;

export interface SnykOpts {
  fetchImpl?: typeof fetch;
  baseDelayMs?: number;
}

export interface JsonApiPage<T = unknown> {
  data?: T[] | { items?: T[] };
  links?: { next?: string | { href?: string } };
}

export async function getSnykToken(
  secretArn: string,
  { send }: { send?: (arn: string) => Promise<{ SecretString?: string }> } = {},
): Promise<string> {
  const doSend =
    send ??
    (async (arn: string) => {
      const { SecretsManagerClient, GetSecretValueCommand } = await import(
        "@aws-sdk/client-secrets-manager"
      );
      return new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }));
    });
  const { SecretString } = await doSend(secretArn);
  if (!SecretString) throw new Error("Snyk secret has no SecretString value");
  return parseSnykSecret(SecretString);
}

const TOKEN_KEYS = ["Snyk_Token", "snyk_token", "SNYK_TOKEN", "token"];

// Accepts either a JSON object holding the token under one of TOKEN_KEYS, or a
// plaintext token. Errors name keys only, never values, so nothing secret is logged.
export function parseSnykSecret(secretString: string): string {
  const raw = secretString.trim();
  if (!raw) throw new Error("Snyk secret is empty");
  if (!raw.startsWith("{")) return raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Snyk secret looks like JSON but is malformed");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Snyk secret JSON must be an object");
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of TOKEN_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  throw new Error(
    `Snyk secret JSON has no usable token; found keys [${Object.keys(obj).join(", ")}], expected one of [${TOKEN_KEYS.join(", ")}]`,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function snykGet<T = JsonApiPage>(
  url: string,
  token: string,
  { fetchImpl = fetch, baseDelayMs = 500 }: SnykOpts = {},
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetchImpl(url, {
      headers: { Authorization: `token ${token}`, Accept: "application/vnd.api+json" },
    });
    if (res.ok) return (await res.json()) as T;
    const retryable = res.status === 429 || res.status >= 500;
    lastError = new Error(`Snyk API ${res.status} for ${url.split("?")[0]}`);
    if (!retryable || attempt === MAX_ATTEMPTS) throw lastError;
    const retryAfter = Number(res.headers?.get?.("retry-after"));
    await sleep(retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** (attempt - 1));
  }
  throw lastError;
}

// Follows JSON:API `links.next` (relative to the API host) and yields each page.
export async function* snykPages<T = unknown>(
  host: string,
  firstPath: string,
  token: string,
  opts?: SnykOpts,
): AsyncGenerator<JsonApiPage<T>> {
  let next: string | undefined = firstPath;
  while (next) {
    const page: JsonApiPage<T> = await snykGet<JsonApiPage<T>>(
      new URL(next, host).toString(),
      token,
      opts,
    );
    yield page;
    const link = page?.links?.next;
    next = typeof link === "string" ? link : link?.href;
  }
}

// Previous full hour relative to the scheduled time, as RFC3339 UTC strings.
export function previousHourWindow(scheduledTime?: string): { from: string; to: string } {
  const t = scheduledTime ? new Date(scheduledTime) : new Date();
  if (Number.isNaN(t.getTime())) throw new Error(`Invalid scheduledTime: ${scheduledTime}`);
  const to = new Date(t);
  to.setUTCMinutes(0, 0, 0);
  const from = new Date(to.getTime() - 3600 * 1000);
  const fmt = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  return { from: fmt(from), to: fmt(to) };
}
