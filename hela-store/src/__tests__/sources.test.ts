import { describe, it, expect, beforeEach } from "vitest";
import { SourceRegistry, xAPISource } from "../sources";
import { HELAStore } from "../store";
import { InMemoryAdapter } from "../adapters";
import { IRI, XAPIStatement } from "../types";

// ── SourceRegistry ───────────────────────────────────────────────────────────

describe("SourceRegistry", () => {
  let registry: SourceRegistry;

  beforeEach(() => {
    registry = new SourceRegistry();
  });

  it("starts empty", () => {
    expect(registry.size).toBe(0);
    expect(registry.sources).toEqual([]);
  });

  it("registers a source", () => {
    const source = new xAPISource({
      id: "test-lrs",
      label: "Test LRS",
      endpoint: "http://localhost:9999/xapi",
      auth: { type: "basic", username: "key", password: "secret" },
    });
    registry.register(source);
    expect(registry.size).toBe(1);
    expect(registry.get("test-lrs")).toBeDefined();
  });

  it("unregisters a source", () => {
    const source = new xAPISource({
      id: "test-lrs",
      label: "Test LRS",
      endpoint: "http://localhost:9999/xapi",
      auth: { type: "basic", username: "key", password: "secret" },
    });
    registry.register(source);
    expect(registry.unregister("test-lrs")).toBe(true);
    expect(registry.size).toBe(0);
  });

  it("returns topology metadata", () => {
    const source = new xAPISource({
      id: "lrs-1",
      label: "LRS One",
      endpoint: "http://localhost:9999/xapi",
      auth: { type: "bearer", token: "tok123" },
    });
    registry.register(source);
    const topo = registry.topology();
    expect(topo.length).toBe(1);
    expect(topo[0].id).toBe("lrs-1");
    expect(topo[0].type).toBe("xapi-lrs");
    expect(topo[0].endpoint).toBe("http://localhost:9999/xapi");
  });

  it("federated query returns empty when no sources", async () => {
    const result = await registry.query({});
    expect(result.psis).toEqual([]);
    expect(result.statements).toEqual([]);
    expect(result.sourcesQueried).toBe(0);
  });
});

// ── xAPISource ───────────────────────────────────────────────────────────────

describe("xAPISource", () => {
  it("has correct capabilities", () => {
    const source = new xAPISource({
      id: "test",
      label: "Test",
      endpoint: "http://localhost:9999/xapi",
      auth: { type: "basic", username: "k", password: "s" },
    });
    const caps = source.capabilities();
    expect(caps.protocols).toContain("xapi");
    expect(caps.queryByActor).toBe(true);
    expect(caps.writable).toBe(true);
  });

  it("reports disconnected when endpoint unreachable", async () => {
    const source = new xAPISource({
      id: "bad",
      label: "Bad LRS",
      endpoint: "http://localhost:1/xapi",
      auth: { type: "basic", username: "k", password: "s" },
    });
    const result = await source.testConnection();
    expect(result.ok).toBe(false);
    expect(source.metadata.status).toBe("disconnected");
  });

  it("returns error in query when endpoint unreachable", async () => {
    const source = new xAPISource({
      id: "bad",
      label: "Bad LRS",
      endpoint: "http://localhost:1/xapi",
      auth: { type: "basic", username: "k", password: "s" },
    });
    const result = await source.query({});
    expect(result.error).toBeDefined();
    expect(result.statements).toEqual([]);
    expect(result.psis).toEqual([]);
  });
});

// ── HELAStore federated layer ────────────────────────────────────────────────

describe("HELAStore federated layer", () => {
  let store: HELAStore;

  beforeEach(() => {
    store = new HELAStore(new InMemoryAdapter());
  });

  it("has an empty source registry by default", () => {
    expect(store.sources.size).toBe(0);
  });

  it("registers and unregisters sources", () => {
    const source = new xAPISource({
      id: "s1",
      label: "S1",
      endpoint: "http://localhost:9999/xapi",
      auth: { type: "basic", username: "k", password: "s" },
    });
    store.registerSource(source);
    expect(store.sources.size).toBe(1);
    store.unregisterSource("s1");
    expect(store.sources.size).toBe(0);
  });

  it("federated query works with no sources (returns empty)", async () => {
    const result = await store.federatedQuery({});
    expect(result.sourcesQueried).toBe(0);
    expect(result.statements).toEqual([]);
  });

  it("federated global sections includes local cache", async () => {
    // Insert local data
    store.insert({
      actor: { mbox: "mailto:test@foxxi.io" },
      verb: { id: IRI("http://adlnet.gov/expapi/verbs/completed") },
      object: { objectType: "Activity", id: IRI("https://example.com/course") },
      result: { completion: true, score: { scaled: 0.9 } },
    });

    const sections = await store.federatedGlobalSections("mbox:mailto:test@foxxi.io");
    expect(sections.psis.length).toBe(1);
    expect(sections.statements.length).toBe(1);
    expect(sections.completions.length).toBe(1);
  });

  it("federated health check works with no sources", async () => {
    const health = await store.federatedHealthCheck();
    expect(health).toEqual([]);
  });
});
