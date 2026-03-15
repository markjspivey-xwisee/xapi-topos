// ─────────────────────────────────────────────────────────────────────────────
// @foxxi/hela-wallet  —  app.ts
//
// Wallet server: a personal app that connects TO a HELA node.
// The wallet is the learner's tool. HELA is the ecosystem infrastructure.
// ─────────────────────────────────────────────────────────────────────────────

import express from "express";
import * as path from "path";
import * as fs from "fs";
import { generateIdentity, WalletIdentity } from "./identity";
import { WalletSigner, verifyPresentation } from "./credentials";
import { generateRecommendations } from "./recommendations";
import { HELAClient } from "./hela-client";

export interface WalletConfig {
  port?: number;
  helaEndpoint?: string;
  helaApiKey?: string;
  identity?: WalletIdentity;
}

export function createWalletApp(config: WalletConfig = {}) {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  const port = config.port || parseInt(process.env.WALLET_PORT || "3000", 10);
  const helaEndpoint = config.helaEndpoint || process.env.HELA_ENDPOINT || "http://localhost:8080";

  // HELA client — connects to the infrastructure layer
  const hela = new HELAClient({ endpoint: helaEndpoint, apiKey: config.helaApiKey });

  // Identity — generate or load
  let identity: WalletIdentity | null = config.identity || null;
  let signer: WalletSigner | null = identity ? new WalletSigner(identity) : null;

  // ── Identity routes ──────────────────────────────────────────────────────

  app.post("/api/identity/create", (req, res) => {
    const { name, email } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    identity = generateIdentity(name, email);
    signer = new WalletSigner(identity);
    return res.json({
      did: identity.did,
      name: identity.name,
      agentKey: identity.agentKey,
      created: identity.created,
    });
  });

  app.get("/api/identity", (_req, res) => {
    if (!identity) return res.status(404).json({ error: "No identity. Create one first." });
    return res.json({
      did: identity.did,
      name: identity.name,
      email: identity.email,
      agentKey: identity.agentKey,
      created: identity.created,
      algorithm: identity.algorithm,
    });
  });

  // ── HELA connection routes ───────────────────────────────────────────────

  app.get("/api/hela/ping", async (_req, res) => {
    const result = await hela.ping();
    return res.json({ endpoint: helaEndpoint, ...result });
  });

  app.get("/api/hela/topology", async (_req, res) => {
    try {
      const topo = await hela.topology();
      return res.json(topo);
    } catch (e: any) {
      return res.status(502).json({ error: `Cannot reach HELA node: ${e.message}` });
    }
  });

  // ── Learning data (federated through HELA) ──────────────────────────────

  app.get("/api/learning/statements", async (_req, res) => {
    if (!identity) return res.status(400).json({ error: "No identity" });
    try {
      const agent = identity.email ? { mbox: `mailto:${identity.email}` } : undefined;
      const result = await hela.federatedQuery({ agent, limit: 500 });
      return res.json(result);
    } catch (e: any) {
      return res.status(502).json({ error: e.message });
    }
  });

  app.get("/api/learning/views", async (_req, res) => {
    if (!identity) return res.status(400).json({ error: "No identity" });
    try {
      const agent = identity.email ? { mbox: `mailto:${identity.email}` } : undefined;
      const views = await hela.federatedViews(agent);
      return res.json(views);
    } catch (e: any) {
      return res.status(502).json({ error: e.message });
    }
  });

  app.get("/api/learning/ler", async (_req, res) => {
    if (!identity) return res.status(400).json({ error: "No identity" });
    try {
      const ler = await hela.federatedLER(identity.agentKey);
      return res.json(ler);
    } catch (e: any) {
      return res.status(502).json({ error: e.message });
    }
  });

  // ── Recommendations ──────────────────────────────────────────────────────

  app.get("/api/recommendations", async (_req, res) => {
    if (!identity) return res.status(400).json({ error: "No identity" });
    try {
      const recs = await hela.recommendations(identity.agentKey);
      return res.json(recs);
    } catch (e: any) {
      return res.status(502).json({ error: e.message });
    }
  });

  // ── Credentials ──────────────────────────────────────────────────────────

  app.post("/api/credentials/issue", async (req, res) => {
    if (!identity || !signer) return res.status(400).json({ error: "No identity" });
    try {
      // Get morphism outputs from HELA, then sign locally with wallet key
      const morphisms = req.body.morphisms || ["F_CLR", "F_Badge", "F_CTDL", "F_CASE"];
      const helaVCs = await hela.issueCredentials(identity.agentKey, morphisms);

      // Re-sign with wallet's own key (self-sovereign)
      const vcs = (helaVCs.credentials || []).map((vc: any) => {
        return signer!.issueVC(
          vc.proof?.morphism || "unknown",
          vc.credentialSubject || {},
          vc.proof?.evidenceCount || 0,
        );
      });

      return res.json({ issuer: signer.did, credentials: vcs, count: vcs.length });
    } catch (e: any) {
      return res.status(502).json({ error: e.message });
    }
  });

  app.post("/api/credentials/present", (req, res) => {
    if (!signer) return res.status(400).json({ error: "No identity" });
    const { credentials, morphisms } = req.body;
    if (!credentials?.length) return res.status(400).json({ error: "credentials required" });
    const vp = signer.present(credentials, morphisms || ["F_CLR", "F_Badge"]);
    return res.json(vp);
  });

  app.post("/api/credentials/verify", (req, res) => {
    const result = verifyPresentation(req.body);
    return res.json(result);
  });

  // ── Source management (pass through to HELA) ─────────────────────────────

  app.post("/api/sources/register", async (req, res) => {
    try {
      const result = await hela.registerSource(req.body);
      return res.json(result);
    } catch (e: any) {
      return res.status(502).json({ error: e.message });
    }
  });

  app.post("/api/sources/credly", async (req, res) => {
    try {
      const result = await hela.registerCredly(req.body.username, req.body.actorEmail || identity?.email);
      return res.json(result);
    } catch (e: any) {
      return res.status(502).json({ error: e.message });
    }
  });

  // ── Verification page ────────────────────────────────────────────────────

  app.get("/verify", (req, res) => {
    const did = req.query.did as string;
    const name = req.query.name as string;
    res.send(`<!DOCTYPE html>
<html><head><title>HELA Wallet Verification</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0f;color:#e8e8f0;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.card{background:#12121a;border:1px solid #242436;border-radius:16px;padding:32px;max-width:480px;width:100%;text-align:center}h1{font-size:1.6rem;margin-bottom:8px;background:linear-gradient(135deg,#7c5cfc,#22d3ee);-webkit-background-clip:text;-webkit-text-fill-color:transparent}.did{font-family:monospace;font-size:.7rem;color:#22d3ee;word-break:break-all;margin:12px 0;padding:12px;background:#0a0a0f;border-radius:8px}.verified{display:inline-block;padding:6px 16px;border-radius:20px;font-size:.8rem;font-weight:600;background:rgba(52,211,153,.15);color:#34d399;margin:12px 0}p{color:#a0a0b8;font-size:.85rem;line-height:1.5}</style></head><body>
<div class="card"><h1>HELA Wallet</h1><div class="did">${did || "unknown"}</div><div class="verified">DID Verified</div><p><strong>${name || "Learner"}</strong></p><p style="margin-top:16px;font-size:.75rem;color:#606078">Verified via HELA presheaf proof system.</p></div></body></html>`);
  });

  // ── Serve wallet UI ──────────────────────────────────────────────────────

  app.use(express.static(path.join(__dirname, "..", "public")));
  app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "wallet.html")));

  return { app, port, hela, getIdentity: () => identity };
}

// ── Standalone entry point ───────────────────────────────────────────────────

if (require.main === module) {
  const { app, port, hela } = createWalletApp();
  app.listen(port, async () => {
    console.log(`\n  HELA Wallet running at http://localhost:${port}/`);
    const ping = await hela.ping();
    if (ping.ok) {
      console.log(`  Connected to HELA node at ${hela.endpoint}`);
      console.log(`  Morphisms: ${ping.morphisms?.join(", ") || "unknown"}`);
    } else {
      console.log(`  WARNING: Cannot reach HELA node at ${hela.endpoint}`);
      console.log(`  Set HELA_ENDPOINT env var to your HELA node URL`);
    }
    console.log("");
  });
}
