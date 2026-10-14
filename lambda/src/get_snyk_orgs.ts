import { getSnykToken, snykPages, previousHourWindow, type SnykOpts } from "./snyk.ts";

export interface GeneratorEvent {
  scheduledTime?: string;
}

export interface WorkItem {
  SnykOrgId: string;
  from: string;
  to: string;
}

interface SnykOrg {
  id: string;
}

export interface GeneratorDeps {
  env?: Record<string, string | undefined>;
  getToken?: (secretArn: string) => Promise<string>;
  snykOpts?: SnykOpts;
}

// Generator: lists every org in the Snyk Group and returns one work item per org.
// The token is deliberately NOT included in the output so it never reaches
// Step Functions execution history; the worker reads it from Secrets Manager.
export function createHandler(deps: GeneratorDeps = {}) {
  const env = deps.env ?? process.env;
  return async function handler(event: GeneratorEvent = {}): Promise<{ orgs: WorkItem[] }> {
    const token = await (deps.getToken ?? getSnykToken)(env.SNYK_SECRET_ARN!);
    const { from, to } = previousHourWindow(event.scheduledTime);
    const first =
      `/rest/groups/${encodeURIComponent(env.SNYK_GROUP_ID!)}/orgs` +
      `?version=${encodeURIComponent(env.SNYK_API_VERSION!)}&limit=100`;

    const orgs: WorkItem[] = [];
    for await (const page of snykPages<SnykOrg>(env.SNYK_API_HOST!, first, token, deps.snykOpts)) {
      const items = Array.isArray(page.data) ? page.data : (page.data?.items ?? []);
      for (const org of items) {
        orgs.push({ SnykOrgId: org.id, from, to });
      }
    }
    console.log(JSON.stringify({ msg: "listed orgs", count: orgs.length, from, to }));
    return { orgs };
  };
}

export const handler = createHandler();
