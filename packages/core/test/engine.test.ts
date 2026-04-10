import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeLedgerDocuments,
  createLedgerTagKey,
  filterPostings,
  resolveLatestLedgerPrice,
  resolveLedgerPriceOnDate,
} from '../src';
import {
  analyzeLedgerState,
  applyLedgerDocumentChanges,
  createLedgerEngineState,
} from '../src/engine';

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
  assert.equal(analysis.postings.length, 2);
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

  const inferred = analysis.postings.find((entry) => entry.account === 'Assets:Cash');
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

  const inferred = analysis.postings.find((entry) => entry.account === 'equity:opening-balances');
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

test('conflicting price directives are reported as diagnostics', async () => {
  const documents = new Map([
    [
      'main.journal',
      {
        content: `P 2024-01-01 USD 1.25 CAD
P 2024-01-01 USD 1.30 CAD
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

  const diagnostics = analysis.diagnostics.filter((diagnostic) =>
    diagnostic.message.includes('Conflicting prices for USD -> CAD on 2024-01-01'),
  );

  assert.equal(diagnostics.length, 2);
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.line),
    [1, 2],
  );
});

test('P directives win over same-day posting-derived prices and do not conflict', async () => {
  const documents = new Map([
    [
      'main.journal',
      {
        content: `P 2024-01-01 VEQT 35 CAD

2024-01-01 Buy
  Assets:Brokerage  1 VEQT @@ CAD 36
  Assets:Cash  CAD -36
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

  const diagnostics = analysis.diagnostics.filter((diagnostic) =>
    diagnostic.message.includes('Conflicting prices for VEQT -> CAD on 2024-01-01'),
  );
  const sameDayPrices = analysis.prices.filter(
    (price) =>
      price.date === '2024-01-01' &&
      price.fromCommodity === 'VEQT' &&
      price.toCommodity === 'CAD',
  );

  assert.equal(diagnostics.length, 0);
  assert.equal(sameDayPrices.length, 2);
  assert.equal(sameDayPrices.at(-1)?.source, 'directive');
  assert.equal(sameDayPrices.at(-1)?.amount, 35);
  assert.equal(sameDayPrices.at(-1)?.line, 1);
});

test('same-day @@ posting-derived prices do not conflict and later prices win', async () => {
  const documents = new Map([
    [
      'main.journal',
      {
        content: `2024-01-01 Buy
  Assets:Brokerage  2 VEQT @@ CAD 20
  Assets:Cash  CAD -20

2024-01-01 Buy more
  Assets:Brokerage  2 VEQT @@ CAD 24
  Assets:Cash  CAD -24
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

  const diagnostics = analysis.diagnostics.filter((diagnostic) =>
    diagnostic.message.includes('Conflicting prices for VEQT -> CAD on 2024-01-01'),
  );
  const sameDayPrices = analysis.prices.filter(
    (price) =>
      price.date === '2024-01-01' &&
      price.fromCommodity === 'VEQT' &&
      price.toCommodity === 'CAD',
  );

  assert.equal(diagnostics.length, 0);
  assert.equal(sameDayPrices.length, 2);
  assert.equal(sameDayPrices.at(-1)?.source, 'posting-annotation');
  assert.equal(sameDayPrices.at(-1)?.amount, 12);
  assert.equal(sameDayPrices.at(-1)?.line, 6);
});

test('price resolution prefers P directives, otherwise later posting-derived prices', async () => {
  const directiveDocuments = new Map([
    [
      'main.journal',
      {
        content: `P 2024-01-01 VEQT 35 CAD

2024-01-01 Buy
  Assets:Brokerage  1 VEQT @@ CAD 36
  Assets:Cash  CAD -36
`,
        isLedger: true,
        name: 'main.journal',
        path: 'main.journal',
      },
    ],
  ]);
  const postingDocuments = new Map([
    [
      'main.journal',
      {
        content: `2024-01-01 Buy
  Assets:Brokerage  2 VEQT @@ CAD 20
  Assets:Cash  CAD -20

2024-01-01 Buy more
  Assets:Brokerage  2 VEQT @@ CAD 24
  Assets:Cash  CAD -24
`,
        isLedger: true,
        name: 'main.journal',
        path: 'main.journal',
      },
    ],
  ]);

  const { analysis: directiveAnalysis } = await analyzeLedgerDocuments(directiveDocuments, {
    rootFilePaths: ['main.journal'],
    verifyOptions: {
      availableFilePaths: ['main.journal'],
      rootFilePaths: ['main.journal'],
    },
  });
  const { analysis: postingAnalysis } = await analyzeLedgerDocuments(postingDocuments, {
    rootFilePaths: ['main.journal'],
    verifyOptions: {
      availableFilePaths: ['main.journal'],
      rootFilePaths: ['main.journal'],
    },
  });

  const directivePrice = resolveLedgerPriceOnDate(directiveAnalysis, {
    date: '2024-01-01',
    fromCommodity: 'VEQT',
    toCommodity: 'CAD',
  });
  const postingPrice = resolveLatestLedgerPrice(postingAnalysis, {
    date: '2024-01-01',
    fromCommodity: 'VEQT',
    toCommodity: 'CAD',
  });

  assert.ok(directivePrice);
  assert.equal(directivePrice.source, 'directive');
  assert.equal(directivePrice.amount, 35);
  assert.equal(directivePrice.line, 1);
  assert.ok(postingPrice);
  assert.equal(postingPrice.source, 'posting-annotation');
  assert.equal(postingPrice.amount, 12);
  assert.equal(postingPrice.line, 6);
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

  assert.equal(analysis.postings.length, 1);
  assert.equal(analysis.postings[0]?.amount, 1);
  assert.equal(analysis.postings[0]?.inferredAmount, true);
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

test('commodity and include metadata are promoted into analysis output', async () => {
  const documents = new Map([
    [
      'main.journal',
      {
        content: `include nested/other.journal
commodity USD

2024-01-01
  Assets:Cash  1 USD
  Income:Other  -1 USD
`,
        isLedger: true,
        name: 'main.journal',
        path: 'main.journal',
      },
    ],
    [
      'nested/other.journal',
      {
        content: `commodity EUR
`,
        isLedger: true,
        name: 'other.journal',
        path: 'nested/other.journal',
      },
    ],
  ]);

  const { analysis } = await analyzeLedgerDocuments(documents, {
    rootFilePaths: ['main.journal'],
    verifyOptions: {
      availableFilePaths: ['main.journal', 'nested/other.journal'],
      rootFilePaths: ['main.journal'],
    },
  });

  assert.deepEqual(analysis.includes.map((record) => record.path), ['main.journal']);
  assert.equal(analysis.includes[0]?.resolved, 'nested/other.journal');
  assert.deepEqual(analysis.includes[0]?.matches, ['nested/other.journal']);

  const usd = analysis.commodities.find((commodity) => commodity.commodity === 'USD');
  const eur = analysis.commodities.find((commodity) => commodity.commodity === 'EUR');

  assert.ok(usd);
  assert.equal(usd.declared, true);
  assert.equal(usd.used, true);
  assert.equal(usd.postingCount, 2);
  assert.deepEqual(usd.paths, ['main.journal']);
  assert.ok(eur);
  assert.equal(eur.declared, true);
  assert.equal(eur.used, false);
  assert.equal(eur.postingCount, 0);
  assert.deepEqual(eur.paths, ['nested/other.journal']);
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

test('search indexes are populated for postings and transaction outputs', async () => {
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

  const cashIds = analysis.index.postingIdsByAccount['Assets:Cash'] ?? [];
  const transactionIds = analysis.index.transactionIdsByPath['main.journal'] ?? [];

  assert.equal(cashIds.length, 1);
  assert.equal(transactionIds.length, 1);
  assert.equal(
    analysis.index.postingPositionById[cashIds[0] ?? 'missing'] >= 0,
    true,
  );
});

test('account directive type annotations drive posting account types', async () => {
  const documents = new Map([
    [
      'main.journal',
      {
        content: `2024-01-01 Paystub
  Payroll:Gross  -100 USD
  Taxes:Federal  30 USD
  CashPool  70 USD

account Payroll:Gross ; type:R
account Taxes:Federal ; type:X
account CashPool ; type:A
commodity USD 1.00
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
    analysis.postings.find((entry) => entry.account === 'Payroll:Gross')?.accountType,
    'income',
  );
  assert.equal(
    analysis.postings.find((entry) => entry.account === 'Taxes:Federal')?.accountType,
    'expense',
  );
  assert.equal(
    analysis.postings.find((entry) => entry.account === 'CashPool')?.accountType,
    'asset',
  );
});

test('account catalog preserves single declarations and heuristic fallback for unannotated accounts', async () => {
  const documents = new Map([
    [
      'main.journal',
      {
        content: `account Expenses:Food ; bucket:household
account Assets:Cash ; type:A
account Equity:OpeningBalances ; type:E
commodity USD 1.00

2024-01-01 Lunch
  Expenses:Food  10 USD
  Assets:Cash  -10 USD
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

  const entry = analysis.accountCatalog.find((account) => account.account === 'Expenses:Food');

  assert.ok(entry);
  assert.equal(entry.declared, true);
  assert.equal(entry.used, true);
  assert.equal(entry.declarationCount, 1);
  assert.equal(entry.postingCount, 1);
  assert.equal(entry.declaredType, null);
  assert.equal(entry.effectiveType, 'expense');
  assert.deepEqual(entry.paths, ['main.journal']);
  assert.deepEqual(entry.tags, [{ name: 'bucket', value: 'household' }]);
  assert.deepEqual(entry.typeAnnotationValues, []);
  assert.deepEqual(entry.typeDiagnostics, []);
  assert.equal(entry.declarations.length, 1);
  assert.equal(entry.declarations[0]?.path, 'main.journal');
  assert.equal(entry.declarations[0]?.line, 1);
  assert.deepEqual(
    analysis.index.accountCatalogIdsByEffectiveType.expense,
    ['Expenses:Food'],
  );
  assert.deepEqual(
    analysis.index.accountCatalogIdsByTag[createLedgerTagKey({ name: 'bucket', value: 'household' })],
    ['Expenses:Food'],
  );
});

test('account catalog merges repeated declarations deterministically', async () => {
  const documents = new Map([
    [
      'main.journal',
      {
        content: `include a.journal
include b.journal

account Assets:Cash ; type:A
commodity USD 1.00

2024-01-01 Lunch
  Expenses:Food  10 USD
  Assets:Cash  -10 USD
`,
        isLedger: true,
        name: 'main.journal',
        path: 'main.journal',
      },
    ],
    [
      'a.journal',
      {
        content: `account Expenses:Food ; type:X, view:taxable
`,
        isLedger: true,
        name: 'a.journal',
        path: 'a.journal',
      },
    ],
    [
      'b.journal',
      {
        content: `account Expenses:Food ; type:expense, bucket:household
`,
        isLedger: true,
        name: 'b.journal',
        path: 'b.journal',
      },
    ],
  ]);

  const { analysis } = await analyzeLedgerDocuments(documents, {
    rootFilePaths: ['main.journal'],
    verifyOptions: {
      availableFilePaths: ['a.journal', 'b.journal', 'main.journal'],
      rootFilePaths: ['main.journal'],
    },
  });

  const entry = analysis.accountCatalog.find((account) => account.account === 'Expenses:Food');

  assert.ok(entry);
  assert.equal(entry.declaredType, 'expense');
  assert.equal(entry.effectiveType, 'expense');
  assert.equal(entry.declarationCount, 2);
  assert.deepEqual(entry.paths, ['a.journal', 'b.journal']);
  assert.deepEqual(entry.typeAnnotationValues, ['X', 'expense']);
  assert.deepEqual(entry.tags, [
    { name: 'view', value: 'taxable' },
    { name: 'bucket', value: 'household' },
  ]);
  assert.deepEqual(
    entry.declarations.map((declaration) => `${declaration.path}:${declaration.line}`),
    ['a.journal:1', 'b.journal:1'],
  );
  assert.deepEqual(
    analysis.index.accountCatalogIdsByPath['a.journal'],
    ['Expenses:Food'],
  );
  assert.deepEqual(
    analysis.index.accountCatalogIdsByTagName.bucket,
    ['Expenses:Food'],
  );
});

test('account catalog marks conflicting explicit declarations as unknown and emits diagnostics', async () => {
  const documents = new Map([
    [
      'main.journal',
      {
        content: `account CashPool ; type:A
account CashPool ; type:X
account Equity:OpeningBalances ; type:E
commodity USD 1.00

2024-01-01 Opening
  CashPool  1 USD
  Equity:OpeningBalances  -1 USD
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

  const entry = analysis.accountCatalog.find((account) => account.account === 'CashPool');

  assert.ok(entry);
  assert.equal(entry.declaredType, 'unknown');
  assert.equal(entry.effectiveType, 'unknown');
  assert.deepEqual(entry.typeAnnotationValues, ['A', 'X']);
  assert.equal(
    analysis.postings.find((registerEntry) => registerEntry.account === 'CashPool')?.accountType,
    'unknown',
  );
  assert.equal(
    analysis.diagnostics.some((diagnostic) =>
      diagnostic.message.includes(
        'Account "CashPool" has conflicting type annotations across declarations.',
      ),
    ),
    true,
  );
});

test('hierarchy type conflicts emit diagnostics without overriding exact-account explicit types', async () => {
  const documents = new Map([
    [
      'main.journal',
      {
        content: `account Assets ; type:A
account Assets:Cash ; type:X
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

  const entry = analysis.accountCatalog.find((account) => account.account === 'Assets:Cash');

  assert.ok(entry);
  assert.equal(entry.declared, true);
  assert.equal(entry.used, false);
  assert.equal(entry.declaredType, 'expense');
  assert.equal(entry.effectiveType, 'expense');
  assert.equal(
    analysis.diagnostics.some((diagnostic) =>
      diagnostic.message.includes(
        'Account "Assets:Cash" is explicitly typed as expense, but ancestor account "Assets" is explicitly typed as asset.',
      ),
    ),
    true,
  );
});

test('declared-only accounts are included in the account catalog', async () => {
  const documents = new Map([
    [
      'main.journal',
      {
        content: `account Assets:Savings ; type:A
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

  const entry = analysis.accountCatalog.find((account) => account.account === 'Assets:Savings');

  assert.ok(entry);
  assert.equal(entry.declared, true);
  assert.equal(entry.used, false);
  assert.equal(entry.postingCount, 0);
  assert.deepEqual(entry.commoditiesUsed, []);
});

test('used-only accounts are included in the account catalog and still emit undeclared diagnostics', async () => {
  const documents = new Map([
    [
      'main.journal',
      {
        content: `account Assets:Cash ; type:A
commodity USD 1.00

2024-01-01 Lunch
  Expenses:Food  10 USD
  Assets:Cash  -10 USD
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

  const entry = analysis.accountCatalog.find((account) => account.account === 'Expenses:Food');

  assert.ok(entry);
  assert.equal(entry.declared, false);
  assert.equal(entry.used, true);
  assert.equal(entry.postingCount, 1);
  assert.equal(entry.effectiveType, 'expense');
  assert.deepEqual(entry.commoditiesUsed, ['USD']);
  assert.equal(
    analysis.diagnostics.some((diagnostic) =>
      diagnostic.message.includes('Undeclared account "Expenses:Food"'),
    ),
    true,
  );
});

test('posting tags include transitive account and transaction tags and are indexed/filterable', async () => {
  const documents = new Map([
    [
      'main.journal',
      {
        content: `2024-01-01 Paystub ; batch:paystub
  Payroll:Gross  -100 USD ; portion:gross
  Taxes:Federal  30 USD ; portion:withholding
  Assets:Checking  70 USD

account Payroll:Gross ; type:R, view:exclude
  ; scope:taxable
account Taxes:Federal ; type:X, category:tax
account Assets:Checking ; type:A
commodity USD 1.00
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

  const grossEntry = analysis.postings.find((entry) => entry.account === 'Payroll:Gross');
  const taxEntry = analysis.postings.find((entry) => entry.account === 'Taxes:Federal');

  assert.ok(grossEntry);
  assert.ok(taxEntry);
  assert.deepEqual(grossEntry.accountTags, [
    { name: 'view', value: 'exclude' },
    { name: 'scope', value: 'taxable' },
  ]);
  assert.deepEqual(grossEntry.transactionTags, [{ name: 'batch', value: 'paystub' }]);
  assert.deepEqual(grossEntry.postingTags, [{ name: 'portion', value: 'gross' }]);
  assert.deepEqual(grossEntry.tags, [
    { name: 'view', value: 'exclude' },
    { name: 'scope', value: 'taxable' },
    { name: 'batch', value: 'paystub' },
    { name: 'portion', value: 'gross' },
  ]);
  assert.equal(grossEntry.tags.some((tag) => tag.name === 'type'), false);
  assert.deepEqual(
    analysis.index.postingIdsByTag[createLedgerTagKey({ name: 'view', value: 'exclude' })],
    [grossEntry.id],
  );
  assert.deepEqual(
    analysis.index.postingIdsByTagName.portion,
    [grossEntry.id, taxEntry.id],
  );
  assert.deepEqual(
    filterPostings(analysis, {
      includeTags: [
        { name: 'batch', value: 'paystub' },
        { name: 'portion' },
      ],
      excludeTags: [{ name: 'view', value: 'exclude' }],
    }).map((entry) => entry.account),
    ['Taxes:Federal'],
  );
  assert.deepEqual(
    filterPostings(analysis, {
      includeTags: [{ name: 'portion' }],
    }).map((entry) => entry.account),
    ['Payroll:Gross', 'Taxes:Federal'],
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

test('incremental analysis reuses unchanged balance-independent suffix fragments after an early edit', async () => {
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
  Assets:Cash  12 USD
  Equity:OpeningBalances  -12 USD

2024-01-02 Lunch
  Expenses:Food  4 USD
  Assets:Cash  -4 USD
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
  assert.notStrictEqual(secondCache.fragments[0], firstCache.fragments[0]);
  assert.strictEqual(secondCache.fragments[1], firstCache.fragments[1]);
});

test('incremental analysis reuses cached analysis results for identical state and options', async () => {
  let state = createLedgerEngineState();

  state = await applyLedgerDocumentChanges(state, [
    {
      document: {
        content: `2024-01-01 Opening
  Assets:Cash  10 USD
  Equity:OpeningBalances  -10 USD
`,
        isLedger: true,
        name: 'main.journal',
        path: 'main.journal',
      },
      type: 'upsert',
    },
  ]);

  const firstRun = analyzeLedgerState(state, {
    availableFilePaths: ['main.journal'],
    rootFilePaths: ['main.journal'],
  });
  const secondRun = analyzeLedgerState(firstRun.state, {
    availableFilePaths: ['main.journal'],
    rootFilePaths: ['main.journal'],
  });

  assert.strictEqual(secondRun.state, firstRun.state);
  assert.strictEqual(secondRun.analysis, firstRun.analysis);
  assert.strictEqual(secondRun.workspace, firstRun.workspace);
});

test('incremental analysis reuses unaffected fragments across unrelated declaration edits', async () => {
  let state = createLedgerEngineState();
  const baseDocument = {
    content: `2024-01-01 Opening
  Assets:Cash  10 USD
  Equity:OpeningBalances  -10 USD

2024-01-02 Lunch
  Expenses:Food  4 USD
  Assets:Cash  -4 USD

account Assets:Cash
account Equity:OpeningBalances
account Expenses:Food
commodity USD
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
  assert.equal(firstRun.analysis.diagnostics.length, 0);

  state = await applyLedgerDocumentChanges(firstRun.state, [
    {
      document: {
        ...baseDocument,
        content: `${baseDocument.content}account Expenses:Travel\n`,
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
  assert.strictEqual(secondCache.fragments[0], firstCache.fragments[0]);
  assert.strictEqual(secondCache.fragments[1], firstCache.fragments[1]);
});

test('incremental analysis caches checkpoint-aligned replay blocks for long reusable suffixes', async () => {
  let state = createLedgerEngineState();
  const transactionCount = 260;
  const content = Array.from({ length: transactionCount }, (_, index) => {
    const amount = index + 1;
    const day = String((index % 28) + 1).padStart(2, '0');

    return `2024-01-${day} Txn ${index}
  Assets:Cash  ${amount} USD
  Equity:OpeningBalances  -${amount} USD`;
  }).join('\n\n');
  const baseDocument = {
    content,
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
  assert.equal(
    firstCache.replayBlocks.some((block) => block.startIndex === 128 && block.endIndex === 256),
    true,
  );

  state = await applyLedgerDocumentChanges(firstRun.state, [
    {
      document: {
        ...baseDocument,
        content: content.replace('2024-01-11 Txn 10', '2024-01-11 Txn 10 updated'),
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
  assert.strictEqual(secondCache.fragments[128], firstCache.fragments[128]);
  assert.equal(
    secondCache.replayBlocks.some((block) => block.startIndex === 128 && block.endIndex === 256),
    true,
  );
});
