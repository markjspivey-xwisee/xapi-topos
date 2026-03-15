// ─────────────────────────────────────────────────────────────────────────────
// @foxxi/hela-store  —  datasim.ts
//
// Yet Analytics DataSim integration
//
// Wraps the DataSim CLI (Clojure JAR) to generate synthetic xAPI statements
// from xAPI profiles + actor personae. Statements can be:
//   1. Generated to memory (returned as JSON array)
//   2. Posted directly to an LRS endpoint (generate-post)
//   3. Ingested into the HELA store
//
// DataSim is the "free functor" from Profile × Personae → Stmt^n:
//   given a profile P and personae A, DataSim produces F_free(P, A) ∈ ℰ
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs";
import { HELAStore } from "./store";
import { XAPIStatement } from "./types";

const execFileAsync = promisify(execFile);

// ── Configuration ────────────────────────────────────────────────────────────

export interface DataSimConfig {
  /** Path to the datasim_cli.jar file */
  jarPath: string;
  /** Path to Java executable */
  javaPath: string;
  /** Default profile path (e.g., cmi5.json) */
  defaultProfilePath?: string;
  /** Default personae path */
  defaultPersonaePath?: string;
  /** Default models path */
  defaultModelsPath?: string;
  /** Default parameters path */
  defaultParametersPath?: string;
}

export interface GenerateOptions {
  /** xAPI profile file path (overrides default) */
  profilePath?: string;
  /** Actor personae file path (overrides default) */
  personaePath?: string;
  /** Models file path (overrides default) */
  modelsPath?: string;
  /** Parameters file path (overrides default) */
  parametersPath?: string;
  /** Combined input file path (alternative to separate files) */
  inputPath?: string;
  /** Random seed override (-1 for random) */
  seed?: number;
  /** Filter by actor IFI (e.g., "mbox::mailto:mark@foxxi.io") */
  actor?: string;
}

export interface GeneratePostOptions extends GenerateOptions {
  /** LRS endpoint URL */
  endpoint: string;
  /** API key for LRS auth */
  apiKey: string;
  /** Secret key for LRS auth */
  secretKey: string;
}

export interface DataSimResult {
  statements: XAPIStatement[];
  count: number;
  seed: number;
  timestamp: string;
}

export interface DataSimPostResult {
  posted: number;
  endpoint: string;
  timestamp: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// DataSim Connector
// ─────────────────────────────────────────────────────────────────────────────

export class DataSimConnector {
  private readonly _config: DataSimConfig;

  constructor(config: DataSimConfig) {
    this._config = config;
  }

  get jarPath(): string { return this._config.jarPath; }
  get javaPath(): string { return this._config.javaPath; }

  // ── Generate statements to memory ──────────────────────────────────────

  async generate(options: GenerateOptions = {}): Promise<DataSimResult> {
    const args = this._buildArgs("generate", options);
    const seed = options.seed ?? 42;

    const { stdout } = await execFileAsync(this._config.javaPath, args, {
      maxBuffer: 50 * 1024 * 1024, // 50MB for large simulations
      timeout: 120_000,            // 2 min timeout
    });

    // DataSim outputs one JSON object per line (NDJSON)
    const statements: XAPIStatement[] = stdout
      .trim()
      .split("\n")
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line));

    return {
      statements,
      count: statements.length,
      seed,
      timestamp: new Date().toISOString(),
    };
  }

  // ── Generate and POST directly to LRS ──────────────────────────────────

  async generatePost(options: GeneratePostOptions): Promise<DataSimPostResult> {
    const args = this._buildArgs("generate-post", options);

    // Add LRS endpoint and Basic Auth credentials
    args.push("-E", options.endpoint);
    args.push("-U", options.apiKey);
    args.push("-P", options.secretKey);
    args.push("--no-async");  // Ensure ordering

    await execFileAsync(this._config.javaPath, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 300_000, // 5 min for POST operations
    });

    return {
      posted: -1, // DataSim doesn't report count in generate-post mode
      endpoint: options.endpoint,
      timestamp: new Date().toISOString(),
    };
  }

  // ── Generate and ingest into HELA store ────────────────────────────────

  async generateAndIngest(store: HELAStore, options: GenerateOptions = {}): Promise<DataSimResult> {
    const result = await this.generate(options);

    for (const stmt of result.statements) {
      store.insert(stmt);
    }

    return result;
  }

  // ── Validate input spec ────────────────────────────────────────────────

  async validateInput(inputPath: string): Promise<{ valid: boolean; errors?: string }> {
    try {
      const { stderr } = await execFileAsync(this._config.javaPath, [
        "-jar", this._config.jarPath,
        "validate-input",
        "-i", inputPath,
      ], {
        maxBuffer: 5 * 1024 * 1024,
        timeout: 30_000,
      });
      return { valid: true };
    } catch (e: any) {
      return { valid: false, errors: e.stderr || e.message };
    }
  }

  // ── Build CLI arguments ────────────────────────────────────────────────

  private _buildArgs(subcommand: string, options: GenerateOptions): string[] {
    const args = ["-jar", this._config.jarPath, subcommand];

    if (options.inputPath) {
      args.push("-i", options.inputPath);
    } else {
      // Use separate file arguments
      const profilePath = options.profilePath ?? this._config.defaultProfilePath;
      const personaePath = options.personaePath ?? this._config.defaultPersonaePath;
      const modelsPath = options.modelsPath ?? this._config.defaultModelsPath;
      const parametersPath = options.parametersPath ?? this._config.defaultParametersPath;

      if (profilePath)    args.push("-p", profilePath);
      if (personaePath)   args.push("-a", personaePath);
      if (modelsPath)     args.push("-m", modelsPath);
      if (parametersPath) args.push("-o", parametersPath);
    }

    if (options.seed !== undefined) {
      args.push("--seed", String(options.seed));
    }

    if (options.actor) {
      args.push("--actor", options.actor);
    }

    return args;
  }

  // ── Static: auto-detect DataSim installation ───────────────────────────

  static autoDetect(basePath: string): DataSimConnector | null {
    const jarCandidates = [
      path.join(basePath, "datasim_cli.jar"),
      path.join(basePath, "datasim", "datasim_cli.jar"),
    ];
    const javaCandidates = [
      path.join(basePath, "lrsql", "runtimes", "windows", "bin", "java.exe"),
      path.join(basePath, "lrsql", "runtimes", "windows", "bin", "java"),
      "java",
    ];

    let jarPath: string | undefined;
    for (const p of jarCandidates) {
      if (fs.existsSync(p)) { jarPath = p; break; }
    }

    let javaPath: string | undefined;
    for (const p of javaCandidates) {
      if (p === "java" || fs.existsSync(p)) { javaPath = p; break; }
    }

    if (!jarPath || !javaPath) return null;

    // Look for default input files
    const inputDir = path.join(path.dirname(jarPath), "input");
    const defaultProfilePath = fs.existsSync(path.join(inputDir, "cmi5.json"))
      ? path.join(inputDir, "cmi5.json") : undefined;
    const defaultPersonaePath = fs.existsSync(path.join(inputDir, "hela-personae.json"))
      ? path.join(inputDir, "hela-personae.json") : undefined;
    const defaultModelsPath = fs.existsSync(path.join(inputDir, "hela-models.json"))
      ? path.join(inputDir, "hela-models.json") : undefined;
    const defaultParametersPath = fs.existsSync(path.join(inputDir, "hela-parameters.json"))
      ? path.join(inputDir, "hela-parameters.json") : undefined;

    return new DataSimConnector({
      jarPath,
      javaPath,
      defaultProfilePath,
      defaultPersonaePath,
      defaultModelsPath,
      defaultParametersPath,
    });
  }
}
