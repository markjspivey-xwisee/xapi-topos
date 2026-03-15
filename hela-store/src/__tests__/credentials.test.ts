import { describe, it, expect } from "vitest";
import { VCIssuer, verifyPresentation, generateRecommendations } from "../credentials";
import { HELAStore, F_CLR, F_Badge, F_CTDL, F_CASE } from "../store";
import { InMemoryAdapter } from "../adapters";
import { IRI, XAPIStatement, StoredXAPIStatement } from "../types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function seedStore(): HELAStore {
  const store = new HELAStore(new InMemoryAdapter());
  const activities = [
    { name: "Cybersecurity Basics", score: 0.95, completed: true },
    { name: "Network Defense", score: 0.82, completed: true },
    { name: "Incident Response", score: 0.6, completed: false },
    { name: "Threat Modeling", score: 0.45, completed: false },
    { name: "Cloud Security", score: 0.91, completed: true },
  ];

  for (const act of activities) {
    store.insert({
      actor: { mbox: "mailto:jane@foxxi.io", name: "Jane Chen" },
      verb: { id: IRI("http://adlnet.gov/expapi/verbs/completed"), display: { "en-US": "completed" } },
      object: {
        objectType: "Activity",
        id: IRI(`https://example.com/activities/${act.name.toLowerCase().replace(/\s+/g, "-")}`),
        definition: { name: { "en-US": act.name }, type: IRI("http://adlnet.gov/expapi/activities/course") },
      },
      result: { completion: act.completed, score: { scaled: act.score } },
      timestamp: new Date().toISOString(),
    });
  }
  return store;
}

// ── VCIssuer ─────────────────────────────────────────────────────────────────

describe("VCIssuer", () => {
  it("generates a keypair with a DID", () => {
    const issuer = VCIssuer.generate();
    expect(issuer.did).toMatch(/^did:key:z/);
  });

  it("signs and produces JWS tokens", () => {
    const issuer = VCIssuer.generate();
    const jws = issuer.sign({ test: true });
    expect(jws.split(".").length).toBe(3); // header.payload.signature
  });

  it("issues VCs from psi objects", () => {
    const store = seedStore();
    const psis = store.query({}).map(s => store.getPsi(s.id)!);
    const issuer = VCIssuer.generate();
    const vcs = issuer.issueAll(psis, "did:key:zHolder123");

    expect(vcs.length).toBeGreaterThan(0);
    // Every VC should have a JWS proof
    for (const vc of vcs) {
      expect(vc.proof.jws).toBeDefined();
      expect(vc.proof.type).toBe("HELAPresheafProof");
      expect(vc.proof.sheafCondition).toBe("satisfied");
      expect(vc.issuer).toBe(issuer.did);
    }
  });

  it("issues VCs from all 4 morphisms", () => {
    const store = seedStore();
    const psis = store.query({}).map(s => store.getPsi(s.id)!);
    const issuer = VCIssuer.generate();
    const vcs = issuer.issueAll(psis, "did:key:zHolder123");

    const morphisms = new Set(vcs.map(vc => vc.proof.morphism));
    expect(morphisms.has("F_CLR")).toBe(true);
    expect(morphisms.has("F_Badge")).toBe(true);
    expect(morphisms.has("F_CTDL")).toBe(true);
    expect(morphisms.has("F_CASE")).toBe(true);
  });

  it("creates a verifiable presentation with selective disclosure", () => {
    const store = seedStore();
    const psis = store.query({}).map(s => store.getPsi(s.id)!);
    const issuer = VCIssuer.generate();
    const vcs = issuer.issueAll(psis, "did:key:zHolder123");

    const vp = issuer.present(vcs, "did:key:zHolder123", ["F_CLR", "F_Badge"]);
    expect(vp.type).toContain("VerifiablePresentation");
    expect(vp.holder).toBe("did:key:zHolder123");
    expect(vp.proof.selectedMorphisms).toEqual(["F_CLR", "F_Badge"]);
    expect(vp.proof.jws).toBeDefined();

    // Only F_CLR and F_Badge VCs should be included
    for (const vc of vp.verifiableCredential) {
      expect(["F_CLR", "F_Badge"]).toContain(vc.proof.morphism);
    }
  });
});

// ── Peer Verification ────────────────────────────────────────────────────────

describe("verifyPresentation", () => {
  it("verifies a valid VP", () => {
    const store = seedStore();
    const psis = store.query({}).map(s => store.getPsi(s.id)!);
    const issuer = VCIssuer.generate();
    const vcs = issuer.issueAll(psis, "did:key:zHolder123");
    const vp = issuer.present(vcs, "did:key:zHolder123", ["F_CLR"]);

    const result = verifyPresentation(vp);
    expect(result.verified).toBe(true);
    expect(result.sheafConditionSatisfied).toBe(true);
    expect(result.signatureValid).toBe(true);
    expect(result.credentialCount).toBeGreaterThan(0);
    expect(result.totalEvidence).toBeGreaterThan(0);
    expect(result.errors).toEqual([]);
  });

  it("fails verification for VP without JWS", () => {
    const vp = {
      "@context": ["https://www.w3.org/2018/credentials/v1"],
      type: ["VerifiablePresentation"],
      id: "urn:test",
      holder: "did:key:zFake",
      verifiableCredential: [
        {
          "@context": ["https://www.w3.org/2018/credentials/v1"],
          type: ["VerifiableCredential"],
          id: "urn:test-vc",
          issuer: "did:key:zFake",
          issuanceDate: new Date().toISOString(),
          credentialSubject: {},
          proof: {
            type: "HELAPresheafProof",
            created: new Date().toISOString(),
            verificationMethod: "did:key:zFake",
            proofPurpose: "assertionMethod",
            morphism: "F_CLR",
            sheafCondition: "satisfied" as const,
            topology: "hela:bare",
            evidenceCount: 0,
            // no jws!
          },
        },
      ],
      proof: {
        type: "HELAPresheafPresentation",
        created: new Date().toISOString(),
        verificationMethod: "did:key:zFake",
        proofPurpose: "authentication",
        selectedMorphisms: ["F_CLR"],
        totalMorphisms: 5,
        selectiveDisclosure: "1/5",
        // no jws!
      },
    };

    const result = verifyPresentation(vp as any);
    expect(result.verified).toBe(false);
    expect(result.signatureValid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ── Recommendations ──────────────────────────────────────────────────────────

describe("generateRecommendations", () => {
  it("generates recommendations from statements", () => {
    const store = seedStore();
    const stmts = store.query({});
    const recs = generateRecommendations(stmts);

    expect(recs.length).toBeGreaterThan(0);
    for (const rec of recs) {
      expect(["gap", "progression", "extension"]).toContain(rec.type);
      expect(rec.confidence).toBeGreaterThan(0);
      expect(rec.confidence).toBeLessThanOrEqual(1);
      expect(rec.activityName).toBeDefined();
    }
  });

  it("identifies gaps (attempted but not mastered)", () => {
    const store = seedStore();
    const stmts = store.query({});
    const recs = generateRecommendations(stmts);
    const gaps = recs.filter(r => r.type === "gap");
    // Incident Response (0.6, not completed) and Threat Modeling (0.45, not completed) are gaps
    expect(gaps.length).toBeGreaterThan(0);
  });

  it("returns empty for no statements", () => {
    const recs = generateRecommendations([]);
    expect(recs).toEqual([]);
  });

  it("respects maxRecommendations limit", () => {
    const store = seedStore();
    const stmts = store.query({});
    const recs = generateRecommendations(stmts, 2);
    expect(recs.length).toBeLessThanOrEqual(2);
  });
});
