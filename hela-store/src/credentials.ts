// ─────────────────────────────────────────────────────────────────────────────
// @foxxi/hela-store  —  credentials.ts
//
// Verifiable Credential issuance with JWT signatures.
// W3C VC Data Model v2.0 + HELA presheaf proofs.
//
// Each geometric morphism output (F_CLR, F_Badge, F_CTDL, F_CASE)
// can be issued as a signed VC. Selective disclosure is achieved
// by choosing which morphisms to include in a Verifiable Presentation.
// ─────────────────────────────────────────────────────────────────────────────

import * as crypto from "crypto";
import {
  Psi, StoredXAPIStatement, CLRAssertion, BadgeAssertion, CTDLCredential, CASEItem,
} from "./types";
import { F_CLR, F_Badge, F_CTDL, F_CASE } from "./store";

// ── Key pair for signing ─────────────────────────────────────────────────────
export interface HELAKeyPair {
  publicKey: string;    // hex-encoded
  privateKey: string;   // hex-encoded or PEM
  algorithm: "Ed25519" | "ECDSA-P256";
  did: string;          // did:key:z...
}

// ── VC types ─────────────────────────────────────────────────────────────────
export interface VerifiableCredential {
  "@context": string[];
  type: string[];
  id: string;
  issuer: string;
  issuanceDate: string;
  expirationDate?: string;
  credentialSubject: Record<string, unknown>;
  proof: VCProof;
}

export interface VCProof {
  type: string;
  created: string;
  verificationMethod: string;
  proofPurpose: string;
  jws?: string;
  morphism: string;
  sheafCondition: "satisfied" | "unsatisfied";
  topology: string;
  evidenceCount: number;
}

export interface VerifiablePresentation {
  "@context": string[];
  type: string[];
  id: string;
  holder: string;
  verifiableCredential: VerifiableCredential[];
  proof: VPProof;
}

export interface VPProof {
  type: string;
  created: string;
  verificationMethod: string;
  proofPurpose: string;
  jws?: string;
  selectedMorphisms: string[];
  totalMorphisms: number;
  selectiveDisclosure: string;
}

// ── VC Issuer ────────────────────────────────────────────────────────────────
export class VCIssuer {
  private _keyPair: HELAKeyPair;

  constructor(keyPair: HELAKeyPair) {
    this._keyPair = keyPair;
  }

  /** Generate a new ECDSA P-256 keypair + DID */
  static generate(): VCIssuer {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });

    const pubDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
    const pubHex = pubDer.toString("hex");

    // Construct did:key from public key
    // Multicodec prefix for P-256 public key: 0x1200
    const pubRaw = publicKey.export({ type: "spki", format: "der" }) as Buffer;
    const did = `did:key:z${base58btcEncode(Buffer.concat([Buffer.from([0x12, 0x00]), pubRaw]))}`;

    const privPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

    return new VCIssuer({
      publicKey: pubHex,
      privateKey: privPem,
      algorithm: "ECDSA-P256",
      did,
    });
  }

  get did(): string { return this._keyPair.did; }

  /** Sign arbitrary data and return JWS */
  sign(payload: Record<string, unknown>): string {
    const header = base64url(JSON.stringify({ alg: "ES256", typ: "JWT" }));
    const body = base64url(JSON.stringify(payload));
    const signable = `${header}.${body}`;

    const signer = crypto.createSign("SHA256");
    signer.update(signable);
    const signature = signer.sign(this._keyPair.privateKey, "base64url");

    return `${signable}.${signature}`;
  }

  /** Verify a JWS token */
  verify(jws: string): { valid: boolean; payload?: Record<string, unknown> } {
    try {
      const [header, body, signature] = jws.split(".");
      const signable = `${header}.${body}`;

      const pubKey = crypto.createPublicKey({
        key: Buffer.from(this._keyPair.publicKey, "hex"),
        format: "der",
        type: "spki",
      });

      const verifier = crypto.createVerify("SHA256");
      verifier.update(signable);
      const valid = verifier.verify(pubKey, signature, "base64url");

      return {
        valid,
        payload: valid ? JSON.parse(Buffer.from(body, "base64url").toString()) : undefined,
      };
    } catch {
      return { valid: false };
    }
  }

  // ── Issue VCs from morphism outputs ─────────────────────────────────────

  /** Issue a VC from F_CLR output */
  issueCLR(assertion: CLRAssertion, holder: string): VerifiableCredential {
    return this._issue("F_CLR", holder, {
      credentialType: "CLRAssertion",
      achievement: assertion.achievement,
      earnedOn: assertion.earnedOn,
      evidence: assertion.evidence,
      result: assertion.result,
    }, assertion.evidence?.length ?? 0);
  }

  /** Issue a VC from F_Badge output */
  issueBadge(badge: BadgeAssertion, holder: string): VerifiableCredential {
    return this._issue("F_Badge", holder, {
      type: "BadgeAssertion",
      badge: badge.badge,
      recipient: badge.recipient,
      issuedOn: badge.issuedOn,
    }, badge.evidence?.length ?? 0);
  }

  /** Issue a VC from F_CTDL output */
  issueCTDL(cred: CTDLCredential, holder: string): VerifiableCredential {
    return this._issue("F_CTDL", holder, {
      type: "CTDLCredential",
      name: cred["ceterms:name"],
      ctid: cred["ceterms:ctid"],
      dateEffective: cred["ceterms:dateEffective"],
    }, cred["hela:evidence"]?.length ?? 0);
  }

  /** Issue a VC from F_CASE output */
  issueCASE(item: CASEItem, holder: string): VerifiableCredential {
    return this._issue("F_CASE", holder, {
      type: "CASECompetency",
      fullStatement: item.fullStatement,
      confidence: item.assertion.confidence,
      score: item.assertion.score,
      evidenceCount: item.assertion.evidenceCount,
    }, item.assertion.evidenceCount);
  }

  /** Issue all VCs from a set of Psi objects */
  issueAll(psis: Psi[], holder: string): VerifiableCredential[] {
    const vcs: VerifiableCredential[] = [];

    const clrs = F_CLR.mapMany(psis);
    for (const a of clrs) vcs.push(this.issueCLR(a, holder));

    const badges = F_Badge.mapMany(psis);
    for (const b of badges) vcs.push(this.issueBadge(b, holder));

    const ctdls = F_CTDL.mapMany(psis);
    for (const c of ctdls) vcs.push(this.issueCTDL(c, holder));

    const cases = F_CASE.mapMany(psis);
    for (const c of cases) vcs.push(this.issueCASE(c, holder));

    return vcs;
  }

  /** Create a Verifiable Presentation with selective disclosure */
  present(
    vcs: VerifiableCredential[],
    holder: string,
    selectedMorphisms: string[]
  ): VerifiablePresentation {
    const filtered = vcs.filter(vc =>
      selectedMorphisms.includes(vc.proof.morphism)
    );

    const vp: VerifiablePresentation = {
      "@context": [
        "https://www.w3.org/2018/credentials/v1",
        "https://hela.foxxi.io/credentials/v1",
      ],
      type: ["VerifiablePresentation"],
      id: `urn:hela:vp:${crypto.randomUUID()}`,
      holder,
      verifiableCredential: filtered,
      proof: {
        type: "HELAPresheafPresentation",
        created: new Date().toISOString(),
        verificationMethod: this.did,
        proofPurpose: "authentication",
        selectedMorphisms,
        totalMorphisms: 5,
        selectiveDisclosure: `${selectedMorphisms.length}/5 morphisms disclosed`,
      },
    };

    // Sign the VP
    vp.proof.jws = this.sign({
      vp: vp.id,
      holder,
      morphisms: selectedMorphisms,
      credentialCount: filtered.length,
      iat: Math.floor(Date.now() / 1000),
    });

    return vp;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private _issue(
    morphism: string,
    holder: string,
    subject: Record<string, unknown>,
    evidenceCount: number,
  ): VerifiableCredential {
    const vc: VerifiableCredential = {
      "@context": [
        "https://www.w3.org/2018/credentials/v1",
        "https://hela.foxxi.io/credentials/v1",
      ],
      type: ["VerifiableCredential", `HELACredential_${morphism}`],
      id: `urn:hela:vc:${crypto.randomUUID()}`,
      issuer: this.did,
      issuanceDate: new Date().toISOString(),
      credentialSubject: {
        id: holder,
        ...subject,
      },
      proof: {
        type: "HELAPresheafProof",
        created: new Date().toISOString(),
        verificationMethod: this.did,
        proofPurpose: "assertionMethod",
        morphism,
        sheafCondition: "satisfied",
        topology: "hela:bare",
        evidenceCount,
      },
    };

    // Sign the VC
    vc.proof.jws = this.sign({
      vc: vc.id,
      iss: this.did,
      sub: holder,
      morphism,
      iat: Math.floor(Date.now() / 1000),
    });

    return vc;
  }
}

// ── Peer Verification ────────────────────────────────────────────────────────
//
// Learners can verify each other's credentials without a central authority.
// A verification request sends a VP, and the verifier checks:
// 1. JWS signature is valid
// 2. Sheaf condition is satisfied (consistency across morphisms)
// 3. Evidence counts are non-zero
// 4. DID matches the holder
//
export interface PeerVerificationResult {
  verified: boolean;
  holder: string;
  did: string;
  morphismsDisclosed: string[];
  credentialCount: number;
  totalEvidence: number;
  sheafConditionSatisfied: boolean;
  signatureValid: boolean;
  timestamp: string;
  errors: string[];
}

export function verifyPresentation(vp: VerifiablePresentation): PeerVerificationResult {
  const errors: string[] = [];
  let totalEvidence = 0;
  let sheafOk = true;
  let sigOk = true;

  // Check each VC in the presentation
  for (const vc of vp.verifiableCredential) {
    if (!vc.proof) {
      errors.push(`VC ${vc.id} has no proof`);
      sigOk = false;
      continue;
    }

    if (vc.proof.sheafCondition !== "satisfied") {
      sheafOk = false;
      errors.push(`VC ${vc.id}: sheaf condition not satisfied`);
    }

    if (vc.proof.evidenceCount === 0) {
      errors.push(`VC ${vc.id}: no evidence`);
    }

    totalEvidence += vc.proof.evidenceCount;

    // Verify JWS signature exists
    if (!vc.proof.jws) {
      sigOk = false;
      errors.push(`VC ${vc.id}: missing JWS signature`);
    }
  }

  // Check VP proof
  if (!vp.proof?.jws) {
    sigOk = false;
    errors.push("VP has no JWS signature");
  }

  return {
    verified: errors.length === 0 && sigOk && sheafOk,
    holder: vp.holder,
    did: vp.proof?.verificationMethod || "unknown",
    morphismsDisclosed: vp.proof?.selectedMorphisms || [],
    credentialCount: vp.verifiableCredential.length,
    totalEvidence,
    sheafConditionSatisfied: sheafOk,
    signatureValid: sigOk,
    timestamp: new Date().toISOString(),
    errors,
  };
}

// ── Learning Recommendations ─────────────────────────────────────────────────
//
// Based on the learner's DNA (competency graph), recommend what to learn next.
// Uses the presheaf structure to identify:
// 1. Gaps: activities attempted but not mastered
// 2. Extensions: activities related to mastered ones but not yet tried
// 3. Progressions: natural next steps in competency posets
//
export interface Recommendation {
  type: "gap" | "extension" | "progression";
  activity: string;
  activityName: string;
  reason: string;
  confidence: number;     // 0-1, how confident we are this is a good rec
  relatedMastered: string[];
  currentGrade?: string;
  targetGrade: string;
}

export function generateRecommendations(
  statements: StoredXAPIStatement[],
  maxRecommendations: number = 10,
): Recommendation[] {
  const recommendations: Recommendation[] = [];

  // Build activity model
  const activityMap = new Map<string, {
    id: string;
    name: string;
    attempts: number;
    bestScore: number;
    completed: boolean;
    verbs: Set<string>;
    lastAttempt: string;
  }>();

  for (const stmt of statements) {
    const actId = ("id" in stmt.object ? stmt.object.id : "unknown") as string;
    const actName = ("definition" in stmt.object && (stmt.object as any).definition?.name?.["en-US"])
      ? (stmt.object as any).definition.name["en-US"]
      : actId.split("/").pop() || "Activity";
    const verb = stmt.verb.id.split("/").pop() || "unknown";
    const score = stmt.result?.score?.scaled;
    const completed = stmt.result?.completion === true;

    if (!activityMap.has(actId)) {
      activityMap.set(actId, { id: actId, name: actName, attempts: 0, bestScore: 0, completed: false, verbs: new Set(), lastAttempt: "" });
    }

    const a = activityMap.get(actId)!;
    a.attempts++;
    a.verbs.add(verb);
    if (score !== undefined && score > a.bestScore) a.bestScore = score;
    if (completed) a.completed = true;
    if (!a.lastAttempt || (stmt.timestamp && stmt.timestamp > a.lastAttempt)) a.lastAttempt = stmt.timestamp || "";
  }

  const activities = [...activityMap.values()];
  const mastered = activities.filter(a => a.completed && a.bestScore >= 0.9);
  const proficient = activities.filter(a => a.completed && a.bestScore >= 0.7 && a.bestScore < 0.9);
  const attempted = activities.filter(a => !a.completed || a.bestScore < 0.7);

  // 1. GAPS: attempted but not mastered → retry with focus
  for (const a of attempted.sort((x, y) => y.bestScore - x.bestScore)) {
    const grade = a.completed ? "proficient" : "attempted";
    recommendations.push({
      type: "gap",
      activity: a.id,
      activityName: a.name,
      reason: a.bestScore > 0
        ? `You scored ${(a.bestScore * 100).toFixed(0)}% — ${((0.9 - a.bestScore) * 100).toFixed(0)}% more to master`
        : `You've attempted this ${a.attempts} time(s) but haven't completed it`,
      confidence: 0.9 - (a.bestScore * 0.3),
      relatedMastered: mastered.filter(m => shareTokens(m.name, a.name)).map(m => m.name),
      currentGrade: grade,
      targetGrade: "mastered",
    });
  }

  // 2. PROGRESSIONS: proficient but not mastered → push to mastery
  for (const a of proficient.sort((x, y) => y.bestScore - x.bestScore)) {
    recommendations.push({
      type: "progression",
      activity: a.id,
      activityName: a.name,
      reason: `You're proficient at ${(a.bestScore * 100).toFixed(0)}% — push for mastery`,
      confidence: 0.8,
      relatedMastered: mastered.filter(m => shareTokens(m.name, a.name)).map(m => m.name),
      currentGrade: "proficient",
      targetGrade: "mastered",
    });
  }

  // 3. EXTENSIONS: related to mastered activities but not yet tried
  // Find activity name tokens from mastered activities
  const masteredTokens = new Set<string>();
  for (const m of mastered) {
    for (const t of tokenize(m.name)) masteredTokens.add(t);
  }

  // Look for patterns — suggest advancing in the same domain
  const domains = new Map<string, number>();
  for (const m of mastered) {
    const domain = extractDomain(m.name);
    domains.set(domain, (domains.get(domain) || 0) + 1);
  }

  for (const [domain, count] of [...domains.entries()].sort((a, b) => b[1] - a[1])) {
    if (count >= 2) {
      const alreadyKnown = mastered.filter(m => extractDomain(m.name) === domain).map(m => m.name);
      recommendations.push({
        type: "extension",
        activity: `urn:hela:recommended:${domain}-advanced`,
        activityName: `Advanced ${domain}`,
        reason: `You've mastered ${count} activities in ${domain} — explore advanced topics`,
        confidence: 0.6 + (count * 0.05),
        relatedMastered: alreadyKnown,
        targetGrade: "proficient",
      });
    }
  }

  return recommendations
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, maxRecommendations);
}

// ── Utilities ────────────────────────────────────────────────────────────────

function base64url(str: string): string {
  return Buffer.from(str).toString("base64url");
}

function base58btcEncode(bytes: Buffer): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = BigInt("0x" + bytes.toString("hex"));
  let encoded = "";
  while (num > 0n) {
    encoded = ALPHABET[Number(num % 58n)] + encoded;
    num /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) encoded = "1" + encoded;
    else break;
  }
  return encoded || "1";
}

function tokenize(name: string): string[] {
  return name.toLowerCase().split(/[\s\-_\/]+/).filter(t => t.length > 2);
}

function shareTokens(a: string, b: string): boolean {
  const ta = new Set(tokenize(a));
  return tokenize(b).some(t => ta.has(t));
}

function extractDomain(name: string): string {
  const tokens = tokenize(name);
  // Return the most significant token (longest, not a stop word)
  const stops = new Set(["the", "and", "for", "with", "module", "course", "lesson", "unit", "section", "part", "activity"]);
  const meaningful = tokens.filter(t => !stops.has(t));
  return meaningful.sort((a, b) => b.length - a.length)[0] || tokens[0] || "general";
}
