// ─────────────────────────────────────────────────────────────────────────────
// @foxxi/hela-store  —  scormcloud.ts
//
// SCORM Cloud xAPI connector.
//
// Pulls xAPI statements from Rustici SCORM Cloud into the HELA store.
// Auth: HTTP Basic (AppID:SecretKey).
// Supports one-shot sync and polling.
// ─────────────────────────────────────────────────────────────────────────────

import { HELAStore } from "./store";
import { XAPIStatement, SCORMCloudConfig } from "./types";

export interface SyncResult {
  readonly inserted: number;
  readonly skipped:  number;
  readonly errors:   string[];
  readonly since:    string;
  readonly timestamp: string;
}

export class SCORMCloudConnector {
  private readonly _config: Required<SCORMCloudConfig>;
  private _lastSync?: string;
  private _pollTimer?: ReturnType<typeof setInterval>;
  private _connected = false;

  constructor(config: SCORMCloudConfig) {
    this._config = {
      appId:     config.appId,
      secretKey: config.secretKey,
      endpoint:  config.endpoint ?? "https://cloud.scorm.com",
    };
  }

  get connected(): boolean { return this._connected; }
  get lastSync(): string | undefined { return this._lastSync; }
  get endpoint(): string { return this._config.endpoint; }

  // ── Test connection ─────────────────────────────────────────────────────
  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${this._config.endpoint}/api/v2/ping`, {
        headers: this._headers(),
      });
      this._connected = res.ok;
      return { ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }

  // ── Pull statements from SCORM Cloud ───────────────────────────────────
  async pullStatements(since?: string): Promise<XAPIStatement[]> {
    const statements: XAPIStatement[] = [];
    let url = `${this._config.endpoint}/api/v2/xapi/statements`;
    if (since) url += `?since=${encodeURIComponent(since)}`;

    try {
      let hasMore = true;
      while (hasMore) {
        const res = await fetch(url, { headers: this._headers() });
        if (!res.ok) throw new Error(`SCORM Cloud returned ${res.status}`);
        const body = await res.json() as { statements: XAPIStatement[]; more?: string };
        statements.push(...body.statements);

        if (body.more) {
          // The `more` field is a relative URL for pagination
          url = body.more.startsWith("http")
            ? body.more
            : `${this._config.endpoint}${body.more}`;
        } else {
          hasMore = false;
        }
      }
    } catch (e: any) {
      // If connection fails, return what we have so far
      if (statements.length === 0) throw e;
    }

    return statements;
  }

  // ── One-shot sync: pull and insert into store ──────────────────────────
  async sync(store: HELAStore): Promise<SyncResult> {
    const since = this._lastSync;
    const statements = await this.pullStatements(since);

    let inserted = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const stmt of statements) {
      try {
        // Check if already exists
        if (stmt.id && store.getById(stmt.id)) {
          skipped++;
          continue;
        }
        store.insert(stmt);
        inserted++;
      } catch (e: any) {
        errors.push(`Statement ${stmt.id ?? "unknown"}: ${e.message}`);
      }
    }

    this._lastSync = new Date().toISOString();
    this._connected = true;

    return {
      inserted,
      skipped,
      errors,
      since: since ?? "initial",
      timestamp: this._lastSync,
    };
  }

  // ── Start polling loop ─────────────────────────────────────────────────
  startPolling(store: HELAStore, intervalMs = 60000): () => void {
    // Initial sync
    this.sync(store).catch(console.error);

    this._pollTimer = setInterval(() => {
      this.sync(store).catch(console.error);
    }, intervalMs);

    return () => this.stopPolling();
  }

  // ── Stop polling ───────────────────────────────────────────────────────
  stopPolling(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = undefined;
    }
  }

  // ── Auth headers ───────────────────────────────────────────────────────
  private _headers(): Record<string, string> {
    const credentials = Buffer.from(
      `${this._config.appId}:${this._config.secretKey}`
    ).toString("base64");

    return {
      "Authorization": `Basic ${credentials}`,
      "X-Experience-API-Version": "1.0.3",
      "Content-Type": "application/json",
    };
  }
}
