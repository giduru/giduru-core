import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeLedgerDocuments } from '../src';

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
