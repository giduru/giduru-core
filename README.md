# `@giduru/ledger-engine`

Pure parsing and verification engine extracted from Giduru's app runtime.

## Goals

- Keep filesystem IO, React, Zustand, and runtime orchestration out of the core engine.
- Accept explicit document snapshots or per-file change notifications.
- Reuse parsed files across runs so unchanged files are not reparsed.
- Emit analysis output that is already indexed for fast higher-level querying.
- Stay compatible with the hledger model where it matters, without inheriting directive-order dependence.

## Public Shape

- `createLedgerEngineState()`
- `applyLedgerDocumentChanges(state, changes)`
- `buildParsedLedgerWorkspace(state, { rootFilePaths })`
- `analyzeLedgerState(state, verifyOptions)`
- `analyzeLedgerDocuments(documentsByPath, options)`
- `parseLedgerDocument()`
- `parseLedgerWorkspace()`
- `verifyLedgerWorkspace()`

Documents are pure values:

```ts
type LedgerSourceDocument = {
  content: string;
  isLedger: boolean;
  lastModified?: number;
  name: string;
  path: string;
};
```

## Incremental Model

`applyLedgerDocumentChanges()` reparses only:

- files whose content or metadata changed
- existing files with glob includes when the known path set changes

Everything else stays cached in `parsedFilesByPath`.

The app adapter in `apps/mobile/src/services/ledger-analysis.ts` now:

- avoids rereading unchanged disk files
- passes dirty drafts directly as document content
- reuses the engine state across analysis runs

## Directive Semantics

Declaration-style directives are intentionally order-insensitive in this engine.

- `account` and `commodity` declarations are collected across the reachable workspace first
- strict validation runs against those full sets
- the engine does not depend on whether a declaration appeared before or after a posting

This is a deliberate deviation from order-sensitive reader behavior upstream.

## Current hledger-Compatible Coverage

- include directives, including glob expansion and unmatched-glob diagnostics
- declared account and commodity strictness
- missing-amount inference
- posting price annotations surfaced as derived prices
- posting kinds: real, virtual, balanced virtual
- balance assertions and simple balance assignments
- separate balancing for real vs balanced-virtual posting groups

## Known Gaps

- full hledger mixed-commodity balance assignment semantics
- automatic commodity conversion during balancing
- lot price/date semantics beyond parse capture
- posting-date-aware balancing order
- alias/apply-account and other imperative directive semantics

Those gaps are now isolated to the package instead of being mixed into app services.
