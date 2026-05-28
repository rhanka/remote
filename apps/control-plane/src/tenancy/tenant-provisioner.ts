import { tenantNamespace } from "./namespace.js";

export interface TenantProvisioner {
  ensureTenant(userId: string): Promise<{ namespace: string }>;
}

export class StubTenantProvisioner implements TenantProvisioner {
  async ensureTenant(userId: string): Promise<{ namespace: string }> {
    return { namespace: tenantNamespace(userId) };
  }
}

export class PocK8sTenantProvisioner implements TenantProvisioner {
  private readonly cache = new Set<string>();
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async ensureTenant(userId: string): Promise<{ namespace: string }> {
    const ns = tenantNamespace(userId);
    if (this.cache.has(userId)) return { namespace: ns };
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/tenants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    if (!res.ok) throw new Error(`ensureTenant: ${res.status}`);
    const json = (await res.json()) as { namespace?: string };
    this.cache.add(userId);
    return { namespace: json.namespace ?? ns };
  }
}

export function tenantProvisionerFromEnv(): TenantProvisioner {
  const url = process.env.POC_K8S_TENANTS_URL;
  return url ? new PocK8sTenantProvisioner(url) : new StubTenantProvisioner();
}
