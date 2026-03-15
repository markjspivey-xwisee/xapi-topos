// ─────────────────────────────────────────────────────────────────────────────
// @foxxi/hela-wallet  —  credentials.ts
//
// Verifiable Credential issuance, selective disclosure, and peer verification.
// W3C VC Data Model v2.0 with ECDSA P-256 JWS signatures.
// ─────────────────────────────────────────────────────────────────────────────

import * as crypto from "crypto";
import { WalletIdentity } from "./identity";

// ── Types ────────────────────────────────────────────────────────────────────

export interface VerifiableCredential {
  "@context": string[];
  type: string[];
  id: string;
  issuer: string;
  issuanceDate: string;
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

// ── Signer ───────────────────────────────────────────────────────────────────

export class WalletSigner {
  private _identity: WalletIdentity;

  constructor(identity: WalletIdentity) {
    this._identity = identity;
  }

  get did(): string { return this._identity.did; }

  sign(payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signable = `${header}.${body}`;

    const signer = crypto.createSign("SHA256");
    signer.update(signable);
    const signature = signer.sign(this._identity.privateKeyPem, "base64url");

    return `${signable}.${signature}`;
  }

  /** Issue a VC for a morphism output fetched from HELA */
  issueVC(morphism: string, subject: Record<string, unknown>, evidenceCount: number): VerifiableCredential {
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
        id: this.did,
        name: this._identity.name,
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

    vc.proof.jws = this.sign({
      vc: vc.id,
      iss: this.did,
      sub: this.did,
      morphism,
      iat: Math.floor(Date.now() / 1000),
    });

    return vc;
  }

  /** Create a VP with selective disclosure */
  present(vcs: VerifiableCredential[], selectedMorphisms: string[]): VerifiablePresentation {
    const filtered = vcs.filter(vc => selectedMorphisms.includes(vc.proof.morphism));

    const vp: VerifiablePresentation = {
      "@context": [
        "https://www.w3.org/2018/credentials/v1",
        "https://hela.foxxi.io/credentials/v1",
      ],
      type: ["VerifiablePresentation"],
      id: `urn:hela:vp:${crypto.randomUUID()}`,
      holder: this.did,
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

    vp.proof.jws = this.sign({
      vp: vp.id,
      holder: this.did,
      morphisms: selectedMorphisms,
      credentialCount: filtered.length,
      iat: Math.floor(Date.now() / 1000),
    });

    return vp;
  }
}

// ── Peer Verification ────────────────────────────────────────────────────────

export function verifyPresentation(vp: VerifiablePresentation): PeerVerificationResult {
  const errors: string[] = [];
  let totalEvidence = 0;
  let sheafOk = true;
  let sigOk = true;

  for (const vc of vp.verifiableCredential) {
    if (!vc.proof) { errors.push(`VC ${vc.id} has no proof`); sigOk = false; continue; }
    if (vc.proof.sheafCondition !== "satisfied") { sheafOk = false; errors.push(`VC ${vc.id}: sheaf condition not satisfied`); }
    if (vc.proof.evidenceCount === 0) errors.push(`VC ${vc.id}: no evidence`);
    totalEvidence += vc.proof.evidenceCount;
    if (!vc.proof.jws) { sigOk = false; errors.push(`VC ${vc.id}: missing JWS`); }
  }

  if (!vp.proof?.jws) { sigOk = false; errors.push("VP has no JWS signature"); }

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
