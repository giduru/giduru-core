import type {
  AccountType,
  LedgerAnalysis,
  LedgerAnalysisIndex,
  LedgerDiagnostic,
  LedgerPrice,
  ParsedLedgerFile,
  ParsedLedgerPosting,
  ParsedLedgerWorkspace,
  RegisterEntry,
  Transaction,
  VerifyLedgerOptions,
} from './types';

const BALANCE_EPSILON = 0.00001;
const LEDGER_FILE_EXTENSIONS = new Set(['.hledger', '.journal', '.ledger']);

type AccountBalanceMap = Map<string, Map<string, number>>;
type CommodityTotals = Map<string, number>;

type PendingPosting = {
  parsedFile: ParsedLedgerFile;
  posting: ParsedLedgerPosting;
  transaction: ParsedLedgerFile['transactions'][number];
};

export function verifyLedgerWorkspace(
  workspace: ParsedLedgerWorkspace,
  options: VerifyLedgerOptions = {},
): LedgerAnalysis {
  const startedAt = Date.now();
  const fileMap = new Map(workspace.files.map((file) => [file.file.path, file]));
  const availableFilePaths = new Set(options.availableFilePaths ?? Array.from(fileMap.keys()));
  const diagnostics: LedgerDiagnostic[] = workspace.files.flatMap((file) => [
    ...file.syntaxDiagnostics,
    ...file.directiveDiagnostics,
  ]);
  const prices: LedgerPrice[] = [];
  const register: RegisterEntry[] = [];
  const transactions: Transaction[] = [];
  const balances = new Map<string, number>();
  const accounts = new Set<string>();
  const dependencyEdges: Array<{ from: string; to: string }> = [];
  const includedFiles = new Set<string>();
  const includeGraph = new Map<string, string[]>();
  const candidateRootFiles = options.rootFilePaths?.filter((path) => fileMap.has(path)) ?? [];
  const rootFiles =
    candidateRootFiles.length > 0
      ? Array.from(new Set(candidateRootFiles)).sort((left, right) => left.localeCompare(right))
      : workspace.rootFilePaths.length > 0
        ? Array.from(new Set(workspace.rootFilePaths)).sort((left, right) =>
            left.localeCompare(right),
          )
        : workspace.files
            .filter((file) => file.file.isLedger)
            .map((file) => file.file.path)
            .sort((left, right) => left.localeCompare(right));

  for (const parsedFile of workspace.files) {
    const includeTargets = [...parsedFile.includeTargets].sort((left, right) =>
      left.localeCompare(right),
    );
    includeGraph.set(parsedFile.file.path, includeTargets);

    for (const target of includeTargets) {
      dependencyEdges.push({ from: parsedFile.file.path, to: target });
      includedFiles.add(target);

      if (!availableFilePaths.has(target)) {
        diagnostics.push(
          createDiagnostic(
            parsedFile.file.path,
            `Included file "${target}" could not be found.`,
            1,
            'error',
          ),
        );
      }
    }
  }

  detectIncludeCycles(rootFiles, includeGraph, diagnostics);

  const reachableFilePaths = collectReachableFilePaths(rootFiles, includeGraph).filter((path) =>
    fileMap.has(path),
  );
  const reachableSet = new Set(reachableFilePaths);

  for (const path of availableFilePaths) {
    if (!reachableSet.has(path) && hasLedgerExtension(path)) {
      diagnostics.push(
        createDiagnostic(
          path,
          'This ledger file is not included from any root file and will not be parsed.',
          1,
          'warning',
        ),
      );
    }
  }

  const declaredAccounts = new Set<string>();
  const declaredCommodities = new Set<string>();

  for (const path of reachableFilePaths) {
    const parsedFile = fileMap.get(path);

    if (!parsedFile) {
      continue;
    }

    for (const account of parsedFile.declaredAccounts) {
      declaredAccounts.add(account);
    }

    for (const commodity of parsedFile.declaredCommodities) {
      declaredCommodities.add(commodity);
    }
  }

  const runningBalances: AccountBalanceMap = new Map();
  const hasAccountDeclarations = declaredAccounts.size > 0;
  const hasCommodityDeclarations = declaredCommodities.size > 0;
  let postingCount = 0;
  let transactionCount = 0;

  const orderedTransactions = reachableFilePaths.flatMap((path) => {
    const parsedFile = fileMap.get(path);

    if (!parsedFile) {
      return [];
    }

    return parsedFile.transactions.map((transaction) => ({
      parsedFile,
      transaction,
    }));
  });

  orderedTransactions.sort((left, right) => {
    if (left.transaction.date === right.transaction.date) {
      if (left.parsedFile.file.path === right.parsedFile.file.path) {
        return left.transaction.headerLine - right.transaction.headerLine;
      }

      return left.parsedFile.file.path.localeCompare(right.parsedFile.file.path);
    }

    return left.transaction.date.localeCompare(right.transaction.date);
  });

  for (const { parsedFile, transaction } of orderedTransactions) {
    transactionCount += 1;
    postingCount += transaction.postings.length;

    if (transaction.postings.length < 2) {
      diagnostics.push(
        createDiagnostic(
          parsedFile.file.path,
          `Transaction "${transaction.description || transaction.date}" has fewer than two postings.`,
          transaction.headerLine,
          'warning',
        ),
      );
    }

    const verified = verifyTransaction({
      balances,
      declaredAccounts,
      declaredCommodities,
      diagnostics,
      hasAccountDeclarations,
      hasCommodityDeclarations,
      parsedFile,
      prices,
      register,
      runningBalances,
      transaction,
      transactions,
    });

    for (const account of verified.accounts) {
      accounts.add(account);
    }
  }

  for (const path of reachableFilePaths) {
    const parsedFile = fileMap.get(path);

    if (!parsedFile) {
      continue;
    }

    for (const price of parsedFile.prices) {
      prices.push({
        ...price,
        id: `${parsedFile.file.path}:${price.line}:${price.fromCommodity}:${price.toCommodity ?? ''}:${price.rawDate}`,
        path: parsedFile.file.path,
      });
    }
  }

  const sortedDiagnostics = diagnostics.sort(compareDiagnostics);
  const sortedRegister = register.sort(compareRegisterEntries);
  const sortedTransactions = transactions.sort(compareTransactions);
  const verifyMs = Date.now() - startedAt;

  return {
    accounts: Array.from(accounts).sort((left, right) => left.localeCompare(right)),
    balances: Array.from(balances.entries())
      .filter(([key]) => {
        const [account, commodity] = key.split('::');
        return Boolean(account) && Boolean(commodity);
      })
      .map(([key, amount]) => {
        const [account, commodity] = key.split('::');
        return { account, amount, commodity };
      })
      .sort((left, right) => {
        if (left.account === right.account) {
          return left.commodity.localeCompare(right.commodity);
        }

        return left.account.localeCompare(right.account);
      }),
    declaredAccounts: Array.from(declaredAccounts).sort((left, right) =>
      left.localeCompare(right),
    ),
    declaredCommodities: Array.from(declaredCommodities).sort((left, right) =>
      left.localeCompare(right),
    ),
    diagnostics: sortedDiagnostics,
    graph: {
      dependencyEdges: dependencyEdges.sort((left, right) => {
        if (left.from === right.from) {
          return left.to.localeCompare(right.to);
        }

        return left.from.localeCompare(right.from);
      }),
      includedFiles: Array.from(includedFiles).sort((left, right) => left.localeCompare(right)),
      rootFiles,
    },
    index: buildAnalysisIndex(sortedDiagnostics, sortedRegister, sortedTransactions),
    parserSummary: {
      errorNodeCount: workspace.files.reduce(
        (total, file) => total + file.stats.errorNodeCount,
        0,
      ),
      fileCount: workspace.files.length,
      nodeCount: workspace.files.reduce((total, file) => total + file.stats.nodeCount, 0),
      reusedFileCount: workspace.reusedFileCount,
    },
    prices: prices.sort((left, right) => {
      if (left.date === right.date) {
        return left.id.localeCompare(right.id);
      }

      return left.date.localeCompare(right.date);
    }),
    register: sortedRegister,
    summary: {
      postingCount,
      transactionCount,
    },
    timings: {
      parseMs: workspace.totalParseMs,
      totalMs: workspace.totalParseMs + verifyMs,
      verifyMs,
    },
    transactions: sortedTransactions,
  };
}

function verifyTransaction(args: {
  balances: Map<string, number>;
  declaredAccounts: Set<string>;
  declaredCommodities: Set<string>;
  diagnostics: LedgerDiagnostic[];
  hasAccountDeclarations: boolean;
  hasCommodityDeclarations: boolean;
  parsedFile: ParsedLedgerFile;
  prices: LedgerPrice[];
  register: RegisterEntry[];
  runningBalances: AccountBalanceMap;
  transaction: ParsedLedgerFile['transactions'][number];
  transactions: Transaction[];
}) {
  const {
    balances,
    declaredAccounts,
    declaredCommodities,
    diagnostics,
    hasAccountDeclarations,
    hasCommodityDeclarations,
    parsedFile,
    prices,
    register,
    runningBalances,
    transaction,
    transactions,
  } = args;
  const accounts = new Set<string>();
  const transactionId = `${parsedFile.file.path}:${transaction.headerLine}`;
  const transactionEntries: RegisterEntry[] = [];
  const realTotals: CommodityTotals = new Map();
  const balancedVirtualTotals: CommodityTotals = new Map();
  const originalCommodityPrecisions = collectOriginalCommodityPrecisions(transaction.postings);
  const realCommodityPrecisions = collectBalancingCommodityPrecisions(
    transaction.postings,
    'real',
    originalCommodityPrecisions,
  );
  const balancedVirtualCommodityPrecisions = collectBalancingCommodityPrecisions(
    transaction.postings,
    'balanced-virtual',
    originalCommodityPrecisions,
  );
  const pendingReal: PendingPosting[] = [];
  const pendingBalancedVirtual: PendingPosting[] = [];

  for (const posting of transaction.postings) {
    accounts.add(posting.account);
    validatePostingDeclarations(
      posting,
      parsedFile,
      diagnostics,
      declaredAccounts,
      declaredCommodities,
      hasAccountDeclarations,
      hasCommodityDeclarations,
    );

    if (posting.amount == null) {
      if (posting.balanceAssertion) {
        const assignment = inferBalanceAssignment(posting, runningBalances);

        if (!assignment) {
          diagnostics.push(
            createDiagnostic(
              parsedFile.file.path,
              `Posting "${posting.account}" cannot infer a balance assignment across multiple commodities.`,
              posting.line,
              'error',
            ),
          );
          continue;
        }

        applyPostingEntry({
          balances,
          parsedFile,
          posting: {
            ...posting,
            amount: assignment.amount,
            commodity: assignment.commodity,
          },
          prices,
          register,
          runningBalances,
          targetTotals: totalsForPostingKind(posting.kind, realTotals, balancedVirtualTotals),
          transaction,
          transactionEntries,
          transactionId,
          wasInferred: true,
        });
        checkBalanceAssertion(posting, parsedFile.file.path, diagnostics, runningBalances);
        continue;
      }

      queuePendingPosting(posting, parsedFile, transaction, pendingReal, pendingBalancedVirtual);
      continue;
    }

    const explicitPosting = posting as ParsedLedgerPosting & {
      amount: number;
      commodity: string;
    };

    applyPostingEntry({
      balances,
      parsedFile,
      posting: explicitPosting,
      prices,
      register,
      runningBalances,
      targetTotals: totalsForPostingKind(posting.kind, realTotals, balancedVirtualTotals),
      transaction,
      transactionEntries,
      transactionId,
      wasInferred: false,
    });
    checkBalanceAssertion(posting, parsedFile.file.path, diagnostics, runningBalances);
  }

  resolvePendingPostings({
    balances,
    commodityPrecisions: realCommodityPrecisions,
    diagnostics,
    kind: 'real',
    parsedFile,
    pending: pendingReal,
    prices,
    register,
    runningBalances,
    targetTotals: realTotals,
    transaction,
    transactionEntries,
    transactionId,
  });
  resolvePendingPostings({
    balances,
    commodityPrecisions: balancedVirtualCommodityPrecisions,
    diagnostics,
    kind: 'balanced-virtual',
    parsedFile,
    pending: pendingBalancedVirtual,
    prices,
    register,
    runningBalances,
    targetTotals: balancedVirtualTotals,
    transaction,
    transactionEntries,
    transactionId,
  });

  assertTransactionTotals(
    realCommodityPrecisions,
    diagnostics,
    parsedFile.file.path,
    realTotals,
    transaction,
    'real postings',
    transaction.headerLine,
  );
  assertTransactionTotals(
    balancedVirtualCommodityPrecisions,
    diagnostics,
    parsedFile.file.path,
    balancedVirtualTotals,
    transaction,
    'balanced virtual postings',
    transaction.headerLine,
  );

  if (transactionEntries.length > 0) {
    const verifiedTransaction: Transaction = {
      comment: transaction.comment,
      date: transaction.date,
      description: transaction.description,
      fileOrder: `${parsedFile.file.path}:${String(transaction.headerLine).padStart(8, '0')}`,
      id: transactionId,
      line: transaction.headerLine,
      path: parsedFile.file.path,
      postings: transactionEntries,
      searchText: buildSearchText([
        transaction.date,
        transaction.secondaryDate ?? '',
        transaction.description,
        transaction.comment,
        ...transaction.tags.map((tag) => `${tag.name}:${tag.value}`),
        ...transactionEntries.map((entry) => entry.account),
      ]),
      secondaryDate: transaction.secondaryDate,
      tags: transaction.tags,
    };
    transactions.push(verifiedTransaction);
  }

  return { accounts };
}

function resolvePendingPostings(args: {
  balances: Map<string, number>;
  commodityPrecisions: Map<string, number>;
  diagnostics: LedgerDiagnostic[];
  kind: 'balanced-virtual' | 'real';
  parsedFile: ParsedLedgerFile;
  pending: PendingPosting[];
  prices: LedgerPrice[];
  register: RegisterEntry[];
  runningBalances: AccountBalanceMap;
  targetTotals: CommodityTotals;
  transaction: ParsedLedgerFile['transactions'][number];
  transactionEntries: RegisterEntry[];
  transactionId: string;
}) {
  const {
    balances,
    commodityPrecisions,
    diagnostics,
    kind,
    parsedFile,
    pending,
    prices,
    register,
    runningBalances,
    targetTotals,
    transaction,
    transactionEntries,
    transactionId,
  } = args;

  if (pending.length === 0) {
    return;
  }

  if (pending.length > 1) {
    diagnostics.push(
      createDiagnostic(
        parsedFile.file.path,
        `Transaction "${transaction.description || transaction.date}" has multiple postings without amounts in the ${kind} balance group.`,
        transaction.headerLine,
        'error',
      ),
    );
    return;
  }

  const [pendingPosting] = pending;
  const nonZeroTotals = significantCommodityEntries(targetTotals, commodityPrecisions);
  const totalEntries = Array.from(targetTotals.entries());

  if (nonZeroTotals.length === 0) {
    if (totalEntries.length === 1) {
      const [inferredCommodity] = totalEntries[0];

      applyPostingEntry({
        balances,
        parsedFile,
        posting: {
          ...pendingPosting.posting,
          amount: 0,
          commodity: inferredCommodity,
        },
        prices,
        register,
        runningBalances,
        targetTotals,
        transaction,
        transactionEntries,
        transactionId,
        wasInferred: true,
      });
      return;
    }

    if (totalEntries.length > 1) {
      diagnostics.push(
        createDiagnostic(
          parsedFile.file.path,
          `Transaction "${transaction.description || transaction.date}" cannot infer a missing amount across multiple commodities.`,
          transaction.headerLine,
          'error',
        ),
      );
      return;
    }

    diagnostics.push(
      createDiagnostic(
        parsedFile.file.path,
        `Posting "${pendingPosting.posting.account}" is missing an amount and there is nothing to balance against.`,
        pendingPosting.posting.line,
        'error',
      ),
    );
    return;
  }

  if (nonZeroTotals.length > 1) {
    diagnostics.push(
      createDiagnostic(
        parsedFile.file.path,
        `Transaction "${transaction.description || transaction.date}" cannot infer a missing amount across multiple commodities.`,
        transaction.headerLine,
        'error',
      ),
    );
    return;
  }

  const entry = nonZeroTotals[0];
  const inferredCommodity = entry[0];
  const inferredAmount = -entry[1];

  applyPostingEntry({
    balances,
    parsedFile,
    posting: {
      ...pendingPosting.posting,
      amount: inferredAmount,
      commodity: inferredCommodity,
    },
    prices,
    register,
    runningBalances,
    targetTotals,
    transaction,
    transactionEntries,
    transactionId,
    wasInferred: true,
  });
}

function queuePendingPosting(
  posting: ParsedLedgerPosting,
  parsedFile: ParsedLedgerFile,
  transaction: ParsedLedgerFile['transactions'][number],
  pendingReal: PendingPosting[],
  pendingBalancedVirtual: PendingPosting[],
) {
  if (posting.kind === 'balanced-virtual') {
    pendingBalancedVirtual.push({ parsedFile, posting, transaction });
    return;
  }

  if (posting.kind === 'real') {
    pendingReal.push({ parsedFile, posting, transaction });
  }
}

function validatePostingDeclarations(
  posting: ParsedLedgerPosting,
  parsedFile: ParsedLedgerFile,
  diagnostics: LedgerDiagnostic[],
  declaredAccounts: Set<string>,
  declaredCommodities: Set<string>,
  hasAccountDeclarations: boolean,
  hasCommodityDeclarations: boolean,
) {
  if (hasAccountDeclarations && !declaredAccounts.has(posting.account)) {
    diagnostics.push(
      createDiagnostic(
        parsedFile.file.path,
        `Undeclared account "${posting.account}". Add an "account ${posting.account}" directive to declare it.`,
        posting.line,
        'error',
      ),
    );
  }

  if (
    hasCommodityDeclarations &&
    posting.commodity &&
    !declaredCommodities.has(posting.commodity)
  ) {
    diagnostics.push(
      createDiagnostic(
        parsedFile.file.path,
        `Undeclared commodity "${posting.commodity}". Add a "commodity ${posting.commodity}" directive to declare it.`,
        posting.line,
        'error',
      ),
    );
  }
}

function applyPostingEntry(args: {
  balances: Map<string, number>;
  parsedFile: ParsedLedgerFile;
  posting: ParsedLedgerPosting & { amount: number; commodity: string };
  prices: LedgerPrice[];
  register: RegisterEntry[];
  runningBalances: AccountBalanceMap;
  targetTotals: CommodityTotals | null;
  transaction: ParsedLedgerFile['transactions'][number];
  transactionEntries: RegisterEntry[];
  transactionId: string;
  wasInferred: boolean;
}) {
  const {
    balances,
    parsedFile,
    posting,
    prices,
    register,
    runningBalances,
    targetTotals,
    transaction,
    transactionEntries,
    transactionId,
    wasInferred,
  } = args;
  const entryId = `${parsedFile.file.path}:${transaction.headerLine}:${posting.line}`;
  const entry: RegisterEntry = {
    account: posting.account,
    accountType: classifyAccount(posting.account),
    amount: posting.amount,
    balanceAssertion: posting.balanceAssertion,
    comment: posting.comment,
    commodity: posting.commodity,
    date: transaction.date,
    description: transaction.description,
    id: entryId,
    inferredAmount: wasInferred,
    kind: posting.kind,
    line: posting.line,
    path: parsedFile.file.path,
    searchText: buildSearchText([
      posting.account,
      posting.comment,
      posting.commodity,
      transaction.date,
      transaction.secondaryDate ?? '',
      transaction.description,
      transaction.comment,
      ...posting.tags.map((tag) => `${tag.name}:${tag.value}`),
      ...transaction.tags.map((tag) => `${tag.name}:${tag.value}`),
    ]),
    tags: posting.tags,
    transactionComment: transaction.comment,
    transactionId,
    transactionTags: transaction.tags,
  };

  register.push(entry);
  transactionEntries.push(entry);
  addToCommodityTotals(
    balances,
    `${posting.account}::${posting.commodity}`,
    posting.amount,
  );
  addToRunningBalances(runningBalances, posting.account, posting.commodity, posting.amount);

  if (targetTotals) {
    const balancingAmount = getPostingBalancingAmount(posting);
    addToCommodityTotals(targetTotals, balancingAmount.commodity, balancingAmount.amount);
  }

  const price = derivePostingAnnotationPrice(parsedFile.file.path, transaction, posting);

  if (price) {
    prices.push(price);
  }
}

function inferBalanceAssignment(
  posting: ParsedLedgerPosting,
  runningBalances: AccountBalanceMap,
) {
  const assertion = posting.balanceAssertion;

  if (!assertion) {
    return null;
  }

  const currentBalance = assertion.inclusive
    ? getInclusiveRunningBalance(runningBalances, posting.account)
    : getRunningBalance(runningBalances, posting.account);
  const assertedCommodity = assertion.commodity ?? '';

  if (!assertion.total) {
    const currentAmount = currentBalance.get(assertedCommodity) ?? 0;
    return {
      amount: assertion.amount - currentAmount,
      commodity: assertedCommodity,
    };
  }

  const desiredBalance = new Map<string, number>([[assertedCommodity, assertion.amount]]);
  const difference = subtractCommodityTotals(desiredBalance, currentBalance);
  const nonZeroEntries = nonZeroCommodityEntries(difference);

  if (nonZeroEntries.length !== 1) {
    return null;
  }

  const entry = nonZeroEntries[0];
  return {
    amount: entry[1],
    commodity: entry[0],
  };
}

function checkBalanceAssertion(
  posting: ParsedLedgerPosting,
  path: string,
  diagnostics: LedgerDiagnostic[],
  runningBalances: AccountBalanceMap,
) {
  const assertion = posting.balanceAssertion;

  if (!assertion) {
    return;
  }

  const actualBalance = assertion.inclusive
    ? getInclusiveRunningBalance(runningBalances, posting.account)
    : getRunningBalance(runningBalances, posting.account);
  const assertedCommodity = assertion.commodity ?? '';
  const actualAmount = actualBalance.get(assertedCommodity) ?? 0;

  if (Math.abs(actualAmount - assertion.amount) > BALANCE_EPSILON) {
    diagnostics.push(
      createDiagnostic(
        path,
        `Balance assertion failed in ${posting.account}. Expected ${formatCommodityAmount(assertedCommodity, assertion.amount)}, got ${formatCommodityAmount(assertedCommodity, actualAmount)}.`,
        posting.line,
        'error',
      ),
    );
    return;
  }

  if (!assertion.total) {
    return;
  }

  for (const [commodity, amount] of actualBalance.entries()) {
    if (commodity === assertedCommodity) {
      continue;
    }

    if (Math.abs(amount) <= BALANCE_EPSILON) {
      continue;
    }

    diagnostics.push(
      createDiagnostic(
        path,
        `Balance assertion failed in ${posting.account}. Commodity ${commodity || '""'} should be zero but is ${formatCommodityAmount(commodity, amount)}.`,
        posting.line,
        'error',
      ),
    );
    return;
  }
}

function totalsForPostingKind(
  kind: ParsedLedgerPosting['kind'],
  realTotals: CommodityTotals,
  balancedVirtualTotals: CommodityTotals,
) {
  if (kind === 'real') {
    return realTotals;
  }

  if (kind === 'balanced-virtual') {
    return balancedVirtualTotals;
  }

  return null;
}

function collectOriginalCommodityPrecisions(postings: ParsedLedgerPosting[]) {
  const precisions = new Map<string, number>();

  for (const posting of postings) {
    if (posting.amount == null || posting.commodity == null || posting.amountPrecision == null) {
      continue;
    }

    updateCommodityPrecision(precisions, posting.commodity, posting.amountPrecision);
  }

  return precisions;
}

function collectBalancingCommodityPrecisions(
  postings: ParsedLedgerPosting[],
  kind: ParsedLedgerPosting['kind'],
  originalCommodityPrecisions: Map<string, number>,
) {
  const precisions = new Map<string, number>();

  for (const posting of postings) {
    if (posting.kind !== kind || posting.amount == null) {
      continue;
    }

    const balancingAmount = getPostingBalancingAmount(
      posting as ParsedLedgerPosting & { amount: number },
    );
    const precision =
      originalCommodityPrecisions.get(balancingAmount.commodity) ??
      getPostingBalancingPrecision(posting) ??
      null;

    if (precision == null) {
      continue;
    }

    updateCommodityPrecision(precisions, balancingAmount.commodity, precision);
  }

  return precisions;
}

function addToRunningBalances(
  runningBalances: AccountBalanceMap,
  account: string,
  commodity: string,
  amount: number,
) {
  let balance = runningBalances.get(account);

  if (!balance) {
    balance = new Map();
    runningBalances.set(account, balance);
  }

  addToCommodityTotals(balance, commodity, amount);
}

function getRunningBalance(
  runningBalances: AccountBalanceMap,
  account: string,
) {
  return new Map(runningBalances.get(account) ?? []);
}

function getInclusiveRunningBalance(
  runningBalances: AccountBalanceMap,
  account: string,
) {
  const inclusive = new Map<string, number>();

  for (const [currentAccount, totals] of runningBalances.entries()) {
    if (currentAccount !== account && !currentAccount.startsWith(`${account}:`)) {
      continue;
    }

    for (const [commodity, amount] of totals.entries()) {
      addToCommodityTotals(inclusive, commodity, amount);
    }
  }

  return inclusive;
}

function subtractCommodityTotals(
  left: CommodityTotals,
  right: CommodityTotals,
) {
  const difference = new Map(left);

  for (const [commodity, amount] of right.entries()) {
    addToCommodityTotals(difference, commodity, -amount);
  }

  return difference;
}

function nonZeroCommodityEntries(totals: CommodityTotals) {
  return Array.from(totals.entries()).filter(([, amount]) => Math.abs(amount) > BALANCE_EPSILON);
}

function significantCommodityEntries(
  totals: CommodityTotals,
  commodityPrecisions: Map<string, number>,
) {
  return Array.from(totals.entries()).filter(
    ([commodity, amount]) => !looksZeroAtCommodityPrecision(amount, commodityPrecisions.get(commodity)),
  );
}

function looksZeroAtCommodityPrecision(amount: number, precision: number | undefined) {
  if (precision == null) {
    return Math.abs(amount) <= BALANCE_EPSILON;
  }

  return Math.abs(amount) <= 0.5 * 10 ** -precision + BALANCE_EPSILON;
}

function updateCommodityPrecision(
  precisions: Map<string, number>,
  commodity: string,
  precision: number,
) {
  const current = precisions.get(commodity);

  if (current == null || precision > current) {
    precisions.set(commodity, precision);
  }
}

function getPostingBalancingAmount(
  posting: ParsedLedgerPosting & { amount: number },
) {
  const annotation = posting.priceAnnotation;

  if (!annotation?.commodity) {
    return {
      amount: posting.amount,
      commodity: posting.commodity ?? '',
    };
  }

  if (annotation.kind === 'total') {
    return {
      amount: annotation.amount,
      commodity: annotation.commodity,
    };
  }

  return {
    amount: posting.amount * annotation.amount,
    commodity: annotation.commodity,
  };
}

function getPostingBalancingPrecision(posting: ParsedLedgerPosting) {
  if (posting.priceAnnotation?.commodity) {
    return posting.priceAnnotation.precision;
  }

  return posting.amountPrecision;
}

function assertTransactionTotals(
  commodityPrecisions: Map<string, number>,
  diagnostics: LedgerDiagnostic[],
  path: string,
  totals: CommodityTotals,
  transaction: ParsedLedgerFile['transactions'][number],
  label: string,
  line: number,
) {
  const nonZeroTotals = significantCommodityEntries(totals, commodityPrecisions);

  if (nonZeroTotals.length === 0) {
    return;
  }

  if (nonZeroTotals.length === 1) {
    const [commodity] = nonZeroTotals[0];
    diagnostics.push(
      createDiagnostic(
        path,
        `Transaction "${transaction.description || transaction.date}" does not balance for ${commodity || '""'}.`,
        line,
        'error',
      ),
    );
    return;
  }

  diagnostics.push(
    createDiagnostic(
      path,
      `This multi-commodity transaction is unbalanced. Automatic commodity conversion is not enabled. The ${label} sum should be 0 but is: ${formatCommodityTotals(nonZeroTotals)}.`,
      line,
      'error',
    ),
  );
}

function derivePostingAnnotationPrice(
  path: string,
  transaction: ParsedLedgerWorkspace['files'][number]['transactions'][number],
  posting: ParsedLedgerWorkspace['files'][number]['transactions'][number]['postings'][number],
): LedgerPrice | null {
  const annotation = posting.priceAnnotation;

  if (!annotation || posting.amount == null || !posting.commodity || !annotation.commodity) {
    return null;
  }

  const baseUnits = Math.abs(posting.amount);

  if (!Number.isFinite(baseUnits) || baseUnits === 0) {
    return null;
  }

  const annotationAmount =
    annotation.kind === 'unit'
      ? Math.abs(annotation.amount)
      : Math.abs(annotation.amount / baseUnits);

  if (!Number.isFinite(annotationAmount) || annotationAmount === 0) {
    return null;
  }

  return {
    amount: annotationAmount,
    comment: posting.comment,
    date: transaction.date,
    fromCommodity: posting.commodity,
    id: `${path}:${transaction.headerLine}:${posting.line}:posting-annotation`,
    line: posting.line,
    path,
    rawDate: transaction.date,
    source: 'posting-annotation',
    toCommodity: annotation.commodity,
  };
}

function detectIncludeCycles(
  rootFiles: string[],
  graph: Map<string, string[]>,
  diagnostics: LedgerDiagnostic[],
) {
  const visited = new Set<string>();
  const stack = new Set<string>();

  const visit = (path: string, ancestry: string[]) => {
    if (stack.has(path)) {
      const cycleStart = ancestry.indexOf(path);
      const cycle = [...ancestry.slice(cycleStart), path].join(' -> ');
      diagnostics.push(
        createDiagnostic(path, `Included file forms a cycle: ${cycle}.`, 1, 'error'),
      );
      return;
    }

    if (visited.has(path)) {
      return;
    }

    visited.add(path);
    stack.add(path);

    for (const dependency of [...(graph.get(path) ?? [])].sort((left, right) =>
      left.localeCompare(right),
    )) {
      visit(dependency, [...ancestry, dependency]);
    }

    stack.delete(path);
  };

  for (const root of rootFiles) {
    visit(root, [root]);
  }
}

function collectReachableFilePaths(
  rootFiles: string[],
  includeGraph: Map<string, string[]>,
) {
  const visited = new Set<string>();
  const queue = [...rootFiles];

  while (queue.length > 0) {
    queue.sort((left, right) => left.localeCompare(right));
    const path = queue.shift();

    if (!path || visited.has(path)) {
      continue;
    }

    visited.add(path);

    for (const dependency of [...(includeGraph.get(path) ?? [])].sort((left, right) =>
      left.localeCompare(right),
    )) {
      if (!visited.has(dependency)) {
        queue.push(dependency);
      }
    }
  }

  return Array.from(visited).sort((left, right) => left.localeCompare(right));
}

function addToCommodityTotals(
  totals: CommodityTotals,
  commodity: string,
  amount: number,
) {
  totals.set(commodity, (totals.get(commodity) ?? 0) + amount);
}

function createDiagnostic(
  path: string,
  message: string,
  line: number,
  severity: 'error' | 'info' | 'warning',
): LedgerDiagnostic {
  return {
    id: `${path}:${line}:${message}`,
    line,
    message,
    path,
    severity,
    source: 'engine',
  };
}

function compareDiagnostics(left: LedgerDiagnostic, right: LedgerDiagnostic) {
  if (left.path === right.path) {
    return (left.line ?? 0) - (right.line ?? 0);
  }

  return left.path.localeCompare(right.path);
}

function compareRegisterEntries(left: RegisterEntry, right: RegisterEntry) {
  if (left.date === right.date) {
    return left.id.localeCompare(right.id);
  }

  return right.date.localeCompare(left.date);
}

function compareTransactions(left: Transaction, right: Transaction) {
  if (left.date === right.date) {
    return left.id.localeCompare(right.id);
  }

  return right.date.localeCompare(left.date);
}

function hasLedgerExtension(path: string) {
  const name = path.split('/').pop() ?? '';
  const dotIndex = name.lastIndexOf('.');

  if (dotIndex === -1) {
    return false;
  }

  return LEDGER_FILE_EXTENSIONS.has(name.slice(dotIndex).toLowerCase());
}

function classifyAccount(account: string): AccountType {
  const firstSegment = account.split(':')[0].toLowerCase().trim();

  switch (firstSegment) {
    case 'asset':
    case 'assets':
      return 'asset';
    case 'liability':
    case 'liabilities':
      return 'liability';
    case 'equity':
      return 'equity';
    case 'revenue':
    case 'revenues':
    case 'income':
      return 'income';
    case 'expense':
    case 'expenses':
      return 'expense';
    default:
      return 'unknown';
  }
}

function buildSearchText(fields: string[]) {
  return fields
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .join('\n')
    .toLowerCase();
}

function buildAnalysisIndex(
  diagnostics: LedgerDiagnostic[],
  register: RegisterEntry[],
  transactions: Transaction[],
): LedgerAnalysisIndex {
  const index: LedgerAnalysisIndex = {
    diagnosticPositionById: {},
    diagnosticsByPath: {},
    registerIdsByAccount: {},
    registerIdsByAccountType: {},
    registerIdsByCommodity: {},
    registerIdsByDate: {},
    registerIdsByPath: {},
    registerPositionById: {},
    transactionIdsByDate: {},
    transactionIdsByPath: {},
    transactionPositionById: {},
  };

  diagnostics.forEach((diagnostic, position) => {
    index.diagnosticPositionById[diagnostic.id] = position;
    appendIndexId(index.diagnosticsByPath, diagnostic.path, diagnostic.id);
  });

  register.forEach((entry, position) => {
    index.registerPositionById[entry.id] = position;
    appendIndexId(index.registerIdsByAccount, entry.account, entry.id);
    appendIndexId(index.registerIdsByAccountType, entry.accountType, entry.id);
    appendIndexId(index.registerIdsByCommodity, entry.commodity, entry.id);
    appendIndexId(index.registerIdsByDate, entry.date, entry.id);
    appendIndexId(index.registerIdsByPath, entry.path, entry.id);
  });

  transactions.forEach((transaction, position) => {
    index.transactionPositionById[transaction.id] = position;
    appendIndexId(index.transactionIdsByDate, transaction.date, transaction.id);
    appendIndexId(index.transactionIdsByPath, transaction.path, transaction.id);
  });

  return index;
}

function appendIndexId(
  target: Record<string, string[]>,
  key: string,
  id: string,
) {
  const bucket = target[key];

  if (bucket) {
    bucket.push(id);
    return;
  }

  target[key] = [id];
}

function formatCommodityAmount(commodity: string, amount: number) {
  return commodity ? `${commodity} ${amount}` : String(amount);
}

function formatCommodityTotals(entries: Array<[string, number]>) {
  return entries
    .map(([commodity, amount]) => formatCommodityAmount(commodity, amount))
    .join(', ');
}
