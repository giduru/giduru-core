# `giduru-cli`

Thin command-line interface for [`giduru-core`](https://www.npmjs.com/package/giduru-core).

## Install

```sh
npm install --global giduru-cli
```

## Commands

```sh
giduru analyze ./main.journal
giduru analyze ./main.journal --compact
giduru check ./main.journal
giduru --version
```

`analyze` prints the full `LedgerAnalysis` JSON for the given root file.

`check` prints diagnostics and exits with status `1` when any error-level diagnostic is present.
