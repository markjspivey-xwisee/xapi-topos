// ─────────────────────────────────────────────────────────────────────────────
// @foxxi/hela-store  —  adapters.ts
//
// Storage adapter interface for persistent backends.
//
// The HELAStore uses an in-memory Map by default.
// This module defines the StoreAdapter interface so the store can be
// backed by any persistent triplestore or key-value store.
//
// Provided adapters:
//   - InMemoryAdapter    (default — what HELAStore uses)
//   - JSONFileAdapter    (dev/test — persist to a JSON file)
//   - ConsoleLogAdapter  (debugging — logs every operation)
//   - ComposeAdapter     (write to multiple stores simultaneously)
//
// Interface for future production adapters:
//   - OxigraphAdapter    (WASM triplestore — browser + Node)
//   - JenaAdapter        (Apache Jena Fuseki — SPARQL endpoint)
//   - StarDogAdapter     (Stardog RDF database)
//
// The adapter mirrors the categorical structure:
//   - put()  = inserting a ψ into ℰ
//   - get()  = retrieving a ψ by its id (the representable functor よ(id))
//   - scan() = iterating all ψ objects (the global sections of the terminal presheaf)
//   - delete() = removing a ψ (we expose this but the store makes it hard to reach —
//                voiding is preferred over deletion)
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import { Psi } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// StoreAdapter interface — implement this for any backend
// ─────────────────────────────────────────────────────────────────────────────
export interface StoreAdapter {
  // Insert or update a ψ object
  put(psi: Psi): void;

  // Retrieve a ψ by id (undefined if not found)
  get(id: string): Promise<Psi | undefined> | Psi | undefined;

  // Scan all ψ objects (optionally filtered by a predicate)
  scan(predicate?: (psi: Psi) => boolean): Promise<Psi[]> | Psi[];

  // Delete a ψ by id (use sparingly — voiding is preferred)
  delete(id: string): void;

  // Count of objects in the store
  size(): Promise<number> | number;

  // Clear the store (test/dev only)
  clear(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// InMemoryAdapter — the default
// ─────────────────────────────────────────────────────────────────────────────
export class InMemoryAdapter implements StoreAdapter {
  private readonly _map = new Map<string, Psi>();

  put(psi: Psi): void {
    this._map.set(psi.id, psi);
  }

  get(id: string): Psi | undefined {
    return this._map.get(id);
  }

  scan(predicate?: (psi: Psi) => boolean): Psi[] {
    const all = [...this._map.values()];
    return predicate ? all.filter(predicate) : all;
  }

  delete(id: string): void {
    this._map.delete(id);
  }

  size(): number {
    return this._map.size;
  }

  clear(): void {
    this._map.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// JSONFileAdapter — dev/test persistence
// Writes the full store to a JSON file on each put().
// Not for production — use a real triplestore.
// ─────────────────────────────────────────────────────────────────────────────
export class JSONFileAdapter implements StoreAdapter {
  private readonly _path: string;
  private readonly _cache: Map<string, Psi>;

  constructor(filePath: string) {
    this._path  = filePath;
    this._cache = new Map();

    // Load existing data
    if (fs.existsSync(filePath)) {
      try {
        const raw  = fs.readFileSync(filePath, "utf-8");
        const data = JSON.parse(raw) as { entries: [string, Psi][] };
        for (const [id, psi] of data.entries) {
          this._cache.set(id, psi);
        }
      } catch {
        // corrupt file — start fresh
      }
    }
  }

  put(psi: Psi): void {
    this._cache.set(psi.id, psi);
    this._flush();
  }

  get(id: string): Psi | undefined {
    return this._cache.get(id);
  }

  scan(predicate?: (psi: Psi) => boolean): Psi[] {
    const all = [...this._cache.values()];
    return predicate ? all.filter(predicate) : all;
  }

  delete(id: string): void {
    this._cache.delete(id);
    this._flush();
  }

  size(): number {
    return this._cache.size;
  }

  clear(): void {
    this._cache.clear();
    this._flush();
  }

  private _flush(): void {
    const data = { entries: [...this._cache.entries()] };
    fs.writeFileSync(this._path, JSON.stringify(data, null, 2), "utf-8");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ConsoleLogAdapter — wraps another adapter and logs all operations
// Useful for debugging and for understanding what the store is doing.
// ─────────────────────────────────────────────────────────────────────────────
export class ConsoleLogAdapter implements StoreAdapter {
  constructor(private readonly _inner: StoreAdapter, private readonly _label = "HELAStore") {}

  put(psi: Psi): void {
    console.log(`[${this._label}] put ψ ${psi.id}  triples=${psi.triples.length}  voided=${psi.metadata.voided}`);
    return this._inner.put(psi);
  }

  get(id: string): Psi | undefined {
    const result = this._inner.get(id) as Psi | undefined;
    console.log(`[${this._label}] get ${id}  →  ${result ? "found" : "not found"}`);
    return result;
  }

  scan(predicate?: (psi: Psi) => boolean): Psi[] {
    const result = this._inner.scan(predicate) as Psi[];
    console.log(`[${this._label}] scan  →  ${result.length} results`);
    return result;
  }

  delete(id: string): void {
    console.log(`[${this._label}] delete ${id}`);
    return this._inner.delete(id);
  }

  size(): number {
    return this._inner.size() as number;
  }

  clear(): void {
    console.log(`[${this._label}] clear`);
    return this._inner.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ComposeAdapter — write to multiple adapters simultaneously
// Reads from the first adapter. Useful for:
//   - write-through caching (InMemory + JSONFile)
//   - mirroring to multiple backends
//   - audit logging (main store + log adapter)
// ─────────────────────────────────────────────────────────────────────────────
export class ComposeAdapter implements StoreAdapter {
  constructor(private readonly _adapters: StoreAdapter[]) {
    if (_adapters.length === 0) throw new Error("ComposeAdapter requires at least one adapter");
  }

  put(psi: Psi): void {
    for (const a of this._adapters) { a.put(psi); }
  }

  get(id: string): Psi | undefined {
    return this._adapters[0].get(id) as Psi | undefined;
  }

  scan(predicate?: (psi: Psi) => boolean): Psi[] {
    return this._adapters[0].scan(predicate) as Psi[];
  }

  delete(id: string): void {
    for (const a of this._adapters) { a.delete(id); }
  }

  size(): number {
    return this._adapters[0].size() as number;
  }

  clear(): void {
    for (const a of this._adapters) { a.clear(); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Interface stubs for production adapters (not yet implemented)
//
// These document what a production adapter would look like.
// Each one maps the HELA store operations to the appropriate backend API.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// OxigraphAdapter — WASM triplestore with real SPARQL support
//
// Each ψ is stored as quads in a named graph <urn:hela:psi:{id}>.
// Metadata is stored as a JSON literal triple in the default graph.
// Exposes sparqlQuery() for raw SPARQL queries against the entire store.
// ─────────────────────────────────────────────────────────────────────────────
import * as oxigraph from "oxigraph";

export class OxigraphAdapter implements StoreAdapter {
  private readonly _ox: oxigraph.Store;
  // Fast lookup cache: id → Psi (avoids SPARQL for simple gets)
  private readonly _cache = new Map<string, Psi>();

  constructor() {
    this._ox = new oxigraph.Store();
  }

  put(psi: Psi): void {
    const graphName = oxigraph.namedNode(`urn:hela:psi:${psi.id}`);

    // Remove existing quads for this graph
    const existing = this._ox.match(null, null, null, graphName);
    for (const q of existing) { this._ox.delete(q); }

    // Remove existing metadata triple
    const metaSubj = oxigraph.namedNode(`urn:hela:psi:${psi.id}`);
    const metaPred = oxigraph.namedNode("urn:hela:metadata");
    const existingMeta = this._ox.match(metaSubj, metaPred, null, oxigraph.defaultGraph());
    for (const q of existingMeta) { this._ox.delete(q); }

    // Insert triples as quads in the named graph
    for (const triple of psi.triples) {
      try {
        const s = this._toOxTerm(triple.subject) as oxigraph.NamedNode | oxigraph.BlankNode;
        const p = oxigraph.namedNode(triple.predicate as string);
        const o = this._toOxTerm(triple.object);
        this._ox.add(oxigraph.quad(s as any, p, o as any, graphName));
      } catch {
        // Skip triples that Oxigraph can't represent (e.g. malformed IRIs)
      }
    }

    // Store metadata as JSON literal in default graph
    const metaJson = JSON.stringify(psi.metadata);
    this._ox.add(oxigraph.quad(
      metaSubj, metaPred,
      oxigraph.literal(metaJson),
      oxigraph.defaultGraph(),
    ));

    this._cache.set(psi.id, psi);
  }

  get(id: string): Psi | undefined {
    return this._cache.get(id);
  }

  scan(predicate?: (psi: Psi) => boolean): Psi[] {
    const all = [...this._cache.values()];
    return predicate ? all.filter(predicate) : all;
  }

  delete(id: string): void {
    const graphName = oxigraph.namedNode(`urn:hela:psi:${id}`);
    const existing = this._ox.match(null, null, null, graphName);
    for (const q of existing) { this._ox.delete(q); }

    const metaSubj = oxigraph.namedNode(`urn:hela:psi:${id}`);
    const metaPred = oxigraph.namedNode("urn:hela:metadata");
    const existingMeta = this._ox.match(metaSubj, metaPred, null, oxigraph.defaultGraph());
    for (const q of existingMeta) { this._ox.delete(q); }

    this._cache.delete(id);
  }

  size(): number {
    return this._cache.size;
  }

  clear(): void {
    // Clear all quads
    const all = this._ox.match(null, null, null, null);
    for (const q of all) { this._ox.delete(q); }
    this._cache.clear();
  }

  // ── SPARQL query — the main value-add over InMemoryAdapter ───────────────
  sparqlQuery(sparql: string): unknown[] {
    const results: unknown[] = [];
    const queryResult = this._ox.query(sparql);
    if (Symbol.iterator in Object(queryResult)) {
      for (const binding of queryResult as Iterable<any>) {
        if (binding instanceof Map || (binding && typeof binding.get === "function")) {
          // SELECT result — binding is a Map
          const row: Record<string, string> = {};
          for (const [key, val] of binding as Map<string, any>) {
            row[key] = val.value;
          }
          results.push(row);
        } else if (binding && "subject" in binding) {
          // CONSTRUCT result — binding is a Quad
          results.push({
            subject:   binding.subject.value,
            predicate: binding.predicate.value,
            object:    binding.object.value,
          });
        }
      }
    }
    return results;
  }

  // ── Raw Oxigraph store access ────────────────────────────────────────────
  get oxStore(): oxigraph.Store { return this._ox; }

  private _toOxTerm(term: string): oxigraph.NamedNode | oxigraph.BlankNode | oxigraph.Literal {
    if (typeof term === "string") {
      if (term.startsWith("_:")) {
        return oxigraph.blankNode(term.slice(2));
      }
      if (term.startsWith('"')) {
        // Parse HELA literal format: "value"^^type or "value"@lang
        const langMatch = term.match(/^"(.+)"@(.+)$/);
        if (langMatch) {
          return oxigraph.literal(langMatch[1], { language: langMatch[2] });
        }
        const typeMatch = term.match(/^"(.+)"\^\^(.+)$/);
        if (typeMatch) {
          return oxigraph.literal(typeMatch[1], { datatype: oxigraph.namedNode(typeMatch[2]) } as any);
        }
        // Plain string literal
        const plain = term.replace(/^"|"$/g, "");
        return oxigraph.literal(plain);
      }
      return oxigraph.namedNode(term);
    }
    return oxigraph.namedNode(String(term));
  }
}

/**
 * JenaFusekiAdapter — Apache Jena Fuseki SPARQL endpoint.
 * Production-grade RDF store with full SPARQL 1.1 support.
 *
 * Uses named graphs: each ψ is a named graph <urn:hela:psi:{id}>
 * Metadata stored as triples in <urn:hela:meta:{id}>
 */
export const JenaAdapterStub = {
  description: "Apache Jena Fuseki adapter (not yet implemented)",
  backend:     "https://jena.apache.org/documentation/fuseki2/",
  endpoint:    "http://localhost:3030/hela/",
  putPattern:  "PUT /hela/data?graph=urn:hela:psi:{id}  (Turtle body)",
  getPattern:  "GET /hela/data?graph=urn:hela:psi:{id}",
  queryPattern:"POST /hela/sparql  (SPARQL query body)",
};
