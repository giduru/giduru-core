export type LedgerDiagnosticSource = 'engine' | 'parser' | 'settings';

export type LedgerDiagnostic = {
  id: string;
  line?: number;
  message: string;
  path: string;
  severity: 'error' | 'info' | 'warning';
  source: LedgerDiagnosticSource;
};

export type AccountType =
  | 'asset'
  | 'equity'
  | 'expense'
  | 'income'
  | 'liability'
  | 'unknown';

export type PostingKind = 'balanced-virtual' | 'real' | 'virtual';

export type BalanceAssertionOperator = '=' | '==' | '=*' | '==*';

export type LedgerTag = {
  name: string;
  value: string;
};

export type LedgerTagFilter = {
  name: string;
  value?: string;
};

export type ParsedLedgerPrice = {
  amount: number;
  comment: string;
  date: string;
  fromCommodity: string;
  line: number;
  rawDate: string;
  source: 'directive' | 'posting-annotation';
  toCommodity: null | string;
};

export type LedgerPrice = ParsedLedgerPrice & {
  id: string;
  path: string;
};

export type ParsedLedgerBalanceAssertion = {
  amount: number;
  commodity: null | string;
  inclusive: boolean;
  operator: BalanceAssertionOperator;
  total: boolean;
};

export type ParsedLedgerAccountDirective = {
  account: string;
  comment: string;
  line: number;
  tags: LedgerTag[];
  type: AccountType | null;
  typeAnnotationValues: string[];
  typeDiagnostic: null | string;
};

export type ParsedLedgerCommodityDirective = {
  commodity: string;
  line: number;
};

export type ParsedLedgerPosting = {
  account: string;
  amount: null | number;
  amountPrecision: null | number;
  balanceAssertion: null | ParsedLedgerBalanceAssertion;
  comment: string;
  commodity: null | string;
  kind: PostingKind;
  line: number;
  priceAnnotation: null | {
    amount: number;
    commodity: null | string;
    kind: 'total' | 'unit';
    precision: null | number;
  };
  tags: LedgerTag[];
};

export type ParsedLedgerTransaction = {
  cacheKey: string;
  comment: string;
  date: string;
  description: string;
  fileOrder: string;
  headerLine: number;
  path: string;
  postings: ParsedLedgerPosting[];
  secondaryDate: null | string;
  tags: LedgerTag[];
  transactionId: string;
};

export type ParsedLedgerIncludeDirective = {
  error: null | 'invalid-glob' | 'missing-target' | 'no-match';
  isGlob: boolean;
  line: number;
  matches: string[];
  normalized: string;
  raw: string;
  resolved: string;
};

export type LedgerSourceDocument = {
  content: string;
  isLedger: boolean;
  lastModified?: number;
  name: string;
  path: string;
};

export type LedgerSourceDocumentsInput =
  | Iterable<LedgerSourceDocument>
  | ReadonlyMap<string, LedgerSourceDocument>;

export type ParsedLedgerFile = {
  accountDirectives: ParsedLedgerAccountDirective[];
  commodityDirectives: ParsedLedgerCommodityDirective[];
  declaredAccounts: string[];
  declaredCommodities: string[];
  directiveDiagnostics: LedgerDiagnostic[];
  file: LedgerSourceDocument;
  includeDirectives: ParsedLedgerIncludeDirective[];
  includeTargets: string[];
  prices: ParsedLedgerPrice[];
  stats: {
    errorNodeCount: number;
    nodeCount: number;
    parseMs: number;
    topNode: string;
  };
  syntaxDiagnostics: LedgerDiagnostic[];
  transactions: ParsedLedgerTransaction[];
};

export type ParsedLedgerWorkspace = {
  files: ParsedLedgerFile[];
  reusedFileCount: number;
  rootFilePaths: string[];
  totalParseMs: number;
};

export type LedgerVerificationBalanceDelta = {
  account: string;
  amount: number;
  commodity: string;
};

export type LedgerVerificationTransactionDescriptor = {
  cacheKey: string;
  parsedFile: ParsedLedgerFile;
  transaction: ParsedLedgerTransaction;
};

export type LedgerVerificationFragment = {
  accounts: string[];
  balanceDeltas: LedgerVerificationBalanceDelta[];
  commodities: string[];
  dependsOnPriorBalances: boolean;
  diagnostics: LedgerDiagnostic[];
  postingCount: number;
  prices: LedgerPrice[];
  postings: Posting[];
  transaction: null | Transaction;
};

export type LedgerVerificationCheckpoint = {
  inclusiveRunningBalances: Map<string, Map<string, number>>;
  runningBalances: Map<string, Map<string, number>>;
  transactionIndex: number;
};

export type LedgerVerificationReplayBlock = {
  balanceDeltas: LedgerVerificationBalanceDelta[];
  endIndex: number;
  startIndex: number;
};

export type LedgerVerificationCache = {
  accountDeclarationSignature: string;
  accountMetadataSignatures: Record<string, string>;
  checkpoints: LedgerVerificationCheckpoint[];
  declaredAccounts: Set<string>;
  declaredCommodities: Set<string>;
  commodityDeclarationSignature: string;
  fragments: LedgerVerificationFragment[];
  hasAccountDeclarations: boolean;
  hasCommodityDeclarations: boolean;
  orderedTransactions: LedgerVerificationTransactionDescriptor[];
  replayBlocks: LedgerVerificationReplayBlock[];
};

export type ParseLedgerProgress = {
  completedFiles: number;
  currentPath: string;
  discoveredFiles: number;
  phase: 'complete' | 'parsing';
};

export type Posting = {
  account: string;
  accountTags: LedgerTag[];
  accountType: AccountType;
  amount: number;
  balanceAssertion: null | ParsedLedgerBalanceAssertion;
  comment: string;
  commodity: string;
  date: string;
  description: string;
  id: string;
  inferredAmount: boolean;
  kind: PostingKind;
  line: number;
  path: string;
  postingTags: LedgerTag[];
  searchText: string;
  tags: LedgerTag[];
  transactionComment: string;
  transactionId: string;
  transactionTags: LedgerTag[];
};

export type Transaction = {
  comment: string;
  date: string;
  description: string;
  fileOrder: string;
  id: string;
  line: number;
  path: string;
  postings: Posting[];
  searchText: string;
  secondaryDate: null | string;
  tags: LedgerTag[];
};

export type PossibleDuplicateTransaction = {
  amountSimilarity: number;
  dateDistanceDays: number;
  descriptionSimilarity: number;
  id: string;
  left: Transaction;
  right: Transaction;
};

export type RecurringTransactionCadence =
  | 'weekly'
  | 'biweekly'
  | 'semi-monthly'
  | 'monthly';

export type RecurringTransactionSeries = {
  amount: number;
  cadence: RecurringTransactionCadence;
  commodity: string;
  endDate: string;
  id: string;
  kind: 'expense' | 'income' | 'other';
  occurrenceCount: number;
  occurrences: Transaction[];
  startDate: string;
  vendor: string;
};

export type AccountBalance = {
  account: string;
  amount: number;
  commodity: string;
};

export type LedgerAccountDirectiveRecord = {
  account: string;
  comment: string;
  line: number;
  path: string;
  tags: LedgerTag[];
  type: AccountType | null;
  typeAnnotationValues: string[];
  typeDiagnostic: null | string;
};

export type LedgerAccountCatalogEntry = {
  account: string;
  comments: string[];
  commoditiesUsed: string[];
  declarationCount: number;
  declarations: LedgerAccountDirectiveRecord[];
  declared: boolean;
  declaredType: AccountType | null;
  effectiveType: AccountType;
  id: string;
  paths: string[];
  postingCount: number;
  tags: LedgerTag[];
  typeAnnotationValues: string[];
  typeDiagnostics: string[];
  used: boolean;
};

export type LedgerCommodityDirectiveRecord = {
  commodity: string;
  line: number;
  path: string;
};

export type LedgerCommodityCatalogEntry = {
  commodity: string;
  declarationCount: number;
  declarations: LedgerCommodityDirectiveRecord[];
  declared: boolean;
  id: string;
  paths: string[];
  postingCount: number;
  priceCount: number;
  pricedAgainst: string[];
  used: boolean;
};

export type LedgerIncludeRecord = ParsedLedgerIncludeDirective & {
  id: string;
  path: string;
};

export type LedgerAnalysisIndex = {
  accountCatalogIdsByEffectiveType: Record<string, string[]>;
  accountCatalogIdsByPath: Record<string, string[]>;
  accountCatalogIdsByTag: Record<string, string[]>;
  accountCatalogIdsByTagName: Record<string, string[]>;
  accountCatalogPositionById: Record<string, number>;
  diagnosticPositionById: Record<string, number>;
  diagnosticsByPath: Record<string, string[]>;
  postingIdsByAccount: Record<string, string[]>;
  postingIdsByAccountType: Record<string, string[]>;
  postingIdsByCommodity: Record<string, string[]>;
  postingIdsByDate: Record<string, string[]>;
  postingIdsByPath: Record<string, string[]>;
  postingIdsByTag: Record<string, string[]>;
  postingIdsByTagName: Record<string, string[]>;
  postingPositionById: Record<string, number>;
  transactionIdsByDate: Record<string, string[]>;
  transactionIdsByPath: Record<string, string[]>;
  transactionPositionById: Record<string, number>;
};

export type LedgerAnalysis = {
  accounts: string[];
  accountCatalog: LedgerAccountCatalogEntry[];
  balances: AccountBalance[];
  commodities: LedgerCommodityCatalogEntry[];
  declaredAccounts: string[];
  declaredCommodities: string[];
  diagnostics: LedgerDiagnostic[];
  graph: {
    dependencyEdges: Array<{ from: string; to: string }>;
    includedFiles: string[];
    rootFiles: string[];
  };
  includes: LedgerIncludeRecord[];
  index: LedgerAnalysisIndex;
  parserSummary: {
    errorNodeCount: number;
    fileCount: number;
    nodeCount: number;
    reusedFileCount: number;
  };
  postings: Posting[];
  prices: LedgerPrice[];
  summary: {
    postingCount: number;
    transactionCount: number;
  };
  timings: {
    parseMs: number;
    totalMs: number;
    verifyMs: number;
  };
  transactions: Transaction[];
};

export type VerifyLedgerOptions = {
  availableFilePaths?: string[];
  rootFilePaths?: string[];
};

export type LedgerPostingFilter = {
  excludeAccountTypes?: AccountType[];
  excludeAccounts?: string[];
  excludeTags?: LedgerTagFilter[];
  includeAccountTypes?: AccountType[];
  includeAccounts?: string[];
  includeTags?: LedgerTagFilter[];
};

export type AnalyzeLedgerDocumentsOptions = {
  onProgress?: (progress: ParseLedgerProgress) => void;
  rootFilePaths?: string[];
};

export type LedgerPriceResolutionQuery = {
  date: string;
  fromCommodity: string;
  mode?: 'exact' | 'latest-on-or-before';
  toCommodity?: null | string;
};

export type LedgerDocumentChange =
  | {
      path: string;
      type: 'delete';
    }
  | {
      document: LedgerSourceDocument;
      type: 'upsert';
    };

export type LedgerEngineUpdateStats = {
  parsedFileCount: number;
  parseMs: number;
  reusedFileCount: number;
};

export type LedgerEngineState = {
  documentsByPath: Map<string, LedgerSourceDocument>;
  lastUpdateStats: LedgerEngineUpdateStats;
  parsedFilesByPath: Map<string, ParsedLedgerFile>;
  verificationCache: LedgerVerificationCache | null;
};
