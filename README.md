# HELA

**Bitcoin gave you sovereignty over your money. HELA gives you sovereignty over your learning identity.**

HELA is a zero-copy, federated, virtual semantic layer over the [TLA](https://adlnet.gov/projects/tla/) (Total Learning Architecture) and [IEEE LER](https://sagroups.ieee.org/1484-2/) (Learning and Employment Record) ecosystem. It uses topos theory to provide a single mathematical lens over every learning data source you connect -- without copying, transforming, or warehousing your data.

One write. Five views. Zero drift. No ETL.

```
npm install @foxxi/hela-store
```

---

## What it does

You have learning data scattered across LRS instances, badge platforms, credential registries, and competency frameworks. Normally you'd build ETL pipelines to sync them, and they'd be stale by tomorrow.

HELA doesn't sync. It doesn't copy. It sits above your sources as a virtual layer and computes views on demand through five geometric morphisms:

| Morphism | What it produces | Standard |
|----------|-----------------|----------|
| `F_xAPI` | xAPI statements | IEEE P9274.1.1 |
| `F_CLR` | CLR assertions | IMS CLR 2.0 |
| `F_Badge` | Open Badge assertions | OBv3 |
| `F_CTDL` | CTDL credentials | Credential Engine |
| `F_CASE` | CASE competency items | IMS CASE |

All five read from the same internal presheaf object. If you void a statement, every view updates instantly -- not because of a webhook, but because functors preserve colimits.

---

## Architecture

```
                    ┌──────────────────────────────────────────────┐
                    │          HELA Presheaf Store (ℰ)             │
                    │        ψ objects = triples + metadata        │
                    └──────┬───┬───┬───┬───┬───────────────────────┘
                           │   │   │   │   │
              ┌────────────┘   │   │   │   └────────────┐
              ▼                ▼   ▼   ▼                ▼
           F_xAPI          F_CLR F_Badge F_CTDL       F_CASE
           (LRS)           (CLR) (OBv3) (CTDL)       (CASE)
              │
              ▼
     xAPI REST (P9274.7.1)
     + HELA extension API

  ╔═══════════════════════════════════════════════════════════════╗
  ║                  Federated Source Layer                       ║
  ║   ┌─────────┐  ┌──────────┐  ┌────────────┐  ┌───────────┐  ║
  ║   │ xAPI LRS│  │SCORM     │  │ Badge      │  │ Credential│  ║
  ║   │ (lrsql) │  │Cloud     │  │ Platform   │  │ Registry  │  ║
  ║   └─────────┘  └──────────┘  └────────────┘  └───────────┘  ║
  ║          zero-copy queries -- data stays at the source       ║
  ╚═══════════════════════════════════════════════════════════════╝
```

Data lives where it lives. HELA queries it, transforms it through geometric morphisms, and gives you a unified view. The `SourceRegistry` tracks what's connected. The `FederatedSite` models the whole TLA topology as a Grothendieck site with descent conditions.

---

## Quick start

```bash
git clone https://github.com/foxxi-io/hela.git
cd hela/hela-store
npm install
npm run build
node dist/server.js
```

The server starts on `http://localhost:8080`. You get:

- **Dashboard** at `/` -- visual overview of the store
- **HELA Wallet** at `/wallet` -- personal identity + credential management
- **xAPI LRS** at `/xapi/` -- full P9274.7.1 conformant endpoint
- **HELA API** at `/hela/` -- presheaf queries, federation, morphisms

### Seed some data and explore

```bash
# Seed demo statements
curl -X POST http://localhost:8080/hela/seed

# See all five morphism outputs for a single presheaf object
curl http://localhost:8080/hela/views/<psi-id>

# Produce a Learning & Employment Record (zero ETL)
curl http://localhost:8080/hela/ler/mbox%3Amailto%3Amark%40foxxi.io

# Mastery classification -- returns a proof object, not a boolean
curl "http://localhost:8080/hela/classify?actor=mbox:mailto:mark@foxxi.io&activity=https://ctdlasn.org/hela/competencies/category-theory"

# Run the full conformance suite
curl http://localhost:8080/hela/conformance
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Server port |
| `HELA_API_KEYS` | _(none)_ | Comma-separated API keys for auth |
| `HELA_ADAPTER` | `oxigraph` | Storage backend: `oxigraph` or `json` |
| `HELA_DATA_PATH` | _(none)_ | File path for JSON persistence |

---

## HELA Wallet

The Wallet is a browser-based personal identity layer built into every HELA node.

- **DID:key generation** -- Ed25519/P-256 keypairs, generated client-side
- **Verifiable Credentials** -- issue self-attested credentials backed by presheaf proofs
- **Learning DNA** -- radar chart visualization of your competency profile across domains
- **Selective disclosure** -- choose which credentials to share per verifier
- **QR proof sharing** -- generate QR codes that link to `/wallet/verify?did=...` for instant verification

No central authority. No login server. Your DID lives in your browser. Credentials are verified against the presheaf evidence sieve, not a database lookup.

Access it at `http://localhost:8080/wallet` after starting the server.

---

## API reference

### xAPI endpoints (P9274.7.1)

| Method | Path | Description |
|--------|------|-------------|
| `PUT` | `/xapi/statements` | Store a single statement |
| `POST` | `/xapi/statements` | Store statement(s) |
| `GET` | `/xapi/statements` | Query statements |
| `GET` | `/xapi/statements?statementId=...` | Get by ID |
| `GET` | `/xapi/about` | LRS metadata |
| `GET` | `/xapi/agents` | Agent lookup |

### HELA extensions

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/hela/psi/:id` | Raw presheaf object (triples + metadata) |
| `GET` | `/hela/views/:id` | All 5 morphism outputs for one object |
| `GET` | `/hela/classify` | Mastery classification (returns proof in Omega) |
| `GET` | `/hela/ler/:actor` | Produce LER via global sections |
| `POST` | `/hela/profiles/:id/validate/:psiId` | Sheafify under a profile topology |
| `GET` | `/hela/conformance` | Run full conformance suite |
| `POST` | `/hela/query` | Query DSL (AND=pullback, OR=pushout, NOT=complement) |
| `GET` | `/hela/progression/:actor` | Learning functor progression report |
| `POST` | `/hela/sparql` | SPARQL queries (requires Oxigraph) |

### Federation (zero-copy)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/hela/sources/register` | Register an external xAPI source |
| `DELETE` | `/hela/sources/:id` | Remove a source |
| `GET` | `/hela/sources/topology` | View the federation topology |
| `GET` | `/hela/sources/health` | Health check all sources |
| `GET` | `/hela/federated/statements` | Fan-out query across all sources |
| `GET` | `/hela/federated/views` | Federated morphism outputs |
| `GET` | `/hela/federated/ler/:actor` | Federated LER across all sources |

### Integrations

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/hela/lrsql/connect` | Connect to Yet Analytics SQL LRS |
| `POST` | `/hela/lrsql/sync` | Bidirectional sync with SQL LRS |
| `POST` | `/hela/scormcloud/connect` | Connect to SCORM Cloud |
| `POST` | `/hela/datasim/generate` | Generate synthetic data via DataSim |
| `GET` | `/hela/sat/status` | SAT orchestrator health |

---

## The math (brief version)

HELA is a **presheaf topos**:

```
ℰ = Set^(C_xAPI^op)
```

Every learning event is stored as a presheaf object `ψ` -- a bundle of RDF triples with metadata. The five geometric morphisms (`F_xAPI`, `F_CLR`, `F_Badge`, `F_CTDL`, `F_CASE`) are functors from this topos to their respective standard formats.

**Why this matters in practice:**

- **Sheaf condition** -- An xAPI Profile defines a Grothendieck topology `J`. A statement conforms to a profile iff it is a sheaf under `J`. Conformance checking = sheafification: `a_J(ψ) = ψ` means it's already conformant.

- **Subobject classifier** -- Mastery isn't a boolean. `classify()` returns a structured proof object in the subobject classifier `Omega`, including the evidence sieve, truth grade, and the classifying morphism `chi_P`. You get the *proof*, not just the answer.

- **Descent** -- TLA federation is modeled as descent on the site. Two LRS nodes agree on a statement iff the cocycle condition is satisfied. Conflicts are resolved via categorical pushout (preserving information from both legs).

- **Learning functor** -- `L : C_xAPI -> C_Mastery` maps evidence to competency grades. The natural transformation `eta : Id => L` is evidence accumulation. Temporal closure `j : Omega -> Omega` is a Lawvere-Tierney topology satisfying `j . j = j`.

---

## Conformance: 47/47

20 theorems proven by mathematical structure. 27 runtime tests. Zero failures.

```bash
npm test
```

Theorems are properties that hold *by construction* -- they don't need runtime checks because the type system and categorical structure make violations impossible. Examples:

- **STMT-002**: Voided statements excluded from queries -- voiding is a pushout; `P_active` is a subpresheaf that structurally excludes voided objects
- **FED-001**: TLA validity iff cocycle conditions satisfied -- Grothendieck descent theorem
- **QRY-001**: AND queries = pullbacks, computed pointwise in `Set^(C^op)`
- **NAT-002**: Temporal closure is idempotent (`j . j = j`) -- closure already contains its preimage

---

## Tech stack

| Component | Technology |
|-----------|-----------|
| Core | TypeScript, Express |
| Triplestore | [Oxigraph](https://github.com/oxigraph/oxigraph) (WASM) + SPARQL |
| SQL LRS | [Yet Analytics lrsql](https://github.com/yetanalytics/lrsql) |
| Synthetic data | [Yet Analytics DataSim](https://github.com/yetanalytics/datasim) |
| Identity | DID:key (Ed25519/P-256), Verifiable Credentials |
| Persistence | Oxigraph (default), JSON file, or in-memory |

---

## Project structure

```
hela-store/
  src/
    store.ts        -- HELAStore, realize(), F_xAPI/F_CLR/F_Badge/F_CTDL/F_CASE, produceLER()
    server.ts       -- xAPI REST + HELA extension endpoints
    federation.ts   -- FederatedSite, descent, gluing, conflict resolution
    sources.ts      -- FederatedSource, SourceRegistry (zero-copy query layer)
    query.ts        -- Query DSL (subpresheaves), QueryExecutor
    natural.ts      -- LearningFunctor, EvidenceAccumulation, temporal closure
    profiles.ts     -- xAPI Profiles as Grothendieck topologies
    adapters.ts     -- InMemoryAdapter, JSONFileAdapter, OxigraphAdapter
    conformance.ts  -- 47 tests (20 theorems + 27 runtime)
    sat.ts          -- SAT orchestrator (Secure, Accessible, Transparent)
    lrsql.ts        -- Yet Analytics SQL LRS connector
    datasim.ts      -- Yet Analytics DataSim connector
    scormcloud.ts   -- SCORM Cloud connector
    types.ts        -- xAPI 2.0 types + HELA categorical types
  public/
    index.html      -- Dashboard
    wallet.html     -- HELA Wallet
lrsql/              -- Yet Analytics SQL LRS (local instance)
datasim/            -- Yet Analytics DataSim (synthetic data)
```

---

## License

MIT -- [Foxxi Mediums Inc.](https://foxxi.io)
