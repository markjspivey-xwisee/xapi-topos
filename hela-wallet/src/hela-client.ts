// ─────────────────────────────────────────────────────────────────────────────
// @foxxi/hela-wallet  —  hela-client.ts
//
// HTTP client that connects to a HELA node.
// The wallet doesn't embed the infrastructure — it queries it.
// ─────────────────────────────────────────────────────────────────────────────

export interface HELANodeConfig {
  endpoint: string;    // e.g. http://localhost:8080
  apiKey?: string;     // HELA API key if auth is enabled
}

export interface FederatedResult {
  statements: any[];
  count: number;
  sourcesQueried: number;
  totalLatencyMs: number;
  provenance: { source: string; count: number; latencyMs: number }[];
}

export class HELAClient {
  private _endpoint: string;
  private _apiKey?: string;

  constructor(config: HELANodeConfig) {
    this._endpoint = config.endpoint.replace(/\/$/, "");
    this._apiKey = config.apiKey;
  }

  get endpoint(): string { return this._endpoint; }

  /** Test connection to the HELA node */
  async ping(): Promise<{ ok: boolean; version?: string[]; morphisms?: string[] }> {
    try {
      const res = await this._fetch("/xapi/about");
      const body = await res.json() as any;
      return {
        ok: true,
        version: body.version,
        morphisms: body.extensions?.["https://hela.foxxi.io/about"]?.morphisms,
      };
    } catch {
      return { ok: false };
    }
  }

  /** Federated query — zero-copy across all sources registered in HELA */
  async federatedQuery(params: {
    agent?: any;
    verb?: string;
    activity?: string;
    limit?: number;
    since?: string;
  } = {}): Promise<FederatedResult> {
    const url = new URL(`${this._endpoint}/hela/federated/statements`);
    if (params.agent) url.searchParams.set("agent", JSON.stringify(params.agent));
    if (params.verb) url.searchParams.set("verb", params.verb);
    if (params.activity) url.searchParams.set("activity", params.activity);
    if (params.limit) url.searchParams.set("limit", String(params.limit));
    if (params.since) url.searchParams.set("since", params.since);

    const res = await this._fetch(url.pathname + url.search);
    return res.json() as Promise<FederatedResult>;
  }

  /** Get federated views (all 5 morphisms) */
  async federatedViews(agent?: any): Promise<any> {
    let url = "/hela/federated/views";
    if (agent) url += `?agent=${encodeURIComponent(JSON.stringify(agent))}`;
    const res = await this._fetch(url);
    return res.json();
  }

  /** Get federated LER for an actor */
  async federatedLER(agentKey: string): Promise<any> {
    const res = await this._fetch(`/hela/federated/ler/${encodeURIComponent(agentKey)}`);
    return res.json();
  }

  /** Get source topology */
  async topology(): Promise<any> {
    const res = await this._fetch("/hela/sources/topology");
    return res.json();
  }

  /** Register an xAPI source in the HELA node */
  async registerSource(source: { id: string; label: string; endpoint: string; auth: any }): Promise<any> {
    const res = await this._fetch("/hela/sources/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(source),
    });
    return res.json();
  }

  /** Register a Credly profile */
  async registerCredly(username: string, actorEmail?: string): Promise<any> {
    const res = await this._fetch("/hela/sources/register/credly", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, actorEmail }),
    });
    return res.json();
  }

  /** Get recommendations */
  async recommendations(agentKey: string): Promise<any> {
    const res = await this._fetch(`/hela/recommendations/${encodeURIComponent(agentKey)}`);
    return res.json();
  }

  /** Issue VCs (server-side signed by HELA node) */
  async issueCredentials(actor: string, morphisms?: string[]): Promise<any> {
    const res = await this._fetch("/hela/credentials/issue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor, morphisms }),
    });
    return res.json();
  }

  /** Verify a VP */
  async verifyPresentation(vp: any): Promise<any> {
    const res = await this._fetch("/hela/credentials/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(vp),
    });
    return res.json();
  }

  /** Health check all sources */
  async sourceHealth(): Promise<any> {
    const res = await this._fetch("/hela/sources/health");
    return res.json();
  }

  private async _fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = path.startsWith("http") ? path : `${this._endpoint}${path}`;
    const headers: Record<string, string> = {
      ...(init?.headers as Record<string, string> || {}),
    };
    if (this._apiKey) {
      headers["X-API-Key"] = this._apiKey;
    }
    const res = await fetch(url, { ...init, headers });
    if (!res.ok) {
      throw new Error(`HELA node error: ${res.status} ${await res.text()}`);
    }
    return res;
  }
}
