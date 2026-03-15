// ─────────────────────────────────────────────────────────────────────────────
// @foxxi/hela-store  —  sat.ts
//
// SAT (Secure, Accessible, Transparent) Architecture Layer
//
// Higher-level orchestration tying together:
//   - HELAStore (the presheaf category ℰ)
//   - SCORMCloudConnector (external xAPI data source)
//   - FederatedSite (multi-node TLA topology)
//   - LearningFunctor (competency tracking)
//
// The SAT layer is the operational surface of the HELA architecture.
// It coordinates data flow between components and provides unified APIs
// for learner analysis, federation management, and external sync.
// ─────────────────────────────────────────────────────────────────────────────

import { HELAStore, produceLER, F_xAPI, F_CLR, F_Badge, F_CTDL, F_CASE } from "./store";
import { SCORMCloudConnector, SyncResult } from "./scormcloud";
import { LRSQLConnector, LRSQLSyncResult, LRSQLConfig } from "./lrsql";
import { FederatedSite, buildTLASite } from "./federation";
import { LearningFunctor, buildHELACurriculumPoset, ProgressionReport } from "./natural";
import { LER, IRI, SCORMCloudConfig } from "./types";
import { CompetencyPoset } from "./natural";

// ── Configuration ────────────────────────────────────────────────────────────
export interface SATConfig {
  store: HELAStore;
  scormCloud?: SCORMCloudConfig;
  lrsql?: LRSQLConfig;
  federation?: {
    activityProviders: string[];
    lrsNodes: string[];
    authorityLabel: string;
  };
  competencyPoset?: CompetencyPoset;
}

// ── Health report ────────────────────────────────────────────────────────────
export interface HealthReport {
  store: { status: "ok" | "error"; psiCount: number };
  scormCloud: { status: "connected" | "disconnected" | "not_configured"; lastSync?: string; error?: string };
  lrsql: { status: "connected" | "disconnected" | "not_configured"; endpoint?: string; lastSync?: string; version?: string[]; error?: string };
  federation: { status: "ok" | "not_configured"; nodeCount?: number; authorityNode?: string };
  competency: { status: "ok" | "not_configured"; nodeCount?: number };
  timestamp: string;
}

// ── Learner analysis ─────────────────────────────────────────────────────────
export interface LearnerAnalysis {
  actor: string;
  ler: LER;
  progression: ReturnType<ProgressionReport["toJSON"]>;
  views: {
    xapiStatements: number;
    clrAssertions: number;
    badgeAssertions: number;
    ctdlCredentials: number;
    caseItems: number;
  };
  timestamp: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// SAT Orchestrator
// ─────────────────────────────────────────────────────────────────────────────
export class SATOrchestrator {
  private readonly _store: HELAStore;
  private _scormCloud?: SCORMCloudConnector;
  private _lrsql?: LRSQLConnector;
  private _site?: FederatedSite;
  private _functor?: LearningFunctor;
  private _poset?: CompetencyPoset;
  private _syncHistory: SyncResult[] = [];

  constructor(config: SATConfig) {
    this._store = config.store;

    if (config.scormCloud) {
      this._scormCloud = new SCORMCloudConnector(config.scormCloud);
    }

    if (config.lrsql) {
      this._lrsql = new LRSQLConnector(config.lrsql);
    }

    if (config.federation) {
      this._site = buildTLASite(config.federation);
    }

    this._poset = config.competencyPoset ?? buildHELACurriculumPoset();
    this._functor = new LearningFunctor(this._store, this._poset);
    for (const node of this._poset.nodes) {
      this._functor.setThreshold(node.id, 0.85);
    }
  }

  get store(): HELAStore { return this._store; }
  get scormCloud(): SCORMCloudConnector | undefined { return this._scormCloud; }
  get lrsql(): LRSQLConnector | undefined { return this._lrsql; }
  get site(): FederatedSite | undefined { return this._site; }
  get syncHistory(): SyncResult[] { return this._syncHistory; }

  // ── Initialize: test connections, set up federation ────────────────────
  async initialize(): Promise<{ scormCloud?: { ok: boolean; error?: string }; lrsql?: { ok: boolean; error?: string } }> {
    const result: { scormCloud?: { ok: boolean; error?: string }; lrsql?: { ok: boolean; error?: string } } = {};

    if (this._scormCloud) {
      result.scormCloud = await this._scormCloud.testConnection();
    }
    if (this._lrsql) {
      result.lrsql = await this._lrsql.testConnection();
    }

    return result;
  }

  // ── Sync from all external sources ─────────────────────────────────────
  async syncAll(): Promise<{ scormCloud?: SyncResult; lrsql?: LRSQLSyncResult }> {
    const result: { scormCloud?: SyncResult; lrsql?: LRSQLSyncResult } = {};

    if (this._scormCloud) {
      try {
        const syncResult = await this._scormCloud.sync(this._store);
        this._syncHistory.push(syncResult);
        result.scormCloud = syncResult;
      } catch (e: any) {
        result.scormCloud = {
          inserted: 0,
          skipped: 0,
          errors: [e.message],
          since: "error",
          timestamp: new Date().toISOString(),
        };
      }
    }

    if (this._lrsql) {
      try {
        result.lrsql = await this._lrsql.sync(this._store);
      } catch (e: any) {
        result.lrsql = {
          direction: "bidirectional",
          pulled: 0,
          pushed: 0,
          skipped: 0,
          errors: [e.message],
          timestamp: new Date().toISOString(),
        };
      }
    }

    return result;
  }

  // ── Configure SCORM Cloud connection ───────────────────────────────────
  configureScormCloud(config: SCORMCloudConfig): void {
    this._scormCloud = new SCORMCloudConnector(config);
  }

  // ── Configure SQL LRS connection ───────────────────────────────────────
  configureLRSQL(config: LRSQLConfig): void {
    this._lrsql = new LRSQLConnector(config);
  }

  // ── Full learner analysis ──────────────────────────────────────────────
  analyzeLearner(agentKey: string): LearnerAnalysis {
    const ler = produceLER(this._store, agentKey, "hela.foxxi.io", "hela:bare");
    const progression = this._functor!.progression(agentKey);

    // Count views across all morphisms
    const { psis } = this._store.globalSections(agentKey);
    const xapiStmts = F_xAPI.mapMany(psis);
    const clrAssertions = F_CLR.mapMany(psis);
    const badgeAssertions = F_Badge.mapMany(psis);
    const ctdlCredentials = F_CTDL.mapMany(psis);
    const caseItems = F_CASE.mapMany(psis);

    return {
      actor: agentKey,
      ler,
      progression: progression.toJSON() as ReturnType<ProgressionReport["toJSON"]>,
      views: {
        xapiStatements:  xapiStmts.length,
        clrAssertions:   clrAssertions.length,
        badgeAssertions: badgeAssertions.length,
        ctdlCredentials: ctdlCredentials.length,
        caseItems:       caseItems.length,
      },
      timestamp: new Date().toISOString(),
    };
  }

  // ── Health check ───────────────────────────────────────────────────────
  async healthCheck(): Promise<HealthReport> {
    const report: HealthReport = {
      store: {
        status: "ok",
        psiCount: this._store.size,
      },
      scormCloud: {
        status: this._scormCloud ? "disconnected" : "not_configured",
        lastSync: this._scormCloud?.lastSync,
      },
      lrsql: {
        status: this._lrsql ? "disconnected" : "not_configured",
        endpoint: this._lrsql?.endpoint,
        lastSync: this._lrsql?.lastSync,
      },
      federation: {
        status: this._site ? "ok" : "not_configured",
        nodeCount: this._site?.nodes.length,
        authorityNode: this._site?.authorityNode?.label,
      },
      competency: {
        status: this._poset ? "ok" : "not_configured",
        nodeCount: this._poset?.nodes.length,
      },
      timestamp: new Date().toISOString(),
    };

    if (this._scormCloud) {
      const connTest = await this._scormCloud.testConnection();
      report.scormCloud.status = connTest.ok ? "connected" : "disconnected";
      report.scormCloud.error = connTest.error;
    }

    if (this._lrsql) {
      const connTest = await this._lrsql.testConnection();
      report.lrsql.status = connTest.ok ? "connected" : "disconnected";
      report.lrsql.version = connTest.version;
      report.lrsql.error = connTest.error;
    }

    return report;
  }
}
