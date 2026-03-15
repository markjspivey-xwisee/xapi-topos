// ─────────────────────────────────────────────────────────────────────────────
// @foxxi/hela-store  —  store.ts
//
// The HELA Store: ℰ = Set^(𝒞_xAPI^op)
//
// This is the presheaf category over the xAPI site.
// Every xAPI statement is mapped to a presheaf object ψ via φ : Σ → ℰ.
// The LRS REST interface is a geometric morphism F_xAPI : ℰ → LRS.
// ─────────────────────────────────────────────────────────────────────────────

import { v4 as uuidv4 } from "uuid";
import {
  IRI, BNode, Literal, Agent,
  XAPIStatement, StoredXAPIStatement,
  Psi, PsiMetadata, Triple,
  Sieve, OmegaValue, TruthGrade,
  StatementQueryParams, Profile, ProfileValidationResult,
  LER, CLRAssertion, BadgeAssertion,
  CTDLCredential, CASEItem,
  GeometricMorphism, StatementResult,
} from "./types";
import { StoreAdapter, InMemoryAdapter } from "./adapters";
import { SourceRegistry, FederatedSource, FederatedMergeResult, FederatedQueryResult } from "./sources";

// ── xAPI namespace IRIs ───────────────────────────────────────────────────────
const XAPI  = (s: string): IRI => IRI(`https://w3id.org/xapi/ontology#${s}`);
const ADL   = (s: string): IRI => IRI(`http://adlnet.gov/expapi/verbs/${s}`);
const RDF   = (s: string): IRI => IRI(`http://www.w3.org/1999/02/22-rdf-syntax-ns#${s}`);
const PROV  = (s: string): IRI => IRI(`http://www.w3.org/ns/prov#${s}`);
const XSD   = (s: string): IRI => IRI(`http://www.w3.org/2001/XMLSchema#${s}`);

const XAPI_STATEMENT_TYPE = XAPI("Statement");
const XAPI_ACTOR          = XAPI("actor");
const XAPI_VERB           = XAPI("verb");
const XAPI_OBJECT         = XAPI("object");
const XAPI_RESULT         = XAPI("result");
const XAPI_SCORE_SCALED   = XAPI("scaled");
const XAPI_COMPLETION     = XAPI("completion");
const XAPI_SUCCESS        = XAPI("success");
const XAPI_STORED         = XAPI("stored");
const XAPI_VOIDED         = XAPI("voided");
const VERB_VOIDED         = ADL("voided");
const RDF_TYPE            = RDF("type");
const PROV_GENERATED      = PROV("generatedAtTime");

// ─────────────────────────────────────────────────────────────────────────────
// φ : XAPIStatement → ψ
// The realization functor: maps an xAPI statement to a presheaf object.
// Produces the RDF triple set that constitutes ψ.
// ─────────────────────────────────────────────────────────────────────────────
export function realize(stmt: StoredXAPIStatement, topology: string): Psi {
  const base    = IRI(`https://hela.foxxi.io/statements/${stmt.id}`);
  const triples: Triple[] = [];

  const t = (s: typeof base | ReturnType<typeof BNode>, p: IRI, o: ReturnType<typeof Literal> | IRI | ReturnType<typeof BNode>) =>
    triples.push({ subject: s, predicate: p, object: o });

  // Core statement identity
  t(base, RDF_TYPE, XAPI_STATEMENT_TYPE);
  t(base, XAPI_STORED, Literal(`"${stmt.stored}"^^xsd:dateTime`));

  // Actor
  const actorNode = BNode(`_:actor_${stmt.id}`);
  t(base, XAPI_ACTOR, actorNode);
  const actor = stmt.actor;
  if ("mbox" in actor && actor.mbox) {
    t(actorNode, XAPI("mbox"), IRI(actor.mbox));
  } else if ("account" in actor && actor.account) {
    const accountNode = BNode(`_:account_${stmt.id}`);
    t(actorNode, XAPI("account"), accountNode);
    t(accountNode, XAPI("homePage"), IRI(actor.account.homePage));
    t(accountNode, XAPI("name"), Literal(`"${actor.account.name}"`));
  }
  if (actor.name) {
    t(actorNode, XAPI("name"), Literal(`"${actor.name}"`));
  }

  // Verb
  t(base, XAPI_VERB, IRI(stmt.verb.id));

  // Object
  const obj = stmt.object;
  if (!("objectType" in obj) || obj.objectType === "Activity" || !obj.objectType) {
    const activity = obj as { id: IRI; definition?: { name?: Record<string,string>; type?: IRI } };
    t(base, XAPI_OBJECT, IRI(activity.id));
    if (activity.definition?.type) {
      t(IRI(activity.id), XAPI("activityType"), IRI(activity.definition.type));
    }
    if (activity.definition?.name) {
      for (const [lang, val] of Object.entries(activity.definition.name)) {
        t(IRI(activity.id), XAPI("name"), Literal(`"${val}"@${lang}`));
      }
    }
  } else if (obj.objectType === "StatementRef") {
    const ref = obj as { objectType: "StatementRef"; id: string };
    t(base, XAPI_OBJECT, IRI(`https://hela.foxxi.io/statements/${ref.id}`));
  }

  // Result
  if (stmt.result) {
    const resultNode = BNode(`_:result_${stmt.id}`);
    t(base, XAPI_RESULT, resultNode);
    if (stmt.result.score?.scaled !== undefined) {
      const scoreNode = BNode(`_:score_${stmt.id}`);
      t(resultNode, XAPI("score"), scoreNode);
      t(scoreNode, XAPI_SCORE_SCALED, Literal(`"${stmt.result.score.scaled}"^^xsd:decimal`));
    }
    if (stmt.result.completion !== undefined) {
      t(resultNode, XAPI_COMPLETION, Literal(`"${stmt.result.completion}"^^xsd:boolean`));
    }
    if (stmt.result.success !== undefined) {
      t(resultNode, XAPI_SUCCESS, Literal(`"${stmt.result.success}"^^xsd:boolean`));
    }
  }

  // Context: registration
  if (stmt.context?.registration) {
    t(base, XAPI("registration"), IRI(`urn:uuid:${stmt.context.registration}`));
  }

  // Provenance
  if (stmt.timestamp) {
    t(base, PROV_GENERATED, Literal(`"${stmt.timestamp}"^^xsd:dateTime`));
  }

  const isVoided = stmt.verb.id === VERB_VOIDED;

  const metadata: PsiMetadata = {
    stored:     stmt.stored,
    voided:     isVoided,
    topology,
    profileIds: [],
    sourceStmt: stmt,
  };

  return { id: stmt.id, triples: Object.freeze(triples), metadata };
}

// ─────────────────────────────────────────────────────────────────────────────
// The HELA Store
// ─────────────────────────────────────────────────────────────────────────────
export class HELAStore {
  // The presheaf category ℰ: objects stored via adapter
  private readonly _adapter: StoreAdapter;

  // Voiding index: voidedId → voidingId
  private readonly _voidIndex = new Map<string, string>();

  // Actor index: agentKey → Set<psiId>
  private readonly _actorIndex = new Map<string, Set<string>>();

  // Activity index: activityIRI → Set<psiId>
  private readonly _activityIndex = new Map<string, Set<string>>();

  // Verb index: verbIRI → Set<psiId>
  private readonly _verbIndex = new Map<string, Set<string>>();

  // Registered profiles (topologies)
  private readonly _profiles = new Map<string, Profile>();

  // Default topology
  private _defaultTopology = "hela:bare";

  // ── Source Registry: the Grothendieck site ──────────────────────────────
  // Sources are external systems (LRSs, badge platforms, credential registries)
  // that HELA queries on demand. The local adapter is a cache, not the source of truth.
  private readonly _sources: SourceRegistry;

  constructor(adapter?: StoreAdapter) {
    this._adapter = adapter ?? new InMemoryAdapter();
    this._sources = new SourceRegistry();
    this.reindex();
  }

  // ── Reindex: rebuild acceleration indices from adapter contents ──────────
  reindex(): void {
    this._actorIndex.clear();
    this._activityIndex.clear();
    this._verbIndex.clear();
    this._voidIndex.clear();

    const all = this._adapter.scan() as Psi[];
    for (const psi of all) {
      this._indexPsi(psi, psi.metadata.sourceStmt);
      if (psi.metadata.voided && psi.metadata.voidedBy) {
        this._voidIndex.set(psi.id, psi.metadata.voidedBy);
      }
    }
  }

  // ── Get the underlying adapter (for SPARQL access etc.) ─────────────────
  get adapter(): StoreAdapter { return this._adapter; }

  // ── Sync get helper (adapters used with HELAStore must be synchronous) ──
  private _get(id: string): Psi | undefined {
    return this._adapter.get(id) as Psi | undefined;
  }

  // ── Insert: φ(σ) → ψ → ℰ ─────────────────────────────────────────────────
  insert(stmt: XAPIStatement, topology?: string): StoredXAPIStatement {
    const stored: StoredXAPIStatement = {
      ...stmt,
      id:      stmt.id ?? uuidv4(),
      stored:  new Date().toISOString(),
      version: "2.0.0",
    };

    const top = topology ?? this._defaultTopology;
    const psi = realize(stored, top);
    this._adapter.put(psi);
    this._indexPsi(psi, stored);

    // If this is a voiding statement, push-out the voided ψ
    if (stored.verb.id === VERB_VOIDED) {
      const obj = stored.object;
      if ("objectType" in obj && obj.objectType === "StatementRef") {
        const voidedId = (obj as { objectType: "StatementRef"; id: string }).id;
        this._pushoutVoid(voidedId, psi.id);
      }
    }

    return stored;
  }

  // ── Pushout for voiding ────────────────────────────────────────────────────
  //
  // Voiding = categorical pushout in ℰ along the voiding morphism v : ψ → ψ′
  //
  // Span:   ψ_target ← v — ψ_voiding
  // Pushout: a new ψ_voided with voided=true
  //
  // Because F_xAPI, F_CLR, F_Badge are functors, F(pushout) = pushout(F).
  // All views automatically reflect the void — this is a theorem, not code.
  private _pushoutVoid(voidedId: string, voidingId: string): void {
    this._voidIndex.set(voidedId, voidingId);

    const target = this._get(voidedId);
    if (!target) return;

    // Construct ψ′: the pushout object
    // ψ′ has all triples of ψ plus the voiding morphism
    const voidedTriples = [
      ...target.triples,
      {
        subject:   IRI(`https://hela.foxxi.io/statements/${voidedId}`),
        predicate: XAPI_VOIDED,
        object:    IRI(`https://hela.foxxi.io/statements/${voidingId}`),
      },
    ];

    const pushed: Psi = {
      id:      target.id,
      triples: Object.freeze(voidedTriples),
      metadata: {
        ...target.metadata,
        voided:   true,
        voidedBy: voidingId,
      },
    };

    this._adapter.put(pushed);
  }

  // ── Index a ψ for efficient retrieval ────────────────────────────────────
  private _indexPsi(psi: Psi, stmt: StoredXAPIStatement): void {
    // Actor index
    const actorKey = this._agentKey(stmt.actor);
    if (!this._actorIndex.has(actorKey)) this._actorIndex.set(actorKey, new Set());
    this._actorIndex.get(actorKey)!.add(psi.id);

    // Activity index
    const obj = stmt.object;
    if (!("objectType" in obj) || (obj as { objectType?: string }).objectType === "Activity" || !(obj as { objectType?: string }).objectType) {
      const actId = (obj as { id: IRI }).id;
      if (!this._activityIndex.has(actId)) this._activityIndex.set(actId, new Set());
      this._activityIndex.get(actId)!.add(psi.id);
    }

    // Verb index
    const verbId = stmt.verb.id;
    if (!this._verbIndex.has(verbId)) this._verbIndex.set(verbId, new Set());
    this._verbIndex.get(verbId)!.add(psi.id);
  }

  // ── Query: global section functor restricted by params ────────────────────
  //
  // StatementQueryParams → subpresheaf → global sections
  // Returns the sections of the presheaf matching the query.
  query(params: StatementQueryParams = {}): StoredXAPIStatement[] {
    let candidates = new Set<string>((this._adapter.scan() as Psi[]).map(p => p.id));

    // Filter by agent
    if (params.agent) {
      const key = this._agentKey(params.agent);
      const agentPsis = this._actorIndex.get(key) ?? new Set<string>();
      candidates = intersection(candidates, agentPsis);
    }

    // Filter by verb
    if (params.verb) {
      const verbPsis = this._verbIndex.get(params.verb) ?? new Set<string>();
      candidates = intersection(candidates, verbPsis);
    }

    // Filter by activity
    if (params.activity) {
      const actPsis = this._activityIndex.get(params.activity) ?? new Set<string>();
      candidates = intersection(candidates, actPsis);
    }

    let results = [...candidates]
      .map(id => this._get(id)!)
      .filter(psi => {
        // Exclude voided unless explicitly queried by voidedStatementId
        if (psi.metadata.voided && !params.voidedStatementId) {
          // Include if this psi IS the voiding statement (verb=voided)
          const src = psi.metadata.sourceStmt;
          if (src.verb.id !== VERB_VOIDED) return false;
        }

        // since / until filters
        if (params.since && psi.metadata.stored <= params.since) return false;
        if (params.until && psi.metadata.stored > params.until) return false;

        // registration
        if (params.registration && psi.metadata.sourceStmt.context?.registration !== params.registration) return false;

        return true;
      })
      .map(psi => psi.metadata.sourceStmt);

    // Sort: descending by stored (default), ascending if requested
    results.sort((a, b) =>
      params.ascending
        ? a.stored!.localeCompare(b.stored!)
        : b.stored!.localeCompare(a.stored!)
    );

    if (params.limit) results = results.slice(0, params.limit);
    return results;
  }

  // ── Get by id ────────────────────────────────────────────────────────────
  getById(id: string): StoredXAPIStatement | undefined {
    return this._get(id)?.metadata.sourceStmt;
  }

  // ── Get raw ψ by id ───────────────────────────────────────────────────────
  getPsi(id: string): Psi | undefined {
    return this._get(id);
  }

  // ── Sheafify under a profile topology ────────────────────────────────────
  //
  // a_J : ℰ → Sh(𝒞_xAPI, J_profile)
  //
  // Returns the sheafification of ψ under J_profile.
  // If ψ is already a sheaf (a_J(ψ) = ψ), conformance = true.
  // Otherwise, conformance = false and ψ is NOT in Sh(𝒞, J).
  sheafify(psiId: string, profileId: string): ProfileValidationResult {
    const psi = this._get(psiId);
    if (!psi) return { conformant: false, isSheaf: false, errors: [`ψ ${psiId} not found`] };

    const profile = this._profiles.get(profileId);
    if (!profile) return { conformant: false, isSheaf: false, errors: [`Profile ${profileId} not registered`] };

    const result = profile.validate(psi.metadata.sourceStmt);

    if (result.conformant) {
      // Mark ψ as living in Sh(J_profile)
      const updated: Psi = {
        ...psi,
        metadata: {
          ...psi.metadata,
          profileIds: [...psi.metadata.profileIds, profileId],
        },
      };
      this._adapter.put(updated);
    }

    return result;
  }

  // ── Register a profile (topology) ────────────────────────────────────────
  registerProfile(profile: Profile): void {
    this._profiles.set(profile.id, profile);
  }

  // ── Global sections Γ(P_actor) ────────────────────────────────────────────
  //
  // Γ(P) = Nat(𝟏, P) — natural transformations from terminal presheaf
  // For a learner: the consistent set of achievements across all contexts.
  // This IS the LER computation — no ETL, no copy, computed from live ψ objects.
  globalSections(agentKey: string): {
    psis: Psi[];
    statements: StoredXAPIStatement[];
    completions: StoredXAPIStatement[];
    scores: { activity: string; score: number }[];
  } {
    const psiIds = this._actorIndex.get(agentKey) ?? new Set<string>();
    const psis = [...psiIds]
      .map(id => this._get(id)!)
      .filter(psi => !psi.metadata.voided);

    const stmts = psis.map(p => p.metadata.sourceStmt);
    const completions = stmts.filter(s => s.result?.completion === true);
    const scores = stmts
      .filter(s => s.result?.score?.scaled !== undefined)
      .map(s => ({
        activity: ("id" in s.object ? s.object.id : "unknown") as string,
        score: s.result!.score!.scaled!,
      }));

    return { psis, statements: stmts, completions, scores };
  }

  // ── Subobject classifier χ_P evaluation ───────────────────────────────────
  //
  // Evaluates χ_P_mastery(actor) ∈ Ω
  // Returns a truth value WITH its evidence sieve — not a boolean.
  //
  // The mastery predicate P is a subpresheaf of よ(activity).
  // χ_P : よ(activity) → Ω maps each ψ to its sieve membership.
  classify(params: {
    actor:        string;   // agent key
    activity:     IRI;
    masteryScore: number;   // threshold
    topology?:    string;
  }): OmegaValue {
    const { actor, activity, masteryScore, topology = "hela:bare" } = params;

    const actorPsis = this._actorIndex.get(actor) ?? new Set<string>();
    const activityPsis = this._activityIndex.get(activity) ?? new Set<string>();

    // The subpresheaf P_mastery: ψ objects at the intersection
    // that satisfy the mastery predicate
    const evidenceIds = intersection(actorPsis, activityPsis);
    const evidence = [...evidenceIds]
      .map(id => this._get(id)!)
      .filter(psi => !psi.metadata.voided);

    const completions = evidence.filter(psi => {
      const s = psi.metadata.sourceStmt;
      return s.result?.completion === true;
    });

    const bestScore = evidence.reduce((best, psi) => {
      const s = psi.metadata.sourceStmt.result?.score?.scaled ?? -Infinity;
      return Math.max(best, s);
    }, -Infinity);

    // Compute truth grade — the element of Ω
    let truthGrade: TruthGrade;
    if (evidence.length === 0) {
      truthGrade = "absent";
    } else if (completions.length > 0 && bestScore >= masteryScore) {
      truthGrade = "mastered";
    } else if (completions.length > 0 && bestScore >= masteryScore * 0.78) {
      truthGrade = "proficient";
    } else if (evidence.length > 0) {
      truthGrade = "attempted";
    } else {
      truthGrade = "absent";
    }

    // Construct the evidence sieve
    // S is closed under pre-composition (temporal precedence)
    const sieve: Sieve = {
      object:    activity,
      morphisms: evidence.map(p => p.id),
      closed:    true,  // closed under temporal ordering in our site
      maximal:   truthGrade === "mastered" && completions.length > 0,
    };

    const claim = `"${actor}" has ${truthGrade} activity <${activity}>`;

    return {
      claim,
      truthGrade,
      topology,
      evidenceSieve:        sieve,
      witnessingStatements: evidence.map(p => p.id),
      score:                bestScore === -Infinity ? undefined : bestScore,
      classifyingMorphism:  `χ_P_mastery(threshold=${masteryScore}) evaluated at ${actor} × <${activity}>`,
    };
  }

  // ── Size ─────────────────────────────────────────────────────────────────
  get size(): number { return this._adapter.size() as number; }

  // ═══════════════════════════════════════════════════════════════════════════
  // FEDERATED LAYER — zero-copy virtual queries across external sources
  // ═══════════════════════════════════════════════════════════════════════════

  /** The source registry (Grothendieck site) */
  get sources(): SourceRegistry { return this._sources; }

  /** Register a federated source */
  registerSource(source: FederatedSource): void {
    this._sources.register(source);
  }

  /** Remove a federated source */
  unregisterSource(id: string): boolean {
    return this._sources.unregister(id);
  }

  /**
   * Federated query: fan out to all registered sources, merge results.
   *
   * This is HELA's core zero-copy operation:
   * - Queries all sources in parallel
   * - Returns virtual Psi objects (not stored locally)
   * - Apply morphisms (F_xAPI, F_CLR, etc.) to project into any view
   *
   * The result is ephemeral — data stays at the source.
   */
  async federatedQuery(params: StatementQueryParams = {}): Promise<FederatedMergeResult> {
    return this._sources.query(params);
  }

  /**
   * Query a single source by ID
   */
  async querySource(sourceId: string, params: StatementQueryParams = {}): Promise<FederatedQueryResult> {
    return this._sources.querySource(sourceId, params);
  }

  /**
   * Federated global sections: Γ(P_actor) across ALL sources.
   *
   * This is the zero-copy LER computation:
   * 1. Fan out to all sources asking for actor's data
   * 2. Merge results (deduplicate by statement ID)
   * 3. Compute global sections from the merged virtual presheaf
   * 4. Return without storing anything
   */
  async federatedGlobalSections(agentKey: string): Promise<{
    psis: Psi[];
    statements: StoredXAPIStatement[];
    completions: StoredXAPIStatement[];
    scores: { activity: string; score: number; source: string }[];
    sourceResults: FederatedQueryResult[];
  }> {
    // Parse agent key back to agent object for xAPI query
    const agent = this._agentFromKey(agentKey);

    // Query all sources for this actor
    const merged = await this._sources.query({
      agent: agent ?? undefined,
    });

    // Also include local ψ objects (cache layer)
    const localPsiIds = this._actorIndex.get(agentKey) ?? new Set<string>();
    const localPsis = [...localPsiIds]
      .map(id => this._get(id)!)
      .filter(psi => psi && !psi.metadata.voided);

    // Merge local + federated, deduplicate
    const seenIds = new Set<string>();
    const allPsis: Psi[] = [];
    const allStatements: StoredXAPIStatement[] = [];

    // Local first (cache hits)
    for (const psi of localPsis) {
      if (!seenIds.has(psi.id)) {
        seenIds.add(psi.id);
        allPsis.push(psi);
        allStatements.push(psi.metadata.sourceStmt);
      }
    }

    // Then federated results
    for (let i = 0; i < merged.statements.length; i++) {
      const stmt = merged.statements[i];
      if (stmt.id && !seenIds.has(stmt.id)) {
        seenIds.add(stmt.id);
        allStatements.push(stmt);
        if (merged.psis[i]) allPsis.push(merged.psis[i]);
      }
    }

    const completions = allStatements.filter(s => s.result?.completion === true);
    const scores = allStatements
      .filter(s => s.result?.score?.scaled !== undefined)
      .map(s => {
        const actId = ("id" in s.object ? s.object.id : "unknown") as string;
        // Find which source this came from
        const sourceResult = merged.sourceResults.find(sr =>
          sr.statements.some(ss => ss.id === s.id)
        );
        return {
          activity: actId,
          score: s.result!.score!.scaled!,
          source: sourceResult?.sourceId ?? "local",
        };
      });

    return {
      psis: allPsis,
      statements: allStatements,
      completions,
      scores,
      sourceResults: merged.sourceResults,
    };
  }

  /**
   * Health check across all federated sources
   */
  async federatedHealthCheck(): Promise<{ id: string; label: string; status: string; version?: string[]; error?: string }[]> {
    return this._sources.healthCheck();
  }

  // ── Parse agent key back to Agent object ─────────────────────────────────
  private _agentFromKey(key: string): Agent | null {
    if (key.startsWith("mbox:")) {
      return { mbox: key.slice(5) };
    }
    if (key.startsWith("account:")) {
      const parts = key.slice(8).split("::");
      if (parts.length === 2) {
        return { account: { homePage: IRI(parts[0]), name: parts[1] } };
      }
    }
    if (key.startsWith("openid:")) {
      return { openid: IRI(key.slice(7)) };
    }
    if (key.startsWith("sha1:")) {
      return { mbox_sha1sum: key.slice(5) };
    }
    return null;
  }

  // ── Agent key utility ─────────────────────────────────────────────────────
  agentKey(agent: { mbox?: string; account?: { homePage: string; name: string }; openid?: string; mbox_sha1sum?: string }): string {
    return this._agentKey(agent);
  }

  private _agentKey(agent: { mbox?: string; account?: { homePage: string; name: string }; openid?: string; mbox_sha1sum?: string }): string {
    if (agent.mbox)        return `mbox:${agent.mbox}`;
    if (agent.account)     return `account:${agent.account.homePage}::${agent.account.name}`;
    if (agent.openid)      return `openid:${agent.openid}`;
    if (agent.mbox_sha1sum) return `sha1:${agent.mbox_sha1sum}`;
    return `unknown:${JSON.stringify(agent)}`;
  }
}

// ── Set intersection utility ──────────────────────────────────────────────────
function intersection<T>(a: Set<T>, b: Set<T>): Set<T> {
  const result = new Set<T>();
  for (const x of a) if (b.has(x)) result.add(x);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometric Morphisms — F : ℰ → Spec
//
// These are the view projections. They share the same underlying ψ.
// When ψ changes (e.g., pushed-out by a void), all views update automatically.
// ─────────────────────────────────────────────────────────────────────────────

// F_xAPI : ℰ → LRS  (the xAPI view)
export const F_xAPI: GeometricMorphism<StoredXAPIStatement[], StoredXAPIStatement> = {
  name:     "F_xAPI",
  domain:   "ℰ",
  codomain: "LRS",
  map:  (psi) => psi.metadata.sourceStmt,
  mapMany: (psis) => psis
    .filter(psi => !psi.metadata.voided || psi.metadata.sourceStmt.verb.id === VERB_VOIDED)
    .map(psi => psi.metadata.sourceStmt),
};

// F_CLR : ℰ → CLR  (the CLR/LER view)
export const F_CLR: GeometricMorphism<CLRAssertion[], CLRAssertion | null> = {
  name:     "F_CLR",
  domain:   "ℰ",
  codomain: "CLR",
  map: (psi) => {
    const stmt = psi.metadata.sourceStmt;
    if (psi.metadata.voided) return null;
    if (!stmt.result?.completion) return null;

    const obj = stmt.object;
    const actId = ("id" in obj ? obj.id : "unknown") as string;
    const actName = ("definition" in obj && obj.definition?.name?.["en-US"])
      ? obj.definition.name["en-US"]
      : actId;

    return {
      id:           `urn:clr:assertion:${stmt.id}`,
      type:         "AchievementSubject" as const,
      achievement:  { id: IRI(actId), achievementType: "Course", name: actName },
      earnedOn:     stmt.timestamp ?? stmt.stored!,
      evidence:     [{ id: `urn:xapi:${stmt.id}`, narrative: `Completed with score ${stmt.result?.score?.scaled ?? "N/A"}` }],
      result:       stmt.result?.score?.scaled !== undefined
        ? { value: String(stmt.result.score.scaled) }
        : undefined,
    };
  },
  mapMany: (psis) =>
    psis.map(p => F_CLR.map(p)).filter((a): a is CLRAssertion => a !== null),
};

// F_Badge : ℰ → OB  (Open Badge v3 view)
export const F_Badge: GeometricMorphism<BadgeAssertion[], BadgeAssertion | null> = {
  name:     "F_Badge",
  domain:   "ℰ",
  codomain: "Badge",
  map: (psi) => {
    const stmt = psi.metadata.sourceStmt;
    if (psi.metadata.voided) return null;
    if (!stmt.result?.completion || (stmt.result?.score?.scaled ?? 0) < 0.7) return null;

    const obj = stmt.object;
    const actId = ("id" in obj ? obj.id : "unknown") as string;
    const actName = ("definition" in obj && obj.definition?.name?.["en-US"])
      ? obj.definition.name["en-US"]
      : actId;

    const actor = stmt.actor;
    const email = ("mbox" in actor && actor.mbox) ? actor.mbox.replace("mailto:", "") : "unknown";

    return {
      "@context": "https://w3id.org/openbadges/v3",
      id:         `urn:ob:assertion:${stmt.id}`,
      type:       "Assertion" as const,
      recipient:  { type: "email", identity: email, hashed: false },
      badge:      {
        id: IRI(actId),
        name: actName,
        criteria: { narrative: `Completed ${actName} with score ${stmt.result?.score?.scaled ?? "N/A"}` }
      },
      issuedOn:   stmt.timestamp ?? stmt.stored!,
      evidence:   [{ id: `urn:xapi:${stmt.id}`, narrative: `xAPI statement recorded at ${stmt.stored}` }],
      verification: { type: "HelaPresheafVerification", psiId: psi.id },
    };
  },
  mapMany: (psis) =>
    psis.map(p => F_Badge.map(p)).filter((a): a is BadgeAssertion => a !== null),
};

// F_CTDL : ℰ → CTDL  (Credential Transparency Description Language view)
export const F_CTDL: GeometricMorphism<CTDLCredential[], CTDLCredential | null> = {
  name:     "F_CTDL",
  domain:   "ℰ",
  codomain: "CTDL",
  map: (psi) => {
    const stmt = psi.metadata.sourceStmt;
    if (psi.metadata.voided) return null;
    if (!stmt.result?.completion) return null;

    const obj = stmt.object;
    const actId = ("id" in obj ? obj.id : "unknown") as string;
    const actName = ("definition" in obj && obj.definition?.name?.["en-US"])
      ? obj.definition.name["en-US"]
      : actId;

    return {
      "@context": ["https://credreg.net/ctdl/schema/context/json"],
      "@type":    "ceterms:Credential" as const,
      "ceterms:ctid":     `ce-${stmt.id}`,
      "ceterms:name":     actName,
      "ceterms:description": `Credential earned by completing ${actName}`,
      "ceterms:subjectWebpage": IRI(actId),
      "ceterms:dateEffective": stmt.timestamp ?? stmt.stored!,
      "ceterms:credentialStatusType": "ceterms:Active",
      "ceterms:requires": [{
        "@type": "ceterms:ConditionProfile",
        "ceterms:description": `Completion of ${actName} with score ${stmt.result?.score?.scaled ?? "N/A"}`,
      }],
      "hela:psiId": psi.id,
      "hela:evidence": [{ id: `urn:xapi:${stmt.id}`, narrative: `xAPI statement recorded at ${stmt.stored}` }],
    };
  },
  mapMany: (psis) =>
    psis.map(p => F_CTDL.map(p)).filter((a): a is CTDLCredential => a !== null),
};

// F_CASE : ℰ → CASE  (Competency and Academic Standards Exchange view)
export const F_CASE: GeometricMorphism<CASEItem[], CASEItem | null> = {
  name:     "F_CASE",
  domain:   "ℰ",
  codomain: "CASE",
  map: (psi) => {
    const stmt = psi.metadata.sourceStmt;
    if (psi.metadata.voided) return null;

    const obj = stmt.object;
    const actId = ("id" in obj ? obj.id : "unknown") as string;
    const actName = ("definition" in obj && obj.definition?.name?.["en-US"])
      ? obj.definition.name["en-US"]
      : actId;

    const score = stmt.result?.score?.scaled;
    const completed = stmt.result?.completion === true;
    let confidence: TruthGrade;
    if (completed && score !== undefined && score >= 0.9) confidence = "mastered";
    else if (completed && score !== undefined && score >= 0.7) confidence = "proficient";
    else if (completed || (score !== undefined && score > 0)) confidence = "attempted";
    else confidence = "absent";

    return {
      CFItemURI:          IRI(`urn:case:item:${actId}`),
      CFItemType:         "Competency",
      humanCodingScheme:  actId.split("/").pop(),
      fullStatement:      `Demonstrates competency in ${actName}`,
      assertion: {
        confidence,
        score,
        evidenceCount: 1,
      },
      evidenceCollection: [{
        id: `urn:xapi:${stmt.id}`,
        narrative: `${stmt.verb.id.split("/").pop()} ${actName}${score !== undefined ? ` (score: ${score})` : ""}`,
      }],
      "hela:psiId": psi.id,
    };
  },
  mapMany: (psis) =>
    psis.map(p => F_CASE.map(p)).filter((a): a is CASEItem => a !== null),
};

// ── Produce federated LER — zero-copy across all sources ─────────────────────
export async function produceFederatedLER(
  store: HELAStore,
  agentKey: string,
  issuer: string,
  topology: string
): Promise<LER & { federation: { sourcesQueried: number; sourceResults: { id: string; label: string; count: number; latencyMs: number }[] } }> {
  const { psis, completions, sourceResults } = await store.federatedGlobalSections(agentKey);
  const assertions = F_CLR.mapMany(psis);
  const sieves = completions.map(stmt => {
    const obj = stmt.object;
    const actId = ("id" in obj ? obj.id : "unknown") as string;
    return store.classify({
      actor:        agentKey,
      activity:     IRI(actId),
      masteryScore: 0.7,
      topology,
    }).evidenceSieve;
  });

  return {
    type:          "LearningAndEmploymentRecord",
    issuer,
    issuanceDate:  new Date().toISOString(),
    credentialSubject: {
      id:   agentKey,
      type: "LearnerProfile",
      assertions,
    },
    proof: {
      type:                "HELAPresheafProof",
      globalSectionCount:  assertions.length,
      evidenceSieves:      sieves,
      topology,
      classifyingMorphism: `Γ_federated(P_${agentKey}) — global sections across ${sourceResults.length} sources + local cache`,
    },
    federation: {
      sourcesQueried: sourceResults.length,
      sourceResults: sourceResults.map(sr => ({
        id: sr.sourceId,
        label: sr.sourceLabel,
        count: sr.statements.length,
        latencyMs: sr.latencyMs,
      })),
    },
  };
}

// ── Produce LER from global sections Γ(P_learner) ───────────────────────────
export function produceLER(
  store: HELAStore,
  agentKey: string,
  issuer: string,
  topology: string
): LER {
  const { psis, completions } = store.globalSections(agentKey);
  const assertions = F_CLR.mapMany(psis);
  const sieves = completions.map(stmt => {
    const obj = stmt.object;
    const actId = ("id" in obj ? obj.id : "unknown") as string;
    return store.classify({
      actor:        agentKey,
      activity:     IRI(actId),
      masteryScore: 0.7,
      topology,
    }).evidenceSieve;
  });

  return {
    type:          "LearningAndEmploymentRecord",
    issuer,
    issuanceDate:  new Date().toISOString(),
    credentialSubject: {
      id:   agentKey,
      type: "LearnerProfile",
      assertions,
    },
    proof: {
      type:                "HELAPresheafProof",
      globalSectionCount:  assertions.length,
      evidenceSieves:      sieves,
      topology,
      classifyingMorphism: `Γ(P_${agentKey}) — global sections of learner evidence presheaf`,
    },
  };
}
