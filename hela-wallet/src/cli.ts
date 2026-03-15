#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// @foxxi/hela-wallet  —  cli.ts
//
// CLI entry point: `hela-wallet` or `npx @foxxi/hela-wallet`
// Spins up a personal wallet that connects to a HELA node.
// ─────────────────────────────────────────────────────────────────────────────

import * as readline from "readline";
import { generateIdentity } from "./identity";
import { createWalletApp } from "./app";

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const PURPLE = "\x1b[35m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") { opts.help = true; }
    else if (arg === "-p" || arg === "--port") { opts.port = args[++i]; }
    else if (arg === "-n" || arg === "--name") { opts.name = args[++i]; }
    else if (arg === "-e" || arg === "--email") { opts.email = args[++i]; }
    else if (arg === "--hela" || arg === "--hela-endpoint") { opts.hela = args[++i]; }
    else if (arg === "--credly") { opts.credly = args[++i]; }
    else if (arg.includes("=")) {
      const [k, v] = arg.split("=", 2);
      opts[k.replace(/^-+/, "")] = v;
    }
  }
  return opts;
}

function showHelp() {
  console.log(`
  ${BOLD}hela-wallet${RESET} — your sovereign learning identity

  ${DIM}USAGE${RESET}
    hela-wallet [options]
    npx @foxxi/hela-wallet [options]

  ${DIM}OPTIONS${RESET}
    -n, --name <name>          Your name
    -e, --email <email>        Your email (for xAPI agent matching)
    -p, --port <number>        Wallet port (default: 3000)
    --hela <url>               HELA node URL (default: http://localhost:8080)
    --credly <username>        Auto-connect Credly profile
    -h, --help                 Show this help

  ${DIM}EXAMPLES${RESET}
    hela-wallet -n "Jane Chen" -e jane@foxxi.io
    hela-wallet --hela http://hela.example.com --credly jane-chen
    hela-wallet -p 4000 -n "Ada Lovelace"

  ${DIM}ENVIRONMENT${RESET}
    HELA_ENDPOINT    HELA node URL
    WALLET_PORT      Wallet port
`);
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

async function main() {
  const opts = parseArgs();
  if (opts.help) { showHelp(); process.exit(0); }

  // Get name
  let name = opts.name as string;
  if (!name) {
    name = await prompt(`${PURPLE}Your name:${RESET} `);
    if (!name) { console.log("Name is required."); process.exit(1); }
  }

  let email = opts.email as string;
  if (!email) {
    email = await prompt(`${PURPLE}Email (for xAPI matching, optional):${RESET} `);
  }

  // Generate identity
  const identity = generateIdentity(name, email || undefined);

  console.log(`
${BOLD}${PURPLE}╔══════════════════════════════════════════════════════════╗
║              HELA Wallet                                 ║
║       Your sovereign learning identity                   ║
╚══════════════════════════════════════════════════════════╝${RESET}

  ${BOLD}Name:${RESET}    ${identity.name}
  ${BOLD}DID:${RESET}     ${CYAN}${identity.did.slice(0, 50)}...${RESET}
  ${BOLD}Agent:${RESET}   ${identity.agentKey}
  ${BOLD}Algo:${RESET}    ${identity.algorithm}
`);

  const port = parseInt(opts.port as string || "3000", 10);
  const helaEndpoint = (opts.hela as string) || process.env.HELA_ENDPOINT || "http://localhost:8080";

  const { app, hela } = createWalletApp({
    port,
    helaEndpoint,
    identity,
  });

  app.listen(port, async () => {
    // Check HELA node
    const ping = await hela.ping();
    if (ping.ok) {
      console.log(`  ${GREEN}HELA node:${RESET}  ${helaEndpoint} ${GREEN}(connected)${RESET}`);
      console.log(`  ${DIM}Morphisms:  ${ping.morphisms?.join(", ") || "?"}${RESET}`);
    } else {
      console.log(`  ${PURPLE}HELA node:${RESET}  ${helaEndpoint} (not reachable)`);
    }

    // Auto-connect Credly if specified
    if (opts.credly) {
      try {
        const result = await hela.registerCredly(opts.credly as string, email);
        console.log(`  ${GREEN}Credly:${RESET}     ${result.badges || 0} badge(s) from ${opts.credly}`);
      } catch (e: any) {
        console.log(`  ${PURPLE}Credly:${RESET}     Could not connect (${e.message})`);
      }
    }

    console.log(`
  ${BOLD}Wallet:${RESET}     ${CYAN}http://localhost:${port}/${RESET}
  ${BOLD}API:${RESET}        ${CYAN}http://localhost:${port}/api/${RESET}
  ${BOLD}Verify:${RESET}     ${CYAN}http://localhost:${port}/verify?did=${encodeURIComponent(identity.did).slice(0, 30)}...${RESET}
`);
  });
}

main().catch(console.error);
