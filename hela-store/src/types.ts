// ─────────────────────────────────────────────────────────────────────────────
// @foxxi/hela-store  —  types.ts
//
// xAPI 2.0 types + HELA categorical types.
// xAPI types follow P9274.1.1. HELA types are the mathematical layer above.
// ─────────────────────────────────────────────────────────────────────────────

// ── IRI ───────────────────────────────────────────────────────────────────────
export type IRI = string & { readonly _brand: "IRI" };
export const IRI = (s: string): IRI => s as IRI;

// ── xAPI core types ───────────────────────────────────────────────────────────
export interface LanguageMap {
  [lang: string]: string;
}

export interface Account {
  homePage: IRI;
  name: string;
}

export interface Agent {
  objectType?: "Agent";
  name?: string;
  mbox?: string;
  mbox_sha1sum?: string;
  openid?: IRI;
  account?: Account;
}

export interface Group {
  objectType: "Group";
  name?: string;
  mbox?: string;
  account?: Account;
  member?: Agent[];
}

export type Actor = Agent | Group;

export interface Verb {
  id: IRI;
  display?: LanguageMap;
}

export interface ActivityDefinition {
  name?: LanguageMap;
  description?: LanguageMap;
  type?: IRI;
  moreInfo?: IRI;
  extensions?: Record<IRI, unknown>;
}

export interface Activity {
  objectType?: "Activity";
  id: IRI;
  definition?: ActivityDefinition;
}

export interface StatementRef {
  objectType: "StatementRef";
  id: string; // UUID
}

export type StatementObject = Activity | Agent | Group | StatementRef;

export interface Score {
  scaled?: number;   // [-1, 1]
  raw?: number;
  min?: number;
  max?: number;
}

export interface Result {
  score?: Score;
  success?: boolean;
  completion?: boolean;
  response?: string;
  duration?: string; // ISO 8601
  extensions?: Record<IRI, unknown>;
}

export interface ContextActivities {
  parent?: Activity[];
  grouping?: Activity[];
  category?: Activity[];
  other?: Activity[];
}

export interface Context {
  registration?: string; // UUID
  instructor?: Actor;
  team?: Group;
  contextActivities?: ContextActivities;
  revision?: string;
  platform?: string;
  language?: string;
  statement?: StatementRef;
  extensions?: Record<IRI, unknown>;
}

export interface Attachment {
  usageType: IRI;
  display: LanguageMap;
  description?: LanguageMap;
  contentType: string;
  length: number;
  sha2: string;
  fileUrl?: IRI;
}

// The canonical xAPI Statement (P9274.1.1 §2.4)
export interface XAPIStatement {
  id?: string;            // UUID — assigned by LRS if absent
  actor: Actor;
  verb: Verb;
  object: StatementObject;
  result?: Result;
  context?: Context;
  timestamp?: string;     // ISO 8601
  stored?: string;        // ISO 8601 — set by LRS
  authority?: Actor;
  version?: string;
  attachments?: Attachment[];
}

// Stored statement always has id, stored, version
export interface StoredXAPIStatement extends XAPIStatement {
  id: string;
  stored: string;
  version: string;
}

// ── Triple / RDF ──────────────────────────────────────────────────────────────
// G = (V, E, src, tgt, λ) — directed labeled graph = RDF graph
export type RDFNode   = IRI | BlankNode | Literal;
export type BlankNode = string & { readonly _brand: "BlankNode" };
export type Literal   = string & { readonly _brand: "Literal" };

export const BNode   = (s: string): BlankNode => s as BlankNode;
export const Literal = (s: string): Literal   => s as Literal;

export interface Triple {
  subject:   IRI | BlankNode;
  predicate: IRI;
  object:    RDFNode;
}

// ── Presheaf object ψ (the HELA store object) ─────────────────────────────────
//
// ψ is an element of the presheaf category ℰ = Set^(𝒞_xAPI^op).
// Concretely: a named set of triples with metadata.
// The xAPI statement is ONE view of ψ, not ψ itself.
export interface Psi {
  readonly id:       string;         // UUID — identity in ℰ
  readonly triples:  readonly Triple[];
  readonly metadata: PsiMetadata;
}

export interface PsiMetadata {
  readonly stored:     string;     // ISO 8601
  readonly voided:     boolean;
  readonly voidedBy?:  string;     // UUID of voiding ψ
  readonly topology:   string;     // which J this was inserted under
  readonly profileIds: string[];   // profile IRIs this conforms to
  readonly sourceStmt: StoredXAPIStatement; // the originating xAPI stmt
}

// ── Sieve (element of Ω(c)) ───────────────────────────────────────────────────
//
// A sieve S on object c is a set of morphisms into c
// closed under pre-composition. In our site:
// morphisms = temporal/evidential relationships between ψ objects.
export interface Sieve {
  readonly object:    string;          // the ψ id this sieve is on
  readonly morphisms: readonly string[]; // ψ ids that map into object
  readonly closed:    boolean;         // closed under pre-composition?
  readonly maximal:   boolean;         // = maximal sieve (⊤)?
}

// ── Truth value in Ω ─────────────────────────────────────────────────────────
//
// Result of evaluating characteristic morphism χ_P at a point.
// NOT a boolean — a structured proof object.
export type TruthGrade = "witnessed" | "mastered" | "proficient" | "attempted" | "absent";

export interface OmegaValue {
  readonly claim:               string;         // human-readable claim
  readonly truthGrade:          TruthGrade;
  readonly topology:            string;         // which J used
  readonly evidenceSieve:       Sieve;
  readonly witnessingStatements: string[];      // ψ ids
  readonly score?:              number;
  readonly classifyingMorphism: string;         // χ_P description
}

// ── Geometric morphism (functor producing a view) ─────────────────────────────
export interface GeometricMorphism<A, B> {
  readonly name:       string;
  readonly domain:     string;    // "ℰ"
  readonly codomain:   string;    // "LRS" | "CLR" | "Badge" | etc.
  readonly map:        (psi: Psi) => B;
  readonly mapMany:    (psis: Psi[]) => A;
}

// ── Query parameters (xAPI §7.2) ─────────────────────────────────────────────
export interface StatementQueryParams {
  statementId?:   string;
  voidedStatementId?: string;
  agent?:         Agent;
  verb?:          IRI;
  activity?:      IRI;
  registration?:  string;
  related_activities?: boolean;
  related_agents?: boolean;
  since?:         string;
  until?:         string;
  limit?:         number;
  format?:        "ids" | "exact" | "canonical";
  attachments?:   boolean;
  ascending?:     boolean;
}

// ── Profile (Grothendieck topology J) ────────────────────────────────────────
//
// An xAPI Profile defines:
//   - concepts (verbs, activity types, extensions)
//   - statement templates (required/optional fields, rules)
//   - patterns (sequences of templates)
//
// In HELA, a Profile IS a Grothendieck topology J on the site 𝒞_xAPI.
// Conformance = ψ is a sheaf under J_profile.
export interface ProfileConcept {
  readonly id: IRI;
  readonly type: "Verb" | "ActivityType" | "AttachmentUsageType" | "Extension" | "Document";
  readonly inScheme: IRI;
}

export interface TemplateRule {
  readonly location:    string;    // JSONPath
  readonly presence?:   "included" | "excluded" | "recommended";
  readonly any?:        IRI[];
  readonly all?:        IRI[];
  readonly none?:       IRI[];
}

export interface StatementTemplate {
  readonly id:          IRI;
  readonly verb?:       IRI;
  readonly objectActivityType?: IRI;
  readonly rules:       TemplateRule[];
}

export interface Profile {
  readonly id:         IRI;
  readonly version:    string;
  readonly concepts:   ProfileConcept[];
  readonly templates:  StatementTemplate[];
  // The topology: sieve S on c is covering iff c satisfies all templates
  // that match S's morphisms
  readonly validate:   (stmt: StoredXAPIStatement) => ProfileValidationResult;
}

export interface ProfileValidationResult {
  readonly conformant:  boolean;
  readonly templateId?: IRI;
  readonly errors:      string[];
  // isSheaf: true iff a_J(ψ) = ψ — the sheafification is identity
  readonly isSheaf:     boolean;
}

// ── CLR / LER types ───────────────────────────────────────────────────────────
export interface CLRAssertion {
  readonly id:           string;
  readonly type:         "AchievementSubject";
  readonly achievement:  { id: IRI; achievementType: string; name: string };
  readonly earnedOn:     string;
  readonly evidence:     { id: string; narrative: string }[];
  readonly result?:      { value: string };
}

export interface LER {
  readonly type:          "VerifiableCredential" | "LearningAndEmploymentRecord";
  readonly issuer:        string;
  readonly issuanceDate:  string;
  readonly credentialSubject: {
    readonly id:         string;
    readonly type:       "LearnerProfile";
    readonly assertions: CLRAssertion[];
  };
  // χ : 𝟏 → Ω — the characteristic morphism witnessing the global sections
  readonly proof: {
    readonly type:                "HELAPresheafProof";
    readonly globalSectionCount:  number;
    readonly evidenceSieves:      Sieve[];
    readonly topology:            string;
    readonly classifyingMorphism: string;
  };
}

// ── BadgeAssertion ────────────────────────────────────────────────────────────
export interface BadgeAssertion {
  readonly "@context": string;
  readonly id:         string;
  readonly type:       "Assertion";
  readonly recipient:  { type: "email"; identity: string; hashed: boolean };
  readonly badge:      { id: IRI; name: string; criteria: { narrative: string } };
  readonly issuedOn:   string;
  readonly evidence:   { id: string; narrative: string }[];
  readonly verification: { type: "HelaPresheafVerification"; psiId: string };
}

// ── CTDLCredential ───────────────────────────────────────────────────────────
// Credential Transparency Description Language — maps from ψ via F_CTDL
export interface CTDLCredential {
  readonly "@context": string[];
  readonly "@type": "ceterms:Credential";
  readonly "ceterms:ctid": string;
  readonly "ceterms:name": string;
  readonly "ceterms:description"?: string;
  readonly "ceterms:subjectWebpage"?: IRI;
  readonly "ceterms:dateEffective": string;
  readonly "ceterms:credentialStatusType": string;
  readonly "ceterms:requires"?: { "@type": "ceterms:ConditionProfile"; "ceterms:description": string }[];
  readonly "hela:psiId": string;
  readonly "hela:evidence": { id: string; narrative: string }[];
}

// ── CASEItem ─────────────────────────────────────────────────────────────────
// Competency and Academic Standards Exchange — maps from ψ via F_CASE
export interface CASEItem {
  readonly CFItemURI: IRI;
  readonly CFItemType: string;
  readonly humanCodingScheme?: string;
  readonly fullStatement: string;
  readonly assertion: {
    readonly confidence: TruthGrade;
    readonly score?: number;
    readonly evidenceCount: number;
  };
  readonly evidenceCollection: { id: string; narrative: string }[];
  readonly "hela:psiId": string;
}

// ── ServerConfig ─────────────────────────────────────────────────────────────
export interface ServerConfig {
  apiKeys?: string[];
  persistence?: { type: "json"; path: string } | { type: "memory" };
  port?: number;
}

// ── SCORMCloudConfig ─────────────────────────────────────────────────────────
export interface SCORMCloudConfig {
  appId: string;
  secretKey: string;
  endpoint?: string; // defaults to https://cloud.scorm.com
}

// ── LRS response types ────────────────────────────────────────────────────────
export interface StatementResult {
  statements: StoredXAPIStatement[];
  more?: string;
}

export interface ConformanceTestResult {
  readonly id:          string;
  readonly description: string;
  readonly requirement: string;   // P9274.1.1 section reference
  readonly status:      "PASS" | "FAIL" | "SKIP";
  readonly method:      "theorem" | "runtime";
  readonly proof?:      string;   // mathematical justification for theorems
  readonly error?:      string;
}
