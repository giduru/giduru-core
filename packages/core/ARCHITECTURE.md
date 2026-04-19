# `@giduru/core` Architecture

This package is the portable double-entry bookkeeping core for Giduru.

The design target is simple:

- one package
- semver-stable root API
- broader unstable engine surface behind `@giduru/core/engine`
- no filesystem or runtime coupling in the core

## Package Boundary

The package root is the public contract.

- `@giduru/core`
  - bookkeeping-first types such as `LedgerAnalysis`, `Posting`, `Transaction`, `LedgerPrice`, `LedgerCommodityCatalogEntry`, and `LedgerIncludeRecord`
  - pure analysis helpers such as `analyzeLedgerDocuments()`
  - stable filtering and price-resolution helpers
- `@giduru/core/engine`
  - parser IR
  - incremental engine state
  - workspace objects
  - lower-level parse and verify entry points

The rule is:

- if an API is intended to survive a future engine rewrite, it belongs at the package root
- if an API exposes parser structure, cache state, or replay machinery, it belongs under `engine`

## Portability Contract

The core package is runtime-agnostic and storage-agnostic.

It does not read files, talk to S3, use browser APIs, or depend on React Native or Node-specific runtime state.

Hosts are responsible for turning their storage model into document snapshots:

```ts
type LedgerSourceDocument = {
  content: string;
  isLedger: boolean;
  lastModified?: number;
  name: string;
  path: string;
};
```

That keeps the same package usable from:

- the CLI
- React Native
- a PWA
- Lambda or ECS
- a future local or cloud sync layer

## Stable Root API

The stable root entry point is:

- `analyzeLedgerDocuments(documents, options?) => Promise<LedgerAnalysis>`

This API is intentionally narrow:

- input is a snapshot of documents
- output is a stable analysis artifact
- parser workspace and engine state are not exposed at the root

That makes the root API appropriate for semver versioning and future implementation swaps.

## Engine API

The `engine` subpath exposes the broader implementation surface:

- `createLedgerEngineState()`
- `applyLedgerDocumentChanges()`
- `buildParsedLedgerWorkspace()`
- `analyzeLedgerState()`
- `analyzeLedgerDocuments()`
- `parseLedgerDocument()`
- `parseLedgerWorkspace()`
- `verifyLedgerWorkspace()`

This is the right surface for:

- editor integrations
- incremental re-analysis
- benchmark harnesses
- internal tooling
- future compatibility shims during engine rewrites

It is not the surface to treat as the long-term external contract.

## Canonical Data Model

The bookkeeping model is transaction-first and posting-first.

The package should use:

- `transactions` for transaction-level verified units
- `postings` for posting-level verified units

It should not use `register` as a primary public or internal artifact name.

The stable `LedgerAnalysis` output includes:

- `postings`
- `transactions`
- `prices`
- `commodities`
- `includes`
- `accountCatalog`
- `balances`
- `diagnostics`
- `graph`
- `index`
- `summary`
- `timings`

These artifacts are the foundation for future query, REST, and RSQL layers.

## Price Semantics

Price resolution is first-class in the stable surface.

Current rules:

- same-day conflicts are reported only between `P` directives
- posting-derived `@@` or `@` prices do not conflict with same-day `P` directives
- when resolving prices, a `P` directive wins if present for that day
- otherwise the later posting-derived price in parse order wins for stability

This keeps balancing behavior compatible with ledger workflows while making price lookup deterministic.

## Internal Pipeline

The engine still has layered phases:

1. parse individual ledger files
2. resolve reachable includes
3. collect declaration metadata
4. verify transactions and postings
5. materialize stable analysis artifacts
6. build query-oriented indexes

The parser extracts syntax and directive structure.

The verifier owns semantic accounting behavior:

- declaration enforcement
- missing amount inference
- balancing
- balance assertions
- priced-posting balancing
- include diagnostics
- artifact materialization

## Incremental Strategy

Incrementality remains an internal engine concern rather than part of the stable root contract.

Important current techniques:

- parse-tree reuse per file
- cached parsed files by path
- per-transaction verification fragments
- replay checkpoints
- reuse of balance-independent suffixes

This is why the engine surface stays separated from the root API.

The implementation can evolve aggressively without forcing churn in the stable contract.

## Repository Plan

The repo-level direction is:

1. Keep `@giduru/core` as the canonical data and analysis package.
2. Keep `giduru-cli` as a thin filesystem adapter over the core.
3. Add higher-level query or server layers above the core when needed, without pushing transport concerns into the core package.
4. Preserve the root package API across refactors using semver, while allowing `@giduru/core/engine` to change faster.
5. Keep the package ready for a future Rust or WASM implementation by holding the root API steady and isolating engine details.
