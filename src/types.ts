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
  comment: string;
  date: string;
  description: string;
  headerLine: number;
  postings: ParsedLedgerPosting[];
  secondaryDate: null | string;
  tags: LedgerTag[];
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

export type ParsedLedgerFile = {
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

export type ParseLedgerProgress = {
  completedFiles: number;
  currentPath: string;
  discoveredFiles: number;
  phase: 'complete' | 'parsing';
};

export type RegisterEntry = {
  account: string;
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
  postings: RegisterEntry[];
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

export type LedgerAnalysisIndex = {
  diagnosticPositionById: Record<string, number>;
  diagnosticsByPath: Record<string, string[]>;
  registerIdsByAccount: Record<string, string[]>;
  registerIdsByAccountType: Record<string, string[]>;
  registerIdsByCommodity: Record<string, string[]>;
  registerIdsByDate: Record<string, string[]>;
  registerIdsByPath: Record<string, string[]>;
  registerPositionById: Record<string, number>;
  transactionIdsByDate: Record<string, string[]>;
  transactionIdsByPath: Record<string, string[]>;
  transactionPositionById: Record<string, number>;
};

export type LedgerAnalysis = {
  accounts: string[];
  balances: AccountBalance[];
  declaredAccounts: string[];
  declaredCommodities: string[];
  diagnostics: LedgerDiagnostic[];
  graph: {
    dependencyEdges: Array<{ from: string; to: string }>;
    includedFiles: string[];
    rootFiles: string[];
  };
  index: LedgerAnalysisIndex;
  parserSummary: {
    errorNodeCount: number;
    fileCount: number;
    nodeCount: number;
    reusedFileCount: number;
  };
  prices: LedgerPrice[];
  register: RegisterEntry[];
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
};
