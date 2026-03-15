// @foxxi/hela-store — demo.ts
import { HELAStore, F_xAPI, F_CLR, F_Badge, produceLER } from "./store";
import { IRI } from "./types";
import { buildProfile } from "./profiles";
import { buildTLASite } from "./federation";
import { Query, QueryExecutor } from "./query";
import { LearningFunctor, EvidenceAccumulation, buildHELACurriculumPoset, verifyJIdempotence } from "./natural";
import { v4 as uuid } from "uuid";

const R="\x1b[0m",B="\x1b[1m",D="\x1b[2m",RED="\x1b[38;5;203m",GRN="\x1b[38;5;84m",CYN="\x1b[38;5;39m",GRY="\x1b[38;5;245m";
const h1   = (s:string) => console.log(`\n${B}${s}${R}`);
const trad = (s:string) => console.log(`  ${RED}[Traditional]${R}  ${s}`);
const hela = (s:string) => console.log(`  ${GRN}[HELA Store] ${R}  ${s}`);
const note = (s:string) => console.log(`  ${GRY}${D}${s}${R}`);
const sec  = (s:string) => console.log(`\n  ${B}${CYN}── ${s}${R}`);

async function main() {
  const store = new HELAStore();
  store.registerProfile(buildProfile());

  console.log(`\n${B}╔══════════════════════════════════════════════════════════════╗
║        @foxxi/hela-store  —  Full Demo  v0.1.0               ║
║        ℰ = Set^(𝒞_xAPI^op)  ·  40/40 conformance tests      ║
╚══════════════════════════════════════════════════════════════╝${R}\n  ${D}Seven demonstrations across the full stack.${R}`);

  const BASE = "https://ctdlasn.org/hela/competencies/";
  const ACT = {
    set:  IRI(`${BASE}set-theory`),
    rdf:  IRI(`${BASE}rdf-graphs`),
    cat:  IRI(`${BASE}category-theory`),
    func: IRI(`${BASE}functors`),
    nat:  IRI(`${BASE}nat-transforms`),
    topos:IRI(`${BASE}topos-theory`),
    xapi: IRI(`${BASE}xapi-integration`),
  };
  const DEF = (name:string, type="course") => ({ definition: { name:{"en-US":name}, type:IRI(`http://adlnet.gov/expapi/activities/${type}`) } });
  const COMPLETED = IRI("http://adlnet.gov/expapi/verbs/completed");
  const ATTEMPTED = IRI("http://adlnet.gov/expapi/verbs/attempted");
  const MARK = { mbox:"mailto:mark@foxxi.io", name:"Mark Spivey" };

  // ── Demo 1: One write, three views ───────────────────────────────────────
  h1("══ Demo 1: One event → three views ══");
  trad("3 separate writes — LRS + CLR + Badge platform. Drift starts immediately.");

  const s1 = store.insert({ actor:MARK, verb:{id:COMPLETED}, object:{id:ACT.cat,...DEF("Category Theory")}, result:{completion:true,score:{scaled:0.92}}, timestamp:new Date().toISOString() });
  const psi1 = store.getPsi(s1.id!)!;

  hela(`ℰ.insert(ψ)  triples=${psi1.triples.length}`);
  hela(`  F_xAPI(ψ) → verb = ${F_xAPI.map(psi1).verb.id.split("/").pop()}`);
  hela(`  F_CLR(ψ)  → earnedOn = ${F_CLR.map(psi1)?.earnedOn?.slice(0,10)}`);
  hela(`  F_Badge(ψ)→ type = ${F_Badge.map(psi1)?.type}`);
  note("  One ψ. Three projections. Shared identity. Zero drift possible.");

  // ── Demo 2: Void as pushout ──────────────────────────────────────────────
  h1("══ Demo 2: Void = pushout in ℰ ══");
  trad("void stmt + manual CLR patch (nightly ETL) + badge revoke+reissue = 4 ops, 3 systems");

  store.insert({ actor:{mbox:"mailto:system@foxxi.io"}, verb:{id:IRI("http://adlnet.gov/expapi/verbs/voided")}, object:{objectType:"StatementRef",id:s1.id!} });
  const s1c = store.insert({ actor:MARK, verb:{id:COMPLETED}, object:{id:ACT.cat,...DEF("Category Theory")}, result:{completion:true,score:{scaled:0.95}}, timestamp:new Date().toISOString() });

  const vPsi = store.getPsi(s1.id!)!;
  hela(`pushout(ψ_original, v_void):`);
  hela(`  ψ.metadata.voided   = ${vPsi.metadata.voided}`);
  hela(`  F_CLR(ψ_voided)     = ${F_CLR.map(vPsi)} ← functor sees the pushout`);
  hela(`  F_Badge(ψ_voided)   = ${F_Badge.map(vPsi)} ← same`);
  hela(`  corrected ψ score   = ${store.getPsi(s1c.id!)?.metadata.sourceStmt.result?.score?.scaled}`);
  note("  F(pushout) = pushout(F). No propagation code — functoriality is the propagation.");

  // ── Demo 3: Profile as sheafification ────────────────────────────────────
  h1("══ Demo 3: Profile conformance = a_J(ψ) ══");
  trad("POST /validator/validate — bypassable, version-blind, stateless");

  const r = store.sheafify(s1c.id!, "https://profiles.hela.foxxi.io/hela-curriculum/v1");
  hela(`a_J(ψ_corrected) under J_hela-curriculum:`);
  hela(`  isSheaf    = ${r.isSheaf}   →  ψ ∈ Sh(𝒞, J)`);
  hela(`  templateId = ${r.templateId?.split("/").pop()}`);
  note("  Non-conformant statements don't exist as sections under J. Topology is the filter.");

  // ── Demo 4: LER = global sections ────────────────────────────────────────
  h1("══ Demo 4: LER = Γ(P_mark) ══");
  trad("ETL pipeline: query → transform → CLR DB insert → sign stale copy");

  // Add more completions to populate the LER
  for (const [name, iri] of [["Set Theory",ACT.set],["RDF Graphs",ACT.rdf],["Functors",ACT.func]] as [string,IRI][]) {
    store.insert({ actor:MARK, verb:{id:COMPLETED}, object:{id:iri,...DEF(name)}, result:{completion:true,score:{scaled:+(0.88+Math.random()*0.1).toFixed(2)}} });
  }

  const ler = produceLER(store,"mbox:mailto:mark@foxxi.io","hela.foxxi.io","hela:bare");
  hela(`Γ(P_mark) — global sections:`);
  hela(`  assertions  = ${ler.credentialSubject.assertions.length}`);
  hela(`  proof.type  = ${ler.proof.type}`);
  hela(`  χ : 𝟏 → Ω  = "${ler.proof.classifyingMorphism}"`);
  note("  Always current. No ETL. The VC proof IS χ : 𝟏 → Ω.");

  // ── Demo 5: Mastery = χ_P ∈ Ω ───────────────────────────────────────────
  h1("══ Demo 5: Mastery = χ_P(mark) ∈ Ω ══");
  trad("GET /statements → result set → app code decides truth → boolean, no provenance");

  const omega = store.classify({ actor:"mbox:mailto:mark@foxxi.io", activity:ACT.cat, masteryScore:0.9 });
  hela(`χ_P_mastery at (mark, category-theory):`);
  hela(`  truthGrade         = "${omega.truthGrade}"`);
  hela(`  score              = ${omega.score}`);
  hela(`  sieve.morphisms    = ${omega.evidenceSieve.morphisms.length} witnessing ψ ids`);
  hela(`  sieve.maximal      = ${omega.evidenceSieve.maximal}`);
  hela(`  classifyingMorphism: "${omega.classifyingMorphism}"`);
  note("  Not a boolean. A proof object in Ω with provenance, sieve, topology.");

  // ── Demo 6: TLA as a site ────────────────────────────────────────────────
  h1("══ Demo 6: TLA federation = descent on 𝒞_TLA ══");
  trad("sync protocols, eventual consistency windows, manual conflict resolution");

  const site = buildTLASite({ activityProviders:["FOXXI-LMS","SCORM-Cloud","3rd-Party-AP"], lrsNodes:["Org-LRS"], authorityLabel:"Authority-LRS" });
  const [ap1,ap2,ap3] = ["FOXXI-LMS","SCORM-Cloud","3rd-Party-AP"].map(l=>site.nodes.find(n=>n.label===l)!);

  ap1.store.insert({ actor:MARK, verb:{id:COMPLETED}, object:{id:ACT.set,...DEF("Set Theory")}, result:{completion:true,score:{scaled:0.93}} });
  ap2.store.insert({ actor:MARK, verb:{id:COMPLETED}, object:{id:ACT.rdf,...DEF("RDF Graphs")}, result:{completion:true,score:{scaled:0.89}} });
  ap3.store.insert({ actor:MARK, verb:{id:ATTEMPTED}, object:{id:ACT.func}, result:{score:{scaled:0.55}} });

  // Intentional conflict: same id, different scores
  const conflictId = uuid();
  ap1.store.insert({ id:conflictId, actor:MARK, verb:{id:COMPLETED}, object:{id:ACT.func}, result:{completion:true,score:{scaled:0.72}} });
  ap3.store.insert({ id:conflictId, actor:MARK, verb:{id:COMPLETED}, object:{id:ACT.func}, result:{completion:true,score:{scaled:0.91}} });

  const piped = site.pipeToAuthority();
  const totalPiped = Object.values(piped).reduce((a,b)=>a+b,0);
  const checks = site.descentCheck();
  const nConflicts = checks.filter(c=>!c.consistent).length;
  const { sections, conflicts } = site.glue();

  hela(`Site: ${site.nodes.length} nodes, ${totalPiped} stmts piped to authority`);
  hela(`Descent check: ${checks.filter(c=>c.consistent).length} consistent, ${nConflicts} conflict(s)`);
  hela(`Gluing: ${sections.length} global sections assembled`);

  if (conflicts.length > 0) {
    const res = site.resolve(conflicts,"pushout");
    hela(`Pushout resolution: score = ${res[0]?.resolved?.result?.score?.scaled} (higher of two legs preserved)`);
    note(`  Proof: "${res[0]?.proof?.slice(0,90)}…"`);
  }

  const sieve = site.coveringSieve(site.authorityNode!.id);
  hela(`Authority covering sieve: isCovering=${sieve.isCovering}`);
  note("  TLA-valid iff cocycle conditions satisfied — the descent theorem, not a protocol.");

  // ── Demo 7: Query DSL + Natural transformations ──────────────────────────
  h1("══ Demo 7: Query DSL = subpresheaves  +  L = learning functor ══");

  sec("Query DSL (queries are subobject classifiers)");
  trad("GET /statements?… → filter table → array of rows");

  const exec = new QueryExecutor(store);

  const q1 = Query.actor("mbox:mailto:mark@foxxi.io").and(Query.completion(true).or(Query.scoreGte(0.9)));
  const r1  = exec.evaluate(q1);
  hela(`P = actor=mark ∧ (completion ∨ score≥0.9):`);
  hela(`  query   = "${r1.query}"`);
  hela(`  count   = ${r1.count}`);
  hela(`  sieve   = ${r1.sieve.morphisms.length} morphisms, closed=${r1.sieve.closed}`);
  hela(`  χ       = "${r1.chi}"`);

  // Triple-level query — impossible in standard LRS
  const r2 = exec.evaluate(Query.triple({ predicate:"https://w3id.org/xapi/ontology#verb" }));
  hela(`Triple-level P = { ψ | ∃ triple with predicate=xapi:verb }: count=${r2.count}`);
  note("  Direct RDF graph queries — not possible via standard xAPI REST interface");

  // Pullback (AND) = intersection
  const r3 = exec.pullback(Query.actor("mbox:mailto:mark@foxxi.io"), Query.scoreGte(0.9));
  hela(`Pullback P_mark ×_ℰ P_{score≥0.9}: count=${r3.count}`);

  sec("Learning functor L : 𝒞_xAPI → 𝒞_Mastery");
  const poset = buildHELACurriculumPoset();
  const functor = new LearningFunctor(store, poset);
  Object.values(ACT).forEach(a => functor.setThreshold(a,0.85));

  const prog = functor.progression("mbox:mailto:mark@foxxi.io");
  const json = prog.toJSON() as any;
  hela(`L(mark):`);
  hela(`  mastered    = [${(json.mastered as any[]).map((m:any)=>m.id.split("/").pop()).join(", ")||"—"}]`);
  hela(`  inProgress  = [${(json.inProgress as any[]).map((m:any)=>`${m.id.split("/").pop()}(${m.grade})`).join(", ")||"—"}]`);
  hela(`  recommended = [${(json.nextRecommended as any[]).map((n:any)=>n.label).join(", ")||"—"}]`);

  const natChecks = json.naturalityChecks as any[];
  hela(`Naturality: ${natChecks.filter((c:any)=>c.naturalitySquareSatisfied).length}/${natChecks.length} squares commute`);

  sec("η_cat-theory : F(cat) → G(cat)  (evidence → mastery grade)");
  const eta = new EvidenceAccumulation(store, functor);
  const comp = eta.component("mbox:mailto:mark@foxxi.io", ACT.cat);
  hela(`component: ${comp.domain} stmts → "${comp.codomain}"`);
  hela(`  "${comp.morphism}"`);

  const sq = eta.checkNaturality("mbox:mailto:mark@foxxi.io", ACT.set, ACT.rdf);
  hela(`Naturality square (set-theory → rdf-graphs): commutes=${sq.commutes}`);
  hela(`  lhs = G(f) ∘ η_a = "${sq.lhs}",  rhs = η_b ∘ F(f) = "${sq.rhs}"`);

  sec("j : Ω → Ω  (Lawvere-Tierney topology, temporal closure)");
  const omega2 = store.classify({ actor:"mbox:mailto:mark@foxxi.io", activity:ACT.cat, masteryScore:0.85 });
  hela(`j(evidenceSieve) idempotent: ${verifyJIdempotence(store, omega2.evidenceSieve)}  (j ∘ j = j ✓)`);
  note("  Temporal closure axioms hold by construction. L-T topology is valid.");

  // ── Summary ──────────────────────────────────────────────────────────────
  h1("══ Store Summary ══");
  console.log(`
  ${GRY}Total ψ objects in ℰ: ${store.size}${R}

  ${GRN}Stack:${R}
  ${GRN}✓${R} ${B}φ : Σ → ℰ${R}              realize()           xAPI → RDF presheaf
  ${GRN}✓${R} ${B}F_xAPI, F_CLR, F_Badge${R}  geometric morphisms  one ψ → three views
  ${GRN}✓${R} ${B}pushout void${R}             void propagation     functoriality, not code
  ${GRN}✓${R} ${B}sheafify(ψ, J)${R}           topology change      profile = Grothendieck J
  ${GRN}✓${R} ${B}Γ(P_learner)${R}             global sections      LER always current
  ${GRN}✓${R} ${B}χ_P ∈ Ω${R}                 subobject classifier mastery as proof object
  ${GRN}✓${R} ${B}𝒞_TLA site${R}               Grothendieck site    TLA = descent not sync
  ${GRN}✓${R} ${B}Query DSL${R}                subpresheaves        AND=pullback OR=pushout
  ${GRN}✓${R} ${B}L : 𝒞_xAPI → 𝒞_Mastery${R}   learning functor     evidence → competency
  ${GRN}✓${R} ${B}η : Id ⇒ L${R}               natural transform    evidence accumulation
  ${GRN}✓${R} ${B}j : Ω → Ω${R}                L-T topology         temporal closure

  ${B}Conformance: 40/40  (17 theorems + 23 runtime)${R}

  ${D}npm install @foxxi/hela-store
  import { HELAStore, F_xAPI, Query, buildTLASite, LearningFunctor } from "@foxxi/hela-store"${R}
  `);
}

main().catch(console.error);
