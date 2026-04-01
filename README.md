# `giduru` Workspace

This repository is a standard npm workspaces monorepo with two independently publishable packages:

- [`giduru-core`](./packages/core/README.md): the pure parsing and verification engine
- [`giduru-cli`](./packages/cli/README.md): a thin filesystem-backed CLI around the core

## Layout

```text
packages/
  core/
  cli/
```

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
