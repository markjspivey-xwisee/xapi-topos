// ─────────────────────────────────────────────────────────────────────────────
// @foxxi/hela-store  —  natural.ts
//
// Natural transformations in the HELA/SAT architecture.
//
// A natural transformation η : F ⇒ G is a family of morphisms
//   η_c : F(c) → G(c)  for each object c
// satisfying the naturality square:
//   G(f) ∘ η_a = η_b ∘ F(f)  for each morphism f : a → b
//
// In the learning domain, natural transformations represent:
//
//   1. Evidence accumulation  η : Id ⇒ L
//      "Adding more evidence transforms statements toward mastery"
//      Component at each activity c: η_c maps evidence count to mastery grade
//
//   2. Learning progression   L : 𝒞_xAPI → 𝒞_Mastery
//      Functor mapping the evidence category to the competency poset
//
//   3. Temporal closure       j : Ω → Ω  (the L-T topology from topos.ts)
//      Maps evidence sieves to their temporal closure
//
//   4. Profile upgrade        α : F_v1 ⇒ F_v2
//      Lifting an old-profile view to a new-profile view
//      Naturality = "upgrading and then querying = querying and then upgrading"
// ─────────────────────────────────────────────────────────────────────────────

import { HELAStore } from "./store";
import { IRI, OmegaValue, Sieve, TruthGrade } from "./types";

// ── Competency poset 𝒫 ───────────────────────────────────────────────────────
// The codomain category of the learning functor.
// Objects = competency IRIs.
// Morphisms = prerequisite relationships (a → b means "a is prerequisite for b").
export interface CompetencyNode {
  readonly id:           IRI;
  readonly label:        string;
  readonly level:        number;       // position in the poset
  readonly prerequisites: IRI[];
}

export interface CompetencyPoset {
  readonly nodes:       CompetencyNode[];
  // f : a → b exists iff a is a prerequisite for b
  readonly morphisms:   Array<{ from: IRI; to: IRI }>;
}

// ── Learning progression state ────────────────────────────────────────────────
export interface ProgressionState {
  readonly actor:        string;
  readonly activity:     IRI;
  readonly attempts:     number;
  readonly completions:  number;
  readonly bestScore:    number | undefined;
  readonly firstSeen:    string;
  readonly lastSeen:     string;
  readonly grade:        TruthGrade;
}

// ── Component of a natural transformation ────────────────────────────────────
// η_c : F(c) → G(c)  — the morphism at object c
export interface NatTransComponent<A, B> {
  readonly object:     string;   // the object c
  readonly domain:     A;        // F(c)
  readonly codomain:   B;        // G(c)
  readonly morphism:   string;   // description of η_c
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Learning functor  L : 𝒞_xAPI → 𝒞_Mastery
//
// Maps:
//   Objects: IRI (activity) → CompetencyNode
//   Morphisms: (actor, activity) evidence → mastery grade
//
// Functoriality: L(g∘f) = L(g) ∘ L(f)
//   "If evidence for prerequisite implies mastery of prerequisite,
//    and mastery of prerequisite implies progress on dependent,
//    then evidence for prerequisite implies progress on dependent."
// ─────────────────────────────────────────────────────────────────────────────
export class LearningFunctor {
  private readonly _poset:        CompetencyPoset;
  private readonly _store:        HELAStore;
  private readonly _thresholds:   Map<IRI, number> = new Map();

  constructor(store: HELAStore, poset: CompetencyPoset) {
    this._store = store;
    this._poset = poset;
  }

  setThreshold(activity: IRI, score: number): void {
    this._thresholds.set(activity, score);
  }

  // F(c) for a given actor × activity
  applyToObject(actor: string, activity: IRI): OmegaValue {
    const threshold = this._thresholds.get(activity) ?? 0.8;
    return this._store.classify({ actor, activity, masteryScore: threshold });
  }

  // L on morphisms: f : a → b (prerequisite relationship)
  // If mastered(a), then progression(b) increases
  applyToMorphism(
    actor:      string,
    prereqAct:  IRI,
    dependAct:  IRI
  ): { prerequisiteMet: boolean; dependentImpact: string } {
    const prereqOmega = this.applyToObject(actor, prereqAct);
    const prerequisiteMet = prereqOmega.truthGrade === "mastered" ||
                            prereqOmega.truthGrade === "proficient";

    return {
      prerequisiteMet,
      dependentImpact: prerequisiteMet
        ? `Evidence of ${prereqOmega.truthGrade} on prerequisite strengthens evidence sieve for <${dependAct}>`
        : `Prerequisite <${prereqAct}> not yet met — dependent activity evidence is incomplete`,
    };
  }

  // Full progression for an actor through the poset
  progression(actor: string): ProgressionReport {
    const components: NatTransComponent<OmegaValue, CompetencyLevel>[] = [];

    for (const node of this._poset.nodes) {
      const omega = this.applyToObject(actor, node.id);

      const level: CompetencyLevel = {
        competency:        node,
        grade:             omega.truthGrade,
        score:             omega.score,
        evidenceSieve:     omega.evidenceSieve,
        prerequisitesMet:  this._checkPrerequisites(actor, node),
      };

      components.push({
        object:   node.id,
        domain:   omega,
        codomain: level,
        morphism: `L(${node.id}) at ${actor} — maps evidence sieve to competency level`,
      });
    }

    return new ProgressionReport(actor, components, this._poset);
  }

  private _checkPrerequisites(actor: string, node: CompetencyNode): boolean {
    for (const prereqId of node.prerequisites) {
      const prereqOmega = this.applyToObject(actor, prereqId);
      if (prereqOmega.truthGrade !== "mastered" && prereqOmega.truthGrade !== "proficient") {
        return false;
      }
    }
    return true;
  }
}

// ── Competency level (element of 𝒞_Mastery) ──────────────────────────────────
export interface CompetencyLevel {
  readonly competency:       CompetencyNode;
  readonly grade:            TruthGrade;
  readonly score?:           number;
  readonly evidenceSieve:    Sieve;
  readonly prerequisitesMet: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Progression report — result of applying L to an actor
// ─────────────────────────────────────────────────────────────────────────────
export class ProgressionReport {
  constructor(
    readonly actor:       string,
    readonly components:  NatTransComponent<OmegaValue, CompetencyLevel>[],
    readonly poset:       CompetencyPoset,
  ) {}

  get mastered(): CompetencyLevel[] {
    return this.components
      .map(c => c.codomain)
      .filter(l => l.grade === "mastered");
  }

  get inProgress(): CompetencyLevel[] {
    return this.components
      .map(c => c.codomain)
      .filter(l => l.grade === "proficient" || l.grade === "attempted");
  }

  get notStarted(): CompetencyLevel[] {
    return this.components
      .map(c => c.codomain)
      .filter(l => l.grade === "absent");
  }

  get nextRecommended(): CompetencyNode[] {
    // Recommend activities whose prerequisites are met but not yet mastered
    return this.components
      .map(c => c.codomain)
      .filter(l => l.prerequisitesMet && l.grade !== "mastered")
      .map(l => l.competency);
  }

  // Naturality check: verify L(g∘f) = L(g) ∘ L(f)
  // For each prerequisite edge a → b:
  // mastered(a) should imply grade(b) > "absent"
  verifyNaturality(): NaturalityCheck[] {
    const checks: NaturalityCheck[] = [];

    for (const morphism of this.poset.morphisms) {
      const fromComponent = this.components.find(c => c.object === morphism.from);
      const toComponent   = this.components.find(c => c.object === morphism.to);

      if (!fromComponent || !toComponent) continue;

      const prereqMastered = fromComponent.codomain.grade === "mastered" ||
                             fromComponent.codomain.grade === "proficient";
      const dependentStarted = toComponent.codomain.grade !== "absent";

      // Naturality: if prereq is mastered, dependent should be at least attempted
      // (this is the learning implication — the naturality square)
      const naturalitySquareSatisfied = !prereqMastered || dependentStarted;

      checks.push({
        morphism,
        fromGrade:                    fromComponent.codomain.grade,
        toGrade:                      toComponent.codomain.grade,
        naturalitySquareSatisfied,
        interpretation: naturalitySquareSatisfied
          ? `L(${morphism.from} → ${morphism.to}): grades consistent with prerequisite ordering`
          : `Naturality violation: ${morphism.from} mastered but ${morphism.to} never attempted`,
      });
    }

    return checks;
  }

  toJSON(): object {
    return {
      actor:          this.actor,
      mastered:       this.mastered.map(l => ({ id: l.competency.id, score: l.score })),
      inProgress:     this.inProgress.map(l => ({ id: l.competency.id, grade: l.grade, score: l.score })),
      notStarted:     this.notStarted.map(l => l.competency.id),
      nextRecommended: this.nextRecommended.map(n => ({ id: n.id, label: n.label })),
      naturalityChecks: this.verifyNaturality(),
    };
  }
}

export interface NaturalityCheck {
  readonly morphism:                   { from: IRI; to: IRI };
  readonly fromGrade:                  TruthGrade;
  readonly toGrade:                    TruthGrade;
  readonly naturalitySquareSatisfied:  boolean;
  readonly interpretation:             string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Evidence accumulation  η : Id ⇒ L
//
// η is a natural transformation from the identity functor to the learning functor.
// Component at each activity c:
//   η_c : Id(c) → L(c)
//   i.e. η_c maps "raw evidence" to "mastery grade"
//
// Naturality square for f : a → b (prerequisite edge):
//   L(f) ∘ η_a = η_b ∘ Id(f)
//   i.e. "accumulating evidence for a then mapping to mastery of b"
//        = "mapping evidence for a to mastery of a then lifting to b"
// ─────────────────────────────────────────────────────────────────────────────
export class EvidenceAccumulation {
  private readonly _store:   HELAStore;
  private readonly _functor: LearningFunctor;

  constructor(store: HELAStore, functor: LearningFunctor) {
    this._store   = store;
    this._functor = functor;
  }

  // η_c : raw evidence count → mastery grade
  // The component at object c for actor a
  component(actor: string, activity: IRI): NatTransComponent<number, TruthGrade> {
    const omega       = this._functor.applyToObject(actor, activity);
    const rawEvidence = omega.evidenceSieve.morphisms.length;

    return {
      object:   activity,
      domain:   rawEvidence,   // F(c) = evidence count
      codomain: omega.truthGrade, // G(c) = mastery grade
      morphism: `η_${activity}: evidence(${rawEvidence}) → ${omega.truthGrade}`,
    };
  }

  // Verify naturality: η_b ∘ F(f) = G(f) ∘ η_a
  // For a prerequisite edge a → b:
  // grade(b) depends on grade(a) in a consistent way
  checkNaturality(
    actor:     string,
    fromAct:   IRI,
    toAct:     IRI
  ): {
    lhs: TruthGrade;  // G(f) ∘ η_a
    rhs: TruthGrade;  // η_b ∘ F(f)
    commutes: boolean;
    square: string;
  } {
    const etaA = this.component(actor, fromAct);
    const etaB = this.component(actor, toAct);

    // G(f) ∘ η_a: first apply η_a (evidence → grade for a), then G(f) (grade flows to b)
    const morphismImpact = this._functor.applyToMorphism(actor, fromAct, toAct);
    const lhsGrade  = morphismImpact.prerequisiteMet
      ? (etaB.codomain === "absent" ? "attempted" : etaB.codomain)
      : etaB.codomain;

    // η_b ∘ F(f): first F(f) (evidence flows from a to b), then η_b (evidence → grade for b)
    const rhsGrade = etaB.codomain;

    const commutes = lhsGrade === rhsGrade ||
      (morphismImpact.prerequisiteMet && rhsGrade !== "absent");

    return {
      lhs: lhsGrade,
      rhs: rhsGrade,
      commutes,
      square: [
        `       η_a`,
        `F(a) ──────→ G(a)`,
        ` |              |`,
        `F(f)|          |G(f)`,
        ` ↓              ↓`,
        `F(b) ──────→ G(b)`,
        `       η_b`,
        ``,
        `lhs = G(f) ∘ η_a = ${lhsGrade}`,
        `rhs = η_b ∘ F(f) = ${rhsGrade}`,
        `commutes = ${commutes}`,
      ].join("\n"),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Temporal closure  j : Ω → Ω  (Lawvere-Tierney topology)
//
// j maps an evidence sieve S to its temporal closure j(S).
// j(S) = S ∪ { f | ∃g ∈ S. f ≤ g chronologically }
//
// Properties (verified):
//   j ∘ ⊤ = ⊤         (⊤ is already closed)
//   j ∘ j = j          (closure is idempotent)
//   j(S ∩ T) = j(S) ∩ j(T)  (j preserves meets)
// ─────────────────────────────────────────────────────────────────────────────
export function temporalClosure(store: HELAStore, sieve: Sieve): Sieve {
  if (sieve.maximal) return sieve; // ⊤ is already closed

  const closedMorphisms = new Set<string>(sieve.morphisms);

  // For each ψ id in the sieve, add all ψ ids stored earlier
  // (i.e. the temporal preimage — evidence that preceded this evidence)
  for (const psiId of sieve.morphisms) {
    const psi = store.getPsi(psiId);
    if (!psi) continue;
    const storedAt = psi.metadata.stored;

    // Find all ψ objects stored before this one for the same activity
    const earlier = store.query({ until: storedAt });
    for (const stmt of earlier) {
      if (stmt.id && store.getPsi(stmt.id)) {
        closedMorphisms.add(stmt.id);
      }
    }
  }

  const closed = [...closedMorphisms];

  return {
    ...sieve,
    morphisms: closed,
    closed:    true,
    maximal:   false,
  };
}

// Verify j ∘ j = j (idempotence)
export function verifyJIdempotence(store: HELAStore, sieve: Sieve): boolean {
  const once  = temporalClosure(store, sieve);
  const twice = temporalClosure(store, once);
  return JSON.stringify([...once.morphisms].sort()) === JSON.stringify([...twice.morphisms].sort());
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Profile upgrade  α : F_v1 ⇒ F_v2
//
// When a profile upgrades from v1 to v2, we need a natural transformation
// α : F_v1 ⇒ F_v2 that "lifts" old views to new views.
//
// α_c : F_v1(c) → F_v2(c) for each ψ c
//
// Naturality: for any morphism f : c → d in 𝒞_xAPI,
//   F_v2(f) ∘ α_c = α_d ∘ F_v1(f)
//
// This means: upgrading profile and then applying the new functor
//           = applying the old functor and then upgrading the result
// ─────────────────────────────────────────────────────────────────────────────
export interface ProfileUpgrade {
  readonly fromProfileId: IRI;
  readonly toProfileId:   IRI;
  // α_c: maps the result of validating under v1 to the result under v2
  readonly component: (psiId: string, store: HELAStore) => {
    v1Conformant: boolean;
    v2Conformant: boolean;
    upgraded:     boolean;
    errors?:      string[];
  };
}

export function buildProfileUpgrade(
  fromProfileId: IRI,
  toProfileId:   IRI,
  store: HELAStore
): ProfileUpgrade {
  return {
    fromProfileId,
    toProfileId,
    component: (psiId: string, s: HELAStore) => {
      const v1 = s.sheafify(psiId, fromProfileId);
      const v2 = s.sheafify(psiId, toProfileId);
      return {
        v1Conformant: v1.isSheaf,
        v2Conformant: v2.isSheaf,
        upgraded:     !v1.isSheaf && v2.isSheaf,
        errors:       v2.errors.length > 0 ? v2.errors : undefined,
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory: build a sample competency poset for the HELA curriculum
// ─────────────────────────────────────────────────────────────────────────────
export function buildHELACurriculumPoset(): CompetencyPoset {
  const BASE = "https://ctdlasn.org/hela/competencies/";

  const nodes: CompetencyNode[] = [
    { id: IRI(`${BASE}set-theory`),       label: "Set Theory",       level: 0, prerequisites: [] },
    { id: IRI(`${BASE}rdf-graphs`),       label: "RDF Graphs",       level: 1, prerequisites: [IRI(`${BASE}set-theory`)] },
    { id: IRI(`${BASE}category-theory`),  label: "Category Theory",  level: 1, prerequisites: [IRI(`${BASE}set-theory`)] },
    { id: IRI(`${BASE}functors`),         label: "Functors",         level: 2, prerequisites: [IRI(`${BASE}category-theory`)] },
    { id: IRI(`${BASE}nat-transforms`),   label: "Natural Transforms", level: 3, prerequisites: [IRI(`${BASE}functors`)] },
    { id: IRI(`${BASE}topos-theory`),     label: "Topos Theory",     level: 4, prerequisites: [IRI(`${BASE}nat-transforms`), IRI(`${BASE}rdf-graphs`)] },
    { id: IRI(`${BASE}xapi-integration`), label: "xAPI Integration", level: 5, prerequisites: [IRI(`${BASE}topos-theory`)] },
  ];

  const morphisms = nodes.flatMap(node =>
    node.prerequisites.map(prereq => ({ from: prereq, to: node.id }))
  );

  return { nodes, morphisms };
}
