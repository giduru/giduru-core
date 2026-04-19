# `giduru` Workspace

This repository is a standard npm workspaces monorepo with two independently publishable packages:

- [`@giduru/core`](./packages/core/README.md): the pure parsing and verification engine
- [`giduru-cli`](./packages/cli/README.md): a thin filesystem-backed CLI around the core

## Layout

```text
packages/
  core/
  cli/
```

## Repo Plan

- `@giduru/core` is the portable bookkeeping library.
- The package root is the semver-stable external API.
- `@giduru/core/engine` is the broader internal engine surface for parser state, incremental analysis, and other implementation details.
- `giduru-cli` is the filesystem-backed adapter around the core package.
- Future REST, RSQL, sync, or cloud adapters should sit above the core instead of pushing runtime or storage concerns into it.

The practical constraint is that the core package must stay agnostic about where files come from. Every host should convert its storage model into `LedgerSourceDocument` snapshots and call the core.

## Common Commands

```sh
npm install
npm run build
npm test
```

Core-specific benchmark runs go through the workspace root:

```sh
npm run bench -- --preset medium
```
