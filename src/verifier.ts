import type {
  AccountType,
  LedgerAnalysis,
  LedgerAnalysisIndex,
  LedgerDiagnostic,
  LedgerPrice,
  LedgerVerificationBalanceDelta,
  LedgerVerificationCache,
  LedgerVerificationCheckpoint,
  LedgerVerificationFragment,
  LedgerVerificationReplayBlock,
  LedgerVerificationTransactionDescriptor,
  ParsedLedgerFile,
  ParsedLedgerPosting,
  ParsedLedgerTransaction,
  ParsedLedgerWorkspace,
  RegisterEntry,
  Transaction,
  VerifyLedgerOptions,
} from './types';

const BALANCE_EPSILON = 0.00001;
const CHECKPOINT_INTERVAL = 128;
const LEDGER_FILE_EXTENSIONS = new Set(['.hledger', '.journal', '.ledger']);
const ACCOUNT_TYPE_CACHE = new Map<string, AccountType>();
const ACCOUNT_ANCESTORS_CACHE = new Map<string, string[]>();

type AccountBalanceMap = Map<string, Map<string, number>>;
type CommodityTotals = Map<string, number>;

type PendingPosting = {
  posting: ParsedLedgerPosting;
};

type VerificationRuntimeState = {
  inclusiveRunningBalances: AccountBalanceMap;
  runningBalances: AccountBalanceMap;
};

type LedgerVerificationPlan = {
  accountDeclarationSignature: string;
  baseDiagnostics: LedgerDiagnostic[];
  commodityDeclarationSignature: string;
  declaredAccounts: Set<string>;
  declaredCommodities: Set<string>;
  dependencyEdges: Array<{ from: string; to: string }>;
  directivePrices: LedgerPrice[];
  graph: {
    dependencyEdges: Array<{ from: string; to: string }>;
    includedFiles: string[];
    rootFiles: string[];
  };
  hasAccountDeclarations: boolean;
  hasCommodityDeclarations: boolean;
  orderedTransactions: LedgerVerificationTransactionDescriptor[];
  postingCount: number;
  transactionCount: number;
};

export function verifyLedgerWorkspace(
  workspace: ParsedLedgerWorkspace,
  options: VerifyLedgerOptions = {},
): LedgerAnalysis {
  return verifyLedgerWorkspaceWithCache(workspace, options, null).analysis;
}

export function verifyLedgerWorkspaceWithCache(
  workspace: ParsedLedgerWorkspace,
  options: VerifyLedgerOptions = {},
  previousCache: LedgerVerificationCache | null,
): {
  analysis: LedgerAnalysis;
  cache: LedgerVerificationCache;
} {
  const startedAt = Date.now();
  const plan = buildVerificationPlan(workspace, options);
  const reusablePrefixLength = getReusablePrefixLength(plan, previousCache);
  const fragments = previousCache?.fragments.slice(0, reusablePrefixLength) ?? [];
  const checkpoints = cloneReusableCheckpoints(previousCache, reusablePrefixLength);
  const reusableReplayBlocks = cloneReusableReplayBlocks(previousCache, reusablePrefixLength);
  const runtimeState = restoreRuntimeStateFromCache(previousCache, reusablePrefixLength);
  const previousReusableFragments = buildReusableFragmentLookup(previousCache, plan);
  const previousReplayBlocks = buildReplayBlockLookup(previousCache);

  for (let index = reusablePrefixLength; index < plan.orderedTransactions.length;) {
    const descriptor = plan.orderedTransactions[index];
    const reusableFragment = previousReusableFragments.get(descriptor.cacheKey);
    const reusableReplayBlock = findReusableReplayBlock({
      currentIndex: index,
      plan,
      previousCache,
      previousIndex: reusableFragment?.index ?? null,
      previousReplayBlocks,
    });

    if (reusableReplayBlock) {
      const blockLength = reusableReplayBlock.endIndex - reusableReplayBlock.startIndex;

      for (let offset = 0; offset < blockLength; offset += 1) {
        const previousFragment = previousCache?.fragments[reusableReplayBlock.startIndex + offset];

        if (!previousFragment) {
          break;
        }

        fragments[index + offset] = previousFragment;
      }

      applyBalanceDeltas(runtimeState, reusableReplayBlock.balanceDeltas);
      checkpoints.push(createVerificationCheckpoint(index + blockLength, runtimeState));
      index += blockLength;
      continue;
    }

    const fragment = reusableFragment
      ? reusableFragment.fragment
      : verifyTransactionFragment({
          declaredAccounts: plan.declaredAccounts,
          declaredCommodities: plan.declaredCommodities,
          hasAccountDeclarations: plan.hasAccountDeclarations,
          hasCommodityDeclarations: plan.hasCommodityDeclarations,
          parsedFile: descriptor.parsedFile,
          runtimeState,
          transaction: descriptor.transaction,
          transactionId: descriptor.transaction.transactionId,
        });

    fragments[index] = fragment;

    if (reusableFragment) {
      applyBalanceDeltas(runtimeState, fragment.balanceDeltas);
    }

    if (
      (index + 1) % CHECKPOINT_INTERVAL === 0 ||
      index === plan.orderedTransactions.length - 1
    ) {
      checkpoints.push(createVerificationCheckpoint(index + 1, runtimeState));
    }

    index += 1;
  }

  const verifyMs = Date.now() - startedAt;
  const analysis = materializeLedgerAnalysis(workspace, plan, fragments, runtimeState, verifyMs);

  return {
    analysis,
    cache: {
      accountDeclarationSignature: plan.accountDeclarationSignature,
      checkpoints,
      declaredAccounts: new Set(plan.declaredAccounts),
      declaredCommodities: new Set(plan.declaredCommodities),
      commodityDeclarationSignature: plan.commodityDeclarationSignature,
      fragments,
      hasAccountDeclarations: plan.hasAccountDeclarations,
      hasCommodityDeclarations: plan.hasCommodityDeclarations,
      orderedTransactions: plan.orderedTransactions,
      replayBlocks: [
        ...reusableReplayBlocks,
        ...buildReplayBlocks(
          fragments,
          reusableReplayBlocks[reusableReplayBlocks.length - 1]?.endIndex ?? 0,
        ),
      ],
    },
  };
}

function buildVerificationPlan(
  workspace: ParsedLedgerWorkspace,
  options: VerifyLedgerOptions,
): LedgerVerificationPlan {
  const fileMap = new Map(workspace.files.map((file) => [file.file.path, file]));
  const availableFilePaths = new Set(options.availableFilePaths ?? Array.from(fileMap.keys()));
  const baseDiagnostics: LedgerDiagnostic[] = workspace.files.flatMap((file) => [
    ...file.syntaxDiagnostics,
    ...file.directiveDiagnostics,
  ]);
  const dependencyEdges: Array<{ from: string; to: string }> = [];
  const includedFiles = new Set<string>();
  const includeGraph = new Map<string, string[]>();
  const candidateRootFiles = options.rootFilePaths?.filter((path) => fileMap.has(path)) ?? [];
  const rootFiles =
    candidateRootFiles.length > 0
      ? sortUnique(candidateRootFiles)
      : workspace.rootFilePaths.length > 0
        ? sortUnique(workspace.rootFilePaths)
        : workspace.files
            .filter((file) => file.file.isLedger)
            .map((file) => file.file.path)
            .sort((left, right) => left.localeCompare(right));

  for (const parsedFile of workspace.files) {
    const includeTargets = sortUnique(parsedFile.includeTargets);
    includeGraph.set(parsedFile.file.path, includeTargets);

    for (const target of includeTargets) {
      dependencyEdges.push({ from: parsedFile.file.path, to: target });
      includedFiles.add(target);

      if (!availableFilePaths.has(target)) {
        baseDiagnostics.push(
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

  detectIncludeCycles(rootFiles, includeGraph, baseDiagnostics);

  const reachableFilePaths = collectReachableFilePaths(rootFiles, includeGraph).filter((path) =>
    fileMap.has(path),
  );
  const reachableSet = new Set(reachableFilePaths);

  for (const path of availableFilePaths) {
    if (!reachableSet.has(path) && hasLedgerExtension(path)) {
      baseDiagnostics.push(
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
  const directivePrices: LedgerPrice[] = [];
  const orderedTransactions: LedgerVerificationTransactionDescriptor[] = [];
  let postingCount = 0;

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

    for (const price of parsedFile.prices) {
      directivePrices.push({
        ...price,
        id: `${parsedFile.file.path}:${price.line}:${price.fromCommodity}:${price.toCommodity ?? ''}:${price.rawDate}`,
        path: parsedFile.file.path,
      });
    }

    for (const transaction of parsedFile.transactions) {
      orderedTransactions.push({
        cacheKey: transaction.cacheKey,
        parsedFile,
        transaction,
      });
      postingCount += transaction.postings.length;
    }
  }

  orderedTransactions.sort((left, right) => {
    if (left.transaction.date === right.transaction.date) {
      return left.transaction.fileOrder.localeCompare(right.transaction.fileOrder);
    }

    return left.transaction.date.localeCompare(right.transaction.date);
  });

  return {
    accountDeclarationSignature: buildDeclarationSignature(declaredAccounts),
    baseDiagnostics,
    commodityDeclarationSignature: buildDeclarationSignature(declaredCommodities),
    declaredAccounts,
    declaredCommodities,
    dependencyEdges,
    directivePrices: directivePrices.sort(comparePrices),
    graph: {
      dependencyEdges: [...dependencyEdges].sort(compareDependencyEdges),
      includedFiles: Array.from(includedFiles).sort((left, right) => left.localeCompare(right)),
      rootFiles,
    },
    hasAccountDeclarations: declaredAccounts.size > 0,
    hasCommodityDeclarations: declaredCommodities.size > 0,
    orderedTransactions,
    postingCount,
    transactionCount: orderedTransactions.length,
  };
}

function getReusablePrefixLength(
  plan: LedgerVerificationPlan,
  previousCache: LedgerVerificationCache | null,
) {
  if (!previousCache) {
    return 0;
  }

  const maxLength = Math.min(
    plan.orderedTransactions.length,
    previousCache.orderedTransactions.length,
    previousCache.fragments.length,
  );
  let index = 0;

  while (index < maxLength) {
    const current = plan.orderedTransactions[index];
    const previous = previousCache.orderedTransactions[index];
    const previousFragment = previousCache.fragments[index];

    if (
      current.cacheKey !== previous.cacheKey ||
      !previousFragment ||
      !hasStableFragmentDeclarationContext(previousFragment, previousCache, plan)
    ) {
      break;
    }

    index += 1;
  }

  return index;
}

function cloneReusableCheckpoints(
  previousCache: LedgerVerificationCache | null,
  reusablePrefixLength: number,
) {
  if (!previousCache || reusablePrefixLength === 0) {
    return [];
  }

  return previousCache.checkpoints
    .filter((checkpoint) => checkpoint.transactionIndex <= reusablePrefixLength)
    .map((checkpoint) => cloneVerificationCheckpoint(checkpoint));
}

function cloneReusableReplayBlocks(
  previousCache: LedgerVerificationCache | null,
  reusablePrefixLength: number,
) {
  if (!previousCache || reusablePrefixLength === 0) {
    return [];
  }

  return previousCache.replayBlocks
    .filter((block) => block.endIndex <= reusablePrefixLength)
    .map((block) => ({
      balanceDeltas: block.balanceDeltas.map((delta) => ({ ...delta })),
      endIndex: block.endIndex,
      startIndex: block.startIndex,
    }));
}

function restoreRuntimeStateFromCache(
  previousCache: LedgerVerificationCache | null,
  reusablePrefixLength: number,
) {
  if (!previousCache || reusablePrefixLength === 0) {
    return createVerificationRuntimeState();
  }

  const checkpoint = findBestCheckpoint(previousCache.checkpoints, reusablePrefixLength);
  const runtimeState = checkpoint
    ? {
        inclusiveRunningBalances: cloneAccountBalanceMap(checkpoint.inclusiveRunningBalances),
        runningBalances: cloneAccountBalanceMap(checkpoint.runningBalances),
      }
    : createVerificationRuntimeState();
  const startIndex = checkpoint?.transactionIndex ?? 0;

  for (let index = startIndex; index < reusablePrefixLength; index += 1) {
    const fragment = previousCache.fragments[index];

    if (!fragment) {
      break;
    }

    applyBalanceDeltas(runtimeState, fragment.balanceDeltas);
  }

  return runtimeState;
}

function buildReusableFragmentLookup(
  previousCache: LedgerVerificationCache | null,
  plan: LedgerVerificationPlan,
) {
  const reusable = new Map<
    string,
    {
      fragment: LedgerVerificationFragment;
      index: number;
    }
  >();

  if (!previousCache) {
    return reusable;
  }

  for (let index = 0; index < previousCache.orderedTransactions.length; index += 1) {
    const descriptor = previousCache.orderedTransactions[index];
    const fragment = previousCache.fragments[index];

    if (
      !fragment ||
      fragment.dependsOnPriorBalances ||
      !hasStableFragmentDeclarationContext(fragment, previousCache, plan)
    ) {
      continue;
    }

    reusable.set(descriptor.cacheKey, {
      fragment,
      index,
    });
  }

  return reusable;
}

function buildReplayBlockLookup(previousCache: LedgerVerificationCache | null) {
  if (!previousCache) {
    return new Map<number, LedgerVerificationReplayBlock>();
  }

  return new Map<number, LedgerVerificationReplayBlock>(
    previousCache.replayBlocks.map((block) => [block.startIndex, block] as const),
  );
}

function findReusableReplayBlock(args: {
  currentIndex: number;
  plan: LedgerVerificationPlan;
  previousCache: LedgerVerificationCache | null;
  previousIndex: number | null;
  previousReplayBlocks: Map<number, LedgerVerificationReplayBlock>;
}) {
  const { currentIndex, plan, previousCache, previousIndex, previousReplayBlocks } = args;

  if (
    !previousCache ||
    previousIndex == null ||
    currentIndex % CHECKPOINT_INTERVAL !== 0 ||
    previousIndex % CHECKPOINT_INTERVAL !== 0
  ) {
    return null;
  }

  const replayBlock = previousReplayBlocks.get(previousIndex);

  if (!replayBlock) {
    return null;
  }

  const blockLength = replayBlock.endIndex - replayBlock.startIndex;

  if (
    blockLength <= 0 ||
    currentIndex + blockLength > plan.orderedTransactions.length ||
    replayBlock.endIndex > previousCache.orderedTransactions.length
  ) {
    return null;
  }

  for (let offset = 0; offset < blockLength; offset += 1) {
    const currentDescriptor = plan.orderedTransactions[currentIndex + offset];
    const previousDescriptor = previousCache.orderedTransactions[previousIndex + offset];
    const previousFragment = previousCache.fragments[previousIndex + offset];

    if (
      !currentDescriptor ||
      !previousDescriptor ||
      !previousFragment ||
      currentDescriptor.cacheKey !== previousDescriptor.cacheKey ||
      previousFragment.dependsOnPriorBalances ||
      !hasStableFragmentDeclarationContext(previousFragment, previousCache, plan)
    ) {
      return null;
    }
  }

  return replayBlock;
}

function buildReplayBlocks(
  fragments: LedgerVerificationFragment[],
  startIndex = 0,
) {
  const replayBlocks: LedgerVerificationReplayBlock[] = [];
  let aggregate = new Map<string, LedgerVerificationBalanceDelta>();
  let blockIsReusable = true;
  let blockStartIndex = startIndex;

  for (let index = startIndex; index < fragments.length; index += 1) {
    const fragment = fragments[index];

    if (!fragment) {
      blockIsReusable = false;
      continue;
    }

    if (fragment.dependsOnPriorBalances) {
      blockIsReusable = false;
    }

    addBalanceDeltasToAggregate(aggregate, fragment.balanceDeltas);

    const isBoundary =
      (index + 1) % CHECKPOINT_INTERVAL === 0 || index === fragments.length - 1;

    if (!isBoundary) {
      continue;
    }

    if (blockIsReusable) {
      replayBlocks.push({
        balanceDeltas: Array.from(aggregate.values()),
        endIndex: index + 1,
        startIndex: blockStartIndex,
      });
    }

    aggregate = new Map();
    blockIsReusable = true;
    blockStartIndex = index + 1;
  }

  return replayBlocks;
}

function hasStableFragmentDeclarationContext(
  fragment: LedgerVerificationFragment,
  previousCache: LedgerVerificationCache,
  plan: LedgerVerificationPlan,
) {
  if (
    previousCache.accountDeclarationSignature === plan.accountDeclarationSignature &&
    previousCache.commodityDeclarationSignature === plan.commodityDeclarationSignature
  ) {
    return true;
  }

  return (
    hasStableDeclarationStatuses(
      fragment.accounts,
      previousCache.hasAccountDeclarations,
      previousCache.declaredAccounts,
      plan.hasAccountDeclarations,
      plan.declaredAccounts,
    ) &&
    hasStableDeclarationStatuses(
      fragment.commodities,
      previousCache.hasCommodityDeclarations,
      previousCache.declaredCommodities,
      plan.hasCommodityDeclarations,
      plan.declaredCommodities,
    )
  );
}

function hasStableDeclarationStatuses(
  symbols: string[],
  previousIsStrict: boolean,
  previousDeclarations: Set<string>,
  nextIsStrict: boolean,
  nextDeclarations: Set<string>,
) {
  for (const symbol of symbols) {
    if (
      isDeclaredForVerification(symbol, previousIsStrict, previousDeclarations) !==
      isDeclaredForVerification(symbol, nextIsStrict, nextDeclarations)
    ) {
      return false;
    }
  }

  return true;
}

function isDeclaredForVerification(
  symbol: string,
  isStrict: boolean,
  declarations: Set<string>,
) {
  return !isStrict || declarations.has(symbol);
}

function findBestCheckpoint(
  checkpoints: LedgerVerificationCheckpoint[],
  reusablePrefixLength: number,
) {
  for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
    const checkpoint = checkpoints[index];

    if (checkpoint.transactionIndex <= reusablePrefixLength) {
      return checkpoint;
    }
  }

  return null;
}

function createVerificationRuntimeState(): VerificationRuntimeState {
  return {
    inclusiveRunningBalances: new Map(),
    runningBalances: new Map(),
  };
}

function createVerificationCheckpoint(
  transactionIndex: number,
  runtimeState: VerificationRuntimeState,
): LedgerVerificationCheckpoint {
  return {
    inclusiveRunningBalances: cloneAccountBalanceMap(runtimeState.inclusiveRunningBalances),
    runningBalances: cloneAccountBalanceMap(runtimeState.runningBalances),
    transactionIndex,
  };
}

function cloneVerificationCheckpoint(
  checkpoint: LedgerVerificationCheckpoint,
): LedgerVerificationCheckpoint {
  return {
    inclusiveRunningBalances: cloneAccountBalanceMap(checkpoint.inclusiveRunningBalances),
    runningBalances: cloneAccountBalanceMap(checkpoint.runningBalances),
    transactionIndex: checkpoint.transactionIndex,
  };
}

function cloneAccountBalanceMap(source: AccountBalanceMap) {
  return new Map(
    Array.from(source.entries()).map(([account, totals]) => [account, new Map(totals)]),
  );
}

function materializeLedgerAnalysis(
  workspace: ParsedLedgerWorkspace,
  plan: LedgerVerificationPlan,
  fragments: LedgerVerificationFragment[],
  runtimeState: VerificationRuntimeState,
  verifyMs: number,
): LedgerAnalysis {
  const accounts = new Set<string>();
  const diagnostics = [...plan.baseDiagnostics];
  const postingPrices: LedgerPrice[] = [];
  const registerByDate = new Map<string, RegisterEntry[]>();
  const transactionDates = new Set<string>();
  const transactionsByDate = new Map<string, Transaction[]>();

  for (const fragment of fragments) {
    for (const account of fragment.accounts) {
      accounts.add(account);
    }

    diagnostics.push(...fragment.diagnostics);
    postingPrices.push(...fragment.prices);

    if (fragment.transaction) {
      appendDateEntries(registerByDate, fragment.transaction.date, fragment.register);
      appendDateEntries(transactionsByDate, fragment.transaction.date, [fragment.transaction]);
      transactionDates.add(fragment.transaction.date);
    }
  }

  const sortedDiagnostics = diagnostics.sort(compareDiagnostics);
  const sortedDatesDescending = Array.from(transactionDates).sort((left, right) =>
    right.localeCompare(left),
  );
  const sortedRegister = materializeEntriesByDate(sortedDatesDescending, registerByDate);
  const sortedTransactions = materializeEntriesByDate(sortedDatesDescending, transactionsByDate);
  const sortedPrices = mergeSortedPrices(plan.directivePrices, postingPrices);

  return {
    accounts: Array.from(accounts).sort((left, right) => left.localeCompare(right)),
    balances: Array.from(runtimeState.runningBalances.entries())
      .flatMap(([account, totals]) =>
        Array.from(totals.entries())
          .filter(([commodity]) => Boolean(account) && Boolean(commodity))
          .map(([commodity, amount]) => ({ account, amount, commodity })),
      )
      .sort((left, right) => {
        if (left.account === right.account) {
          return left.commodity.localeCompare(right.commodity);
        }

        return left.account.localeCompare(right.account);
      }),
    declaredAccounts: Array.from(plan.declaredAccounts).sort((left, right) =>
      left.localeCompare(right),
    ),
    declaredCommodities: Array.from(plan.declaredCommodities).sort((left, right) =>
      left.localeCompare(right),
    ),
    diagnostics: sortedDiagnostics,
    graph: plan.graph,
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
    prices: sortedPrices,
    register: sortedRegister,
    summary: {
      postingCount: plan.postingCount,
      transactionCount: plan.transactionCount,
    },
    timings: {
      parseMs: workspace.totalParseMs,
      totalMs: workspace.totalParseMs + verifyMs,
      verifyMs,
    },
    transactions: sortedTransactions,
  };
}

function verifyTransactionFragment(args: {
  declaredAccounts: Set<string>;
  declaredCommodities: Set<string>;
  hasAccountDeclarations: boolean;
  hasCommodityDeclarations: boolean;
  parsedFile: ParsedLedgerFile;
  runtimeState: VerificationRuntimeState;
  transaction: ParsedLedgerTransaction;
  transactionId: string;
}): LedgerVerificationFragment {
  const {
    declaredAccounts,
    declaredCommodities,
    hasAccountDeclarations,
    hasCommodityDeclarations,
    parsedFile,
    runtimeState,
    transaction,
    transactionId,
  } = args;
  const accounts = new Set<string>();
  const balanceDeltas: LedgerVerificationBalanceDelta[] = [];
  const commodities = new Set<string>();
  const dependsOnPriorBalances = transaction.postings.some((posting) => posting.balanceAssertion);
  const diagnostics: LedgerDiagnostic[] = [];
  const prices: LedgerPrice[] = [];
  const register: RegisterEntry[] = [];
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

  for (const posting of transaction.postings) {
    accounts.add(posting.account);

    if (posting.commodity) {
      commodities.add(posting.commodity);
    }

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
        const assignment = inferBalanceAssignment(posting, runtimeState);

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
          balanceDeltas,
          parsedFile,
          posting: {
            ...posting,
            amount: assignment.amount,
            commodity: assignment.commodity,
          },
          prices,
          register,
          runtimeState,
          targetTotals: totalsForPostingKind(posting.kind, realTotals, balancedVirtualTotals),
          transaction,
          transactionEntries,
          transactionId,
          wasInferred: true,
        });
        checkBalanceAssertion(posting, parsedFile.file.path, diagnostics, runtimeState);
        continue;
      }

      queuePendingPosting(posting, pendingReal, pendingBalancedVirtual);
      continue;
    }

    applyPostingEntry({
      balanceDeltas,
      parsedFile,
      posting: posting as ParsedLedgerPosting & { amount: number; commodity: string },
      prices,
      register,
      runtimeState,
      targetTotals: totalsForPostingKind(posting.kind, realTotals, balancedVirtualTotals),
      transaction,
      transactionEntries,
      transactionId,
      wasInferred: false,
    });
    checkBalanceAssertion(posting, parsedFile.file.path, diagnostics, runtimeState);
  }

  resolvePendingPostings({
    balanceDeltas,
    commodityPrecisions: realCommodityPrecisions,
    diagnostics,
    kind: 'real',
    parsedFile,
    pending: pendingReal,
    prices,
    register,
    runtimeState,
    targetTotals: realTotals,
    transaction,
    transactionEntries,
    transactionId,
  });
  resolvePendingPostings({
    balanceDeltas,
    commodityPrecisions: balancedVirtualCommodityPrecisions,
    diagnostics,
    kind: 'balanced-virtual',
    parsedFile,
    pending: pendingBalancedVirtual,
    prices,
    register,
    runtimeState,
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

  return {
    accounts: Array.from(accounts),
    balanceDeltas,
    commodities: Array.from(commodities),
    dependsOnPriorBalances,
    diagnostics,
    postingCount: transaction.postings.length,
    prices,
    register,
    transaction:
      transactionEntries.length > 0
        ? {
            comment: transaction.comment,
            date: transaction.date,
            description: transaction.description,
            fileOrder: transaction.fileOrder,
            id: transactionId,
            line: transaction.headerLine,
            path: transaction.path,
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
          }
        : null,
  };
}

function resolvePendingPostings(args: {
  balanceDeltas: LedgerVerificationBalanceDelta[];
  commodityPrecisions: Map<string, number>;
  diagnostics: LedgerDiagnostic[];
  kind: 'balanced-virtual' | 'real';
  parsedFile: ParsedLedgerFile;
  pending: PendingPosting[];
  prices: LedgerPrice[];
  register: RegisterEntry[];
  runtimeState: VerificationRuntimeState;
  targetTotals: CommodityTotals;
  transaction: ParsedLedgerTransaction;
  transactionEntries: RegisterEntry[];
  transactionId: string;
}) {
  const {
    balanceDeltas,
    commodityPrecisions,
    diagnostics,
    kind,
    parsedFile,
    pending,
    prices,
    register,
    runtimeState,
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
        balanceDeltas,
        parsedFile,
        posting: {
          ...pendingPosting.posting,
          amount: 0,
          commodity: inferredCommodity,
        },
        prices,
        register,
        runtimeState,
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

  const [inferredCommodity, totalAmount] = nonZeroTotals[0];

  applyPostingEntry({
    balanceDeltas,
    parsedFile,
    posting: {
      ...pendingPosting.posting,
      amount: -totalAmount,
      commodity: inferredCommodity,
    },
    prices,
    register,
    runtimeState,
    targetTotals,
    transaction,
    transactionEntries,
    transactionId,
    wasInferred: true,
  });
}

function queuePendingPosting(
  posting: ParsedLedgerPosting,
  pendingReal: PendingPosting[],
  pendingBalancedVirtual: PendingPosting[],
) {
  if (posting.kind === 'balanced-virtual') {
    pendingBalancedVirtual.push({ posting });
    return;
  }

  if (posting.kind === 'real') {
    pendingReal.push({ posting });
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
  balanceDeltas: LedgerVerificationBalanceDelta[];
  parsedFile: ParsedLedgerFile;
  posting: ParsedLedgerPosting & { amount: number; commodity: string };
  prices: LedgerPrice[];
  register: RegisterEntry[];
  runtimeState: VerificationRuntimeState;
  targetTotals: CommodityTotals | null;
  transaction: ParsedLedgerTransaction;
  transactionEntries: RegisterEntry[];
  transactionId: string;
  wasInferred: boolean;
}) {
  const {
    balanceDeltas,
    parsedFile,
    posting,
    prices,
    register,
    runtimeState,
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
  balanceDeltas.push({
    account: posting.account,
    amount: posting.amount,
    commodity: posting.commodity,
  });
  applyBalanceDelta(runtimeState, balanceDeltas[balanceDeltas.length - 1]);

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
  runtimeState: VerificationRuntimeState,
) {
  const assertion = posting.balanceAssertion;

  if (!assertion) {
    return null;
  }

  const currentBalance = assertion.inclusive
    ? getInclusiveRunningBalance(runtimeState.inclusiveRunningBalances, posting.account)
    : getRunningBalance(runtimeState.runningBalances, posting.account);
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

  const [commodity, amount] = nonZeroEntries[0];
  return {
    amount,
    commodity,
  };
}

function checkBalanceAssertion(
  posting: ParsedLedgerPosting,
  path: string,
  diagnostics: LedgerDiagnostic[],
  runtimeState: VerificationRuntimeState,
) {
  const assertion = posting.balanceAssertion;

  if (!assertion) {
    return;
  }

  const actualBalance = assertion.inclusive
    ? getInclusiveRunningBalance(runtimeState.inclusiveRunningBalances, posting.account)
    : getRunningBalance(runtimeState.runningBalances, posting.account);
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

function applyBalanceDeltas(
  runtimeState: VerificationRuntimeState,
  balanceDeltas: LedgerVerificationBalanceDelta[],
) {
  for (const delta of balanceDeltas) {
    applyBalanceDelta(runtimeState, delta);
  }
}

function addBalanceDeltasToAggregate(
  aggregate: Map<string, LedgerVerificationBalanceDelta>,
  balanceDeltas: LedgerVerificationBalanceDelta[],
) {
  for (const delta of balanceDeltas) {
    const key = `${delta.account}::${delta.commodity}`;
    const existing = aggregate.get(key);

    if (existing) {
      existing.amount += delta.amount;
      continue;
    }

    aggregate.set(key, { ...delta });
  }
}

function applyBalanceDelta(
  runtimeState: VerificationRuntimeState,
  delta: LedgerVerificationBalanceDelta,
) {
  addToAccountBalanceMap(runtimeState.runningBalances, delta.account, delta.commodity, delta.amount);

  for (const account of getAccountAncestors(delta.account)) {
    addToAccountBalanceMap(
      runtimeState.inclusiveRunningBalances,
      account,
      delta.commodity,
      delta.amount,
    );
  }
}

function addToAccountBalanceMap(
  balances: AccountBalanceMap,
  account: string,
  commodity: string,
  amount: number,
) {
  let totals = balances.get(account);

  if (!totals) {
    totals = new Map();
    balances.set(account, totals);
  }

  addToCommodityTotals(totals, commodity, amount);
}

function getRunningBalance(
  runningBalances: AccountBalanceMap,
  account: string,
) {
  return new Map(runningBalances.get(account) ?? []);
}

function getInclusiveRunningBalance(
  inclusiveRunningBalances: AccountBalanceMap,
  account: string,
) {
  return new Map(inclusiveRunningBalances.get(account) ?? []);
}

function getAccountAncestors(account: string) {
  const cached = ACCOUNT_ANCESTORS_CACHE.get(account);

  if (cached) {
    return cached;
  }

  const segments = account.split(':');
  const accounts: string[] = [];

  for (let index = 1; index <= segments.length; index += 1) {
    accounts.push(segments.slice(0, index).join(':'));
  }

  ACCOUNT_ANCESTORS_CACHE.set(account, accounts);
  return accounts;
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
    ([commodity, amount]) =>
      !looksZeroAtCommodityPrecision(amount, commodityPrecisions.get(commodity)),
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
  transaction: ParsedLedgerTransaction,
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
  transaction: ParsedLedgerTransaction,
  posting: ParsedLedgerPosting,
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

    for (const dependency of graph.get(path) ?? []) {
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

  const visit = (path: string) => {
    if (visited.has(path)) {
      return;
    }

    visited.add(path);

    for (const dependency of includeGraph.get(path) ?? []) {
      visit(dependency);
    }
  };

  for (const root of rootFiles) {
    visit(root);
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

function compareDependencyEdges(
  left: { from: string; to: string },
  right: { from: string; to: string },
) {
  if (left.from === right.from) {
    return left.to.localeCompare(right.to);
  }

  return left.from.localeCompare(right.from);
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

function comparePrices(left: LedgerPrice, right: LedgerPrice) {
  if (left.date === right.date) {
    return left.id.localeCompare(right.id);
  }

  return left.date.localeCompare(right.date);
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
  const cached = ACCOUNT_TYPE_CACHE.get(account);

  if (cached) {
    return cached;
  }

  const firstSegment = account.split(':')[0].toLowerCase().trim();
  let accountType: AccountType;

  switch (firstSegment) {
    case 'asset':
    case 'assets':
      accountType = 'asset';
      break;
    case 'liability':
    case 'liabilities':
      accountType = 'liability';
      break;
    case 'equity':
      accountType = 'equity';
      break;
    case 'revenue':
    case 'revenues':
    case 'income':
      accountType = 'income';
      break;
    case 'expense':
    case 'expenses':
      accountType = 'expense';
      break;
    default:
      accountType = 'unknown';
      break;
  }

  ACCOUNT_TYPE_CACHE.set(account, accountType);
  return accountType;
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

function buildDeclarationSignature(values: Set<string>) {
  return Array.from(values).sort((left, right) => left.localeCompare(right)).join('\n');
}

function appendDateEntries<T>(
  entriesByDate: Map<string, T[]>,
  date: string,
  entries: T[],
) {
  if (entries.length === 0) {
    return;
  }

  const existingEntries = entriesByDate.get(date);

  if (existingEntries) {
    existingEntries.push(...entries);
    return;
  }

  entriesByDate.set(date, [...entries]);
}

function materializeEntriesByDate<T>(
  sortedDatesDescending: string[],
  entriesByDate: Map<string, T[]>,
) {
  const entries: T[] = [];

  for (const date of sortedDatesDescending) {
    entries.push(...(entriesByDate.get(date) ?? []));
  }

  return entries;
}

function mergeSortedPrices(
  left: LedgerPrice[],
  right: LedgerPrice[],
) {
  if (left.length === 0) {
    return [...right];
  }

  if (right.length === 0) {
    return [...left];
  }

  const merged: LedgerPrice[] = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    const leftPrice = left[leftIndex];
    const rightPrice = right[rightIndex];

    if (comparePrices(leftPrice, rightPrice) <= 0) {
      merged.push(leftPrice);
      leftIndex += 1;
      continue;
    }

    merged.push(rightPrice);
    rightIndex += 1;
  }

  while (leftIndex < left.length) {
    merged.push(left[leftIndex]);
    leftIndex += 1;
  }

  while (rightIndex < right.length) {
    merged.push(right[rightIndex]);
    rightIndex += 1;
  }

  return merged;
}

function formatCommodityAmount(commodity: string, amount: number) {
  return commodity ? `${commodity} ${amount}` : String(amount);
}

function formatCommodityTotals(entries: Array<[string, number]>) {
  return entries
    .map(([commodity, amount]) => formatCommodityAmount(commodity, amount))
    .join(', ');
}

function sortUnique(values: string[]) {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}
