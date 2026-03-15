import { describe, it, expect, beforeEach } from "vitest";
import { HELAStore, F_xAPI, F_CLR, F_Badge, F_CTDL, F_CASE, produceLER, realize } from "../store";
import { InMemoryAdapter } from "../adapters";
import { IRI, XAPIStatement, StoredXAPIStatement } from "../types";

// ── Test helpers ─────────────────────────────────────────────────────────────

function mkStmt(overrides: Partial<XAPIStatement> = {}): XAPIStatement {
  return {
    actor: { mbox: "mailto:test@foxxi.io", name: "Test Learner" },
    verb: { id: IRI("http://adlnet.gov/expapi/verbs/completed"), display: { "en-US": "completed" } },
    object: {
      objectType: "Activity",
      id: IRI("https://example.com/activities/test-course"),
      definition: {
        name: { "en-US": "Test Course" },
        type: IRI("http://adlnet.gov/expapi/activities/course"),
      },
    },
    result: { completion: true, score: { scaled: 0.85 } },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ── Store basics ─────────────────────────────────────────────────────────────

describe("HELAStore", () => {
  let store: HELAStore;

  beforeEach(() => {
    store = new HELAStore(new InMemoryAdapter());
  });

  it("starts empty", () => {
    expect(store.size).toBe(0);
  });

  it("inserts a statement and increments size", () => {
    store.insert(mkStmt());
    expect(store.size).toBe(1);
  });

  it("returns a stored statement with id, stored, version", () => {
    const result = store.insert(mkStmt());
    expect(result.id).toBeDefined();
    expect(result.stored).toBeDefined();
    expect(result.version).toBe("2.0.0");
  });

  it("retrieves by id", () => {
    const result = store.insert(mkStmt());
    const found = store.getById(result.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(result.id);
  });

  it("retrieves raw psi by id", () => {
    const result = store.insert(mkStmt());
    const psi = store.getPsi(result.id);
    expect(psi).toBeDefined();
    expect(psi!.triples.length).toBeGreaterThan(0);
    expect(psi!.metadata.topology).toBe("hela:bare");
  });

  it("queries all statements", () => {
    store.insert(mkStmt());
    store.insert(mkStmt({ actor: { mbox: "mailto:other@foxxi.io" } }));
    const results = store.query({});
    expect(results.length).toBe(2);
  });

  it("queries by agent", () => {
    store.insert(mkStmt());
    store.insert(mkStmt({ actor: { mbox: "mailto:other@foxxi.io" } }));
    const results = store.query({ agent: { mbox: "mailto:test@foxxi.io" } });
    expect(results.length).toBe(1);
  });

  it("queries by verb", () => {
    store.insert(mkStmt());
    store.insert(mkStmt({ verb: { id: IRI("http://adlnet.gov/expapi/verbs/attempted") } }));
    const results = store.query({ verb: IRI("http://adlnet.gov/expapi/verbs/completed") });
    expect(results.length).toBe(1);
  });

  it("queries by activity", () => {
    store.insert(mkStmt());
    store.insert(mkStmt({ object: { objectType: "Activity", id: IRI("https://example.com/other") } }));
    const results = store.query({ activity: IRI("https://example.com/activities/test-course") });
    expect(results.length).toBe(1);
  });

  it("handles voiding via pushout", () => {
    const original = store.insert(mkStmt());
    store.insert({
      actor: { mbox: "mailto:admin@foxxi.io" },
      verb: { id: IRI("http://adlnet.gov/expapi/verbs/voided") },
      object: { objectType: "StatementRef", id: original.id },
    });
    // The original should be voided
    const psi = store.getPsi(original.id);
    expect(psi!.metadata.voided).toBe(true);
    // Voided statements excluded from default queries
    const results = store.query({});
    const origInResults = results.find(s => s.id === original.id);
    expect(origInResults).toBeUndefined();
  });

  it("computes global sections for an actor", () => {
    store.insert(mkStmt());
    store.insert(mkStmt({ result: { completion: true, score: { scaled: 0.92 } } }));
    const sections = store.globalSections("mbox:mailto:test@foxxi.io");
    expect(sections.psis.length).toBe(2);
    expect(sections.completions.length).toBe(2);
    expect(sections.scores.length).toBe(2);
  });

  it("classifies mastery correctly", () => {
    store.insert(mkStmt({ result: { completion: true, score: { scaled: 0.95 } } }));
    const omega = store.classify({
      actor: "mbox:mailto:test@foxxi.io",
      activity: IRI("https://example.com/activities/test-course"),
      masteryScore: 0.9,
    });
    expect(omega.truthGrade).toBe("mastered");
    expect(omega.evidenceSieve.maximal).toBe(true);
  });

  it("classifies attempted correctly", () => {
    store.insert(mkStmt({ result: { score: { scaled: 0.3 } } }));
    const omega = store.classify({
      actor: "mbox:mailto:test@foxxi.io",
      activity: IRI("https://example.com/activities/test-course"),
      masteryScore: 0.9,
    });
    expect(omega.truthGrade).toBe("attempted");
  });

  it("classifies absent correctly", () => {
    const omega = store.classify({
      actor: "mbox:mailto:nobody@foxxi.io",
      activity: IRI("https://example.com/nonexistent"),
      masteryScore: 0.9,
    });
    expect(omega.truthGrade).toBe("absent");
    expect(omega.evidenceSieve.morphisms.length).toBe(0);
  });
});

// ── Realize (φ) ──────────────────────────────────────────────────────────────

describe("realize", () => {
  it("produces triples from a statement", () => {
    const stmt: StoredXAPIStatement = {
      ...mkStmt(),
      id: "test-id-123",
      stored: new Date().toISOString(),
      version: "2.0.0",
    };
    const psi = realize(stmt, "test-topology");
    expect(psi.id).toBe("test-id-123");
    expect(psi.triples.length).toBeGreaterThan(3);
    expect(psi.metadata.topology).toBe("test-topology");
    expect(psi.metadata.sourceStmt).toBe(stmt);
  });

  it("includes actor triples", () => {
    const stmt: StoredXAPIStatement = {
      ...mkStmt(),
      id: "actor-test",
      stored: new Date().toISOString(),
      version: "2.0.0",
    };
    const psi = realize(stmt, "test");
    const actorTriples = psi.triples.filter(t =>
      t.predicate.includes("actor") || t.predicate.includes("mbox")
    );
    expect(actorTriples.length).toBeGreaterThan(0);
  });
});

// ── Geometric Morphisms ──────────────────────────────────────────────────────

describe("Geometric Morphisms", () => {
  let store: HELAStore;
  let psis: any[];

  beforeEach(() => {
    store = new HELAStore(new InMemoryAdapter());
    store.insert(mkStmt({ result: { completion: true, score: { scaled: 0.85 } } }));
    store.insert(mkStmt({ result: { completion: true, score: { scaled: 0.95 } } }));
    store.insert(mkStmt({ result: { score: { scaled: 0.4 } } })); // no completion
    psis = store.query({}).map(s => store.getPsi(s.id)!);
  });

  it("F_xAPI maps all non-voided psis to statements", () => {
    const stmts = F_xAPI.mapMany(psis);
    expect(stmts.length).toBe(3);
  });

  it("F_CLR maps only completed psis to assertions", () => {
    const assertions = F_CLR.mapMany(psis);
    expect(assertions.length).toBe(2);
    expect(assertions[0].type).toBe("AchievementSubject");
  });

  it("F_Badge maps only completed+high-score to badges", () => {
    const badges = F_Badge.mapMany(psis);
    expect(badges.length).toBe(2); // both 0.85 and 0.95 >= 0.7
    expect(badges[0].type).toBe("Assertion");
  });

  it("F_CTDL maps completed to CTDL credentials", () => {
    const creds = F_CTDL.mapMany(psis);
    expect(creds.length).toBe(2);
    expect(creds[0]["@type"]).toBe("ceterms:Credential");
  });

  it("F_CASE maps all non-voided to competency items", () => {
    const items = F_CASE.mapMany(psis);
    expect(items.length).toBe(3);
    expect(items[0].CFItemType).toBe("Competency");
  });

  it("F_CASE assigns correct confidence levels", () => {
    const items = F_CASE.mapMany(psis);
    const scores = items.map(i => i.assertion.confidence);
    expect(scores).toContain("mastered");    // 0.95
    expect(scores).toContain("proficient");  // 0.85
    expect(scores).toContain("attempted");   // 0.4 (no completion)
  });
});

// ── produceLER ───────────────────────────────────────────────────────────────

describe("produceLER", () => {
  it("produces a valid LER with presheaf proof", () => {
    const store = new HELAStore(new InMemoryAdapter());
    store.insert(mkStmt({ result: { completion: true, score: { scaled: 0.9 } } }));
    store.insert(mkStmt({ result: { completion: true, score: { scaled: 0.8 } } }));

    const ler = produceLER(store, "mbox:mailto:test@foxxi.io", "hela.foxxi.io", "hela:bare");
    expect(ler.type).toBe("LearningAndEmploymentRecord");
    expect(ler.credentialSubject.assertions.length).toBe(2);
    expect(ler.proof.type).toBe("HELAPresheafProof");
    expect(ler.proof.globalSectionCount).toBe(2);
    expect(ler.proof.topology).toBe("hela:bare");
  });
});
