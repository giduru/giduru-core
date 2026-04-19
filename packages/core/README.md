# `@giduru/core`

Pure parsing and verification engine extracted from Giduru's app runtime.

Detailed architecture and performance notes live in [ARCHITECTURE.md](./ARCHITECTURE.md).
Artifact inventory and query-layer notes live in [ARTIFACTS.md](./ARTIFACTS.md).

## Install

```sh
npm install @giduru/core
```

This package is maintained from the [`giduru/giduru-core`](https://github.com/giduru/giduru-core) repository.

## Goals

- Keep filesystem IO, React, Zustand, and runtime orchestration out of the core engine.
- Accept explicit document snapshots or per-file change notifications.
- Reuse parsed files across runs so unchanged files are not reparsed.
- Emit analysis output that is already indexed for fast higher-level querying.
- Stay compatible with the hledger model where it matters, without inheriting directive-order dependence.

## Public API

- `analyzeLedgerDocuments(documents, options?)`
- `filterPostings(analysis, filter)`
- `filterPostingIds(analysis, filter)`
- `getPostingIdsForTag(index, tag)`
- `resolveLedgerPrice(queryable, query)`
- `resolveLedgerPriceOnDate(queryable, query)`
- `resolveLatestLedgerPrice(queryable, query)`
- stable bookkeeping types such as `LedgerAnalysis`, `Posting`, `Transaction`, `LedgerPrice`, `LedgerCommodityCatalogEntry`, and `LedgerIncludeRecord`

These stable exports live at the package root:

```ts
import { analyzeLedgerDocuments, filterPostings, resolveLatestLedgerPrice } from '@giduru/core';
```

The root `analyzeLedgerDocuments()` API is intentionally narrow:

- input: `LedgerSourceDocument` snapshots
- output: `LedgerAnalysis`
- no parser workspace handles
- no incremental engine state handles

That is the semver-stable contract for the package.

## Engine API

The broader parser/incremental engine surface is still available from:

```ts
import {
  analyzeLedgerDocuments,
  analyzeLedgerState,
  applyLedgerDocumentChanges,
  buildParsedLedgerWorkspace,
  createLedgerEngineState,
  parseLedgerDocument,
  parseLedgerWorkspace,
  verifyLedgerWorkspace,
} from '@giduru/core/engine';
```

Use the `engine` subpath when you need parser IR, incremental state handles, or lower-level verification entry points. The package root is the semver-stable API boundary.

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

## Host Boundary

`@giduru/core` is intentionally storage-agnostic.

- CLI code should read from the local filesystem and convert files into `LedgerSourceDocument` values.
- React Native or PWA code should do the same from whatever local or synced store they use.
- Cloud code should do the same from S3 or another object store.

The core package should not know where documents came from. It only sees explicit snapshots.

## Incremental Model

`applyLedgerDocumentChanges()` reparses only:

- files whose content or metadata changed
- existing files with glob includes when the known path set changes

Everything else stays cached in `parsedFilesByPath`.

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
- posting price annotations used for balancing and surfaced as derived prices
- posting kinds: real, virtual, balanced virtual
- balance assertions and simple balance assignments
- separate balancing for real vs balanced-virtual posting groups

## Stable Analysis Output

The stable `LedgerAnalysis` artifact includes:

- `postings`: flat posting-level verified output
- `transactions`: transaction-level output with embedded postings
- `prices`: directive plus posting-derived prices
- `commodities`: commodity catalog with declaration and usage metadata
- `includes`: promoted include directive metadata
- `accountCatalog`, `balances`, `diagnostics`, `graph`, `index`, `summary`, and `timings`

## Known Gaps

- full hledger mixed-commodity balance assignment semantics
- automatic commodity conversion during balancing
- lot price/date semantics beyond parse capture
- posting-date-aware balancing order
- alias/apply-account and other imperative directive semantics

Those gaps are now isolated to the package instead of being mixed into app services.

## Benchmarks

Run the package benchmark harness with:

```sh
npm run bench -- --preset medium
```

Supported flags:

- `--preset small|medium|large|enterprise`
- `--iterations N`
- `--warmup N`
- `--filter substring`
- `--json`

The harness prints wall time, parse time, verify time, parsed/reused file counts, and Node heap/RSS usage.

The harness covers:

- large single-file simple journals
- large single-file priced journals
- deep static include graphs
- glob-included workspaces
- incremental leaf edits and worst-case early edits
- declaration-file edits that invalidate global strictness
- glob file additions and deletions
- no-op cached analyses to expose pure materialization overhead

The `enterprise` preset is intended for capacity planning rather than quick local smoke tests. It pushes file counts and transaction counts high enough to surface index, memory, and invalidation behavior on much larger synthetic ledgers.
