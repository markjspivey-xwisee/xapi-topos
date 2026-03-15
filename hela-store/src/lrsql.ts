// ─────────────────────────────────────────────────────────────────────────────
// @foxxi/hela-store  —  lrsql.ts
//
// Yet Analytics SQL LRS connector.
//
// Connects HELA to a running instance of Yet Analytics' open-source SQL LRS
// (https://github.com/yetanalytics/lrsql).
//
// Supports:
//   - Pull: fetch xAPI statements from SQL LRS → insert into HELA store
//   - Push: export HELA statements → SQL LRS
//   - Bidirectional sync
//   - Admin API: login, create credentials, list credentials
//
// Auth: HTTP Basic (API-Key:Secret-Key), xAPI version 2.0.0
// ─────────────────────────────────────────────────────────────────────────────

import { HELAStore } from "./store";
import { XAPIStatement, StoredXAPIStatement } from "./types";

export interface LRSQLConfig {
  endpoint: string;           // e.g. "http://localhost:9090"
  apiKey: string;             // API key from admin/creds
  secretKey: string;          // Secret key from admin/creds
  // Optional admin credentials (for auto-setup)
  adminUser?: string;
  adminPass?: string;
}

export interface LRSQLSyncResult {
  readonly direction: "pull" | "push" | "bidirectional";
  readonly pulled: number;
  readonly pushed: number;
  readonly skipped: number;
  readonly errors: string[];
  readonly timestamp: string;
}

export interface LRSQLStatus {
  readonly connected: boolean;
  readonly endpoint: string;
  readonly version?: string[];
  readonly lastSync?: string;
  readonly error?: string;
}

export class LRSQLConnector {
  private readonly _config: LRSQLConfig;
  private _lastSync?: string;
  private _connected = false;
  private _version?: string[];
  private _pollTimer?: ReturnType<typeof setInterval>;
  private _syncHistory: LRSQLSyncResult[] = [];

  constructor(config: LRSQLConfig) {
    this._config = { ...config };
    // Ensure endpoint has no trailing slash
    if (this._config.endpoint.endsWith("/")) {
      this._config.endpoint = this._config.endpoint.slice(0, -1);
    }
  }

  get connected(): boolean { return this._connected; }
  get lastSync(): string | undefined { return this._lastSync; }
  get endpoint(): string { return this._config.endpoint; }
  get syncHistory(): LRSQLSyncResult[] { return this._syncHistory; }

  // ── Auth header ──────────────────────────────────────────────────────────
  private _authHeader(): string {
    const credentials = Buffer.from(
      `${this._config.apiKey}:${this._config.secretKey}`
    ).toString("base64");
    return `Basic ${credentials}`;
  }

  private _headers(): Record<string, string> {
    return {
      "Authorization": this._authHeader(),
      "X-Experience-API-Version": "2.0.0",
      "Content-Type": "application/json",
    };
  }

  // ── Test connection (GET /xapi/about) ─────────────────────────────────────
  async testConnection(): Promise<{ ok: boolean; version?: string[]; error?: string }> {
    try {
      const res = await fetch(`${this._config.endpoint}/xapi/about`, {
        headers: this._headers(),
      });
      if (!res.ok) {
        this._connected = false;
        return { ok: false, error: `HTTP ${res.status}` };
      }
      const body = await res.json() as { version: string[] };
      this._connected = true;
      this._version = body.version;
      return { ok: true, version: body.version };
    } catch (e: any) {
      this._connected = false;
      return { ok: false, error: e.message };
    }
  }

  // ── Pull statements from SQL LRS into HELA ──────────────────────────────
  async pull(store: HELAStore, since?: string): Promise<LRSQLSyncResult> {
    const errors: string[] = [];
    let pulled = 0;
    let skipped = 0;

    try {
      const statements = await this._fetchStatements(since);

      for (const stmt of statements) {
        try {
          // Skip if already in HELA
          if (stmt.id && store.getById(stmt.id)) {
            skipped++;
            continue;
          }
          store.insert(stmt);
          pulled++;
        } catch (e: any) {
          errors.push(`Statement ${stmt.id ?? "unknown"}: ${e.message}`);
        }
      }

      this._lastSync = new Date().toISOString();
      this._connected = true;
    } catch (e: any) {
      errors.push(e.message);
    }

    const result: LRSQLSyncResult = {
      direction: "pull",
      pulled,
      pushed: 0,
      skipped,
      errors,
      timestamp: new Date().toISOString(),
    };
    this._syncHistory.push(result);
    return result;
  }

  // ── Push statements from HELA to SQL LRS ──────────────────────────────────
  async push(store: HELAStore, since?: string): Promise<LRSQLSyncResult> {
    const errors: string[] = [];
    let pushed = 0;
    let skipped = 0;

    try {
      const statements = store.query({ since });

      // Send in batches of 25
      const batchSize = 25;
      for (let i = 0; i < statements.length; i += batchSize) {
        const batch = statements.slice(i, i + batchSize);
        try {
          const res = await fetch(`${this._config.endpoint}/xapi/statements`, {
            method: "POST",
            headers: this._headers(),
            body: JSON.stringify(batch),
          });

          if (res.ok) {
            const ids = await res.json() as string[];
            pushed += ids.length;
          } else if (res.status === 409) {
            // Conflict — statements already exist
            skipped += batch.length;
          } else {
            const body = await res.text();
            errors.push(`Batch ${Math.floor(i / batchSize) + 1}: HTTP ${res.status} - ${body.slice(0, 200)}`);
          }
        } catch (e: any) {
          errors.push(`Batch ${Math.floor(i / batchSize) + 1}: ${e.message}`);
        }
      }

      this._lastSync = new Date().toISOString();
      this._connected = true;
    } catch (e: any) {
      errors.push(e.message);
    }

    const result: LRSQLSyncResult = {
      direction: "push",
      pulled: 0,
      pushed,
      skipped,
      errors,
      timestamp: new Date().toISOString(),
    };
    this._syncHistory.push(result);
    return result;
  }

  // ── Bidirectional sync ──────────────────────────────────────────────────
  async sync(store: HELAStore): Promise<LRSQLSyncResult> {
    const since = this._lastSync;

    // Pull first, then push
    const pullResult = await this.pull(store, since);
    const pushResult = await this.push(store, since);

    const result: LRSQLSyncResult = {
      direction: "bidirectional",
      pulled: pullResult.pulled,
      pushed: pushResult.pushed,
      skipped: pullResult.skipped + pushResult.skipped,
      errors: [...pullResult.errors, ...pushResult.errors],
      timestamp: new Date().toISOString(),
    };
    this._syncHistory.push(result);
    return result;
  }

  // ── Start polling ────────────────────────────────────────────────────────
  startPolling(store: HELAStore, intervalMs = 60000): () => void {
    this.pull(store).catch(console.error);

    this._pollTimer = setInterval(() => {
      this.pull(store, this._lastSync).catch(console.error);
    }, intervalMs);

    return () => this.stopPolling();
  }

  stopPolling(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = undefined;
    }
  }

  // ── Status ────────────────────────────────────────────────────────────────
  status(): LRSQLStatus {
    return {
      connected: this._connected,
      endpoint: this._config.endpoint,
      version: this._version,
      lastSync: this._lastSync,
    };
  }

  // ── Admin: login and get JWT ──────────────────────────────────────────────
  static async adminLogin(
    endpoint: string,
    username: string,
    password: string
  ): Promise<{ accountId: string; jwt: string }> {
    const res = await fetch(`${endpoint}/admin/account/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error(`Admin login failed: HTTP ${res.status}`);
    const body = await res.json() as { "account-id": string; "json-web-token": string };
    return { accountId: body["account-id"], jwt: body["json-web-token"] };
  }

  // ── Admin: create API credentials ─────────────────────────────────────────
  static async adminCreateCredentials(
    endpoint: string,
    jwt: string,
    scopes: string[] = ["all", "all/read"]
  ): Promise<{ apiKey: string; secretKey: string; scopes: string[] }> {
    const res = await fetch(`${endpoint}/admin/creds`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${jwt}`,
      },
      body: JSON.stringify({ scopes }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Create credentials failed: HTTP ${res.status} - ${body}`);
    }
    const body = await res.json() as { "api-key": string; "secret-key": string; scopes: string[] };
    return { apiKey: body["api-key"], secretKey: body["secret-key"], scopes: body.scopes };
  }

  // ── Auto-setup: login + create creds + return connector ─────────────────
  static async autoSetup(
    endpoint: string,
    adminUser: string,
    adminPass: string
  ): Promise<LRSQLConnector> {
    const { jwt } = await LRSQLConnector.adminLogin(endpoint, adminUser, adminPass);
    const creds = await LRSQLConnector.adminCreateCredentials(endpoint, jwt);
    return new LRSQLConnector({
      endpoint,
      apiKey: creds.apiKey,
      secretKey: creds.secretKey,
      adminUser,
      adminPass,
    });
  }

  // ── Internal: fetch statements with pagination ────────────────────────────
  private async _fetchStatements(since?: string): Promise<XAPIStatement[]> {
    const statements: XAPIStatement[] = [];
    let url = `${this._config.endpoint}/xapi/statements`;
    const params: string[] = [];
    if (since) params.push(`since=${encodeURIComponent(since)}`);
    if (params.length) url += `?${params.join("&")}`;

    let hasMore = true;
    while (hasMore) {
      const res = await fetch(url, { headers: this._headers() });
      if (!res.ok) throw new Error(`SQL LRS returned ${res.status}`);
      const body = await res.json() as { statements: XAPIStatement[]; more?: string };
      statements.push(...body.statements);

      if (body.more && body.more !== "") {
        url = body.more.startsWith("http")
          ? body.more
          : `${this._config.endpoint}${body.more}`;
      } else {
        hasMore = false;
      }
    }

    return statements;
  }
}
