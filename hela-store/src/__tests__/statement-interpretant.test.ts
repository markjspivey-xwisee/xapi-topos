import { describe, expect, it, vi } from 'vitest';
// The pure RDF producer uses no persistence backend; avoid loading a WASM store
// solely to exercise this boundary. The producer and its xAPI readback are real.
vi.mock('../adapters', () => ({ InMemoryAdapter: class {} }));
import { realize, F_xAPI } from '../store';
import { IRI, type StoredXAPIStatement } from '../types';

describe('HELA statement identity at the I2IDL-X boundary', () => {
  it('identifies the actual event record with the Foxxi Statement class without broad ADL equivalence', () => {
    const statement: StoredXAPIStatement = {
      id: '2f009091-2825-46fd-90af-1c6f72dc182f',
      actor: { mbox: 'mailto:learner@example.org' },
      verb: { id: IRI('http://adlnet.gov/expapi/verbs/experienced') },
      object: { objectType: 'Activity', id: IRI('https://example.org/course') },
      timestamp: '2026-11-04T04:00:00.000Z', stored: '2026-11-04T04:00:01.000Z',
      version: '2.0.0',
    };
    const before = JSON.stringify(statement);
    const psi = realize(statement, 'default');
    const root = `https://hela.foxxi.io/statements/${statement.id}`;
    const rootTypes = psi.triples.filter(t => t.subject === root && t.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type').map(t => t.object);
    // I2IDL-X's current executable bridge is for this class. ADL's Statement also
    // includes part classes, so globally equating the two would classify parts as events.
    expect(rootTypes).toContain('https://foxxi-bridge.interego.xwisee.com/ns/xapi#Statement');
    expect(rootTypes).toContain('https://w3id.org/xapi/ontology#Statement');
    expect(psi.triples.some(t => t.predicate === 'http://www.w3.org/2002/07/owl#equivalentClass')).toBe(false);
    expect(psi.metadata.sourceStmt).toBe(statement);
    expect(JSON.stringify(statement)).toBe(before);
    expect(F_xAPI.map(psi)).toEqual(statement);
    // Property projections retain their existing vocabulary; this is a scoped
    // event-type correction, not a claim of complete Foxxi JSON-LD conformance.
    expect(psi.triples.some(t => t.predicate === 'https://w3id.org/xapi/ontology#verb')).toBe(true);
  });
});
