# Ledger Analysis Artifacts and Query Architecture

This document describes the canonical artifacts emitted by `@giduru/core` and outlines where an RSQL and OpenAPI layer should live.

## Engine Outputs

The public entry points produce three layers of output:

| API | Output | Purpose |
| --- | --- | --- |
| `analyzeLedgerDocuments()` | `{ analysis, workspace, state }` | Stable root entry point for full analysis plus parser output and incremental cache state. |
| `parseLedgerDocument()` | `ParsedLedgerFile` | Single-file parser output from `@giduru/core/engine`. |
| `parseLedgerWorkspace()` | `ParsedLedgerWorkspace` | Reachable parser output for a workspace from `@giduru/core/engine`. |
| `verifyLedgerWorkspace()` | `LedgerAnalysis` | Semantic, verified analysis output from `@giduru/core/engine`. |
| `analyzeLedgerState()` | `{ analysis, workspace, state }` | Incremental engine entry point from `@giduru/core/engine`. |

The important distinction is:

- `LedgerAnalysis` is the stable, query-ready artifact.
- `ParsedLedgerWorkspace` is still useful when you need raw parser details that are not promoted into `LedgerAnalysis`.
- `LedgerEngineState` is an incremental cache handle, not a stable external artifact or API contract.

## Top-Level `LedgerAnalysis` Fields

| Field | Type | Meaning | Query Notes |
| --- | --- | --- | --- |
| `accounts` | `string[]` | Distinct accounts seen in verified postings. | Declared-only accounts are not included here. |
| `accountCatalog` | `LedgerAccountCatalogEntry[]` | First-class account artifact built from reachable `account` directives plus verified posting usage. | Best source for declaration-aware account queries. |
| `balances` | `AccountBalance[]` | Final running balances by exact account and commodity. | No parent or inclusive rollups are emitted. |
| `commodities` | `LedgerCommodityCatalogEntry[]` | Commodity catalog built from reachable `commodity` directives plus verified posting and price usage. | Good source for declaration-aware commodity queries. |
| `declaredAccounts` | `string[]` | Exact account names declared by reachable `account` directives. | Names only; richer declaration metadata lives in `accountCatalog`. |
| `declaredCommodities` | `string[]` | Commodity names declared by reachable `commodity` directives. | Names only. |
| `diagnostics` | `LedgerDiagnostic[]` | Parser, directive, and verifier diagnostics. | Snapshot-local ids; indexed by path. |
| `graph` | `{ dependencyEdges, includedFiles, rootFiles }` | Reachable include graph metadata. | Better treated as metadata than a primary RSQL collection. |
| `includes` | `LedgerIncludeRecord[]` | Promoted include directive metadata from reachable files. | Useful for directive-aware tooling and APIs. |
| `index` | `LedgerAnalysisIndex` | Prebuilt lookup buckets over `accountCatalog`, `diagnostics`, `postings`, and `transactions`. | Foundation for efficient query execution. |
| `parserSummary` | `{ errorNodeCount, fileCount, nodeCount, reusedFileCount }` | Parser and materialization summary. | Metadata only. |
| `postings` | `Posting[]` | Posting-level verified output. | Best primary query collection. |
| `prices` | `LedgerPrice[]` | Directive prices plus posting-annotation-derived prices. | Good secondary collection; not fully index-backed. |
| `summary` | `{ postingCount, transactionCount }` | Snapshot counts. | Metadata only. |
| `timings` | `{ parseMs, totalMs, verifyMs }` | Timing metadata for the current run. | Operational metadata, not business data. |
| `transactions` | `Transaction[]` | Transaction-level verified output with embedded verified postings. | Useful collection, but nested postings complicate generic RSQL. |

## `accountCatalog`

`analysis.accountCatalog` is the canonical account artifact in `@giduru/core`.

Each `LedgerAccountCatalogEntry` includes:

- `id` and `account`: the exact account name.
- `declared` / `used`: whether the account appears in reachable `account` directives and/or verified posting output.
- `declarationCount` / `postingCount`: declaration count from reachable directives, posting count from verified posting entries.
- `paths`, `comments`, `tags`, `typeAnnotationValues`, `typeDiagnostics`: unique merged views derived from declarations.
- `declaredType`: the merged explicit account type from directives for that exact account. Conflicting explicit declarations resolve to `unknown`.
- `effectiveType`: the type used by the engine for that account. This is the explicit declared type when present, otherwise the name-based heuristic from `inferAccountTypeFromName()`.
- `commoditiesUsed`: distinct commodities seen for the account in verified posting entries.
- `declarations`: every reachable `account` directive for that exact account, preserved as `LedgerAccountDirectiveRecord[]`.

### Declaration Semantics

- `declarations` is the source of truth for raw directive metadata.
- `tags` and `typeAnnotationValues` preserve declaration order while removing exact duplicates.
- `paths` is the unique declaration path list for the account.
- `comments` omits blank comments and preserves the parser's raw comment text for non-blank declaration comments.
- `typeDiagnostics` collects raw directive-level type diagnostics, such as unsupported or conflicting inline `type:` annotations on a single directive.

### Type Semantics

- Explicit `type:` annotations apply to the exact declared account only.
- Unannotated accounts keep the name-based heuristic fallback.
- If the same account is declared multiple times with incompatible explicit `type:` annotations, `declaredType` becomes `unknown`, `effectiveType` becomes `unknown`, and diagnostics are emitted.
- If a parent account and child account both have explicit `type:` annotations and they disagree, diagnostics are emitted, but each exact account keeps its own explicit type as its `effectiveType`.

### Source Boundaries

- Declaration metadata comes only from reachable workspace files.
- Usage metadata (`used`, `postingCount`, `commoditiesUsed`) comes only from verified posting output.
- `analysis.accountCatalog` includes declared-only accounts, used-only accounts, and accounts that are both declared and used.

## Artifact Semantics That Matter For Querying

These details matter if you want a predictable query contract:

- `postings` and `transactions` are materialized in descending date order.
- `prices` are materialized in ascending date order.
- `diagnostics` are sorted by path and line.
- `accountCatalog` is sorted by exact account name.
- Posting ids are `path:headerLine:postingLine`.
- Transaction ids are `path:headerLine`.
- Diagnostic ids are `path:line:message`.
- Price ids are line-based and source-specific.

Those ids are stable within a single analysis snapshot, but they are not durable entity ids across edits that move line numbers or change diagnostic text.

## Current Index Coverage

`analysis.index` includes:

- `accountCatalogPositionById`
- `accountCatalogIdsByEffectiveType`
- `accountCatalogIdsByTag`
- `accountCatalogIdsByTagName`
- `accountCatalogIdsByPath`
- `diagnosticPositionById`
- `diagnosticsByPath`
- `postingIdsByAccount`
- `postingIdsByAccountType`
- `postingIdsByCommodity`
- `postingIdsByDate`
- `postingIdsByPath`
- `postingIdsByTag`
- `postingIdsByTagName`
- `postingPositionById`
- `transactionIdsByDate`
- `transactionIdsByPath`
- `transactionPositionById`

This means the engine is already optimized for a query layer over:

- `accountCatalog`
- `postings`
- `transactions`
- `diagnostics`

There is no equivalent index yet for:

- `balances`
- `prices`
- `graph`
- commodity metadata beyond declared names

## What Is Not Currently Preserved In `LedgerAnalysis`

These gaps matter if you want a fuller query API:

- Parser-only directive details that are not promoted into `accountCatalog`, `commodities`, `diagnostics`, `includes`, `prices`, `postings`, or `transactions` still require reading `ParsedLedgerWorkspace`.
- Exported types like `PossibleDuplicateTransaction` and `RecurringTransactionSeries` exist in the package, but they are not currently emitted by the analysis engine.

If you want directive-centric queries beyond the promoted analysis artifacts, you either need:

- the query layer to read both `analysis` and `workspace`, or
- `@giduru/core` to grow richer top-level artifacts where those queries belong.

## Recommended RSQL Collections

If the goal is a practical first query engine, these should be the initial collections:

| Collection | Backing Artifact | Why |
| --- | --- | --- |
| `postings` | `analysis.postings` | Flat, verified, already indexed, and likely the main reporting surface. |
| `transactions` | `analysis.transactions` | Useful for header-level search and pagination. |
| `diagnostics` | `analysis.diagnostics` | Natural fit for lint and error queries. |
| `prices` | `analysis.prices` | Small, well-defined market and exchange-rate surface. |
| `balances` | `analysis.balances` | Useful for current-state snapshots. |
| `commodities` | `analysis.commodities` | Commodity declaration and usage surface. |
| `includes` | `analysis.includes` | Include directive metadata. |
| `accountCatalog` | `analysis.accountCatalog` | Best declaration-aware account collection. |

I would treat these as metadata endpoints rather than RSQL collections:

- `analysis.summary`
- `analysis.timings`
- `analysis.parserSummary`
- `analysis.graph`

## Recommended Query Model

The cleanest first design is:

- make `postings` the primary collection
- keep RSQL selectors flat
- avoid querying nested `transactions.postings` in the first version
- use `postings.transactionId` to join postings back to transactions

Standard RSQL is a better fit for flat records than nested arrays. That means:

- posting-level filters belong on `postings`
- transaction-level filters belong on `transactions`
- tag queries should use flattened synthetic fields or membership semantics

For tags, the current engine already indexes:

- exact tag pairs via `postingIdsByTag` and `accountCatalogIdsByTag`
- tag-name presence via `postingIdsByTagName` and `accountCatalogIdsByTagName`

So the query layer can support tag predicates without rescanning the full posting or account catalog.

## Package Boundary Recommendation

I would not put the HTTP server or OpenAPI generator in `@giduru/core`.

I would also avoid putting the RSQL syntax parser in `@giduru/core`. That pushes the package beyond "parser and verifier" into "query language host", which is a different concern.

The clean split is:

- `@giduru/core`
  - owns parsing, verification, incremental state, and canonical analysis types
  - may optionally own a small data-only artifact or field manifest if you want one source of truth for collection definitions
- `giduru-query` (new package)
  - depends on `@giduru/core`
  - owns collection descriptors, field metadata, RSQL parsing, query compilation, query execution, and OpenAPI generation
- `giduru-cli`
  - stays as the filesystem and runtime adapter
  - can add `serve` mode on top of `giduru-query`

This keeps `core` focused while still making the query engine reusable as a package.

## OpenAPI Recommendation

Do not try to generate `openapi.json` directly from TypeScript types alone. The types are erased at runtime and they do not encode enough API-specific information about:

- collection names
- filterable fields
- supported operators
- pagination
- sort keys
- query examples

Instead, define runtime collection descriptors in the query package. A descriptor should include:

- collection name
- backing artifact
- field names and scalar types
- which fields are filterable
- which fields are sortable
- which fields have an index-backed execution path

From that descriptor you can generate:

- the RSQL field registry
- request validation
- OpenAPI parameter schemas
- server documentation

If you later want zero duplication between `core` and `query`, the part worth moving into `core` is the data-only artifact manifest, not the RSQL or HTTP code.

## Practical First Increment

If you build this in the monorepo now, I would do it in this order:

1. Add a new `packages/query` package that depends on `@giduru/core`.
2. Implement a collection registry for `postings`, `transactions`, `diagnostics`, `prices`, `balances`, `commodities`, `includes`, and `accountCatalog`.
3. Compile RSQL into a collection-specific predicate plan.
4. Use `analysis.index` for equality and membership filters where possible.
5. Add `giduru serve <root-file>` in `giduru-cli` as a thin HTTP adapter.
6. Expose `GET /openapi.json` from the query package's runtime descriptors.

That architecture gives you:

- a reusable in-process query package
- a CLI-hosted local server mode
- a clean separation between accounting analysis and transport and query-syntax concerns

## Bottom Line

The current engine already emits the right core artifacts for a first query layer, especially `accountCatalog`, `postings`, `transactions`, `diagnostics`, `prices`, `balances`, `commodities`, `includes`, and `analysis.index`.

The part that belongs in `core` is the canonical analysis model.

The parts that should probably live outside `core` are:

- RSQL parsing
- query execution policy
- OpenAPI generation
- HTTP server mode

If you later decide that more directive metadata must be queryable as first-class collections, that is the signal to extend the core output model rather than forcing the server layer to reverse-engineer it.
