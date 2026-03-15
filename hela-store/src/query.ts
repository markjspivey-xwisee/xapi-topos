// ─────────────────────────────────────────────────────────────────────────────
// @foxxi/hela-store  —  query.ts
//
// HELA Query DSL — queries as subobject classifiers.
//
// In a normal LRS, a query is a filter over a table:
//   SELECT * FROM statements WHERE agent = ? AND verb = ? AND ...
//
// In HELA, a query IS a subpresheaf P ↪ よ(c).
// Evaluating the query = evaluating the characteristic morphism χ_P.
// The result is a section of the presheaf, not a result set.
//
// The HELA query DSL expresses this:
//   - Queries are composable (presheaves are closed under limits)
//   - AND = intersection of subpresheaves (pullback)
//   - OR  = union of subpresheaves (pushout)
//   - NOT = complement in the internal logic of ℰ
//   - PATTERN = matching on triple structure (subpresheaf selector)
//
// ─────────────────────────────────────────────────────────────────────────────

import { HELAStore } from "./store";
import { IRI, StoredXAPIStatement, Psi, OmegaValue, Sieve, TruthGrade } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Query expression types — the internal language of ℰ
// ─────────────────────────────────────────────────────────────────────────────

// Atomic predicates (generators of subpresheaves)
export type AtomicPredicate =
  | { type: "actor";    value: string }       // agentKey
  | { type: "verb";     value: IRI }
  | { type: "activity"; value: IRI }
  | { type: "score";    op: "gte" | "lte" | "eq"; value: number }
  | { type: "completion"; value: boolean }
  | { type: "since";    value: string }        // ISO 8601
  | { type: "until";    value: string }        // ISO 8601
  | { type: "registration"; value: string }
  | { type: "profile";  value: string }        // profile IRI — sheaf condition
  | { type: "triple";   pattern: TriplePattern }; // RDF-level query

// Triple pattern: match against the ψ triple set directly
export interface TriplePattern {
  subject?:   string;   // IRI or blank node pattern (use * for wildcard)
  predicate?: string;   // IRI pattern
  object?:    string;   // IRI, blank node, or literal pattern
}

// Composed queries
export type QueryExpr =
  | { type: "atom";  pred: AtomicPredicate }
  | { type: "and";   left: QueryExpr; right: QueryExpr }   // pullback
  | { type: "or";    left: QueryExpr; right: QueryExpr }   // pushout
  | { type: "not";   inner: QueryExpr }                    // complement
  | { type: "all" }                                         // terminal presheaf
  | { type: "none" };                                       // initial presheaf

// ── Query builder (fluent API) ────────────────────────────────────────────────
export class Query {
  private _expr: QueryExpr;

  constructor(expr: QueryExpr = { type: "all" }) {
    this._expr = expr;
  }

  // Atomic constructors
  static actor(key: string):          Query { return new Query({ type: "atom", pred: { type: "actor",    value: key } }); }
  static verb(iri: IRI):              Query { return new Query({ type: "atom", pred: { type: "verb",     value: iri } }); }
  static activity(iri: IRI):          Query { return new Query({ type: "atom", pred: { type: "activity", value: iri } }); }
  static completion(v = true):        Query { return new Query({ type: "atom", pred: { type: "completion", value: v } }); }
  static scoreGte(v: number):         Query { return new Query({ type: "atom", pred: { type: "score", op: "gte", value: v } }); }
  static scoreLte(v: number):         Query { return new Query({ type: "atom", pred: { type: "score", op: "lte", value: v } }); }
  static since(iso: string):          Query { return new Query({ type: "atom", pred: { type: "since", value: iso } }); }
  static until(iso: string):          Query { return new Query({ type: "atom", pred: { type: "until", value: iso } }); }
  static registration(id: string):    Query { return new Query({ type: "atom", pred: { type: "registration", value: id } }); }
  static profile(id: string):         Query { return new Query({ type: "atom", pred: { type: "profile", value: id } }); }
  static triple(p: TriplePattern):    Query { return new Query({ type: "atom", pred: { type: "triple", pattern: p } }); }
  static all():                        Query { return new Query({ type: "all" }); }
  static none():                       Query { return new Query({ type: "none" }); }

  // Composition operators
  // AND = pullback (intersection of subpresheaves)
  and(other: Query): Query { return new Query({ type: "and", left: this._expr, right: other._expr }); }

  // OR = pushout (union of subpresheaves)
  or(other: Query): Query  { return new Query({ type: "or",  left: this._expr, right: other._expr }); }

  // NOT = complement in internal logic
  not(): Query             { return new Query({ type: "not", inner: this._expr }); }

  get expr(): QueryExpr { return this._expr; }

  // Human-readable description of this query as a subpresheaf
  describe(): string { return describeExpr(this._expr); }
}

// ─────────────────────────────────────────────────────────────────────────────
// QueryResult — the evaluation of χ_P
// Not a result set. A structured section of the presheaf.
// ─────────────────────────────────────────────────────────────────────────────
export interface QueryResult {
  readonly query:        string;           // the subpresheaf description
  readonly statements:   StoredXAPIStatement[];
  readonly psis:         Psi[];
  readonly count:        number;
  // The sieve: the set of ψ ids selected by this query
  // S is closed under pre-composition if query is monotone
  readonly sieve:        Sieve;
  readonly subpresheaf:  string;           // which P ↪ ℰ this corresponds to
  // Characteristic morphism description
  readonly chi:          string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The query executor — evaluates χ_P against the HELA store
// ─────────────────────────────────────────────────────────────────────────────
export class QueryExecutor {
  constructor(private readonly _store: HELAStore) {}

  // evaluate(Q) = { ψ ∈ ℰ | Q(ψ) = ⊤ }
  // This IS the characteristic morphism χ_P applied to all objects
  evaluate(query: Query, limit?: number): QueryResult {
    const allPsis = this._getAllPsis();
    const matching = allPsis.filter(psi => this._matchExpr(psi, query.expr));
    const limited  = limit ? matching.slice(0, limit) : matching;

    const sieve: Sieve = {
      object:    "ℰ",
      morphisms: limited.map(p => p.id),
      closed:    this._isClosed(query.expr),
      maximal:   query.expr.type === "all",
    };

    return {
      query:       query.describe(),
      statements:  limited.map(p => p.metadata.sourceStmt),
      psis:        limited,
      count:       limited.length,
      sieve,
      subpresheaf: `P_{ ${query.describe()} } ↪ ℰ`,
      chi:         `χ_P evaluated over ${allPsis.length} objects → ${limited.length} in P`,
    };
  }

  // evaluate to Ω: for a focused query (actor × activity), return the truth value
  classify(actor: string, activity: IRI, masteryScore = 0.8): OmegaValue {
    return this._store.classify({ actor, activity, masteryScore });
  }

  // Pullback: AND of two queries
  // χ_{P ∩ Q} = χ_P ∧ χ_Q
  pullback(a: Query, b: Query): QueryResult {
    return this.evaluate(a.and(b));
  }

  // Pushout: OR of two queries
  // χ_{P ∪ Q} = χ_P ∨ χ_Q
  pushout(a: Query, b: Query): QueryResult {
    return this.evaluate(a.or(b));
  }

  // Complement: NOT
  // χ_{¬P} = ¬χ_P  (in internal logic of ℰ)
  complement(q: Query): QueryResult {
    return this.evaluate(q.not());
  }

  private _getAllPsis(): Psi[] {
    const stmts = this._store.query({});
    return stmts
      .map(s => this._store.getPsi(s.id!))
      .filter((p): p is Psi => p !== undefined)
      .filter(p => !p.metadata.voided);
  }

  private _matchExpr(psi: Psi, expr: QueryExpr): boolean {
    switch (expr.type) {
      case "all":  return true;
      case "none": return false;
      case "and":  return this._matchExpr(psi, expr.left) && this._matchExpr(psi, expr.right);
      case "or":   return this._matchExpr(psi, expr.left) || this._matchExpr(psi, expr.right);
      case "not":  return !this._matchExpr(psi, expr.inner);
      case "atom": return this._matchAtom(psi, expr.pred);
    }
  }

  private _matchAtom(psi: Psi, pred: AtomicPredicate): boolean {
    const stmt = psi.metadata.sourceStmt;

    switch (pred.type) {
      case "actor": {
        return this._store.agentKey(stmt.actor as Parameters<HELAStore["agentKey"]>[0]) === pred.value;
      }
      case "verb": {
        return stmt.verb.id === pred.value;
      }
      case "activity": {
        const obj = stmt.object;
        return ("id" in obj) && obj.id === pred.value;
      }
      case "completion": {
        return (stmt.result?.completion ?? false) === pred.value;
      }
      case "score": {
        const s = stmt.result?.score?.scaled;
        if (s === undefined) return false;
        switch (pred.op) {
          case "gte": return s >= pred.value;
          case "lte": return s <= pred.value;
          case "eq":  return s === pred.value;
        }
      }
      case "since": {
        return psi.metadata.stored >= pred.value;
      }
      case "until": {
        return psi.metadata.stored <= pred.value;
      }
      case "registration": {
        return stmt.context?.registration === pred.value;
      }
      case "profile": {
        return psi.metadata.profileIds.includes(pred.value);
      }
      case "triple": {
        return this._matchTriplePattern(psi, pred.pattern);
      }
    }
  }

  private _matchTriplePattern(psi: Psi, pattern: TriplePattern): boolean {
    return psi.triples.some(triple => {
      const matchSubject   = !pattern.subject   || pattern.subject   === "*" || triple.subject   === pattern.subject;
      const matchPredicate = !pattern.predicate || pattern.predicate === "*" || triple.predicate === pattern.predicate;
      const matchObject    = !pattern.object    || pattern.object    === "*" || triple.object    === pattern.object;
      return matchSubject && matchPredicate && matchObject;
    });
  }

  // A query is "closed" (its sieve is closed under pre-composition)
  // iff the predicate is monotone: if ψ satisfies P and there's a morphism ψ′→ψ,
  // then ψ′ satisfies P.
  // Approximation: queries on timestamps are monotone; score/completion queries are not.
  private _isClosed(expr: QueryExpr): boolean {
    switch (expr.type) {
      case "all":   return true;
      case "none":  return true;
      case "and":   return this._isClosed(expr.left) && this._isClosed(expr.right);
      case "or":    return this._isClosed(expr.left) && this._isClosed(expr.right);
      case "not":   return false;
      case "atom":  return expr.pred.type === "actor" ||
                           expr.pred.type === "activity" ||
                           expr.pred.type === "verb" ||
                           expr.pred.type === "since";
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function describeExpr(expr: QueryExpr): string {
  switch (expr.type) {
    case "all":   return "⊤ (all statements)";
    case "none":  return "⊥ (no statements)";
    case "and":   return `(${describeExpr(expr.left)} ∧ ${describeExpr(expr.right)})`;
    case "or":    return `(${describeExpr(expr.left)} ∨ ${describeExpr(expr.right)})`;
    case "not":   return `¬(${describeExpr(expr.inner)})`;
    case "atom":  return describeAtom(expr.pred);
  }
}

function describeAtom(pred: AtomicPredicate): string {
  switch (pred.type) {
    case "actor":        return `actor = "${pred.value}"`;
    case "verb":         return `verb = <${pred.value}>`;
    case "activity":     return `activity = <${pred.value}>`;
    case "completion":   return `completion = ${pred.value}`;
    case "score":        return `score ${pred.op} ${pred.value}`;
    case "since":        return `stored ≥ ${pred.value}`;
    case "until":        return `stored ≤ ${pred.value}`;
    case "registration": return `registration = "${pred.value}"`;
    case "profile":      return `∈ Sh(J_${pred.value.split("/").pop()})`;
    case "triple":       return `triple{ ${pred.pattern.subject ?? "*"} ${pred.pattern.predicate ?? "*"} ${pred.pattern.object ?? "*"} }`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: translate xAPI StatementQueryParams to HELA Query
// This is the backward-compatibility bridge for existing xAPI query users.
// ─────────────────────────────────────────────────────────────────────────────
export function fromXAPIParams(params: {
  agent?:        { mbox?: string; account?: { homePage: string; name: string } };
  verb?:         IRI;
  activity?:     IRI;
  registration?: string;
  since?:        string;
  until?:        string;
}): Query {
  let q = Query.all();

  if (params.agent) {
    const key = params.agent.mbox
      ? `mbox:${params.agent.mbox}`
      : params.agent.account
      ? `account:${params.agent.account.homePage}::${params.agent.account.name}`
      : null;
    if (key) q = q.and(Query.actor(key));
  }

  if (params.verb)         q = q.and(Query.verb(params.verb));
  if (params.activity)     q = q.and(Query.activity(params.activity));
  if (params.registration) q = q.and(Query.registration(params.registration));
  if (params.since)        q = q.and(Query.since(params.since));
  if (params.until)        q = q.and(Query.until(params.until));

  return q;
}
