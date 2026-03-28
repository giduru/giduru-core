#!/usr/bin/env node

const { performance } = require('node:perf_hooks');

const {
  analyzeLedgerDocuments,
  analyzeLedgerState,
  applyLedgerDocumentChanges,
} = require('../dist/src');

const BYTES_PER_MB = 1024 * 1024;

const PRESETS = {
  small: {
    deepIncludeMonthsPerYear: 6,
    deepIncludeTransactionCountPerMonth: 60,
    deepIncludeYears: 2,
    globFileCount: 18,
    globTransactionsPerFile: 90,
    iterations: 2,
    pricedTransactionCount: 1800,
    simpleTransactionCount: 3000,
    warmup: 1,
  },
  medium: {
    deepIncludeMonthsPerYear: 12,
    deepIncludeTransactionCountPerMonth: 120,
    deepIncludeYears: 4,
    globFileCount: 48,
    globTransactionsPerFile: 160,
    iterations: 3,
    pricedTransactionCount: 7000,
    simpleTransactionCount: 12000,
    warmup: 1,
  },
  large: {
    deepIncludeMonthsPerYear: 12,
    deepIncludeTransactionCountPerMonth: 180,
    deepIncludeYears: 6,
    globFileCount: 96,
    globTransactionsPerFile: 220,
    iterations: 2,
    pricedTransactionCount: 16000,
    simpleTransactionCount: 30000,
    warmup: 1,
  },
  enterprise: {
    deepIncludeMonthsPerYear: 12,
    deepIncludeTransactionCountPerMonth: 360,
    deepIncludeYears: 10,
    globFileCount: 240,
    globTransactionsPerFile: 600,
    iterations: 2,
    pricedTransactionCount: 60000,
    simpleTransactionCount: 120000,
    warmup: 1,
  },
};

const ACCOUNT_DIRECTIVES = [
  'account Assets:Bank:Checking',
  'account Assets:Investment:Brokerage:CAD',
  'account Assets:Investment:Brokerage:USD',
  'account Equity:OpeningBalances',
  'account Equity:Virtual:Brokerage',
  'account Expenses:Food',
  'account Expenses:Housing',
  'account Expenses:Transportation',
  'account Expenses:Utilities',
  'account Income:Salary',
];

const COMMODITY_DIRECTIVES = [
  'commodity CAD 1.00',
  'commodity USD 1.00',
  'commodity "HSUV.U"',
  'commodity "VEQT"',
  'commodity "XSP"',
  'commodity "CASH"',
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const preset = PRESETS[options.preset];

  if (!preset) {
    throw new Error(`Unknown preset "${options.preset}". Expected one of: ${Object.keys(PRESETS).join(', ')}`);
  }

  const config = {
    ...preset,
    iterations: options.iterations ?? preset.iterations,
    warmup: options.warmup ?? preset.warmup,
  };
  const scenarios = buildScenarios(config).filter((scenario) =>
    options.filter ? scenario.name.includes(options.filter) : true,
  );

  if (scenarios.length === 0) {
    throw new Error(`No benchmark scenarios matched filter "${options.filter}".`);
  }

  const results = [];

  for (const scenario of scenarios) {
    console.log(`\n[bench] ${scenario.name}`);
    console.log(`[bench] ${scenario.description}`);
    const context = await scenario.setup();

    for (let index = 0; index < config.warmup; index += 1) {
      await scenario.run(context, index);
    }

    const samples = [];

    for (let index = 0; index < config.iterations; index += 1) {
      const metrics = await scenario.run(context, index);
      ensureHealthyScenario(scenario.name, metrics);
      samples.push(metrics);

      console.log(
        [
          `  iter ${index + 1}/${config.iterations}`,
          `wall ${formatMs(metrics.wallMs)}`,
          `parse ${formatMs(metrics.parseMs)}`,
          `verify ${formatMs(metrics.verifyMs)}`,
          `files ${metrics.fileCount}`,
          `txns ${metrics.transactionCount}`,
          `parsed ${metrics.parsedFileCount}`,
          `reused ${metrics.reusedFileCount}`,
          `heap ${formatMb(metrics.heapUsedMb)}`,
          `rss ${formatMb(metrics.rssMb)}`,
        ].join('  '),
      );
    }

    results.push(summarizeScenario(scenario, context, samples));
  }

  if (options.json) {
    console.log(JSON.stringify({ config, results }, null, 2));
    return;
  }

  console.log('\n[bench] Summary');
  console.table(
    results.map((result) => ({
      scenario: result.name,
      kind: result.kind,
      files: result.dataset.fileCount,
      txns: result.dataset.transactionCount,
      wall_avg_ms: result.wallMs.avg.toFixed(2),
      wall_p50_ms: result.wallMs.p50.toFixed(2),
      parse_avg_ms: result.parseMs.avg.toFixed(2),
      verify_avg_ms: result.verifyMs.avg.toFixed(2),
      parsed_avg: result.parsedFileCount.avg.toFixed(2),
      reused_avg: result.reusedFileCount.avg.toFixed(2),
      heap_avg_mb: result.heapUsedMb.avg.toFixed(1),
      rss_avg_mb: result.rssMb.avg.toFixed(1),
    })),
  );
}

function buildScenarios(config) {
  return [
    {
      description: 'Large single-file journal with simple CAD transactions and elided balancing postings.',
      kind: 'full',
      name: 'single-file-simple-full',
      async setup() {
        const workspace = buildSingleFileWorkspace({
          mode: 'simple',
          transactionCount: config.simpleTransactionCount,
        });

        return {
          ...workspace,
          dataset: {
            fileCount: workspace.documents.size,
            transactionCount: config.simpleTransactionCount,
          },
        };
      },
      async run(context) {
        return runFullAnalysis(context.documents, context.rootFilePath);
      },
    },
    {
      description: 'Large single-file journal with quoted commodities plus @ and @@ price annotations.',
      kind: 'full',
      name: 'single-file-priced-full',
      async setup() {
        const workspace = buildSingleFileWorkspace({
          mode: 'priced',
          transactionCount: config.pricedTransactionCount,
        });

        return {
          ...workspace,
          dataset: {
            fileCount: workspace.documents.size,
            transactionCount: config.pricedTransactionCount,
          },
        };
      },
      async run(context) {
        return runFullAnalysis(context.documents, context.rootFilePath);
      },
    },
    {
      description: 'Deep static include graph with account and commodity declarations split into config files.',
      kind: 'full',
      name: 'deep-include-full',
      async setup() {
        const workspace = buildDeepIncludeWorkspace(config);

        return {
          ...workspace,
          dataset: {
            fileCount: workspace.documents.size,
            transactionCount: workspace.transactionCount,
          },
        };
      },
      async run(context) {
        return runFullAnalysis(context.documents, context.rootFilePath);
      },
    },
    {
      description: 'Glob include workspace baseline with many monthly files.',
      kind: 'full',
      name: 'glob-workspace-full',
      async setup() {
        const workspace = buildGlobWorkspace(config);

        return {
          ...workspace,
          dataset: {
            fileCount: workspace.documents.size,
            transactionCount: workspace.transactionCount,
          },
        };
      },
      async run(context) {
        return runFullAnalysis(context.documents, context.rootFilePath);
      },
    },
    {
      description: 'Incremental edit of one existing monthly journal in a large glob-included workspace.',
      kind: 'incremental',
      name: 'incremental-leaf-edit',
      async setup() {
        const workspace = buildGlobWorkspace(config);
        const seeded = await seedIncrementalState(workspace.documents, workspace.rootFilePath);
        const targetMonthIndex = Math.max(0, config.globFileCount - 1);
        const targetPath = `monthly/${formatGlobMonth(targetMonthIndex)}.journal`;
        const original = workspace.documents.get(targetPath);

        if (!original) {
          throw new Error(`Missing benchmark target file: ${targetPath}`);
        }

        return {
          ...workspace,
          baseState: seeded.state,
          dataset: {
            fileCount: workspace.documents.size,
            transactionCount: workspace.transactionCount,
          },
          targetPath,
          updatedDocument: createLedgerDocument(
            targetPath,
            `${original.content}\n${buildMonthlyTransaction({
              entryIndex: config.globTransactionsPerFile,
              monthIndex: targetMonthIndex,
            })}`,
            2,
          ),
        };
      },
      async run(context) {
        return runIncrementalAnalysis(
          context.baseState,
          context.rootFilePath,
          [{ document: context.updatedDocument, type: 'upsert' }],
        );
      },
    },
    {
      description: 'Worst-case incremental edit near the start of the ordered transaction stream.',
      kind: 'incremental',
      name: 'incremental-early-edit',
      async setup() {
        const workspace = buildGlobWorkspace(config);
        const seeded = await seedIncrementalState(workspace.documents, workspace.rootFilePath);
        const targetMonthIndex = 0;
        const targetPath = `monthly/${formatGlobMonth(targetMonthIndex)}.journal`;

        return {
          ...workspace,
          baseState: seeded.state,
          dataset: {
            fileCount: workspace.documents.size,
            transactionCount: workspace.transactionCount,
          },
          targetPath,
          updatedDocument: createLedgerDocument(
            targetPath,
            buildMonthlyJournal({
              monthIndex: targetMonthIndex,
              transactionCount: config.globTransactionsPerFile,
              transformTransaction(transaction, info) {
                if (info.entryIndex !== 1) {
                  return transaction;
                }

                return transaction.replace('CAD 6.34', 'CAD 16.34');
              },
            }),
            2,
          ),
        };
      },
      async run(context) {
        return runIncrementalAnalysis(
          context.baseState,
          context.rootFilePath,
          [{ document: context.updatedDocument, type: 'upsert' }],
        );
      },
    },
    {
      description: 'Incremental addition of a new file matched by a root glob include.',
      kind: 'incremental',
      name: 'incremental-glob-add',
      async setup() {
        const workspace = buildGlobWorkspace(config);
        const seeded = await seedIncrementalState(workspace.documents, workspace.rootFilePath);
        const targetMonthIndex = config.globFileCount;
        const targetPath = `monthly/${formatGlobMonth(targetMonthIndex)}.journal`;

        return {
          ...workspace,
          addedDocument: createLedgerDocument(
            targetPath,
            buildMonthlyJournal({
              monthIndex: targetMonthIndex,
              transactionCount: Math.max(24, Math.floor(config.globTransactionsPerFile / 2)),
            }),
            2,
          ),
          baseState: seeded.state,
          dataset: {
            fileCount: workspace.documents.size,
            transactionCount: workspace.transactionCount,
          },
        };
      },
      async run(context) {
        return runIncrementalAnalysis(
          context.baseState,
          context.rootFilePath,
          [{ document: context.addedDocument, type: 'upsert' }],
        );
      },
    },
    {
      description: 'Incremental edit of a declaration file that invalidates global account strictness.',
      kind: 'incremental',
      name: 'incremental-declaration-edit',
      async setup() {
        const workspace = buildGlobWorkspace(config);
        const seeded = await seedIncrementalState(workspace.documents, workspace.rootFilePath);
        const targetPath = 'config/accounts.journal';
        const original = workspace.documents.get(targetPath);

        if (!original) {
          throw new Error(`Missing benchmark target file: ${targetPath}`);
        }

        return {
          ...workspace,
          baseState: seeded.state,
          dataset: {
            fileCount: workspace.documents.size,
            transactionCount: workspace.transactionCount,
          },
          targetPath,
          updatedDocument: createLedgerDocument(
            targetPath,
            `${original.content.trimEnd()}\naccount Expenses:Legal\n`,
            2,
          ),
        };
      },
      async run(context) {
        return runIncrementalAnalysis(
          context.baseState,
          context.rootFilePath,
          [{ document: context.updatedDocument, type: 'upsert' }],
        );
      },
    },
    {
      description: 'Incremental deletion of a file matched by a root glob include.',
      kind: 'incremental',
      name: 'incremental-glob-delete',
      async setup() {
        const workspace = buildGlobWorkspace(config);
        const seeded = await seedIncrementalState(workspace.documents, workspace.rootFilePath);

        return {
          ...workspace,
          baseState: seeded.state,
          dataset: {
            fileCount: workspace.documents.size,
            transactionCount: workspace.transactionCount,
          },
          deletedPath: `monthly/${formatGlobMonth(Math.floor(config.globFileCount / 2))}.journal`,
        };
      },
      async run(context) {
        return runIncrementalAnalysis(
          context.baseState,
          context.rootFilePath,
          [{ path: context.deletedPath, type: 'delete' }],
        );
      },
    },
    {
      description: 'Repeated analysis of an unchanged state to expose pure cached-materialization cost.',
      kind: 'incremental',
      name: 'incremental-noop-analysis',
      async setup() {
        const workspace = buildGlobWorkspace(config);
        const seeded = await seedIncrementalState(workspace.documents, workspace.rootFilePath);

        return {
          ...workspace,
          baseState: seeded.state,
          dataset: {
            fileCount: workspace.documents.size,
            transactionCount: workspace.transactionCount,
          },
        };
      },
      async run(context) {
        return runStateAnalysis(context.baseState, context.rootFilePath);
      },
    },
  ];
}

async function runFullAnalysis(documents, rootFilePath) {
  const startedAt = performance.now();
  const { analysis, workspace } = await analyzeLedgerDocuments(documents, {
    rootFilePaths: [rootFilePath],
    verifyOptions: verifyOptionsForPaths(documents.keys(), rootFilePath),
  });

  return metricsFromRun({
    analysis,
    parsedFileCount: workspace.files.length,
    reusedFileCount: workspace.reusedFileCount,
    wallMs: performance.now() - startedAt,
  });
}

async function seedIncrementalState(documents, rootFilePath) {
  const seeded = await analyzeLedgerDocuments(documents, {
    rootFilePaths: [rootFilePath],
    verifyOptions: verifyOptionsForPaths(documents.keys(), rootFilePath),
  });

  ensureHealthyScenario('incremental-seed', metricsFromRun({
    analysis: seeded.analysis,
    parsedFileCount: seeded.workspace.files.length,
    reusedFileCount: seeded.workspace.reusedFileCount,
    wallMs: seeded.analysis.timings.totalMs,
  }));

  return seeded;
}

async function runIncrementalAnalysis(baseState, rootFilePath, changes) {
  const startedAt = performance.now();
  const nextState = await applyLedgerDocumentChanges(baseState, changes);
  const { analysis } = analyzeLedgerState(nextState, {
    availableFilePaths: Array.from(nextState.documentsByPath.keys()),
    rootFilePaths: [rootFilePath],
  });

  return metricsFromRun({
    analysis,
    parsedFileCount: nextState.lastUpdateStats.parsedFileCount,
    reusedFileCount: nextState.lastUpdateStats.reusedFileCount,
    wallMs: performance.now() - startedAt,
  });
}

async function runStateAnalysis(baseState, rootFilePath) {
  const startedAt = performance.now();
  const { analysis } = analyzeLedgerState(baseState, {
    availableFilePaths: Array.from(baseState.documentsByPath.keys()),
    rootFilePaths: [rootFilePath],
  });

  return {
    ...metricsFromRun({
      analysis,
      parsedFileCount: 0,
      reusedFileCount: baseState.parsedFilesByPath.size,
      wallMs: performance.now() - startedAt,
    }),
    parseMs: 0,
  };
}

function metricsFromRun({ analysis, parsedFileCount, reusedFileCount, wallMs }) {
  const memory = process.memoryUsage();

  return {
    diagnosticMessages: analysis.diagnostics.map((diagnostic) => diagnostic.message),
    diagnosticsCount: analysis.diagnostics.length,
    fileCount: analysis.parserSummary.fileCount,
    heapUsedMb: memory.heapUsed / BYTES_PER_MB,
    parsedFileCount,
    parseMs: analysis.timings.parseMs,
    parserErrorCount: analysis.parserSummary.errorNodeCount,
    reusedFileCount,
    rssMb: memory.rss / BYTES_PER_MB,
    transactionCount: analysis.summary.transactionCount,
    verifyMs: analysis.timings.verifyMs,
    wallMs,
  };
}

function ensureHealthyScenario(name, metrics) {
  if (metrics.parserErrorCount > 0) {
    throw new Error(`${name}: benchmark fixture produced ${metrics.parserErrorCount} parser error nodes.`);
  }

  if (metrics.diagnosticsCount > 0) {
    throw new Error(`${name}: benchmark fixture produced diagnostics:\n${metrics.diagnosticMessages.join('\n')}`);
  }
}

function summarizeScenario(scenario, context, samples) {
  return {
    dataset: context.dataset,
    heapUsedMb: summarizeMetric(samples.map((sample) => sample.heapUsedMb)),
    kind: scenario.kind,
    name: scenario.name,
    parseMs: summarizeMetric(samples.map((sample) => sample.parseMs)),
    parsedFileCount: summarizeMetric(samples.map((sample) => sample.parsedFileCount)),
    rssMb: summarizeMetric(samples.map((sample) => sample.rssMb)),
    reusedFileCount: summarizeMetric(samples.map((sample) => sample.reusedFileCount)),
    verifyMs: summarizeMetric(samples.map((sample) => sample.verifyMs)),
    wallMs: summarizeMetric(samples.map((sample) => sample.wallMs)),
  };
}

function summarizeMetric(values) {
  const sorted = [...values].sort((left, right) => left - right);

  return {
    avg: average(values),
    max: sorted[sorted.length - 1] ?? 0,
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
  };
}

function average(values) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(sortedValues, ratio) {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.floor((sortedValues.length - 1) * ratio)),
  );

  return sortedValues[index];
}

function buildSingleFileWorkspace({ mode, transactionCount }) {
  const rootFilePath = 'main.journal';
  const directives = [
    ...ACCOUNT_DIRECTIVES,
    '',
    ...COMMODITY_DIRECTIVES,
    '',
  ].join('\n');
  const transactions = [];

  for (let index = 0; index < transactionCount; index += 1) {
    transactions.push(
      mode === 'priced' ? buildPricedTransaction(index) : buildSimpleTransaction(index),
    );
  }

  return {
    documents: new Map([
      [rootFilePath, createLedgerDocument(rootFilePath, `${directives}${transactions.join('\n')}`)],
    ]),
    rootFilePath,
    transactionCount,
  };
}

function buildDeepIncludeWorkspace(config) {
  const documents = new Map();
  const years = [];
  let transactionCount = 0;

  documents.set(
    'config/accounts.journal',
    createLedgerDocument('config/accounts.journal', `${ACCOUNT_DIRECTIVES.join('\n')}\n`),
  );
  documents.set(
    'config/commodities.journal',
    createLedgerDocument('config/commodities.journal', `${COMMODITY_DIRECTIVES.join('\n')}\n`),
  );

  for (let yearOffset = 0; yearOffset < config.deepIncludeYears; yearOffset += 1) {
    const year = 2022 + yearOffset;
    years.push(year);
    const monthPaths = [];

    for (let month = 1; month <= config.deepIncludeMonthsPerYear; month += 1) {
      const monthPath = `months/${year}-${String(month).padStart(2, '0')}.journal`;
      monthPaths.push(monthPath);
      const content = buildMonthlyJournal({
        monthIndex: yearOffset * config.deepIncludeMonthsPerYear + (month - 1),
        transactionCount: config.deepIncludeTransactionCountPerMonth,
      });
      documents.set(monthPath, createLedgerDocument(monthPath, content));
      transactionCount += config.deepIncludeTransactionCountPerMonth;
    }

    documents.set(
      `years/${year}.journal`,
      createLedgerDocument(
        `years/${year}.journal`,
        `${monthPaths.map((path) => `include ../${path}`).join('\n')}\n`,
      ),
    );
  }

  documents.set(
    'main.journal',
    createLedgerDocument(
      'main.journal',
      [
        'include config/accounts.journal',
        'include config/commodities.journal',
        ...years.map((year) => `include years/${year}.journal`),
        '',
      ].join('\n'),
    ),
  );

  return {
    documents,
    rootFilePath: 'main.journal',
    transactionCount,
  };
}

function buildGlobWorkspace(config) {
  const documents = new Map();
  let transactionCount = 0;

  documents.set(
    'config/accounts.journal',
    createLedgerDocument('config/accounts.journal', `${ACCOUNT_DIRECTIVES.join('\n')}\n`),
  );
  documents.set(
    'config/commodities.journal',
    createLedgerDocument('config/commodities.journal', `${COMMODITY_DIRECTIVES.join('\n')}\n`),
  );
  documents.set(
    'main.journal',
    createLedgerDocument(
      'main.journal',
      [
        'include config/accounts.journal',
        'include config/commodities.journal',
        'include monthly/*.journal',
        '',
      ].join('\n'),
    ),
  );

  for (let index = 0; index < config.globFileCount; index += 1) {
    const monthPath = `monthly/${formatGlobMonth(index)}.journal`;
    documents.set(
      monthPath,
      createLedgerDocument(
        monthPath,
        buildMonthlyJournal({
          monthIndex: index,
          transactionCount: config.globTransactionsPerFile,
        }),
      ),
    );
    transactionCount += config.globTransactionsPerFile;
  }

  return {
    documents,
    rootFilePath: 'main.journal',
    transactionCount,
  };
}

function buildMonthlyJournal({ monthIndex, transactionCount, transformTransaction = null }) {
  const entries = [];

  for (let entryIndex = 0; entryIndex < transactionCount; entryIndex += 1) {
    const transaction = buildMonthlyTransaction({ entryIndex, monthIndex });
    entries.push(
      transformTransaction
        ? transformTransaction(transaction, { entryIndex, monthIndex })
        : transaction,
    );
  }

  return `${entries.join('\n')}\n`;
}

function buildMonthlyTransaction({ entryIndex, monthIndex }) {
  const globalIndex = monthIndex * 10_000 + entryIndex;
  const date = dateForMonthEntry(monthIndex, entryIndex);

  return globalIndex % 5 === 0
    ? buildPricedTransaction(globalIndex, date)
    : buildSimpleTransaction(globalIndex, date);
}

function buildSimpleTransaction(index, date = dateForIndex(index)) {
  const expenseAccount = [
    'Expenses:Food',
    'Expenses:Housing',
    'Expenses:Transportation',
    'Expenses:Utilities',
  ][index % 4];
  const amount = ((index % 37) + 1) * 3.17;

  return [
    `${date} Expense ${index}`,
    `  ${expenseAccount}  CAD ${formatFixed(amount, 2)}`,
    '  Assets:Bank:Checking',
    '',
  ].join('\n');
}

function buildPricedTransaction(index, date = dateForIndex(index + 91)) {
  const symbol = ['"HSUV.U"', '"VEQT"', '"XSP"', '"CASH"'][index % 4];

  if (index % 7 === 0) {
    const usdTotal = roundTo(250 + (index % 23) * 17.35, 2);
    const cadTotal = roundTo(usdTotal * (1.18 + (index % 5) * 0.013), 2);

    return [
      `${date} FX transfer ${index}`,
      `  Equity:Virtual:Brokerage  USD -${formatFixed(usdTotal, 2)} @@ CAD ${formatFixed(cadTotal, 2)}`,
      `  Equity:Virtual:Brokerage  CAD ${formatFixed(cadTotal, 2)}`,
      '',
    ].join('\n');
  }

  const quantity = roundTo(10 + (index % 31) * 0.75 + (index % 3) * 0.125, 4);
  const unitPrice = roundTo(25 + (index % 19) * 2.15 + (index % 7) * 0.0137, 4);
  const cashAmount = roundTo(quantity * unitPrice, 2);

  return [
    `${date} Buy ${symbol} ${index}`,
    `  Assets:Investment:Brokerage:USD  ${formatFixed(quantity, 4)} ${symbol} @ USD ${formatFixed(unitPrice, 4)}`,
    `  Assets:Investment:Brokerage:USD  USD -${formatFixed(cashAmount, 2)}`,
    '',
  ].join('\n');
}

function createLedgerDocument(path, content, lastModified = 1) {
  return {
    content,
    isLedger: true,
    lastModified,
    name: path.split('/').pop() ?? path,
    path,
  };
}

function verifyOptionsForPaths(paths, rootFilePath) {
  return {
    availableFilePaths: Array.from(paths),
    rootFilePaths: [rootFilePath],
  };
}

function formatGlobMonth(index) {
  const year = 2024 + Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

function dateForIndex(index) {
  const date = new Date(Date.UTC(2024, 0, 1 + index));
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateForMonthEntry(monthIndex, entryIndex) {
  const year = 2024 + Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  const day = String((entryIndex % 28) + 1).padStart(2, '0');
  return `${year}-${String(month).padStart(2, '0')}-${day}`;
}

function roundTo(value, precision) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function formatFixed(value, precision) {
  return roundTo(value, precision).toFixed(precision);
}

function formatMs(value) {
  return `${value.toFixed(2)}ms`;
}

function formatMb(value) {
  return `${value.toFixed(1)}MB`;
}

function parseArgs(argv) {
  const options = {
    filter: '',
    iterations: null,
    json: false,
    preset: 'medium',
    warmup: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (arg === '--preset') {
      options.preset = argv[index + 1] ?? options.preset;
      index += 1;
      continue;
    }

    if (arg === '--iterations') {
      options.iterations = Number(argv[index + 1] ?? options.iterations);
      index += 1;
      continue;
    }

    if (arg === '--warmup') {
      options.warmup = Number(argv[index + 1] ?? options.warmup);
      index += 1;
      continue;
    }

    if (arg === '--filter') {
      options.filter = argv[index + 1] ?? options.filter;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.iterations != null && (!Number.isFinite(options.iterations) || options.iterations <= 0)) {
    throw new Error(`Invalid --iterations value: ${options.iterations}`);
  }

  if (options.warmup != null && (!Number.isFinite(options.warmup) || options.warmup < 0)) {
    throw new Error(`Invalid --warmup value: ${options.warmup}`);
  }

  return options;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
