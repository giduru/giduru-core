# Ledger Engine Architecture

This package is the isolated parse/analyze/verify core extracted from Giduru.

It is intended to stay:

- filesystem-agnostic
- UI-agnostic
- runtime-agnostic
- packageable as a future standalone npm module

The app should treat it like a local backend library.

## Purpose

The engine accepts plain document snapshots or explicit per-file changes and produces:

- parsed workspace state
- semantic diagnostics
- posting-level register output
- transaction-level output
- account balances
- derived prices
- include/dependency graph data
- indexed output for fast higher-level querying

The long-term design goal is to support:

- incremental reparse
- incremental verification
- future query layers such as RSQL over analysis output
- reuse in other tools without pulling in Expo, React, Zustand, or browser file APIs

## Public Surface

The current public shape is centered on these functions:

- `createLedgerEngineState(documents?)`
- `applyLedgerDocumentChanges(state, changes, options?)`
- `buildParsedLedgerWorkspace(state, { rootFilePaths })`
- `analyzeLedgerState(state, verifyOptions)`
- `analyzeLedgerDocuments(documentsByPath, options)`
- `parseLedgerDocument()`
- `parseLedgerWorkspace()`
- `verifyLedgerWorkspace()`

Core data enters as `LedgerSourceDocument` values:

```ts
type LedgerSourceDocument = {
  content: string;
  isLedger: boolean;
  lastModified?: number;
  name: string;
  path: string;
};
```

This keeps the package pure and host-independent.

## Pipeline

The current pipeline is:

1. The host creates or updates a `LedgerEngineState`.
2. `applyLedgerDocumentChanges()` reparses only changed ledger files.
3. `buildParsedLedgerWorkspace()` resolves root files and reachable include graph.
4. `verifyLedgerWorkspaceWithCache()` builds a verification plan for the reachable workspace.
5. The verifier reuses cached transaction fragments where safe and replays only what changed.
6. Final materialization produces balances, register, transactions, prices, diagnostics, graph, and indexes.

There are two distinct layers of incrementality:

- parse incrementality
- verify incrementality

Both matter. The parser is no longer the main bottleneck on realistic incremental edits.

## Parser Layer

The parser in [src/parser.ts](./src/parser.ts) uses the `codemirror-lang-hledger` Lezer grammar and extracts:

- include directives
- account directives
- commodity directives
- price directives
- transactions
- postings
- posting annotations
- balance assertions
- comment-derived tags

Important current parser behavior:

- parse-tree reuse is supported for changed files
- quoted commodities are preserved correctly
- total-price `@@` annotations are normalized to the posting sign for balancing
- transaction cache keys are built at parse time and carried forward into verification planning

The parser is responsible for syntax and extraction, not semantic accounting rules.

## Verifier Layer

The verifier in [src/verifier.ts](./src/verifier.ts) does semantic accounting work:

- declaration enforcement
- transaction balancing
- missing amount inference
- balance assertions and simple assignments
- priced posting balancing
- balanced-virtual balancing
- include cycle and reachability diagnostics

Important semantic choice:

- declaration directives are intentionally order-insensitive

That means `account` and `commodity` declarations are collected across the reachable workspace before strict validation runs. This avoids "declare before use" behavior and is an explicit engine design decision.

## Incremental Techniques

The engine currently uses several layered caches.

### Parse Caches

Stored in [src/workspace.ts](./src/workspace.ts):

- previous parsed files by path
- previous parse trees by path
- state-local analysis cache for identical state and options

`applyLedgerDocumentChanges()` reparses only:

- files whose content or metadata changed
- files with glob includes when the known path set changes

Everything else stays cached.

### Verification Fragments

The verifier works on per-transaction fragments:

- diagnostics
- register entries
- derived prices
- balance deltas
- touched accounts
- touched commodities
- dependency on prior balances

These fragments are cached in `LedgerVerificationCache`.

### Prefix Reuse

If the ordered transaction stream is unchanged at the front, the verifier reuses the verified prefix directly.

### Balance-Independent Suffix Reuse

Fragments that do not depend on prior running balances can be reused even after an earlier edit, as long as:

- the transaction cache key still matches
- declaration status for symbols touched by the fragment is still equivalent

This is what makes early edits much cheaper than a full reverification.

### Declaration-Aware Reuse

Declaration edits no longer invalidate everything blindly.

A fragment is reusable across declaration changes when the declaration status of the accounts and commodities it touches has not changed from:

- declared to undeclared
- undeclared to declared

This is stricter than full blind reuse, but much cheaper than total invalidation.

### Checkpoints

The verifier stores running-balance checkpoints every 128 transactions.

These checkpoints allow restore-and-replay from the nearest safe point instead of replaying from the beginning on every run.

### Checkpoint Replay Blocks

Added in commit `b7dc3e6`.

If a checkpoint-aligned block consists entirely of balance-independent reusable fragments, the engine stores the aggregated balance delta for that whole block and can bulk-apply it on later runs.

This helps the "early edit followed by a long reusable suffix" case.

## Output Shape

The final `LedgerAnalysis` includes:

- `accounts`
- `balances`
- `declaredAccounts`
- `declaredCommodities`
- `diagnostics`
- `graph`
- `index`
- `parserSummary`
- `prices`
- `register`
- `summary`
- `timings`
- `transactions`

### Register Output

`register` is posting-level verified output.

Each entry includes:

- account
- account type
- amount and commodity
- balance assertion metadata
- inferred amount flag
- posting kind
- path, line, date
- transaction linkage
- search text
- tags

### Transaction Output

`transactions` is transaction-level output with verified postings embedded.

### Prices

`prices` contains both:

- directive prices
- posting-annotation-derived prices

### Graph

`graph` contains:

- dependency edges
- included files
- root files

### Timings

`timings` currently includes:

- `parseMs`
- `verifyMs`
- `totalMs`

Important caveat:

- `verifyMs` measures verifier planning/replay work, but not all final materialization wall time

When benchmarking, prefer wall-clock benchmark output over `verifyMs` alone.

## Indexes and Query Readiness

The package already emits structured indexes in `analysis.index`.

Current indexed dimensions include:

- diagnostics by path
- diagnostic position by id
- register ids by account
- register ids by account type
- register ids by commodity
- register ids by date
- register ids by path
- register position by id
- transaction ids by date
- transaction ids by path
- transaction position by id

This is the intended base for a future query layer such as RSQL. The engine already emits stable ids and pre-grouped buckets instead of forcing all future consumers to rescan arrays.

## hledger Compatibility Notes

Current coverage includes:

- include directives, including globs
- unmatched-glob diagnostics
- declared account and commodity strictness
- missing amount inference
- priced posting balancing for `@` and `@@`
- total-price sign normalization
- balance assertions and simple assignments
- balanced virtual posting balancing

Known gaps:

- full mixed-commodity balance assignment semantics
- automatic commodity conversion during balancing
- lot semantics beyond parse capture
- posting-date-aware balancing order
- alias/apply-account and other imperative directive semantics

These gaps are isolated to the engine package now rather than being mixed into app services.

## Benchmark Harness

The benchmark harness lives in [bench/run.js](./bench/run.js).

Useful commands:

```sh
npm run bench -- --preset medium
npm run bench -- --preset large --filter incremental
npm run bench -- --preset enterprise
npm run bench -- --preset large --json
```

Supported presets:

- `small`
- `medium`
- `large`
- `enterprise`

Supported scenario types include:

- large single-file journals
- priced journals
- include-heavy workspaces
- glob-included workspaces
- leaf edits
- early edits
- declaration edits
- glob adds
- glob deletes
- noop cached analyses

The `enterprise` preset is for capacity planning, not quick smoke tests.

## Current Performance Shape

The main bottleneck is no longer raw parsing.

The current shape is:

- no-op analysis is essentially solved through exact state+options caching
- incremental parsing is working well
- verifier replay is much better than the original full-workspace rerun model
- remaining wall time is mostly in changed-state materialization/index work and unavoidable replay in the harder cases

Rough large-preset incremental behavior at the current accepted baseline:

- leaf edit: about `220-260ms` wall
- early edit: about `250ms` wall
- glob add: about `190-225ms` wall
- declaration edit: about `230-300ms` wall
- glob delete: about `240-285ms` wall
- noop analysis: sub-millisecond

Treat those as rough benchmark-shape numbers, not hard guarantees.

## Accepted vs Rejected Optimizations

Accepted:

- extracted package boundary
- incremental parse state
- analysis result caching
- verification fragments
- declaration-aware fragment reuse
- checkpoints
- checkpoint replay blocks

Tried and rejected because benchmarks regressed:

- aggressive parser cache-key rewrite to replace `JSON.stringify`
- merged materialization/index construction pass
- loop-heavy rewrites of several array-heavy materialization paths

Future work should assume that simple "fewer array helpers must be faster" rewrites are not automatically wins in this codebase. Benchmark before keeping them.

## Good Next Targets

If future work continues on performance, the best remaining targets are:

- partial materialization reuse for changed states
- partial index reuse instead of rebuilding all buckets every run
- better measurement separation between replay time and materialization time
- more selective invalidation for declaration and include-graph changes

If the package ever needs a bigger step-function improvement beyond this, it will probably require a larger architectural change than routine micro-optimization.
