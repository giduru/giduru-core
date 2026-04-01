# Ledger Analysis Artifacts

This document describes the canonical artifacts emitted by `giduru-core`.

## Engine Outputs

The public entry points produce three layers of output:

| API | Output | Purpose |
| --- | --- | --- |
| `parseLedgerDocument()` | `ParsedLedgerFile` | Single-file parser output. |
| `parseLedgerWorkspace()` | `ParsedLedgerWorkspace` | Reachable parser output for a workspace. |
| `verifyLedgerWorkspace()` | `LedgerAnalysis` | Semantic, verified analysis output. |
| `analyzeLedgerDocuments()` / `analyzeLedgerState()` | `{ analysis, workspace, state }` | Full pipeline result plus parser output and incremental cache state. |

`LedgerAnalysis` is the stable, query-ready artifact. `ParsedLedgerWorkspace` is still useful when you need raw parser details that are not promoted into `LedgerAnalysis`.

## Top-Level `LedgerAnalysis` Fields

| Field | Type | Meaning |
| --- | --- | --- |
| `accounts` | `string[]` | Distinct accounts seen in verified postings. Declared-only accounts are not included here. |
| `accountCatalog` | `LedgerAccountCatalogEntry[]` | First-class account artifact built from reachable `account` directives plus verified register usage. |
| `balances` | `AccountBalance[]` | Final running balances by exact account and commodity. |
| `declaredAccounts` | `string[]` | Exact account names declared by reachable `account` directives. |
| `declaredCommodities` | `string[]` | Commodity names declared by reachable `commodity` directives. |
| `diagnostics` | `LedgerDiagnostic[]` | Parser, directive, and verifier diagnostics. |
| `graph` | `{ dependencyEdges, includedFiles, rootFiles }` | Reachable include graph metadata. |
| `index` | `LedgerAnalysisIndex` | Prebuilt lookup buckets over `accountCatalog`, `diagnostics`, `register`, and `transactions`. |
| `parserSummary` | `{ errorNodeCount, fileCount, nodeCount, reusedFileCount }` | Parser/materialization summary. |
| `prices` | `LedgerPrice[]` | Directive prices plus posting-annotation-derived prices. |
| `register` | `RegisterEntry[]` | Posting-level verified output. |
| `summary` | `{ postingCount, transactionCount }` | Snapshot counts. |
| `timings` | `{ parseMs, totalMs, verifyMs }` | Timing metadata for the current run. |
| `transactions` | `Transaction[]` | Transaction-level verified output with embedded verified postings. |

## `accountCatalog`

`analysis.accountCatalog` is the canonical account artifact in `giduru-core`.

Each `LedgerAccountCatalogEntry` includes:

- `id` and `account`: the exact account name.
- `declared` / `used`: whether the account appears in reachable `account` directives and/or verified register output.
- `declarationCount` / `postingCount`: declaration count from reachable directives, posting count from verified register entries.
- `paths`, `comments`, `tags`, `typeAnnotationValues`, `typeDiagnostics`: unique merged views derived from declarations.
- `declaredType`: the merged explicit account type from directives for that exact account. Conflicting explicit declarations resolve to `unknown`.
- `effectiveType`: the type used by the engine for that account. This is the explicit declared type when present, otherwise the name-based heuristic from `inferAccountTypeFromName()`.
- `commoditiesUsed`: distinct commodities seen for the account in verified register entries.
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
- Usage metadata (`used`, `postingCount`, `commoditiesUsed`) comes only from verified register output.
- `analysis.accountCatalog` includes declared-only accounts, used-only accounts, and accounts that are both declared and used.

## Index Coverage

`analysis.index` includes:

- `accountCatalogPositionById`
- `accountCatalogIdsByEffectiveType`
- `accountCatalogIdsByTag`
- `accountCatalogIdsByTagName`
- `accountCatalogIdsByPath`
- `diagnosticPositionById`
- `diagnosticsByPath`
- `registerIdsByAccount`
- `registerIdsByAccountType`
- `registerIdsByCommodity`
- `registerIdsByDate`
- `registerIdsByPath`
- `registerIdsByTag`
- `registerIdsByTagName`
- `registerPositionById`
- `transactionIdsByDate`
- `transactionIdsByPath`
- `transactionPositionById`

## Ordering

- `register` and `transactions` are materialized in descending date order.
- `prices` are materialized in ascending date order.
- `diagnostics` are sorted by path and line.
- `accountCatalog` is sorted by exact account name.
