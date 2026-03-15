// ─────────────────────────────────────────────────────────────────────────────
// @foxxi/hela-wallet  —  identity.ts
//
// DID:key generation and management for learner sovereignty.
// Private key never leaves the device.
// ─────────────────────────────────────────────────────────────────────────────

import * as crypto from "crypto";

export interface WalletIdentity {
  name: string;
  email?: string;
  did: string;
  publicKey: string;     // hex
  privateKeyPem: string; // PEM (stored locally only)
  algorithm: "ECDSA-P256";
  created: string;
  agentKey: string;      // xAPI agent key for HELA queries
}

export function generateIdentity(name: string, email?: string): WalletIdentity {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });

  const pubDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const pubHex = pubDer.toString("hex");

  // did:key from public key (multicodec P-256 prefix: 0x1200)
  const did = `did:key:z${base58btcEncode(Buffer.concat([Buffer.from([0x12, 0x00]), pubDer]))}`;
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

  return {
    name,
    email,
    did,
    publicKey: pubHex,
    privateKeyPem: privPem,
    algorithm: "ECDSA-P256",
    created: new Date().toISOString(),
    agentKey: email ? `mbox:mailto:${email}` : `openid:${did}`,
  };
}

// ── Base58btc ────────────────────────────────────────────────────────────────

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
