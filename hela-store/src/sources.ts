// ─────────────────────────────────────────────────────────────────────────────
// @foxxi/hela-store  —  sources.ts
//
// FederatedSource: the virtual query layer
//
// HELA is a zero-copy federated semantic layer. Data lives at the source.
// A FederatedSource represents a node in the TLA/LER ecosystem that HELA
// can query on demand without copying data.
//
// Mathematically: each source is an object in the site category 𝒞_TLA.
// HELA's presheaf ℰ = Set^(𝒞_TLA^op) is computed lazily by pulling
// sections from sources and applying geometric morphisms (lenses).
//
// The SourceRegistry is the Grothendieck site: it knows the topology
// (which sources exist, what they cover, how they relate).
// ─────────────────────────────────────────────────────────────────────────────

import {
  IRI, XAPIStatement, StoredXAPIStatement, Psi,
  StatementQueryParams, Agent,
} from "./types";
import { realize } from "./store";

// ── Source capabilities ──────────────────────────────────────────────────────
export interface SourceCapabilities {
  /** Standards this source speaks */
  protocols: ("xapi" | "openbadges" | "clr" | "ctdl" | "case")[];
  /** Can we query by actor? */
  queryByActor: boolean;
  /** Can we query by activity? */
  queryByActivity: boolean;
  /** Can we query by verb? */
  queryByVerb: boolean;
  /** Can we query by time range? */
  queryByTimeRange: boolean;
  /** Does this source support write/push? */
  writable: boolean;
}

// ── Source metadata (stored in topology graph) ───────────────────────────────
export interface SourceMetadata {
  id: string;
  label: string;
  type: "xapi-lrs" | "badge-platform" | "ctdl-registry" | "case-network" | "clr-issuer" | "custom";
  endpoint: string;
  capabilities: SourceCapabilities;
  /** When this source was last queried */
  lastQueried?: string;
  /** Health status */
  status: "connected" | "disconnected" | "unknown";
  /** Optional: actors this source is known to have data for */
  knownActors?: string[];
  /** Optional: activities this source covers */
  knownActivities?: string[];
}

// ── Query result from a federated source ─────────────────────────────────────
export interface FederatedQueryResult {
  sourceId: string;
  sourceLabel: string;
  psis: Psi[];
  statements: StoredXAPIStatement[];
  /** Time taken for this source query (ms) */
  latencyMs: number;
  /** Whether this result came from cache */
  cached: boolean;
  error?: string;
}

// ── The FederatedSource interface ─────────────────────────────────────────────
export interface FederatedSource {
  readonly id: string;
  readonly label: string;
  readonly metadata: SourceMetadata;

  /** Query this source for statements matching params, return as Psi objects */
  query(params: StatementQueryParams): Promise<FederatedQueryResult>;

  /** Test connectivity to this source */
  testConnection(): Promise<{ ok: boolean; error?: string; version?: string[] }>;

  /** Get source capabilities */
  capabilities(): SourceCapabilities;

  /** Push a statement to this source (if writable) */
  push?(statement: XAPIStatement): Promise<{ id: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// xAPISource: wraps any xAPI-conformant LRS endpoint
//
// This is the primary source type. Any LRS (lrsql, SCORM Cloud, Learning
// Locker, Watershed, etc.) becomes a node in the HELA federation via this.
// ─────────────────────────────────────────────────────────────────────────────
export interface xAPISourceConfig {
  id: string;
  label: string;
  endpoint: string;            // Base xAPI endpoint (e.g. http://localhost:9090/xapi)
  auth: {
    type: "basic";
    username: string;
    password: string;
  } | {
    type: "bearer";
    token: string;
  };
  /** xAPI version to send */
  version?: string;
}

export class xAPISource implements FederatedSource {
  readonly id: string;
  readonly label: string;
  readonly metadata: SourceMetadata;
  private readonly _config: xAPISourceConfig;
  private readonly _version: string;

  constructor(config: xAPISourceConfig) {
    this._config = config;
    this._version = config.version ?? "2.0.0";
    this.id = config.id;
    this.label = config.label;
    this.metadata = {
      id: config.id,
      label: config.label,
      type: "xapi-lrs",
      endpoint: config.endpoint,
      capabilities: this.capabilities(),
      status: "unknown",
    };
  }

  capabilities(): SourceCapabilities {
    return {
      protocols: ["xapi"],
      queryByActor: true,
      queryByActivity: true,
      queryByVerb: true,
      queryByTimeRange: true,
      writable: true,
    };
  }

  async testConnection(): Promise<{ ok: boolean; error?: string; version?: string[] }> {
    try {
      const res = await fetch(`${this._config.endpoint}/about`, {
        headers: this._headers(),
      });
      if (!res.ok) {
        this.metadata.status = "disconnected";
        return { ok: false, error: `HTTP ${res.status}` };
      }
      const body = await res.json() as any;
      this.metadata.status = "connected";
      return { ok: true, version: body.version };
    } catch (e: any) {
      this.metadata.status = "disconnected";
      return { ok: false, error: e.message };
    }
  }

  async query(params: StatementQueryParams): Promise<FederatedQueryResult> {
    const start = Date.now();
    try {
      const url = new URL(`${this._config.endpoint}/statements`);

      // Map HELA query params to xAPI query string
      if (params.agent) url.searchParams.set("agent", JSON.stringify(params.agent));
      if (params.verb) url.searchParams.set("verb", params.verb);
      if (params.activity) url.searchParams.set("activity", params.activity);
      if (params.registration) url.searchParams.set("registration", params.registration);
      if (params.since) url.searchParams.set("since", params.since);
      if (params.until) url.searchParams.set("until", params.until);
      if (params.limit) url.searchParams.set("limit", String(params.limit));
      if (params.ascending) url.searchParams.set("ascending", "true");

      const res = await fetch(url.toString(), { headers: this._headers() });
      if (!res.ok) {
        return {
          sourceId: this.id,
          sourceLabel: this.label,
          psis: [],
          statements: [],
          latencyMs: Date.now() - start,
          cached: false,
          error: `HTTP ${res.status}: ${await res.text()}`,
        };
      }

      const body = await res.json() as any;
      const rawStatements: XAPIStatement[] = body.statements ?? [];

      // Realize each statement into a Psi — zero-copy means we DON'T store these,
      // we just project them through morphisms on demand
      const statements: StoredXAPIStatement[] = rawStatements.map(s => ({
        ...s,
        id: s.id ?? crypto.randomUUID(),
        stored: s.stored ?? new Date().toISOString(),
        version: s.version ?? this._version,
      }));

      const psis = statements.map(s => realize(s, `source:${this.id}`));

      this.metadata.lastQueried = new Date().toISOString();
      this.metadata.status = "connected";

      // Pagination: follow `more` link if present
      let moreStatements: StoredXAPIStatement[] = [];
      let morePsis: Psi[] = [];
      if (body.more && typeof body.more === "string" && body.more.length > 0) {
        const moreResult = await this._fetchMore(body.more);
        moreStatements = moreResult.statements;
        morePsis = moreResult.psis;
      }

      return {
        sourceId: this.id,
        sourceLabel: this.label,
        psis: [...psis, ...morePsis],
        statements: [...statements, ...moreStatements],
        latencyMs: Date.now() - start,
        cached: false,
      };
    } catch (e: any) {
      this.metadata.status = "disconnected";
      return {
        sourceId: this.id,
        sourceLabel: this.label,
        psis: [],
        statements: [],
        latencyMs: Date.now() - start,
        cached: false,
        error: e.message,
      };
    }
  }

  async push(statement: XAPIStatement): Promise<{ id: string }> {
    const res = await fetch(`${this._config.endpoint}/statements`, {
      method: "POST",
      headers: { ...this._headers(), "Content-Type": "application/json" },
      body: JSON.stringify([statement]),
    });
    if (!res.ok) throw new Error(`Push failed: HTTP ${res.status}`);
    const ids = await res.json();
    return { id: Array.isArray(ids) ? ids[0] : ids };
  }

  private async _fetchMore(moreUrl: string): Promise<{ statements: StoredXAPIStatement[]; psis: Psi[] }> {
    try {
      // `more` can be a relative path or full URL
      const url = moreUrl.startsWith("http") ? moreUrl : `${this._config.endpoint}${moreUrl}`;
      const res = await fetch(url, { headers: this._headers() });
      if (!res.ok) return { statements: [], psis: [] };
      const body = await res.json() as any;
      const stmts: StoredXAPIStatement[] = (body.statements ?? []).map((s: any) => ({
        ...s,
        id: s.id ?? crypto.randomUUID(),
        stored: s.stored ?? new Date().toISOString(),
        version: s.version ?? this._version,
      }));
      return {
        statements: stmts,
        psis: stmts.map(s => realize(s, `source:${this.id}`)),
      };
    } catch {
      return { statements: [], psis: [] };
    }
  }

  private _headers(): Record<string, string> {
    const h: Record<string, string> = {
      "X-Experience-API-Version": this._version,
    };
    if (this._config.auth.type === "basic") {
      const cred = Buffer.from(`${this._config.auth.username}:${this._config.auth.password}`).toString("base64");
      h["Authorization"] = `Basic ${cred}`;
    } else {
      h["Authorization"] = `Bearer ${this._config.auth.token}`;
    }
    return h;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BadgeSource: wraps Open Badges 2.0/3.0 platforms (Credly, Badgr, etc.)
//
// Queries a badge platform API and maps assertions into Psi objects.
// ─────────────────────────────────────────────────────────────────────────────
export interface BadgeSourceConfig {
  id: string;
  label: string;
  endpoint: string;       // e.g. https://api.credly.com/v1
  auth: { type: "bearer"; token: string } | { type: "basic"; username: string; password: string };
  /** Map badge earner email to xAPI actor */
  actorEmail?: string;
}

export class BadgeSource implements FederatedSource {
  readonly id: string;
  readonly label: string;
  readonly metadata: SourceMetadata;
  private readonly _config: BadgeSourceConfig;

  constructor(config: BadgeSourceConfig) {
    this._config = config;
    this.id = config.id;
    this.label = config.label;
    this.metadata = {
      id: config.id,
      label: config.label,
      type: "badge-platform",
      endpoint: config.endpoint,
      capabilities: this.capabilities(),
      status: "unknown",
    };
  }

  capabilities(): SourceCapabilities {
    return {
      protocols: ["openbadges"],
      queryByActor: true,
      queryByActivity: false,
      queryByVerb: false,
      queryByTimeRange: true,
      writable: false,
    };
  }

  async testConnection(): Promise<{ ok: boolean; error?: string; version?: string[] }> {
    try {
      const res = await fetch(this._config.endpoint, { headers: this._headers() });
      this.metadata.status = res.ok ? "connected" : "disconnected";
      return { ok: res.ok, version: ["OBv2"] };
    } catch (e: any) {
      this.metadata.status = "disconnected";
      return { ok: false, error: e.message };
    }
  }

  async query(params: StatementQueryParams): Promise<FederatedQueryResult> {
    const start = Date.now();
    try {
      // Build badge API URL — Credly-style: /organizations/{org}/badges or /users/{id}/badges
      let url = `${this._config.endpoint}/badges`;
      if (this._config.actorEmail) {
        url += `?filter=recipient_email::${this._config.actorEmail}`;
      }

      const res = await fetch(url, { headers: this._headers() });
      if (!res.ok) {
        return { sourceId: this.id, sourceLabel: this.label, psis: [], statements: [], latencyMs: Date.now() - start, cached: false, error: `HTTP ${res.status}` };
      }

      const body = await res.json() as any;
      const badges: any[] = body.data || body.badges || body || [];

      // Map badge assertions to xAPI statements (synthetic realization)
      const statements: StoredXAPIStatement[] = badges.map((badge: any) => ({
        id: badge.id || crypto.randomUUID(),
        actor: {
          mbox: this._config.actorEmail ? `mailto:${this._config.actorEmail}` : "mailto:unknown@example.com",
          name: badge.recipient_name || badge.earner?.name || "Learner",
        },
        verb: { id: IRI("http://adlnet.gov/expapi/verbs/earned"), display: { "en-US": "earned" } },
        object: {
          objectType: "Activity" as const,
          id: IRI(badge.badge_template?.url || badge.badge_url || `urn:badge:${badge.id}`),
          definition: {
            name: { "en-US": badge.badge_template?.name || badge.name || "Badge" },
            description: { "en-US": badge.badge_template?.description || badge.description || "" },
            type: IRI("https://w3id.org/xapi/openbadges/activity-type/badge"),
          },
        },
        result: { completion: true, success: true, score: { scaled: 1.0 } },
        timestamp: badge.issued_at || badge.issuedOn || new Date().toISOString(),
        stored: new Date().toISOString(),
        version: "2.0.0",
      }));

      const psis = statements.map(s => realize(s, `source:${this.id}`));
      this.metadata.lastQueried = new Date().toISOString();
      this.metadata.status = "connected";

      return { sourceId: this.id, sourceLabel: this.label, psis, statements, latencyMs: Date.now() - start, cached: false };
    } catch (e: any) {
      this.metadata.status = "disconnected";
      return { sourceId: this.id, sourceLabel: this.label, psis: [], statements: [], latencyMs: Date.now() - start, cached: false, error: e.message };
    }
  }

  private _headers(): Record<string, string> {
    const h: Record<string, string> = { "Accept": "application/json" };
    if (this._config.auth.type === "bearer") {
      h["Authorization"] = `Bearer ${this._config.auth.token}`;
    } else {
      const cred = Buffer.from(`${this._config.auth.username}:${this._config.auth.password}`).toString("base64");
      h["Authorization"] = `Basic ${cred}`;
    }
    return h;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CTDLSource: wraps Credential Engine Registry API
//
// Queries the Credential Engine API for credentials/competencies
// and maps them into Psi objects via synthetic xAPI realization.
// ─────────────────────────────────────────────────────────────────────────────
export interface CTDLSourceConfig {
  id: string;
  label: string;
  endpoint: string;       // e.g. https://apps.credentialengine.org/assistant
  apiKey: string;
}

export class CTDLSource implements FederatedSource {
  readonly id: string;
  readonly label: string;
  readonly metadata: SourceMetadata;
  private readonly _config: CTDLSourceConfig;

  constructor(config: CTDLSourceConfig) {
    this._config = config;
    this.id = config.id;
    this.label = config.label;
    this.metadata = {
      id: config.id,
      label: config.label,
      type: "ctdl-registry",
      endpoint: config.endpoint,
      capabilities: this.capabilities(),
      status: "unknown",
    };
  }

  capabilities(): SourceCapabilities {
    return {
      protocols: ["ctdl"],
      queryByActor: false,
      queryByActivity: true,
      queryByVerb: false,
      queryByTimeRange: false,
      writable: false,
    };
  }

  async testConnection(): Promise<{ ok: boolean; error?: string; version?: string[] }> {
    try {
      const res = await fetch(`${this._config.endpoint}/search?query=test&limit=1`, {
        headers: this._headers(),
      });
      this.metadata.status = res.ok ? "connected" : "disconnected";
      return { ok: res.ok, version: ["CTDL"] };
    } catch (e: any) {
      this.metadata.status = "disconnected";
      return { ok: false, error: e.message };
    }
  }

  async query(params: StatementQueryParams): Promise<FederatedQueryResult> {
    const start = Date.now();
    try {
      // Search for credentials — use activity as search term if provided
      const searchTerm = params.activity || "credential";
      const url = `${this._config.endpoint}/search?query=${encodeURIComponent(searchTerm as string)}&limit=50`;

      const res = await fetch(url, { headers: this._headers() });
      if (!res.ok) {
        return { sourceId: this.id, sourceLabel: this.label, psis: [], statements: [], latencyMs: Date.now() - start, cached: false, error: `HTTP ${res.status}` };
      }

      const body = await res.json() as any;
      const results: any[] = body.results || body.data || body || [];

      // Map CTDL credentials to synthetic xAPI statements
      const statements: StoredXAPIStatement[] = results.map((cred: any) => ({
        id: crypto.randomUUID(),
        actor: { name: "Credential Registry", mbox: "mailto:registry@credentialengine.org" },
        verb: { id: IRI("https://w3id.org/xapi/adl/verbs/registered"), display: { "en-US": "registered" } },
        object: {
          objectType: "Activity" as const,
          id: IRI(cred["ceterms:ctid"] || cred.id || `urn:ctdl:${crypto.randomUUID()}`),
          definition: {
            name: { "en-US": cred["ceterms:name"] || cred.name || "Credential" },
            description: { "en-US": cred["ceterms:description"] || cred.description || "" },
            type: IRI("https://credreg.net/ctdl/terms/Credential"),
          },
        },
        result: { completion: true },
        timestamp: cred["ceterms:dateEffective"] || new Date().toISOString(),
        stored: new Date().toISOString(),
        version: "2.0.0",
      }));

      const psis = statements.map(s => realize(s, `source:${this.id}`));
      this.metadata.lastQueried = new Date().toISOString();
      this.metadata.status = "connected";

      return { sourceId: this.id, sourceLabel: this.label, psis, statements, latencyMs: Date.now() - start, cached: false };
    } catch (e: any) {
      this.metadata.status = "disconnected";
      return { sourceId: this.id, sourceLabel: this.label, psis: [], statements: [], latencyMs: Date.now() - start, cached: false, error: e.message };
    }
  }

  private _headers(): Record<string, string> {
    return {
      "Accept": "application/json",
      "Authorization": `ApiToken ${this._config.apiKey}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SourceRegistry: the Grothendieck site
//
// Manages all federated sources. Knows the topology of the ecosystem.
// Provides federated queries that fan out to all sources and merge results.
// ─────────────────────────────────────────────────────────────────────────────

export interface FederatedMergeResult {
  /** All psis from all sources (virtual — not stored) */
  psis: Psi[];
  /** All statements from all sources */
  statements: StoredXAPIStatement[];
  /** Per-source results for provenance tracking */
  sourceResults: FederatedQueryResult[];
  /** Total query time */
  totalLatencyMs: number;
  /** Number of sources queried */
  sourcesQueried: number;
  /** Number of sources that returned errors */
  sourceErrors: number;
}

export class SourceRegistry {
  private readonly _sources = new Map<string, FederatedSource>();

  /** Register a source in the topology */
  register(source: FederatedSource): void {
    this._sources.set(source.id, source);
  }

  /** Remove a source from the topology */
  unregister(id: string): boolean {
    return this._sources.delete(id);
  }

  /** Get a specific source */
  get(id: string): FederatedSource | undefined {
    return this._sources.get(id);
  }

  /** All registered sources */
  get sources(): FederatedSource[] {
    return [...this._sources.values()];
  }

  /** Number of registered sources */
  get size(): number {
    return this._sources.size;
  }

  /** The topology: metadata about all sources */
  topology(): SourceMetadata[] {
    return this.sources.map(s => s.metadata);
  }

  /**
   * Federated query: fan out to all sources in parallel, merge results.
   *
   * This is the core of HELA's zero-copy architecture:
   * - Query goes to all sources simultaneously
   * - Each source returns its results as virtual Psi objects
   * - Results are merged (with deduplication by statement ID)
   * - Morphisms can then project the merged results into any view
   *
   * No data is stored. The result is ephemeral.
   */
  async query(params: StatementQueryParams = {}): Promise<FederatedMergeResult> {
    const start = Date.now();

    // Fan out to all sources in parallel
    const results = await Promise.all(
      this.sources.map(source => source.query(params))
    );

    // Merge and deduplicate by statement ID
    const seenIds = new Set<string>();
    const mergedPsis: Psi[] = [];
    const mergedStatements: StoredXAPIStatement[] = [];

    for (const result of results) {
      for (let i = 0; i < result.statements.length; i++) {
        const stmt = result.statements[i];
        if (stmt.id && seenIds.has(stmt.id)) continue; // deduplicate
        if (stmt.id) seenIds.add(stmt.id);
        mergedStatements.push(stmt);
        if (result.psis[i]) mergedPsis.push(result.psis[i]);
      }
    }

    return {
      psis: mergedPsis,
      statements: mergedStatements,
      sourceResults: results,
      totalLatencyMs: Date.now() - start,
      sourcesQueried: results.length,
      sourceErrors: results.filter(r => r.error).length,
    };
  }

  /**
   * Query a specific source by ID
   */
  async querySource(sourceId: string, params: StatementQueryParams = {}): Promise<FederatedQueryResult> {
    const source = this._sources.get(sourceId);
    if (!source) {
      return {
        sourceId,
        sourceLabel: "unknown",
        psis: [],
        statements: [],
        latencyMs: 0,
        cached: false,
        error: `Source ${sourceId} not found in registry`,
      };
    }
    return source.query(params);
  }

  /**
   * Test connectivity to all sources
   */
  async healthCheck(): Promise<{ id: string; label: string; status: string; version?: string[]; error?: string }[]> {
    const results = await Promise.all(
      this.sources.map(async source => {
        const result = await source.testConnection();
        return {
          id: source.id,
          label: source.label,
          status: result.ok ? "connected" : "disconnected",
          version: result.version,
          error: result.error,
        };
      })
    );
    return results;
  }
}
