// ─────────────────────────────────────────────────────────────────────────────
// @foxxi/hela-store  —  federation.ts
//
// TLA (Total Learning Architecture) as a Grothendieck site 𝒞_TLA.
//
// In normal TLA, federation is a synchronization problem:
//   - replication protocols
//   - conflict resolution policies
//   - eventual consistency windows
//   - authority LRS arbitration
//
// In HELA, federation IS descent:
//   - Each LRS node = a sheaf object on the site
//   - TLA pipes = the coverage families J_TLA
//   - Statement consistency = the cocycle conditions for descent
//   - A federation is TLA-valid iff local sections on overlapping nodes
//     assemble to a unique global section
//   - The authority LRS = terminal object of the site
//
// This module implements:
//   1. FederatedSite — the site 𝒞_TLA (nodes + coverage)
//   2. FederationNode — a node with its local HELAStore
//   3. descentCheck() — verifies cocycle conditions across nodes
//   4. glue() — assembles compatible local sections to global sections
//   5. resolve() — resolves conflicts via the pushout construction
// ─────────────────────────────────────────────────────────────────────────────

import { HELAStore } from "./store";
import { StoredXAPIStatement, IRI, Psi, OmegaValue } from "./types";
import { v4 as uuidv4 } from "uuid";

// ── Node roles in the TLA architecture ───────────────────────────────────────
export type NodeRole =
  | "activity-provider"   // source of statements
  | "learning-record-store" // stores + serves statements
  | "authority"           // terminal object — final authority
  | "competency-management" // codomain of the learning functor
  | "noisy-pipe";         // passes statements without authority

// ── A node in the TLA site ───────────────────────────────────────────────────
export interface FederationNode {
  readonly id:       string;
  readonly label:    string;
  readonly role:     NodeRole;
  readonly store:    HELAStore;
  readonly endpoint: string;  // conceptual IRI — not a live URL in this impl
}

// ── A morphism in 𝒞_TLA (a data flow between nodes) ─────────────────────────
// Morphisms are the xAPI pipes — they carry statements from source to target.
export interface SiteMorphism {
  readonly id:     string;
  readonly from:   string;  // node id
  readonly to:     string;  // node id
  readonly filter?: {        // optional restriction on what flows
    verb?:     IRI;
    activity?: IRI;
  };
}

// ── A sieve in 𝒞_TLA ─────────────────────────────────────────────────────────
// S is a covering sieve on node c iff the collection of nodes flowing into c
// constitutes a valid coverage (i.e. they together can witness any statement at c).
export interface TLASieve {
  readonly targetNode:  string;          // node c
  readonly coveringNodes: string[];      // nodes flowing into c
  readonly isCovering:  boolean;         // does this sieve cover c?
  readonly cocycleSatisfied: boolean;    // are the gluing conditions met?
}

// ── Descent datum ─────────────────────────────────────────────────────────────
// When we have local sections σ_i on nodes U_i that overlap (U_i ∩ U_j ≠ ∅),
// the cocycle condition requires: σ_i|_{U_i ∩ U_j} = σ_j|_{U_i ∩ U_j}
// i.e. overlapping nodes agree on their shared statements.
export interface DescentDatum {
  readonly statementId: string;
  readonly nodeId:      string;
  readonly statement:   StoredXAPIStatement;
}

export interface CocycleCheck {
  readonly statementId:   string;
  readonly nodes:         string[];   // nodes that have this statement
  readonly consistent:    boolean;    // do they agree?
  readonly discrepancies: DescentDiscrepancy[];
}

export interface DescentDiscrepancy {
  readonly nodeA:    string;
  readonly nodeB:    string;
  readonly field:    string;
  readonly valueA:   unknown;
  readonly valueB:   unknown;
}

// ── Global section (assembled from compatible local sections) ─────────────────
export interface GlobalSection {
  readonly statementId: string;
  readonly statement:   StoredXAPIStatement;
  readonly witnessNodes: string[];     // which nodes contributed
  readonly authorityNode: string;      // which node has authority
  readonly cocycleSatisfied: boolean;
}

// ── Conflict (failed gluing condition) ────────────────────────────────────────
export interface FederationConflict {
  readonly statementId:   string;
  readonly discrepancies: DescentDiscrepancy[];
  readonly resolution?:   ConflictResolution;
}

export interface ConflictResolution {
  readonly method:    "pushout" | "authority-wins" | "timestamp-wins";
  readonly resolved:  StoredXAPIStatement;
  readonly sourceNode: string;
  readonly proof:     string;  // mathematical justification
}

// ─────────────────────────────────────────────────────────────────────────────
// FederatedSite — the site 𝒞_TLA
// ─────────────────────────────────────────────────────────────────────────────
export class FederatedSite {
  private readonly _nodes     = new Map<string, FederationNode>();
  private readonly _morphisms = new Map<string, SiteMorphism>();
  private _authorityNodeId?: string;

  // ── Add a node to the site ────────────────────────────────────────────────
  addNode(node: FederationNode): void {
    this._nodes.set(node.id, node);
    if (node.role === "authority") {
      this._authorityNodeId = node.id;
    }
  }

  // ── Add a morphism (pipe) between nodes ───────────────────────────────────
  addMorphism(morphism: SiteMorphism): void {
    this._morphisms.set(morphism.id, morphism);
  }

  getNode(id: string): FederationNode | undefined {
    return this._nodes.get(id);
  }

  get nodes(): FederationNode[] {
    return [...this._nodes.values()];
  }

  get authorityNode(): FederationNode | undefined {
    return this._authorityNodeId
      ? this._nodes.get(this._authorityNodeId)
      : undefined;
  }

  // ── Pipe: push statements from source node to target node ─────────────────
  // In TLA terms: the xAPI pipe carries statements downstream.
  // In categorical terms: the morphism f : U → V induces a restriction map
  //   f* : P(V) → P(U) on presheaves, but for sheaves we also get a pushforward.
  pipe(fromId: string, toId: string, filter?: SiteMorphism["filter"]): number {
    const from = this._nodes.get(fromId);
    const to   = this._nodes.get(toId);
    if (!from || !to) return 0;

    let statements = from.store.query({
      verb:     filter?.verb,
      activity: filter?.activity,
    });

    let piped = 0;
    for (const stmt of statements) {
      // Don't re-pipe statements the target already has
      if (to.store.getById(stmt.id!)) continue;

      // Re-insert into target node's store
      // In a real implementation this would be an HTTP POST to the target LRS
      to.store.insert(stmt);
      piped++;
    }

    // Record the morphism
    this._morphisms.set(uuidv4(), { id: uuidv4(), from: fromId, to: toId, filter });
    return piped;
  }

  // ── Pipe all nodes toward authority (TLA upward flow) ────────────────────
  pipeToAuthority(): { [fromId: string]: number } {
    const result: { [fromId: string]: number } = {};
    if (!this._authorityNodeId) return result;

    for (const node of this._nodes.values()) {
      if (node.id === this._authorityNodeId) continue;
      result[node.id] = this.pipe(node.id, this._authorityNodeId);
    }

    return result;
  }

  // ── Descent check: verify cocycle conditions across all nodes ─────────────
  //
  // The cocycle condition: for any two nodes U_i, U_j that both have statement σ,
  // their versions must agree on the overlap U_i ∩ U_j.
  //
  // σ|_{U_i} = σ|_{U_j}  on  U_i ∩ U_j
  //
  // If the cocycle is satisfied for all σ and all pairs (U_i, U_j),
  // the local sections glue to a unique global section.
  descentCheck(): CocycleCheck[] {
    // Collect all statement ids across all nodes
    const allIds = new Set<string>();
    for (const node of this._nodes.values()) {
      const stmts = node.store.query({});
      for (const s of stmts) allIds.add(s.id!);
    }

    const checks: CocycleCheck[] = [];

    for (const stmtId of allIds) {
      // Find all nodes that have this statement
      const holders: { nodeId: string; stmt: StoredXAPIStatement }[] = [];
      for (const node of this._nodes.values()) {
        const s = node.store.getById(stmtId);
        if (s) holders.push({ nodeId: node.id, stmt: s });
      }

      if (holders.length < 2) {
        // Statement only on one node — trivially consistent
        checks.push({
          statementId: stmtId,
          nodes:       holders.map(h => h.nodeId),
          consistent:  true,
          discrepancies: [],
        });
        continue;
      }

      // Check pairwise consistency (the cocycle condition)
      const discrepancies: DescentDiscrepancy[] = [];
      for (let i = 0; i < holders.length; i++) {
        for (let j = i + 1; j < holders.length; j++) {
          const a = holders[i];
          const b = holders[j];
          const d = compareStatements(a.stmt, b.stmt, a.nodeId, b.nodeId);
          discrepancies.push(...d);
        }
      }

      checks.push({
        statementId:   stmtId,
        nodes:         holders.map(h => h.nodeId),
        consistent:    discrepancies.length === 0,
        discrepancies,
      });
    }

    return checks;
  }

  // ── Glue: assemble compatible local sections to global sections ───────────
  //
  // If the cocycle conditions are satisfied, local sections on overlapping nodes
  // assemble to a UNIQUE global section. This is the Grothendieck gluing lemma.
  //
  // Returns: global sections (consistent) + conflicts (failed gluing)
  glue(): { sections: GlobalSection[]; conflicts: FederationConflict[] } {
    const checks  = this.descentCheck();
    const sections: GlobalSection[]    = [];
    const conflicts: FederationConflict[] = [];

    const authorityId = this._authorityNodeId;

    for (const check of checks) {
      if (check.consistent) {
        // Cocycle satisfied — unique global section exists
        // Authority node's version is canonical (it's the terminal object)
        const authorityStmt = authorityId
          ? this._nodes.get(authorityId)?.store.getById(check.statementId)
          : undefined;

        const anyNode = check.nodes[0];
        const stmt = authorityStmt
          ?? this._nodes.get(anyNode)!.store.getById(check.statementId)!;

        sections.push({
          statementId:      check.statementId,
          statement:        stmt,
          witnessNodes:     check.nodes,
          authorityNode:    authorityId ?? anyNode,
          cocycleSatisfied: true,
        });
      } else {
        // Cocycle failed — gluing condition not met — this is a conflict
        conflicts.push({
          statementId:   check.statementId,
          discrepancies: check.discrepancies,
        });
      }
    }

    return { sections, conflicts };
  }

  // ── Resolve: push conflicts to their resolution via pushout ──────────────
  //
  // A conflict = a failed gluing condition = two nodes disagree on σ.
  // Resolution options:
  //   1. pushout: compute the categorical pushout of the two versions
  //      (take all fields from both, prefer authority node on conflicts)
  //   2. authority-wins: the authority node's version is canonical
  //   3. timestamp-wins: the most recently stored version wins
  resolve(
    conflicts: FederationConflict[],
    method: ConflictResolution["method"] = "authority-wins"
  ): ConflictResolution[] {
    const resolutions: ConflictResolution[] = [];

    for (const conflict of conflicts) {
      const stmtId = conflict.statementId;

      // Collect all versions
      const versions: { nodeId: string; stmt: StoredXAPIStatement }[] = [];
      for (const node of this._nodes.values()) {
        const s = node.store.getById(stmtId);
        if (s) versions.push({ nodeId: node.id, stmt: s });
      }

      if (versions.length === 0) continue;

      let resolved: StoredXAPIStatement;
      let sourceNode: string;
      let proof: string;

      if (method === "authority-wins" && this._authorityNodeId) {
        const auth = versions.find(v => v.nodeId === this._authorityNodeId);
        if (auth) {
          resolved   = auth.stmt;
          sourceNode = auth.nodeId;
          proof      = "Authority node is the terminal object of the site. " +
                       "Its version is the unique morphism from any other node. " +
                       "authority-wins = evaluation at the terminal object.";
        } else {
          resolved   = versions[0].stmt;
          sourceNode = versions[0].nodeId;
          proof      = "No authority version found; using first available.";
        }
      } else if (method === "timestamp-wins") {
        const sorted = versions.sort((a, b) =>
          b.stmt.stored!.localeCompare(a.stmt.stored!)
        );
        resolved   = sorted[0].stmt;
        sourceNode = sorted[0].nodeId;
        proof      = "timestamp-wins = most recent stored value. " +
                     "Morphism in 𝒞_Time: newer stored ≥ older stored in the temporal order.";
      } else {
        // pushout: merge fields, preferring authority node
        const authVersion = this._authorityNodeId
          ? versions.find(v => v.nodeId === this._authorityNodeId)?.stmt
          : undefined;
        const base = authVersion ?? versions[0].stmt;

        // The pushout is the colimit of the span:
        // version_A ← shared ← version_B
        // We compute it by taking authority fields + merging non-conflicting fields
        resolved = {
          ...base,
          // result: take best score across versions (pushout favors more evidence)
          result: versions.reduce((best, v) => {
            const s = v.stmt.result?.score?.scaled ?? -Infinity;
            const b = best?.score?.scaled ?? -Infinity;
            return s > b ? v.stmt.result! : best!;
          }, base.result),
        };
        sourceNode = this._authorityNodeId ?? versions[0].nodeId;
        proof      = "Pushout in ℰ: colimit of the span (v_A ← shared ← v_B). " +
                     "Fields from authority node; result.score from the version with " +
                     "highest evidence (pushouts preserve all information from both legs). " +
                     "The pushout is unique up to unique isomorphism.";
      }

      resolutions.push({ method, resolved, sourceNode, proof });
    }

    return resolutions;
  }

  // ── Coverage sieve check ──────────────────────────────────────────────────
  // Is the collection of nodes flowing into target a covering sieve?
  coveringSieve(targetNodeId: string): TLASieve {
    const inbound: string[] = [];
    for (const m of this._morphisms.values()) {
      if (m.to === targetNodeId) inbound.push(m.from);
    }

    // A sieve is covering if:
    // 1. There is at least one activity-provider in the covering set
    // 2. The cocycle conditions are satisfied for the target node
    const hasActivityProvider = inbound.some(id => {
      const node = this._nodes.get(id);
      return node?.role === "activity-provider";
    });

    const targetNode = this._nodes.get(targetNodeId);
    const isAuthority = targetNode?.role === "authority";

    // For the authority node, covering = all APs are connected (transitively)
    const allAPs = [...this._nodes.values()].filter(n => n.role === "activity-provider");
    const allAPsConnected = allAPs.every(ap => {
      // Check if there's a path from ap to targetNodeId
      return this._hasPath(ap.id, targetNodeId);
    });

    const cocycleChecks = this.descentCheck();
    const cocycleSatisfied = cocycleChecks.every(c => c.consistent);

    return {
      targetNode:     targetNodeId,
      coveringNodes:  inbound,
      isCovering:     hasActivityProvider && (isAuthority ? allAPsConnected : true),
      cocycleSatisfied,
    };
  }

  private _hasPath(fromId: string, toId: string, visited = new Set<string>()): boolean {
    if (fromId === toId) return true;
    if (visited.has(fromId)) return false;
    visited.add(fromId);
    for (const m of this._morphisms.values()) {
      if (m.from === fromId && this._hasPath(m.to, toId, visited)) return true;
    }
    return false;
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  summary(): {
    nodeCount:       number;
    morphismCount:   number;
    totalStatements: number;
    authorityNode?:  string;
    coverage:        TLASieve[];
  } {
    let totalStatements = 0;
    const coverage: TLASieve[] = [];

    for (const node of this._nodes.values()) {
      totalStatements += node.store.size;
      coverage.push(this.coveringSieve(node.id));
    }

    return {
      nodeCount:      this._nodes.size,
      morphismCount:  this._morphisms.size,
      totalStatements,
      authorityNode:  this._authorityNodeId,
      coverage,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function compareStatements(
  a: StoredXAPIStatement,
  b: StoredXAPIStatement,
  nodeA: string,
  nodeB: string
): DescentDiscrepancy[] {
  const discrepancies: DescentDiscrepancy[] = [];

  // Fields that must be identical for the cocycle condition to hold
  const checkFields: (keyof StoredXAPIStatement)[] = ["verb", "object", "actor"];

  for (const field of checkFields) {
    const vA = JSON.stringify(a[field]);
    const vB = JSON.stringify(b[field]);
    if (vA !== vB) {
      discrepancies.push({ nodeA, nodeB, field, valueA: a[field], valueB: b[field] });
    }
  }

  // Score: versions may differ if one has more recent evidence
  if (a.result?.score?.scaled !== b.result?.score?.scaled) {
    discrepancies.push({
      nodeA, nodeB,
      field:  "result.score.scaled",
      valueA: a.result?.score?.scaled,
      valueB: b.result?.score?.scaled,
    });
  }

  return discrepancies;
}

// ─────────────────────────────────────────────────────────────────────────────
// httpPipe: live HTTP federation — POST statements to a remote LRS endpoint
// ─────────────────────────────────────────────────────────────────────────────
export async function httpPipe(
  fromStore: HELAStore,
  toUrl: string,
  options?: { apiKey?: string; since?: string }
): Promise<{ sent: number; errors: string[] }> {
  const statements = fromStore.query({ since: options?.since });
  const errors: string[] = [];
  let sent = 0;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Experience-API-Version": "2.0.0",
  };
  if (options?.apiKey) {
    headers["Authorization"] = `Bearer ${options.apiKey}`;
  }

  // Send in batches of 25
  const batchSize = 25;
  for (let i = 0; i < statements.length; i += batchSize) {
    const batch = statements.slice(i, i + batchSize);
    try {
      const res = await fetch(toUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(batch),
      });
      if (!res.ok) {
        errors.push(`Batch ${i / batchSize + 1}: HTTP ${res.status}`);
      } else {
        sent += batch.length;
      }
    } catch (e: any) {
      errors.push(`Batch ${i / batchSize + 1}: ${e.message}`);
    }
  }

  return { sent, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory: build a standard TLA-topology site
// AP nodes → LRS nodes → Authority LRS
// ─────────────────────────────────────────────────────────────────────────────
export function buildTLASite(config: {
  activityProviders: string[];
  lrsNodes:          string[];
  authorityLabel:    string;
}): FederatedSite {
  const site = new FederatedSite();

  // Activity providers
  const apNodes: FederationNode[] = config.activityProviders.map(label => ({
    id:       uuidv4(),
    label,
    role:     "activity-provider",
    store:    new HELAStore(),
    endpoint: `https://hela.foxxi.io/tla/${label.toLowerCase().replace(/\s+/g, "-")}`,
  }));

  // Intermediate LRS nodes
  const lrsNodes: FederationNode[] = config.lrsNodes.map(label => ({
    id:       uuidv4(),
    label,
    role:     "learning-record-store",
    store:    new HELAStore(),
    endpoint: `https://hela.foxxi.io/tla/lrs/${label.toLowerCase().replace(/\s+/g, "-")}`,
  }));

  // Authority LRS (terminal object)
  const authorityNode: FederationNode = {
    id:       uuidv4(),
    label:    config.authorityLabel,
    role:     "authority",
    store:    new HELAStore(),
    endpoint: `https://hela.foxxi.io/tla/authority`,
  };

  for (const node of [...apNodes, ...lrsNodes, authorityNode]) {
    site.addNode(node);
  }

  // Wire: APs → first LRS (or authority if no intermediate LRS)
  const target = lrsNodes[0] ?? authorityNode;
  for (const ap of apNodes) {
    site.addMorphism({ id: uuidv4(), from: ap.id, to: target.id });
  }

  // Wire: LRS nodes → authority
  for (const lrs of lrsNodes) {
    site.addMorphism({ id: uuidv4(), from: lrs.id, to: authorityNode.id });
  }

  return site;
}
