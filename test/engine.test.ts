import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeLedgerDocuments,
  analyzeLedgerState,
  applyLedgerDocumentChanges,
  createLedgerEngineState,
} from '../src';

test('declaration directives are order-insensitive', async () => {
  const documents = new Map([
    [
      'main.journal',
      {
        content: `2024-01-01 Lunch
  Expenses:Food  $10.00
  Assets:Cash

account Assets:Cash
account Expenses:Food
commodity $1.00
`,
        isLedger: true,
        name: 'main.journal',
        path: 'main.journal',
      },
    ],
  ]);

  const { analysis } = await analyzeLedgerDocuments(documents, {
    rootFilePaths: ['main.journal'],
    verifyOptions: {
      availableFilePaths: ['main.journal'],
      rootFilePaths: ['main.journal'],
    },
  });

  assert.equal(
    analysis.diagnostics.some((diagnostic) => diagnostic.message.includes('Undeclared')),
    false,
  );
  assert.equal(analysis.register.length, 2);
});

test('missing amounts are inferred inside the real-posting balance group', async () => {
  const documents = new Map([
    [
      'main.journal',
      {
        content: `2024-01-01 Lunch
  Expenses:Food  $10.00
  Assets:Cash
`,
        isLedger: true,
        name: 'main.journal',
        path: 'main.journal',
      },
    ],
  ]);

  const { analysis } = await analyzeLedgerDocuments(documents, {
    rootFilePaths: ['main.journal'],
    verifyOptions: {
      availableFilePaths: ['main.journal'],
      rootFilePaths: ['main.journal'],
    },
  });

  const inferred = analysis.register.find((entry) => entry.account === 'Assets:Cash');
  assert.ok(inferred);
  assert.equal(inferred.amount, -10);
  assert.equal(inferred.inferredAmount, true);
});

test('missing amounts can infer zero when balancing against a single zero commodity total', async () => {
  const documents = new Map([
    [
      'main.journal',
      {
        content: `2015-01-26 * opening balances ; account open
  assets:bank:td:checking_4506  CAD 0.00
  equity:opening-balances
`,
        isLedger: true,
        name: 'main.journal',
        path: 'main.journal',
      },
    ],
  ]);

  const { analysis } = await analyzeLedgerDocuments(documents, {
    rootFilePaths: ['main.journal'],
    verifyOptions: {
      availableFilePaths: ['main.journal'],
      rootFilePaths: ['main.journal'],
    },
  });

  const inferred = analysis.register.find((entry) => entry.account === 'equity:opening-balances');
  assert.ok(inferred);
  assert.equal(inferred.amount, 0);
  assert.equal(inferred.commodity, 'CAD');
  assert.equal(inferred.inferredAmount, true);
  assert.equal(
    analysis.diagnostics.some((diagnostic) =>
      diagnostic.message.includes('there is nothing to balance against'),
    ),
    false,
  );
});

test('priced postings balance against their cost commodity totals', async () => {
  const documents = new Map([
    [
      'main.journal',
      {
        content: `2024-01-12 Buy 3.9492 VEQT @ CAD 36.8122
  assets:investment:ws:fhsa  3.9492 VEQT @ CAD 36.8122
  assets:investment:ws:fhsa  CAD -145.38

2024-02-14 Buy 12.00 VEQT @ CAD 38.05
  assets:investment:ws:fhsa  12.00 VEQT @ CAD 38.05
  assets:investment:ws:fhsa  CAD -456.60
`,
        isLedger: true,
        name: 'main.journal',
        path: 'main.journal',
      },
    ],
  ]);

  const { analysis } = await analyzeLedgerDocuments(documents, {
    rootFilePaths: ['main.journal'],
    verifyOptions: {
      availableFilePaths: ['main.journal'],
      rootFilePaths: ['main.journal'],
    },
  });

  assert.equal(
    analysis.diagnostics.some((diagnostic) =>
      diagnostic.message.includes('Automatic commodity conversion is not enabled'),
    ),
    false,
  );
  assert.equal(
    analysis.diagnostics.some((diagnostic) =>
      diagnostic.message.includes('does not balance'),
    ),
    false,
  );
});

test('total price annotations are used for balancing', async () => {
  const documents = new Map([
    [
      'main.journal',
      {
        content: `2024-01-01
  a  1 USD @@ 1 EUR
  a  -2 USD @@ -1 EUR
`,
        isLedger: true,
        name: 'main.journal',
        path: 'main.journal',
      },
    ],
  ]);

  const { analysis } = await analyzeLedgerDocuments(documents, {
    rootFilePaths: ['main.journal'],
    verifyOptions: {
      availableFilePaths: ['main.journal'],
      rootFilePaths: ['main.journal'],
    },
  });

  assert.equal(
    analysis.diagnostics.some((diagnostic) =>
      diagnostic.message.includes('does not balance'),
    ),
    false,
  );
});

test('total price annotations inherit the posting sign for balancing', async () => {
  const documents = new Map([
    [
      'main.journal',
      {
        content: `2025-03-03 FX reconciliation: TFSA USD→CAD transfer
  equity:virtual:ws:internal_transfer  USD -899.22 @@ CAD 1,273.15
  equity:virtual:ws:internal_transfer  CAD 1,273.15
`,
        isLedger: true,
        name: 'main.journal',
        path: 'main.journal',
      },
    ],
  ]);

  const { analysis } = await analyzeLedgerDocuments(documents, {
    rootFilePaths: ['main.journal'],
    verifyOptions: {
      availableFilePaths: ['main.journal'],
      rootFilePaths: ['main.journal'],
    },
  });

  assert.equal(
    analysis.diagnostics.some((diagnostic) =>
      diagnostic.message.includes('does not balance for CAD'),
    ),
    false,
  );
});

test('simple balance assignments are inferred from assertions', async () => {
  const documents = new Map([
    [
      'main.journal',
      {
        content: `2024-01-01 Opening
  (a)  = 1
`,
        isLedger: true,
        name: 'main.journal',
        path: 'main.journal',
      },
    ],
  ]);

  const { analysis } = await analyzeLedgerDocuments(documents, {
    rootFilePaths: ['main.journal'],
    verifyOptions: {
      availableFilePaths: ['main.journal'],
      rootFilePaths: ['main.journal'],
    },
  });

  assert.equal(analysis.register.length, 1);
  assert.equal(analysis.register[0]?.amount, 1);
  assert.equal(analysis.register[0]?.inferredAmount, true);
});

test('failed balance assertions surface as diagnostics', async () => {
  const documents = new Map([
    [
      'main.journal',
      {
        content: `2024-01-01
  a  0 = 1
`,
        isLedger: true,
        name: 'main.journal',
        path: 'main.journal',
      },
    ],
  ]);

  const { analysis } = await analyzeLedgerDocuments(documents, {
    rootFilePaths: ['main.journal'],
    verifyOptions: {
      availableFilePaths: ['main.journal'],
      rootFilePaths: ['main.journal'],
    },
  });

  assert.equal(
    analysis.diagnostics.some((diagnostic) =>
      diagnostic.message.includes('Balance assertion failed in a'),
    ),
    true,
  );
});

test('unmatched include globs become parser diagnostics', async () => {
  const documents = new Map([
    [
      'main.journal',
      {
        content: `include nosuchfile*

2024-01-01
  a  1
  b -1
`,
        isLedger: true,
        name: 'main.journal',
        path: 'main.journal',
      },
    ],
  ]);

  const { analysis } = await analyzeLedgerDocuments(documents, {
    rootFilePaths: ['main.journal'],
    verifyOptions: {
      availableFilePaths: ['main.journal'],
      rootFilePaths: ['main.journal'],
    },
  });

  assert.equal(
    analysis.diagnostics.some((diagnostic) =>
      diagnostic.message.includes('No files were matched by: nosuchfile*'),
    ),
    true,
  );
});

test('undeclared accounts are reported even when validation is order-insensitive', async () => {
  const documents = new Map([
    [
      'main.journal',
      {
        content: `account Assets:Cash

2024-01-01
  Assets:Cash  1
  Expenses:Food  -1
`,
        isLedger: true,
        name: 'main.journal',
        path: 'main.journal',
      },
    ],
  ]);

  const { analysis } = await analyzeLedgerDocuments(documents, {
    rootFilePaths: ['main.journal'],
    verifyOptions: {
      availableFilePaths: ['main.journal'],
      rootFilePaths: ['main.journal'],
    },
  });

  assert.equal(
    analysis.diagnostics.some((diagnostic) =>
      diagnostic.message.includes('Undeclared account "Expenses:Food"'),
    ),
    true,
  );
});

test('undeclared commodities are reported from commodity directives', async () => {
  const documents = new Map([
    [
      'main.journal',
      {
        content: `commodity USD 1.00

2024-01-01
  Assets:Cash  -1 USD
  Income:Other  1 EUR
`,
        isLedger: true,
        name: 'main.journal',
        path: 'main.journal',
      },
    ],
  ]);

  const { analysis } = await analyzeLedgerDocuments(documents, {
    rootFilePaths: ['main.journal'],
    verifyOptions: {
      availableFilePaths: ['main.journal'],
      rootFilePaths: ['main.journal'],
    },
  });

  assert.equal(
    analysis.diagnostics.some((diagnostic) =>
      diagnostic.message.includes('Undeclared commodity "EUR"'),
    ),
    true,
  );
});

test('quoted commodity directives declare quoted posting commodities', async () => {
  const documents = new Map([
    [
      'main.journal',
      {
        content: `commodity USD 1.00
commodity "HSUV.U"

2024-03-01 Buy
  Assets:Investment:WS:NonRegisteredUSD  230.00 "HSUV.U" @ USD 108.67
  Assets:Investment:WS:NonRegisteredUSD  USD -24994.10
`,
        isLedger: true,
        name: 'main.journal',
        path: 'main.journal',
      },
    ],
  ]);

  const { analysis } = await analyzeLedgerDocuments(documents, {
    rootFilePaths: ['main.journal'],
    verifyOptions: {
      availableFilePaths: ['main.journal'],
      rootFilePaths: ['main.journal'],
    },
  });

  assert.equal(analysis.declaredCommodities.includes('"HSUV.U"'), true);
  assert.equal(
    analysis.diagnostics.some((diagnostic) =>
      diagnostic.message.includes('Undeclared commodity ""HSUV.U""'),
    ),
    false,
  );
});

test('balanced virtual postings must balance among themselves', async () => {
  const documents = new Map([
    [
      'main.journal',
      {
        content: `2024-01-01
  Assets:Cash  1 USD
  Equity       -1 USD
  [Check]      5 USD
  [Other]     -1 EUR
`,
        isLedger: true,
        name: 'main.journal',
        path: 'main.journal',
      },
    ],
  ]);

  const { analysis } = await analyzeLedgerDocuments(documents, {
    rootFilePaths: ['main.journal'],
    verifyOptions: {
      availableFilePaths: ['main.journal'],
      rootFilePaths: ['main.journal'],
    },
  });

  assert.equal(
    analysis.diagnostics.some((diagnostic) =>
      diagnostic.message.includes('balanced virtual postings'),
    ),
    true,
  );
});

test('search indexes are populated for register and transaction outputs', async () => {
  const documents = new Map([
    [
      'main.journal',
      {
        content: `2024-01-01 Lunch
  Expenses:Food  $10.00
  Assets:Cash   $-10.00
`,
        isLedger: true,
        name: 'main.journal',
        path: 'main.journal',
      },
    ],
  ]);

  const { analysis } = await analyzeLedgerDocuments(documents, {
    rootFilePaths: ['main.journal'],
    verifyOptions: {
      availableFilePaths: ['main.journal'],
      rootFilePaths: ['main.journal'],
    },
  });

  const cashIds = analysis.index.registerIdsByAccount['Assets:Cash'] ?? [];
  const transactionIds = analysis.index.transactionIdsByPath['main.journal'] ?? [];

  assert.equal(cashIds.length, 1);
  assert.equal(transactionIds.length, 1);
  assert.equal(
    analysis.index.registerPositionById[cashIds[0] ?? 'missing'] >= 0,
    true,
  );
});

test('incremental analysis reuses unchanged verified prefixes after a later file edit', async () => {
  let state = createLedgerEngineState();
  const baseDocument = {
    content: `2024-01-01 Opening
  Assets:Cash  10 USD
  Equity:OpeningBalances  -10 USD

2024-01-02 Lunch
  Expenses:Food  4 USD
  Assets:Cash  -4 USD
`,
    isLedger: true,
    name: 'main.journal',
    path: 'main.journal',
  };

  state = await applyLedgerDocumentChanges(
    state,
    [{ document: baseDocument, type: 'upsert' }],
  );

  const firstRun = analyzeLedgerState(state, {
    availableFilePaths: ['main.journal'],
    rootFilePaths: ['main.journal'],
  });
  const firstCache = firstRun.state.verificationCache;

  assert.ok(firstCache);
  assert.equal(firstCache.fragments.length, 2);

  state = await applyLedgerDocumentChanges(firstRun.state, [
    {
      document: {
        ...baseDocument,
        content: `2024-01-01 Opening
  Assets:Cash  10 USD
  Equity:OpeningBalances  -10 USD

2024-01-02 Lunch
  Expenses:Food  6 USD
  Assets:Cash  -6 USD
`,
      },
      type: 'upsert',
    },
  ]);

  const secondRun = analyzeLedgerState(state, {
    availableFilePaths: ['main.journal'],
    rootFilePaths: ['main.journal'],
  });
  const secondCache = secondRun.state.verificationCache;

  assert.ok(secondCache);
  assert.equal(secondRun.analysis.diagnostics.length, 0);
  assert.equal(secondRun.analysis.transactions.length, 2);
  assert.strictEqual(secondCache.fragments[0], firstCache.fragments[0]);
  assert.notStrictEqual(secondCache.fragments[1], firstCache.fragments[1]);
});
