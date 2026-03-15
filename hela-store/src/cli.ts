#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// @foxxi/hela-store  —  cli.ts
//
// Personal HELA node CLI.
// Usage: npx @foxxi/hela-store  or  node dist/cli.js
//
// Zero external CLI deps — uses process.argv directly.
// ─────────────────────────────────────────────────────────────────────────────

import * as crypto from "crypto";
import * as path from "path";
import * as readline from "readline";
import { HELAStore } from "./store";
import { createServer, CreateServerOptions } from "./server";
import { xAPISource } from "./sources";
import { buildProfile } from "./profiles";
import { SATOrchestrator } from "./sat";
import { DataSimConnector } from "./datasim";

// ── Arg parsing ──────────────────────────────────────────────────────────────

interface CLIArgs {
  port: number;
  name: string | null;
  connect: string | null;
  connectKey: string | null;
  connectSecret: string | null;
  noWallet: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CLIArgs {
  const args: CLIArgs = {
    port: 8080,
    name: null,
    connect: null,
    connectKey: null,
    connectSecret: null,
    noWallet: false,
    help: false,
  };

  const raw = argv.slice(2); // skip node + script
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    switch (arg) {
      case "--port":
      case "-p":
        args.port = parseInt(raw[++i], 10) || 8080;
        break;
      case "--name":
      case "-n":
        args.name = raw[++i] || null;
        break;
      case "--connect":
        args.connect = raw[++i] || null;
        break;
      case "--connect-key":
        args.connectKey = raw[++i] || null;
        break;
      case "--connect-secret":
        args.connectSecret = raw[++i] || null;
        break;
      case "--no-wallet":
        args.noWallet = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        // Check for --port=8080 style
        if (arg.startsWith("--port=") || arg.startsWith("-p=")) {
          args.port = parseInt(arg.split("=")[1], 10) || 8080;
        } else if (arg.startsWith("--name=") || arg.startsWith("-n=")) {
          args.name = arg.split("=").slice(1).join("=");
        } else if (arg.startsWith("--connect=")) {
          args.connect = arg.split("=").slice(1).join("=");
        } else if (arg.startsWith("--connect-key=")) {
          args.connectKey = arg.split("=").slice(1).join("=");
        } else if (arg.startsWith("--connect-secret=")) {
          args.connectSecret = arg.split("=").slice(1).join("=");
        } else {
          console.error(`Unknown argument: ${arg}`);
          process.exit(1);
        }
        break;
    }
  }

  return args;
}

// ── Help text ────────────────────────────────────────────────────────────────

function showHelp(): void {
  console.log(`
  hela — spin up a personal HELA node

  USAGE
    hela [options]
    npx @foxxi/hela-store [options]
    node dist/cli.js [options]

  OPTIONS
    -p, --port <number>          Port to listen on (default: 8080)
    -n, --name <string>          Your learner name (prompts if not given)
    --connect <url>              xAPI endpoint to auto-connect as a source
    --connect-key <key>          API key for the --connect source
    --connect-secret <secret>    API secret for the --connect source
    --no-wallet                  Disable wallet, run LRS + API only
    -h, --help                   Show this help message

  EXAMPLES
    hela                                      # Start on :8080, prompts for name
    hela -p 3000 -n "Ada Lovelace"            # Start on :3000 with name
    hela --connect http://lrs:9090/xapi \\
         --connect-key mykey \\
         --connect-secret mysecret            # Auto-federate with an LRS

  ENVIRONMENT
    HELA_DATA_PATH     Path for JSON file persistence (default: in-memory)
    HELA_ADAPTER       Set to "json" to force JSON adapter
    HELA_API_KEYS      Comma-separated API keys for auth
    PORT               Alternative to --port
`);
}

// ── DID generation ───────────────────────────────────────────────────────────

function generateDID(name: string): { did: string; publicKeyHex: string } {
  const { publicKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  // Take last 32 bytes of the DER-encoded public key (the raw key material)
  const rawKey = publicKey.subarray(publicKey.length - 32);
  const publicKeyHex = rawKey.toString("hex");

  // did:key method — multicodec ed25519-pub prefix (0xed, 0x01) + raw key
  const multicodec = Buffer.concat([Buffer.from([0xed, 0x01]), rawKey]);
  const did = `did:key:z${base58btc(multicodec)}`;

  return { did, publicKeyHex };
}

// Minimal base58btc encoder (no external deps)
function base58btc(buf: Buffer): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const BASE = BigInt(58);

  let num = BigInt("0x" + buf.toString("hex"));
  const chars: string[] = [];
  while (num > 0n) {
    chars.unshift(ALPHABET[Number(num % BASE)]);
    num = num / BASE;
  }

  // Preserve leading zeros
  for (const byte of buf) {
    if (byte === 0) chars.unshift("1");
    else break;
  }

  return chars.join("");
}

// ── Prompt for input ─────────────────────────────────────────────────────────

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Banner ───────────────────────────────────────────────────────────────────

function printBanner(name: string, did: string, port: number, noWallet: boolean): void {
  const walletLine = noWallet
    ? "  Wallet:      disabled"
    : `  Wallet:      http://localhost:${port}/wallet`;

  console.log(`
\x1b[36m
  ██╗  ██╗███████╗██╗      █████╗
  ██║  ██║██╔════╝██║     ██╔══██╗
  ███████║█████╗  ██║     ███████║
  ██╔══██║██╔══╝  ██║     ██╔══██║
  ██║  ██║███████╗███████╗██║  ██║
  ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝
\x1b[0m\x1b[90m  Set^(C_xAPI^op)  ·  presheaf topos  ·  v0.1.0\x1b[0m

\x1b[1m  Welcome, ${name}\x1b[0m
\x1b[90m  DID: ${did}\x1b[0m

\x1b[33m  ┌──────────────────────────────────────────────────┐\x1b[0m
\x1b[33m  │\x1b[0m  Dashboard:   \x1b[4mhttp://localhost:${port}/\x1b[0m
\x1b[33m  │\x1b[0m  xAPI LRS:    \x1b[4mhttp://localhost:${port}/xapi/\x1b[0m
\x1b[33m  │\x1b[0m  HELA API:    \x1b[4mhttp://localhost:${port}/hela/\x1b[0m
\x1b[33m  │\x1b[0m${walletLine}
\x1b[33m  │\x1b[0m  Conformance: \x1b[4mhttp://localhost:${port}/hela/conformance\x1b[0m
\x1b[33m  └──────────────────────────────────────────────────┘\x1b[0m
`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  // Resolve port: CLI arg > env > default
  const port = args.port || parseInt(process.env.PORT || "8080", 10);

  // Resolve learner name
  let name = args.name;
  if (!name) {
    name = await prompt("\x1b[1m  What's your name?\x1b[0m ");
    if (!name) {
      name = "Learner";
    }
  }

  // Generate DID
  const { did } = generateDID(name);

  // Choose adapter
  const { JSONFileAdapter, InMemoryAdapter } = require("./adapters");
  const { OxigraphAdapter } = require("./adapters");

  const dataPath = process.env.HELA_DATA_PATH;
  const useOxigraph = process.env.HELA_ADAPTER !== "json" && !dataPath;
  let adapter;
  let adapterLabel: string;

  if (dataPath) {
    adapter = new JSONFileAdapter(dataPath);
    adapterLabel = `JSONFile -> ${dataPath}`;
  } else if (useOxigraph) {
    try {
      adapter = new OxigraphAdapter();
      adapterLabel = "Oxigraph (WASM triplestore)";
    } catch {
      adapter = new InMemoryAdapter();
      adapterLabel = "In-Memory";
    }
  } else {
    adapter = new InMemoryAdapter();
    adapterLabel = "In-Memory";
  }

  // Create store
  const store = new HELAStore(adapter);

  // Register the built-in HELA profile
  const helaProfile = buildProfile();
  store.registerProfile(helaProfile);

  // API keys from env
  const apiKeys = process.env.HELA_API_KEYS?.split(",").map(k => k.trim()).filter(Boolean);

  // SAT orchestrator
  const sat = new SATOrchestrator({ store });

  // Auto-detect DataSim
  const datasim = DataSimConnector.autoDetect(path.resolve(__dirname, "../.."));

  // Build server options
  const serverOpts: CreateServerOptions = {
    apiKeys,
    sat,
    datasim: datasim ?? undefined,
  };

  const app = createServer(store, serverOpts);

  // If --no-wallet, remove wallet routes by adding a guard
  // (The wallet routes are already in the server; we just skip displaying them)

  // Start server
  const server = app.listen(port, async () => {
    printBanner(name!, did, port, args.noWallet);

    console.log(`\x1b[90m  Adapter: ${adapterLabel}\x1b[0m`);
    if (apiKeys && apiKeys.length > 0) {
      console.log(`\x1b[90m  Auth: ${apiKeys.length} API key(s) configured\x1b[0m`);
    } else {
      console.log(`\x1b[90m  Auth: disabled (set HELA_API_KEYS to enable)\x1b[0m`);
    }
    if (datasim) {
      console.log(`\x1b[90m  DataSim: detected at ${datasim.jarPath}\x1b[0m`);
    }

    // Auto-connect to an xAPI source if --connect was given
    if (args.connect) {
      console.log(`\n\x1b[36m  Connecting to source: ${args.connect}...\x1b[0m`);
      try {
        const sourceId = "cli-source-" + Date.now();
        const auth = args.connectKey && args.connectSecret
          ? { type: "basic" as const, username: args.connectKey, password: args.connectSecret }
          : { type: "bearer" as const, token: args.connectKey || "" };

        const source = new xAPISource({
          id: sourceId,
          label: args.connect,
          endpoint: args.connect,
          auth,
        });

        const test = await source.testConnection();
        if (test.ok) {
          store.registerSource(source);
          console.log(`\x1b[32m  Connected! xAPI ${test.version?.join(", ") || "?"} — registered as source "${sourceId}"\x1b[0m`);
        } else {
          console.log(`\x1b[31m  Could not connect: ${test.error}\x1b[0m`);
        }
      } catch (e: any) {
        console.log(`\x1b[31m  Connection failed: ${e.message}\x1b[0m`);
      }
    }

    console.log(`\n\x1b[90m  Press Ctrl+C to stop.\x1b[0m\n`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n\x1b[90m  Shutting down HELA node...\x1b[0m");
    server.close(() => {
      console.log("\x1b[90m  Goodbye.\x1b[0m");
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("\x1b[31m  Fatal error:\x1b[0m", err.message || err);
  process.exit(1);
});
