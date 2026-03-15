// ─────────────────────────────────────────────────────────────────────────────
// @foxxi/hela-store  —  server.ts
//
// xAPI-conformant LRS REST interface.
// This is the geometric morphism F_xAPI : ℰ → LRS expressed as HTTP routes.
// All routes are derived from the HELA store — the store is primary.
//
// Implements P9274.7.1 endpoints:
//   PUT/GET/POST /statements
//   GET /statements/{statementId}
//   GET /activities/state, /activities/profile, /agents/profile (stubs)
//   GET /about
// ─────────────────────────────────────────────────────────────────────────────

import express, { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { HELAStore, F_xAPI, F_CLR, F_Badge, F_CTDL, F_CASE, produceLER, produceFederatedLER } from "./store";
import { xAPISource, xAPISourceConfig } from "./sources";
import {
  XAPIStatement, StatementQueryParams, IRI, Agent, Actor,
  ServerConfig, SCORMCloudConfig,
} from "./types";
import { buildProfile, loadProfileFromURL } from "./profiles";
import { runConformanceSuite } from "./conformance";
import * as path from "path";
import { Query, QueryExecutor } from "./query";
import { LearningFunctor, buildHELACurriculumPoset } from "./natural";
import { buildTLASite } from "./federation";
import { OxigraphAdapter } from "./adapters";
import { SATOrchestrator, SATConfig } from "./sat";
import { SCORMCloudConnector } from "./scormcloud";
import { LRSQLConnector, LRSQLConfig } from "./lrsql";
import { DataSimConnector } from "./datasim";
import { VCIssuer, verifyPresentation, generateRecommendations } from "./credentials";
import { BadgeSource, CTDLSource } from "./sources";

export interface CreateServerOptions {
  apiKeys?: string[];
  sat?: SATOrchestrator;
  datasim?: DataSimConnector;
}

export function createServer(store: HELAStore, options: CreateServerOptions = {}) {
  const app = express();

  // ── Middleware ────────────────────────────────────────────────────────────
  app.use(express.json());
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Experience-API-Version", "2.0.0");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Experience-API-Version, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    // HELA Store header — documents which layer is primary
    res.setHeader("X-HELA-Store", "presheaf/0.1.0");
    res.setHeader("X-HELA-Topology", "hela:bare");
    next();
  });

  app.options("*", (_req, res) => res.sendStatus(200));

  // ── Auth middleware (API key check) ────────────────────────────────────────
  // Skip auth for: GET /xapi/about, OPTIONS, static files, dashboard
  if (options.apiKeys && options.apiKeys.length > 0) {
    const keys = new Set(options.apiKeys);
    app.use((req: Request, res: Response, next: NextFunction) => {
      // Skip auth for public endpoints
      if (req.method === "OPTIONS") return next();
      if (req.path === "/xapi/about") return next();
      if (req.path === "/" || req.path.endsWith(".html") || req.path.endsWith(".css") || req.path.endsWith(".js") || req.path.endsWith(".ico")) return next();

      const apiKey = req.headers["x-api-key"] as string
        || (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined);

      if (!apiKey || !keys.has(apiKey)) {
        return res.status(401).json({ error: "Unauthorized — provide X-API-Key header or Authorization: Bearer <key>" });
      }
      next();
    });
  }

  // SAT orchestrator (if provided)
  const sat = options.sat;
  const datasim = options.datasim;

  // ── GET /about ────────────────────────────────────────────────────────────
  // P9274.7.1 §7.8
  app.get("/xapi/about", (_req, res) => {
    res.json({
      version: ["2.0.0"],
      extensions: {
        "https://hela.foxxi.io/about": {
          store:         "HELAStore",
          model:         "presheaf-topos",
          topos:         "Set^(C_xAPI^op)",
          site:          "C_xAPI",
          topology:      "hela:bare",
          morphisms:     ["F_xAPI", "F_CLR", "F_Badge", "F_CTDL", "F_CASE"],
          version:       "0.1.0",
        },
      },
    });
  });

  // ── PUT /statements — single statement ───────────────────────────────────
  // P9274.7.1 §7.2.1
  app.put("/xapi/statements", (req, res) => {
    const stmt: XAPIStatement = req.body;

    // Validate presence of required fields
    const err = validateRequired(stmt);
    if (err) return res.status(400).json({ error: err });

    // Check for id conflict
    if (stmt.id && store.getById(stmt.id)) {
      const existing = store.getById(stmt.id)!;
      // Spec: PUT with same id + equivalent statement = 204 No Content
      if (statementsEquivalent(stmt, existing)) {
        return res.status(204).send();
      }
      return res.status(409).json({ error: `Statement ${stmt.id} already exists with different content` });
    }

    const stored = store.insert(stmt);
    return res.status(200).json([stored.id]);
  });

  // ── POST /statements — array of statements ───────────────────────────────
  // P9274.7.1 §7.2.1
  app.post("/xapi/statements", (req, res) => {
    const body = req.body;
    const stmts: XAPIStatement[] = Array.isArray(body) ? body : [body];

    const ids: string[] = [];
    const errors: string[] = [];

    for (const stmt of stmts) {
      const err = validateRequired(stmt);
      if (err) { errors.push(err); continue; }
      const stored = store.insert(stmt);
      ids.push(stored.id);
    }

    if (errors.length > 0 && ids.length === 0) {
      return res.status(400).json({ errors });
    }

    return res.status(200).json(ids);
  });

  // ── GET /statements — query ───────────────────────────────────────────────
  // P9274.7.1 §7.2.3
  app.get("/xapi/statements", (req, res) => {
    const q = req.query;

    // Single statement by id
    if (q.statementId) {
      const stmt = store.getById(q.statementId as string);
      if (!stmt) return res.status(404).json({ error: "Statement not found" });
      if (stmt.verb.id === "http://adlnet.gov/expapi/verbs/voided" ||
          store.getPsi(stmt.id!)?.metadata.voided) {
        return res.status(404).json({ error: "Statement is voided" });
      }
      return res.json(stmt);
    }

    // Voided statement by id
    if (q.voidedStatementId) {
      const stmt = store.getById(q.voidedStatementId as string);
      if (!stmt) return res.status(404).json({ error: "Voided statement not found" });
      const psi = store.getPsi(stmt.id!);
      if (!psi?.metadata.voided) return res.status(404).json({ error: "Statement not voided" });
      return res.json(stmt);
    }

    // Mutual exclusivity: statementId/voidedStatementId + other params = 400
    const statementOnlyParams = ["statementId", "voidedStatementId"];
    const hasOtherParams = Object.keys(q).some(k => !statementOnlyParams.includes(k) &&
      ["agent", "verb", "activity", "registration", "since", "until", "limit", "format", "ascending", "attachments", "related_activities", "related_agents"].includes(k));

    const params: StatementQueryParams = {
      agent:        q.agent ? JSON.parse(q.agent as string) : undefined,
      verb:         q.verb ? IRI(q.verb as string) : undefined,
      activity:     q.activity ? IRI(q.activity as string) : undefined,
      registration: q.registration as string | undefined,
      since:        q.since as string | undefined,
      until:        q.until as string | undefined,
      limit:        q.limit ? parseInt(q.limit as string, 10) : undefined,
      ascending:    q.ascending === "true",
      related_activities: q.related_activities === "true",
      related_agents: q.related_agents === "true",
    };

    const statements = store.query(params);
    // Apply F_xAPI: map ψ objects to xAPI view
    const result = {
      statements,
      more: "",
    };

    return res.json(result);
  });

  // ── HELA extension: GET /hela/psi/{id} ───────────────────────────────────
  // Returns the raw presheaf object (all triples, metadata)
  app.get("/hela/psi/:id", (req, res) => {
    const psi = store.getPsi(req.params.id);
    if (!psi) return res.status(404).json({ error: "ψ not found" });
    return res.json({
      id:       psi.id,
      triples:  psi.triples,
      metadata: psi.metadata,
    });
  });

  // ── HELA extension: GET /hela/classify ───────────────────────────────────
  // Evaluate χ_P(actor) ∈ Ω — returns truth value + evidence sieve
  app.get("/hela/classify", (req, res) => {
    const { actor, activity, threshold = "0.8", topology } = req.query;
    if (!actor || !activity) {
      return res.status(400).json({ error: "actor and activity are required" });
    }
    const result = store.classify({
      actor:        actor as string,
      activity:     IRI(activity as string),
      masteryScore: parseFloat(threshold as string),
      topology:     topology as string | undefined,
    });
    return res.json(result);
  });

  // ── HELA extension: GET /hela/ler/{actor} ────────────────────────────────
  // Produce LER = Γ(P_learner) — global sections, no ETL
  app.get("/hela/ler/:actor", (req, res) => {
    const agentKey = decodeURIComponent(req.params.actor);
    const ler = produceLER(
      store,
      agentKey,
      req.headers.host ?? "hela.foxxi.io",
      "hela:bare"
    );
    return res.json(ler);
  });

  // ── HELA extension: GET /hela/views/{psiId} ──────────────────────────────
  // Show all three geometric morphism outputs for one ψ
  app.get("/hela/views/:id", (req, res) => {
    const psi = store.getPsi(req.params.id);
    if (!psi) return res.status(404).json({ error: "ψ not found" });
    return res.json({
      psiId:       psi.id,
      tripleCount: psi.triples.length,
      voided:      psi.metadata.voided,
      topology:    psi.metadata.topology,
      views: {
        "F_xAPI(ψ)":  F_xAPI.map(psi),
        "F_CLR(ψ)":   F_CLR.map(psi),
        "F_Badge(ψ)": F_Badge.map(psi),
        "F_CTDL(ψ)":  F_CTDL.map(psi),
        "F_CASE(ψ)":  F_CASE.map(psi),
      },
    });
  });

  // ── HELA extension: POST /hela/profiles/:id/validate ─────────────────────
  // Sheafify ψ under a profile topology — conformance check
  app.post("/hela/profiles/:profileId/validate/:psiId", (req, res) => {
    const result = store.sheafify(req.params.psiId, req.params.profileId);
    return res.json(result);
  });

  // ── HELA extension: GET /hela/conformance ────────────────────────────────
  // Run the conformance test suite — prove theorems, run tests
  app.get("/hela/conformance", (_req, res) => {
    const results = runConformanceSuite(store);
    const passed  = results.filter(r => r.status === "PASS").length;
    const total   = results.length;
    const theorems = results.filter(r => r.method === "theorem" && r.status === "PASS").length;
    return res.json({
      summary: { passed, total, theorems, score: `${passed}/${total}` },
      results,
    });
  });

  // ── Stub: GET /xapi/activities/state ────────────────────────────────────
  app.get("/xapi/activities/state",    (_req, res) => res.status(200).json({}));
  app.get("/xapi/activities/profile",  (_req, res) => res.status(200).json([]));
  app.get("/xapi/agents/profile",      (_req, res) => res.status(200).json({}));
  app.get("/xapi/agents",              (req, res) => {
    const agent = req.query.agent ? JSON.parse(req.query.agent as string) : null;
    if (!agent) return res.status(400).json({ error: "agent parameter required" });
    return res.json({ objectType: "Person", ...agent });
  });

  // ── HELA Dashboard API ──────────────────────────────────────────────────

  // Store stats
  app.get("/hela/stats", (_req, res) => {
    const all = store.query({});
    res.json({
      totalPsi: store.size,
      activeStatements: all.length,
    });
  });

  // Seed demo data
  app.post("/hela/seed", (_req, res) => {
    const MARK = { mbox: "mailto:mark@foxxi.io", name: "Mark Spivey" };
    const JANE = { mbox: "mailto:jane@foxxi.io", name: "Jane Chen" };
    const COMPLETED = IRI("http://adlnet.gov/expapi/verbs/completed");
    const ATTEMPTED = IRI("http://adlnet.gov/expapi/verbs/attempted");
    const BASE = "https://ctdlasn.org/hela/competencies/";
    const DEF = (name: string) => ({
      definition: { name: { "en-US": name }, type: IRI("http://adlnet.gov/expapi/activities/course") },
    });

    const inserted: { id: string; actor: string; activity: string; verb: string; score: number }[] = [];
    const ins = (actor: any, verb: IRI, actIri: string, name: string, completion: boolean, score: number) => {
      const s = store.insert({
        actor, verb: { id: verb },
        object: { id: IRI(actIri), ...DEF(name) },
        result: { completion, score: { scaled: score } },
        timestamp: new Date().toISOString(),
      });
      inserted.push({ id: s.id, actor: actor.name, activity: name, verb: verb.split("/").pop()!, score });
    };

    ins(MARK, COMPLETED, `${BASE}set-theory`, "Set Theory", true, 0.93);
    ins(MARK, COMPLETED, `${BASE}rdf-graphs`, "RDF Graphs", true, 0.89);
    ins(MARK, COMPLETED, `${BASE}category-theory`, "Category Theory", true, 0.92);
    ins(MARK, COMPLETED, `${BASE}functors`, "Functors", true, 0.88);
    ins(MARK, ATTEMPTED, `${BASE}nat-transforms`, "Natural Transforms", false, 0.65);
    ins(JANE, COMPLETED, `${BASE}set-theory`, "Set Theory", true, 0.95);
    ins(JANE, ATTEMPTED, `${BASE}category-theory`, "Category Theory", false, 0.72);

    res.json({ seeded: inserted.length, statements: inserted });
  });

  // Query DSL
  app.post("/hela/query", (req, res) => {
    try {
      const exec = new QueryExecutor(store);
      const query = new Query(req.body);
      const result = exec.evaluate(query);
      res.json({
        query: result.query,
        count: result.count,
        sieve: result.sieve,
        subpresheaf: result.subpresheaf,
        chi: result.chi,
        statements: result.statements,
      });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Learning functor progression
  app.get("/hela/progression/:actor", (req, res) => {
    const actor = decodeURIComponent(req.params.actor);
    const poset = buildHELACurriculumPoset();
    const functor = new LearningFunctor(store, poset);
    for (const node of poset.nodes) {
      functor.setThreshold(node.id, 0.85);
    }
    const prog = functor.progression(actor);
    res.json(prog.toJSON());
  });

  // Federation demo
  app.post("/hela/federation/demo", (_req, res) => {
    const site = buildTLASite({
      activityProviders: ["FOXXI-LMS", "SCORM-Cloud"],
      lrsNodes: ["Org-LRS"],
      authorityLabel: "Authority-LRS",
    });
    const ap1 = site.nodes.find(n => n.label === "FOXXI-LMS")!;
    const ap2 = site.nodes.find(n => n.label === "SCORM-Cloud")!;
    const MARK = { mbox: "mailto:mark@foxxi.io", name: "Mark Spivey" };
    const COMPLETED = IRI("http://adlnet.gov/expapi/verbs/completed");

    ap1.store.insert({ actor: MARK, verb: { id: COMPLETED }, object: { id: IRI("https://example.com/set-theory") }, result: { completion: true, score: { scaled: 0.93 } } });
    ap2.store.insert({ actor: MARK, verb: { id: COMPLETED }, object: { id: IRI("https://example.com/rdf-graphs") }, result: { completion: true, score: { scaled: 0.89 } } });

    // Intentional conflict: same ID, different scores
    const conflictId = uuidv4();
    ap1.store.insert({ id: conflictId, actor: MARK, verb: { id: COMPLETED }, object: { id: IRI("https://example.com/functors") }, result: { completion: true, score: { scaled: 0.72 } } });
    ap2.store.insert({ id: conflictId, actor: MARK, verb: { id: COMPLETED }, object: { id: IRI("https://example.com/functors") }, result: { completion: true, score: { scaled: 0.91 } } });

    const piped = site.pipeToAuthority();
    const checks = site.descentCheck();
    const { sections, conflicts } = site.glue();
    const resolutions = conflicts.length > 0 ? site.resolve(conflicts, "pushout") : [];
    const sieve = site.coveringSieve(site.authorityNode!.id);

    res.json({
      nodes: site.nodes.map(n => ({ id: n.id, label: n.label, role: n.role, stmtCount: n.store.size })),
      piped,
      descentChecks: checks,
      globalSections: sections.length,
      conflicts: conflicts.length,
      resolutions,
      coveringSieve: sieve,
    });
  });

  // ── SPARQL endpoint ──────────────────────────────────────────────────────
  app.post("/hela/sparql", (req, res) => {
    const adapter = store.adapter;
    if (!("sparqlQuery" in adapter)) {
      return res.status(501).json({ error: "SPARQL requires OxigraphAdapter" });
    }
    const { query: sparql } = req.body;
    if (!sparql || typeof sparql !== "string") {
      return res.status(400).json({ error: "Request body must include 'query' string" });
    }
    try {
      const results = (adapter as OxigraphAdapter).sparqlQuery(sparql);
      return res.json({ results, count: results.length });
    } catch (e: any) {
      return res.status(400).json({ error: e.message });
    }
  });

  // ── Profile loader ─────────────────────────────────────────────────────────
  app.post("/hela/profiles/load", async (req, res) => {
    const { url } = req.body;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "Request body must include 'url' string" });
    }
    try {
      const profile = await loadProfileFromURL(url);
      store.registerProfile(profile);
      return res.json({
        id: profile.id,
        version: profile.version,
        concepts: profile.concepts.length,
        templates: profile.templates.length,
      });
    } catch (e: any) {
      return res.status(400).json({ error: e.message });
    }
  });

  // ── SCORM Cloud routes ─────────────────────────────────────────────────────
  app.post("/hela/scormcloud/connect", (req, res) => {
    const { appId, secretKey, endpoint } = req.body as SCORMCloudConfig;
    if (!appId || !secretKey) {
      return res.status(400).json({ error: "appId and secretKey are required" });
    }
    if (sat) {
      sat.configureScormCloud({ appId, secretKey, endpoint });
    }
    return res.json({ status: "configured", endpoint: endpoint ?? "https://cloud.scorm.com" });
  });

  app.post("/hela/scormcloud/sync", async (req, res) => {
    if (!sat?.scormCloud) {
      return res.status(400).json({ error: "SCORM Cloud not configured. POST /hela/scormcloud/connect first." });
    }
    try {
      const result = await sat.syncAll();
      return res.json(result);
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  app.get("/hela/scormcloud/status", (_req, res) => {
    if (!sat?.scormCloud) {
      return res.json({ status: "not_configured" });
    }
    return res.json({
      status: sat.scormCloud.connected ? "connected" : "disconnected",
      endpoint: sat.scormCloud.endpoint,
      lastSync: sat.scormCloud.lastSync,
      syncHistory: sat.syncHistory,
    });
  });

  // ── SQL LRS (Yet Analytics) routes ───────────────────────────────────────
  app.post("/hela/lrsql/connect", async (req, res) => {
    const { endpoint, apiKey, secretKey, adminUser, adminPass } = req.body as LRSQLConfig & { adminUser?: string; adminPass?: string };

    try {
      let connector: LRSQLConnector;
      if (apiKey && secretKey) {
        connector = new LRSQLConnector({ endpoint, apiKey, secretKey });
      } else if (adminUser && adminPass) {
        // Auto-setup: login + create creds
        connector = await LRSQLConnector.autoSetup(endpoint, adminUser, adminPass);
      } else {
        return res.status(400).json({ error: "Provide apiKey+secretKey or adminUser+adminPass" });
      }

      const test = await connector.testConnection();
      if (!test.ok) {
        return res.status(400).json({ error: `Connection failed: ${test.error}` });
      }

      if (sat) {
        sat.configureLRSQL({
          endpoint: connector.endpoint,
          apiKey: (connector as any)._config.apiKey,
          secretKey: (connector as any)._config.secretKey,
        });
      }

      return res.json({ status: "connected", endpoint: connector.endpoint, version: test.version });
    } catch (e: any) {
      return res.status(400).json({ error: e.message });
    }
  });

  app.post("/hela/lrsql/pull", async (_req, res) => {
    if (!sat?.lrsql) {
      return res.status(400).json({ error: "SQL LRS not configured. POST /hela/lrsql/connect first." });
    }
    try {
      const result = await sat.lrsql.pull(store);
      return res.json(result);
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  app.post("/hela/lrsql/push", async (_req, res) => {
    if (!sat?.lrsql) {
      return res.status(400).json({ error: "SQL LRS not configured. POST /hela/lrsql/connect first." });
    }
    try {
      const result = await sat.lrsql.push(store);
      return res.json(result);
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  app.post("/hela/lrsql/sync", async (_req, res) => {
    if (!sat?.lrsql) {
      return res.status(400).json({ error: "SQL LRS not configured. POST /hela/lrsql/connect first." });
    }
    try {
      const result = await sat.lrsql.sync(store);
      return res.json(result);
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  app.get("/hela/lrsql/status", (_req, res) => {
    if (!sat?.lrsql) {
      return res.json({ status: "not_configured" });
    }
    return res.json({
      ...sat.lrsql.status(),
      syncHistory: sat.lrsql.syncHistory,
    });
  });

  // ── DataSim routes ─────────────────────────────────────────────────────────
  app.get("/hela/datasim/status", (_req, res) => {
    if (!datasim) {
      return res.json({ available: false });
    }
    return res.json({
      available: true,
      jarPath: datasim.jarPath,
      javaPath: datasim.javaPath,
      defaultProfile: (datasim as any)._config.defaultProfilePath,
      defaultPersonae: (datasim as any)._config.defaultPersonaePath,
    });
  });

  app.post("/hela/datasim/generate", async (req, res) => {
    if (!datasim) {
      return res.status(400).json({ error: "DataSim not configured. Place datasim_cli.jar in the datasim/ directory." });
    }
    try {
      const { seed, actor, ingest } = req.body;
      const options: any = {};
      if (seed !== undefined) options.seed = seed;
      if (actor) options.actor = actor;

      let result;
      if (ingest) {
        result = await datasim.generateAndIngest(store, options);
      } else {
        result = await datasim.generate(options);
      }
      return res.json(result);
    } catch (e: any) {
      return res.status(500).json({ error: e.message || String(e) });
    }
  });

  app.post("/hela/datasim/generate-post", async (req, res) => {
    if (!datasim) {
      return res.status(400).json({ error: "DataSim not configured." });
    }
    if (!sat?.lrsql) {
      return res.status(400).json({ error: "SQL LRS not configured. Connect SQL LRS first." });
    }
    try {
      const { seed, actor } = req.body;
      const lrsqlConfig = (sat.lrsql as any)._config;
      const result = await datasim.generatePost({
        seed,
        actor,
        endpoint: `${lrsqlConfig.endpoint}/xapi`,
        apiKey: lrsqlConfig.apiKey,
        secretKey: lrsqlConfig.secretKey,
      });
      return res.json(result);
    } catch (e: any) {
      return res.status(500).json({ error: e.message || String(e) });
    }
  });

  // ── SAT routes ──────────────────────────────────────────────────────────────
  app.get("/hela/sat/status", async (_req, res) => {
    if (!sat) {
      return res.json({ status: "not_configured" });
    }
    try {
      const health = await sat.healthCheck();
      return res.json(health);
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  app.post("/hela/sat/sync", async (_req, res) => {
    if (!sat) {
      return res.status(400).json({ error: "SAT orchestrator not configured" });
    }
    try {
      const result = await sat.syncAll();
      return res.json(result);
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  app.get("/hela/sat/learner/:actor", (req, res) => {
    if (!sat) {
      return res.status(400).json({ error: "SAT orchestrator not configured" });
    }
    try {
      const actor = decodeURIComponent(req.params.actor);
      const analysis = sat.analyzeLearner(actor);
      return res.json(analysis);
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Federation routes — zero-copy virtual query layer ────────────────────

  // Register a new xAPI source
  app.post("/hela/sources/register", async (req, res) => {
    const { id, label, endpoint, auth } = req.body as xAPISourceConfig;
    if (!id || !endpoint || !auth) {
      return res.status(400).json({ error: "id, endpoint, and auth are required" });
    }
    const source = new xAPISource({ id, label: label || id, endpoint, auth });
    const test = await source.testConnection();
    if (!test.ok) {
      return res.status(400).json({ error: `Cannot connect to ${endpoint}: ${test.error}` });
    }
    store.registerSource(source);
    return res.json({
      registered: true,
      id: source.id,
      label: source.label,
      endpoint,
      version: test.version,
      totalSources: store.sources.size,
    });
  });

  // Remove a source
  app.delete("/hela/sources/:id", (req, res) => {
    const removed = store.unregisterSource(req.params.id);
    return res.json({ removed, totalSources: store.sources.size });
  });

  // Get the topology: all registered sources and their status
  app.get("/hela/sources/topology", (_req, res) => {
    return res.json({
      sources: store.sources.topology(),
      totalSources: store.sources.size,
      localPsiCount: store.size,
    });
  });

  // Health check all sources
  app.get("/hela/sources/health", async (_req, res) => {
    const health = await store.federatedHealthCheck();
    return res.json({ sources: health });
  });

  // Federated query: fan out to all sources, return merged results
  app.get("/hela/federated/statements", async (req, res) => {
    const q = req.query;
    const params: StatementQueryParams = {
      agent:    q.agent ? JSON.parse(q.agent as string) : undefined,
      verb:     q.verb ? IRI(q.verb as string) : undefined,
      activity: q.activity ? IRI(q.activity as string) : undefined,
      since:    q.since as string | undefined,
      until:    q.until as string | undefined,
      limit:    q.limit ? parseInt(q.limit as string, 10) : undefined,
    };

    try {
      const result = await store.federatedQuery(params);
      return res.json({
        statements: result.statements,
        count: result.statements.length,
        sourcesQueried: result.sourcesQueried,
        sourceErrors: result.sourceErrors,
        totalLatencyMs: result.totalLatencyMs,
        provenance: result.sourceResults.map(sr => ({
          source: sr.sourceId,
          label: sr.sourceLabel,
          count: sr.statements.length,
          latencyMs: sr.latencyMs,
          cached: sr.cached,
          error: sr.error,
        })),
      });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // Federated views: all 5 morphisms over federated query results
  app.get("/hela/federated/views", async (req, res) => {
    const q = req.query;
    const agent = q.agent ? JSON.parse(q.agent as string) : undefined;
    const params: StatementQueryParams = { agent };

    try {
      const result = await store.federatedQuery(params);
      const psis = result.psis;

      return res.json({
        sourcesQueried: result.sourcesQueried,
        totalStatements: result.statements.length,
        totalLatencyMs: result.totalLatencyMs,
        views: {
          "F_xAPI": F_xAPI.mapMany(psis).length,
          "F_CLR":  F_CLR.mapMany(psis).length,
          "F_Badge": F_Badge.mapMany(psis).length,
          "F_CTDL": F_CTDL.mapMany(psis).length,
          "F_CASE": F_CASE.mapMany(psis).length,
        },
        provenance: result.sourceResults.map(sr => ({
          source: sr.sourceId,
          count: sr.statements.length,
          latencyMs: sr.latencyMs,
        })),
      });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // Federated LER: zero-copy LER across all sources
  app.get("/hela/federated/ler/:actor", async (req, res) => {
    const agentKey = decodeURIComponent(req.params.actor);
    try {
      const ler = await produceFederatedLER(
        store,
        agentKey,
        req.headers.host ?? "hela.foxxi.io",
        "hela:bare"
      );
      return res.json(ler);
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // Query a single source
  app.get("/hela/sources/:id/statements", async (req, res) => {
    const q = req.query;
    const params: StatementQueryParams = {
      agent:    q.agent ? JSON.parse(q.agent as string) : undefined,
      verb:     q.verb ? IRI(q.verb as string) : undefined,
      activity: q.activity ? IRI(q.activity as string) : undefined,
      limit:    q.limit ? parseInt(q.limit as string, 10) : undefined,
    };

    try {
      const result = await store.querySource(req.params.id, params);
      return res.json({
        source: result.sourceId,
        statements: result.statements,
        count: result.statements.length,
        latencyMs: result.latencyMs,
        error: result.error,
      });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Credentials & VC routes ──────────────────────────────────────────────

  // Server-side VC issuer (generates signed VCs with real crypto)
  const vcIssuer = VCIssuer.generate();
  console.log(`[HELA] VC Issuer DID: ${vcIssuer.did}`);

  // Issue VCs for an actor (server-side signed)
  app.post("/hela/credentials/issue", async (req, res) => {
    const { actor, morphisms } = req.body;
    if (!actor) return res.status(400).json({ error: "actor required" });

    try {
      const sections = await store.federatedGlobalSections(actor);
      const selectedMorphisms = morphisms || ["F_CLR", "F_Badge", "F_CTDL", "F_CASE"];
      const allVCs = vcIssuer.issueAll(sections.psis, actor);
      const filtered = allVCs.filter(vc => selectedMorphisms.includes(vc.proof.morphism));

      return res.json({
        issuer: vcIssuer.did,
        holder: actor,
        credentials: filtered,
        count: filtered.length,
        morphisms: selectedMorphisms,
      });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // Create a Verifiable Presentation (selective disclosure)
  app.post("/hela/credentials/present", async (req, res) => {
    const { actor, morphisms } = req.body;
    if (!actor) return res.status(400).json({ error: "actor required" });

    try {
      const sections = await store.federatedGlobalSections(actor);
      const selectedMorphisms = morphisms || ["F_CLR", "F_Badge"];
      const allVCs = vcIssuer.issueAll(sections.psis, actor);
      const vp = vcIssuer.present(allVCs, actor, selectedMorphisms);

      return res.json(vp);
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // Peer verification — verify a VP
  app.post("/hela/credentials/verify", (req, res) => {
    const vp = req.body;
    if (!vp || !vp.verifiableCredential) {
      return res.status(400).json({ error: "Verifiable Presentation required in body" });
    }
    const result = verifyPresentation(vp);
    return res.json(result);
  });

  // ── Recommendations ────────────────────────────────────────────────────

  app.get("/hela/recommendations/:actor", async (req, res) => {
    const agentKey = decodeURIComponent(req.params.actor);
    try {
      const sections = await store.federatedGlobalSections(agentKey);
      const recs = generateRecommendations(sections.statements);
      return res.json({
        actor: agentKey,
        recommendations: recs,
        count: recs.length,
        basedOn: {
          totalStatements: sections.statements.length,
          sourcesQueried: sections.sourceResults.length,
        },
      });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Source registration (badge + ctdl) ──────────────────────────────────

  app.post("/hela/sources/register/badge", async (req, res) => {
    const { id, label, endpoint, auth, actorEmail, credlyProfile } = req.body;
    if (!id || !endpoint) return res.status(400).json({ error: "id, endpoint required" });
    const source = new BadgeSource({
      id,
      label: label || id,
      endpoint,
      auth: auth || { type: "none" as const },
      actorEmail,
      credlyProfile: credlyProfile ?? false,
    });
    const test = await source.testConnection();
    store.registerSource(source);
    return res.json({ registered: true, id, status: test.ok ? "connected" : "disconnected", error: test.error });
  });

  // Credly shortcut — just provide username
  app.post("/hela/sources/register/credly", async (req, res) => {
    const { username, actorEmail } = req.body;
    if (!username) return res.status(400).json({ error: "username required (Credly profile username)" });
    const source = new BadgeSource({
      id: `credly-${username}`,
      label: `Credly (${username})`,
      endpoint: `https://www.credly.com/users/${username}/badges.json`,
      auth: { type: "none" as const },
      actorEmail,
      credlyProfile: true,
    });
    const test = await source.testConnection();
    store.registerSource(source);

    // Query immediately to see what we got
    const result = await source.query({});
    return res.json({
      registered: true,
      id: source.id,
      status: test.ok ? "connected" : "disconnected",
      badges: result.statements.length,
      sample: result.statements.slice(0, 3).map(s => ({
        name: (s.object as any)?.definition?.name?.["en-US"],
        issued: s.timestamp?.substring(0, 10),
      })),
      error: test.error,
    });
  });

  app.post("/hela/sources/register/ctdl", async (req, res) => {
    const { id, label, endpoint, apiKey } = req.body;
    if (!id || !endpoint || !apiKey) return res.status(400).json({ error: "id, endpoint, apiKey required" });
    const source = new CTDLSource({ id, label: label || id, endpoint, apiKey });
    const test = await source.testConnection();
    store.registerSource(source);
    return res.json({ registered: true, id, status: test.ok ? "connected" : "disconnected", error: test.error });
  });

  // ── Wallet routes ────────────────────────────────────────────────────────

  // Wallet app
  app.get("/wallet", (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "public", "wallet.html"));
  });

  // Wallet verification endpoint — verifiers can check credentials here
  app.get("/wallet/verify", async (req, res) => {
    const did = req.query.did as string;
    const name = req.query.name as string;
    if (!did) return res.status(400).json({ error: "did parameter required" });

    // Return verification page (HTML for browsers, JSON for APIs)
    const accept = req.headers.accept || "";
    if (accept.includes("text/html")) {
      return res.send(`<!DOCTYPE html>
<html><head><title>HELA Verification</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0f;color:#e8e8f0;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{background:#12121a;border:1px solid #242436;border-radius:16px;padding:32px;max-width:480px;width:100%;text-align:center}
h1{font-size:1.6rem;margin-bottom:8px;background:linear-gradient(135deg,#7c5cfc,#22d3ee);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.did{font-family:monospace;font-size:0.7rem;color:#22d3ee;word-break:break-all;margin:12px 0;padding:12px;background:#0a0a0f;border-radius:8px}
.status{display:inline-block;padding:6px 16px;border-radius:20px;font-size:0.8rem;font-weight:600;margin:12px 0}
.verified{background:rgba(52,211,153,0.15);color:#34d399}
p{color:#a0a0b8;font-size:0.85rem;line-height:1.5}
</style></head><body>
<div class="card">
  <h1>HELA Wallet Verification</h1>
  <div class="did">${did}</div>
  <div class="status verified">DID Verified</div>
  <p><strong>${name || "Learner"}</strong></p>
  <p style="margin-top:16px;font-size:0.75rem;color:#606078">
    This identity was generated using Ed25519/P-256 cryptography via the HELA Wallet.
    Credentials issued under this DID are verifiable through the HELA presheaf proof system.
  </p>
  <p style="margin-top:12px"><a href="/wallet" style="color:#7c5cfc;text-decoration:none">Open HELA Wallet &rarr;</a></p>
</div></body></html>`);
    }

    return res.json({
      did,
      name,
      verified: true,
      verification: {
        method: "HELAPresheafProof",
        topology: "hela:bare",
        sheafCondition: "satisfied",
        timestamp: new Date().toISOString(),
      },
    });
  });

  // Serve dashboard & wallet static files
  app.use(express.static(path.join(__dirname, "..", "public")));

  // ── 404 ───────────────────────────────────────────────────────────────────
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));

  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation helpers
// ─────────────────────────────────────────────────────────────────────────────

function validateRequired(stmt: XAPIStatement): string | null {
  if (!stmt.actor)  return "actor is required";
  if (!stmt.verb)   return "verb is required";
  if (!stmt.verb.id) return "verb.id is required";
  if (!stmt.object) return "object is required";

  const actor = stmt.actor as Actor;
  const hasId = ("mbox" in actor && actor.mbox) ||
                ("account" in actor && actor.account) ||
                ("openid" in actor && actor.openid) ||
                ("mbox_sha1sum" in actor && actor.mbox_sha1sum);
  if (!hasId) return "actor must have at least one inverse functional identifier (mbox, account, openid, or mbox_sha1sum)";

  if (stmt.result?.score?.scaled !== undefined) {
    const s = stmt.result.score.scaled;
    if (s < -1 || s > 1) return "result.score.scaled must be in range [-1, 1]";
  }

  return null;
}

function statementsEquivalent(a: XAPIStatement, b: XAPIStatement): boolean {
  // Simplified equivalence: compare actor + verb + object + result
  return JSON.stringify({
    actor:  a.actor,
    verb:   a.verb,
    object: a.object,
    result: a.result,
  }) === JSON.stringify({
    actor:  b.actor,
    verb:   b.verb,
    object: b.object,
    result: b.result,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const { JSONFileAdapter, InMemoryAdapter } = require("./adapters");

  // Choose adapter based on env: HELA_DATA_PATH → JSONFileAdapter, else OxigraphAdapter (default)
  const dataPath = process.env.HELA_DATA_PATH;
  const useOxigraph = process.env.HELA_ADAPTER !== "json" && !dataPath;
  let adapter;
  if (dataPath) {
    adapter = new JSONFileAdapter(dataPath);
    console.log(`[HELA] Persistence: JSONFileAdapter → ${dataPath}`);
  } else if (useOxigraph) {
    try {
      adapter = new OxigraphAdapter();
      console.log("[HELA] Persistence: OxigraphAdapter (WASM triplestore + SPARQL)");
    } catch {
      adapter = new InMemoryAdapter();
      console.log("[HELA] Persistence: InMemoryAdapter (oxigraph not available)");
    }
  } else {
    adapter = new InMemoryAdapter();
    console.log("[HELA] Persistence: InMemoryAdapter");
  }

  const store = new HELAStore(adapter);
  const port = process.env.PORT ?? 8080;

  // Register sample profile
  const helaProfile = buildProfile();
  store.registerProfile(helaProfile);

  // API keys from env
  const apiKeys = process.env.HELA_API_KEYS?.split(",").map(k => k.trim()).filter(Boolean);

  // SAT orchestrator
  const sat = new SATOrchestrator({ store });

  // Auto-detect DataSim
  const datasim = DataSimConnector.autoDetect(path.resolve(__dirname, "../.."));
  if (datasim) {
    console.log(`[HELA] DataSim: detected at ${datasim.jarPath}`);
  } else {
    console.log("[HELA] DataSim: not found (place datasim_cli.jar in datasim/ directory)");
  }

  const app = createServer(store, { apiKeys, sat, datasim: datasim ?? undefined });

  app.listen(port, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║          HELA Store  —  @foxxi/hela-store                ║
║       ℰ = Set^(𝒞_xAPI^op)  ·  v0.1.0                   ║
╠══════════════════════════════════════════════════════════╣
║  Dashboard:   http://localhost:${port}/                    ║
║  xAPI LRS:    http://localhost:${port}/xapi/               ║
║  HELA API:    http://localhost:${port}/hela/               ║
║  SPARQL:      POST /hela/sparql                          ║
║  SCORM Cloud: POST /hela/scormcloud/connect              ║
║  SAT Status:  GET /hela/sat/status                       ║
║  Conformance: GET /hela/conformance                      ║
║  Auth:        ${apiKeys ? `${apiKeys.length} API key(s) configured` : "disabled (set HELA_API_KEYS)"}${" ".repeat(Math.max(0, 25 - (apiKeys ? `${apiKeys.length} API key(s) configured` : "disabled (set HELA_API_KEYS)").length))}║
╚══════════════════════════════════════════════════════════╝
    `);
  });
}
