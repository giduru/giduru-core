import { TreeFragment, type Tree } from '@lezer/common';
import { parser as hledgerParser } from 'codemirror-lang-hledger';

import {
  expandGlob,
  isGlobPattern,
  normalizeIncludeTarget,
  resolveRelativePath,
  validateGlobPattern,
} from './path';
import type {
  LedgerDiagnostic,
  LedgerSourceDocument,
  LedgerTag,
  ParseLedgerProgress,
  ParsedLedgerBalanceAssertion,
  ParsedLedgerFile,
  ParsedLedgerIncludeDirective,
  ParsedLedgerPosting,
  ParsedLedgerPrice,
  ParsedLedgerTransaction,
  ParsedLedgerWorkspace,
} from './types';

type ParseLedgerWorkspaceOptions = {
  onProgress?: (progress: ParseLedgerProgress) => void;
  rootFilePaths: string[];
};

type ParseLedgerDocumentOptions = {
  knownFilePaths: Iterable<string>;
};

type ParseLedgerDocumentWithCacheOptions = ParseLedgerDocumentOptions & {
  previousContent?: string;
  previousTree?: Tree;
};

export type LedgerDocumentParseCache = {
  tree: Tree;
};

type ParseLedgerDocumentResult = {
  cache: LedgerDocumentParseCache;
  parsedFile: ParsedLedgerFile;
};

type ParseLedgerWorkspaceResult = {
  parseCachesByPath: Map<string, LedgerDocumentParseCache>;
  workspace: ParsedLedgerWorkspace;
};

type TreeCursor = ReturnType<ReturnType<typeof hledgerParser.parse>['cursor']>;
type ParsedLedgerPostingDraft = Omit<
  ParsedLedgerPosting,
  'balanceAssertion' | 'comment' | 'tags'
> & {
  balanceAssertion: null | ParsedLedgerBalanceAssertion;
  commentLines: string[];
};

export function parseLedgerDocument(
  document: LedgerSourceDocument,
  options: ParseLedgerDocumentOptions,
): ParsedLedgerFile {
  return parseLedgerDocumentWithCache(document, options).parsedFile;
}

export function parseLedgerDocumentWithCache(
  document: LedgerSourceDocument,
  options: ParseLedgerDocumentWithCacheOptions,
): ParseLedgerDocumentResult {
  const parseStartedAt = Date.now();
  const tree = parseLedgerTree(document.content, options.previousContent, options.previousTree);
  const parseMs = Date.now() - parseStartedAt;
  const lineStarts = buildLineStarts(document.content);
  const {
    declaredAccounts,
    declaredCommodities,
    includeDirectives,
    prices,
    transactions,
  } = extractParsedLedgerFileData(
    document.path,
    tree,
    document.content,
    lineStarts,
    options.knownFilePaths,
  );
  const errorLines = new Set<number>();
  let errorNodeCount = 0;
  let nodeCount = 0;

  walkCursor(tree.cursor(), (cursor) => {
    nodeCount += 1;

    if (cursor.type.isError) {
      errorNodeCount += 1;
      errorLines.add(lineNumberAt(cursor.from, lineStarts));
    }
  });

  return {
    cache: { tree },
    parsedFile: {
    declaredAccounts,
    declaredCommodities,
    directiveDiagnostics: buildIncludeDiagnostics(document.path, includeDirectives),
    file: document,
    includeDirectives,
    includeTargets: Array.from(
      new Set(
        includeDirectives.flatMap((directive) =>
          directive.matches.filter((target) => target !== document.path),
        ),
      ),
    ).sort((left, right) => left.localeCompare(right)),
    prices,
    stats: {
      errorNodeCount,
      nodeCount,
      parseMs,
      topNode: tree.topNode.type.name,
    },
    syntaxDiagnostics: Array.from(errorLines).map((line) =>
      createParserDiagnostic(
        document.path,
        line,
        'Lezer parser reported a syntax error node.',
      ),
    ),
    transactions,
    } satisfies ParsedLedgerFile,
  };
}

export async function parseLedgerWorkspace(
  documentsByPath: Map<string, LedgerSourceDocument>,
  options: ParseLedgerWorkspaceOptions,
): Promise<ParsedLedgerWorkspace> {
  return (await parseLedgerWorkspaceWithCache(documentsByPath, options)).workspace;
}

export async function parseLedgerWorkspaceWithCache(
  documentsByPath: Map<string, LedgerSourceDocument>,
  options: ParseLedgerWorkspaceOptions,
): Promise<ParseLedgerWorkspaceResult> {
  const rootFilePaths = Array.from(
    new Set(options.rootFilePaths.filter((path) => documentsByPath.get(path)?.isLedger)),
  ).sort((left, right) => left.localeCompare(right));
  const visited = new Set<string>();
  const queued = new Set(rootFilePaths);
  const queue = [...rootFilePaths];
  const parsedFilesByPath = new Map<string, ParsedLedgerFile>();
  const parseCachesByPath = new Map<string, ParseLedgerDocumentResult['cache']>();
  let totalParseMs = 0;

  while (queue.length > 0) {
    queue.sort((left, right) => left.localeCompare(right));
    const currentPath = queue.shift();

    if (!currentPath || visited.has(currentPath)) {
      continue;
    }

    visited.add(currentPath);
    const document = documentsByPath.get(currentPath);

    if (!document?.isLedger) {
      continue;
    }

    options.onProgress?.({
      completedFiles: parsedFilesByPath.size,
      currentPath,
      discoveredFiles: visited.size + queue.length,
      phase: 'parsing',
    });

    await yieldToMainThread();
    const { cache, parsedFile } = parseLedgerDocumentWithCache(document, {
      knownFilePaths: documentsByPath.keys(),
    });

    parsedFilesByPath.set(currentPath, parsedFile);
    parseCachesByPath.set(currentPath, cache);
    totalParseMs += parsedFile.stats.parseMs;

    for (const target of parsedFile.includeTargets) {
      if (visited.has(target) || queued.has(target)) {
        continue;
      }

      if (!documentsByPath.get(target)?.isLedger) {
        continue;
      }

      queued.add(target);
      queue.push(target);
    }
  }

  options.onProgress?.({
    completedFiles: parsedFilesByPath.size,
    currentPath: rootFilePaths[0] ?? '',
    discoveredFiles: parsedFilesByPath.size,
    phase: 'complete',
  });

  return {
    parseCachesByPath,
    workspace: {
      files: Array.from(parsedFilesByPath.values()).sort((left, right) =>
        left.file.path.localeCompare(right.file.path),
      ),
      reusedFileCount: 0,
      rootFilePaths,
      totalParseMs,
    },
  };
}

async function yieldToMainThread() {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function extractParsedLedgerFileData(
  filePath: string,
  tree: ReturnType<typeof hledgerParser.parse>,
  text: string,
  lineStarts: number[],
  knownFilePaths: Iterable<string>,
) {
  const includeDirectives: ParsedLedgerIncludeDirective[] = [];
  const declaredAccounts: string[] = [];
  const declaredCommodities: string[] = [];
  const prices: ParsedLedgerPrice[] = [];
  const transactions: ParsedLedgerTransaction[] = [];
  const cursor = tree.cursor();

  if (!cursor.firstChild()) {
    return { declaredAccounts, declaredCommodities, includeDirectives, prices, transactions };
  }

  do {
    const nodeName = cursor.type.name as string;

    if (nodeName === 'IncludeDirective') {
      includeDirectives.push(
        extractIncludeDirective(filePath, cursor, text, lineStarts, knownFilePaths),
      );
      continue;
    }

    if (nodeName === 'AccountDirective') {
      if (cursor.firstChild()) {
        do {
          if ((cursor.type.name as string) === 'DirectiveAccountName') {
            const name = text.slice(cursor.from, cursor.to).trim();

            if (name) {
              declaredAccounts.push(name);
            }
          }
        } while (cursor.nextSibling());
        cursor.parent();
      }

      continue;
    }

    if (nodeName === 'CommodityDirective') {
      if (cursor.firstChild()) {
        do {
          if ((cursor.type.name as string) === 'DirectiveArgument') {
            const argument = text.slice(cursor.from, cursor.to).trim();
            const commodity = extractDeclaredCommodity(argument);

            if (commodity) {
              declaredCommodities.push(commodity);
            }
          }
        } while (cursor.nextSibling());
        cursor.parent();
      }

      continue;
    }

    if (nodeName === 'Transaction') {
      const transaction = extractTransaction(cursor, text, lineStarts);

      if (transaction) {
        transactions.push(transaction);
      }

      continue;
    }

    if (nodeName === 'PriceDirective') {
      const price = extractPriceDirective(cursor, text, lineStarts);

      if (price) {
        prices.push(price);
      }
    }
  } while (cursor.nextSibling());

  cursor.parent();
  return { declaredAccounts, declaredCommodities, includeDirectives, prices, transactions };
}

function extractIncludeDirective(
  filePath: string,
  cursor: TreeCursor,
  text: string,
  lineStarts: number[],
  knownFilePaths: Iterable<string>,
): ParsedLedgerIncludeDirective {
  const line = lineNumberAt(cursor.from, lineStarts);

  if (!cursor.firstChild()) {
    return {
      error: 'missing-target',
      isGlob: false,
      line,
      matches: [],
      normalized: '',
      raw: '',
      resolved: '',
    };
  }

  let raw = '';

  do {
    if ((cursor.type.name as string) === 'IncludePath') {
      raw = text.slice(cursor.from, cursor.to).trim();
      break;
    }
  } while (cursor.nextSibling());

  cursor.parent();

  const normalized = normalizeIncludeTarget(raw);

  if (!normalized) {
    return {
      error: 'missing-target',
      isGlob: false,
      line,
      matches: [],
      normalized,
      raw,
      resolved: '',
    };
  }

  const resolved = resolveRelativePath(filePath, normalized);
  const isGlob = isGlobPattern(resolved);

  if (!isGlob) {
    return {
      error: null,
      isGlob,
      line,
      matches: resolved === filePath ? [] : [resolved],
      normalized,
      raw,
      resolved,
    };
  }

  const validation = validateGlobPattern(resolved);

  if (!validation.isValid) {
    return {
      error: 'invalid-glob',
      isGlob,
      line,
      matches: [],
      normalized,
      raw,
      resolved,
    };
  }

  const matches = expandGlob(resolved, knownFilePaths).filter((target) => target !== filePath);

  return {
    error: matches.length === 0 ? 'no-match' : null,
    isGlob,
    line,
    matches,
    normalized,
    raw,
    resolved,
  };
}

function buildIncludeDiagnostics(
  filePath: string,
  includeDirectives: ParsedLedgerIncludeDirective[],
) {
  return includeDirectives.flatMap((directive) => {
    if (directive.error === 'missing-target') {
      return [
        createParserDiagnostic(
          filePath,
          directive.line,
          'Include directive needs a file path or glob pattern argument.',
        ),
      ];
    }

    if (directive.error === 'invalid-glob') {
      return [
        createParserDiagnostic(
          filePath,
          directive.line,
          `Invalid glob pattern "${directive.normalized || directive.raw}".`,
        ),
      ];
    }

    if (directive.error === 'no-match') {
      return [
        createParserDiagnostic(
          filePath,
          directive.line,
          `No files were matched by: ${directive.normalized || directive.raw}`,
        ),
      ];
    }

    return [];
  });
}

function walkCursor(
  cursor: TreeCursor,
  visit: (cursor: TreeCursor) => void,
) {
  visit(cursor);

  if (!cursor.firstChild()) {
    return;
  }

  do {
    walkCursor(cursor, visit);
  } while (cursor.nextSibling());

  cursor.parent();
}

function buildLineStarts(text: string) {
  const starts = [0];

  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      starts.push(index + 1);
    }
  }

  return starts;
}

function lineNumberAt(position: number, starts: number[]) {
  let low = 0;
  let high = starts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const start = starts[middle];
    const nextStart = starts[middle + 1] ?? Number.POSITIVE_INFINITY;

    if (position < start) {
      high = middle - 1;
      continue;
    }

    if (position >= nextStart) {
      low = middle + 1;
      continue;
    }

    return middle + 1;
  }

  return starts.length;
}

function extractTransaction(
  cursor: TreeCursor,
  text: string,
  lineStarts: number[],
) {
  let primaryDate = '';
  let secondaryDate: null | string = null;
  let description = '';
  let headerFrom = -1;
  const transactionCommentLines: string[] = [];
  const postings: ParsedLedgerPostingDraft[] = [];
  let lastPosting: null | ParsedLedgerPostingDraft = null;

  if (!cursor.firstChild()) {
    return null;
  }

  do {
    const nodeName = cursor.type.name as string;

    if (nodeName === 'TxnHeader') {
      headerFrom = cursor.from;

      if (cursor.firstChild()) {
        do {
          const childName = cursor.type.name as string;

          if (childName === 'TxnDate') {
            const dates = extractTransactionDates(text.slice(cursor.from, cursor.to));
            primaryDate = dates.primaryDate;
            secondaryDate = dates.secondaryDate;
            continue;
          }

          if (childName === 'TxnDescription') {
            description = text.slice(cursor.from, cursor.to).trim();
            continue;
          }

          if (childName === 'InlineComment') {
            transactionCommentLines.push(extractCommentText(cursor, text));
          }
        } while (cursor.nextSibling());

        cursor.parent();
      }

      continue;
    }

    if (nodeName === 'IndentedComment') {
      const commentLine = extractCommentText(cursor, text);

      if (lastPosting) {
        lastPosting.commentLines.push(commentLine);
      } else {
        transactionCommentLines.push(commentLine);
      }

      continue;
    }

    if (nodeName !== 'Posting') {
      continue;
    }

    const posting = extractPosting(cursor, text, lineStarts);

    if (posting) {
      postings.push(posting);
      lastPosting = posting;
    }
  } while (cursor.nextSibling());

  cursor.parent();

  if (!primaryDate) {
    return null;
  }

  if (description.startsWith('* ') || description.startsWith('! ')) {
    description = description.slice(2).trim();
  } else if (description === '*' || description === '!') {
    description = '';
  }

  const transactionComment = extractCommentMetadata(transactionCommentLines);

  return {
    comment: transactionComment.text,
    date: primaryDate,
    description,
    headerLine: lineNumberAt(headerFrom, lineStarts),
    postings: postings.map(({ commentLines, ...posting }) => {
      const postingComment = extractCommentMetadata(commentLines);

      return {
        ...posting,
        comment: postingComment.text,
        tags: postingComment.tags,
      };
    }),
    secondaryDate,
    tags: transactionComment.tags,
  } satisfies ParsedLedgerTransaction;
}

function extractTransactionDates(rawDate: string) {
  const [primaryPart, secondaryPart] = rawDate.split('=');
  return {
    primaryDate: normalizeLedgerDate(primaryPart.trim()) ?? '',
    secondaryDate: secondaryPart ? normalizeLedgerDate(secondaryPart.trim()) : null,
  };
}

function extractPosting(
  cursor: TreeCursor,
  text: string,
  lineStarts: number[],
) {
  let account = '';
  let kind: ParsedLedgerPosting['kind'] = 'real';
  let amount: null | { commodity: null | string; precision: number; value: number } = null;
  let balanceAssertion: ParsedLedgerPosting['balanceAssertion'] = null;
  const commentLines: string[] = [];
  let priceAnnotation: ParsedLedgerPosting['priceAnnotation'] = null;

  if (!cursor.firstChild()) {
    return null;
  }

  do {
    if (cursor.type.name === 'AccountName') {
      const extracted = extractPostingAccount(text.slice(cursor.from, cursor.to).trim());
      account = extracted.account;
      kind = extracted.kind;
      continue;
    }

    if (cursor.type.name === 'Amount') {
      amount = extractAmount(cursor, text);
      continue;
    }

    if (cursor.type.name === 'InlineComment') {
      commentLines.push(extractCommentText(cursor, text));
      continue;
    }

    if (cursor.type.name === 'PostingAnnotation') {
      priceAnnotation =
        extractPostingPriceAnnotation(cursor, text, amount?.value ?? null) ?? priceAnnotation;
      balanceAssertion =
        extractPostingBalanceAssertion(cursor, text) ?? balanceAssertion;
    }
  } while (cursor.nextSibling());

  cursor.parent();

  if (!account) {
    return null;
  }

  return {
    account,
    amount: amount?.value ?? null,
    amountPrecision: amount?.precision ?? null,
    balanceAssertion,
    commentLines,
    commodity: amount?.commodity ?? null,
    kind,
    line: lineNumberAt(cursor.from, lineStarts),
    priceAnnotation,
  } satisfies ParsedLedgerPostingDraft;
}

function extractPostingAccount(raw: string) {
  if (raw.startsWith('(') && raw.endsWith(')')) {
    return {
      account: raw.slice(1, -1).trim(),
      kind: 'virtual' as const,
    };
  }

  if (raw.startsWith('[') && raw.endsWith(']')) {
    return {
      account: raw.slice(1, -1).trim(),
      kind: 'balanced-virtual' as const,
    };
  }

  return {
    account: raw,
    kind: 'real' as const,
  };
}

function extractAmount(
  cursor: TreeCursor,
  text: string,
) {
  let commodityPrefix: null | string = null;
  let commoditySuffix: null | string = null;
  let numberText = '';
  let sign = '';

  if (!cursor.firstChild()) {
    return null;
  }

  do {
    const value = text.slice(cursor.from, cursor.to).trim();

    if (!value) {
      continue;
    }

    if (cursor.type.name === 'Commodity') {
      if (!numberText && commodityPrefix === null) {
        commodityPrefix = value;
      } else {
        commoditySuffix = value;
      }

      continue;
    }

    if (cursor.type.name === 'Number') {
      numberText = value;
      continue;
    }

    if (cursor.type.name === 'Sign') {
      sign = value;
    }
  } while (cursor.nextSibling());

  cursor.parent();

  if (!numberText) {
    return null;
  }

  const normalizedNumber = numberText.replaceAll(',', '').replaceAll(' ', '');
  const numericValue = Number(`${sign}${normalizedNumber}`);

  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return {
    commodity: commodityPrefix ?? commoditySuffix ?? '',
    precision: inferNumericDisplayPrecision(numberText),
    value: numericValue,
  };
}

function inferNumericDisplayPrecision(numberText: string) {
  const compact = numberText.replaceAll(' ', '');
  const lastDot = compact.lastIndexOf('.');
  const lastComma = compact.lastIndexOf(',');
  const separatorIndex = Math.max(lastDot, lastComma);

  if (separatorIndex < 0) {
    return 0;
  }

  const digitsAfterSeparator = compact.length - separatorIndex - 1;

  if (digitsAfterSeparator <= 0) {
    return 0;
  }

  return digitsAfterSeparator;
}

function extractPriceDirective(
  cursor: TreeCursor,
  text: string,
  lineStarts: number[],
) {
  let rawDate = '';
  let fromCommodity = '';
  let amount: null | { commodity: null | string; value: number } = null;
  let comment = '';

  if (!cursor.firstChild()) {
    return null;
  }

  do {
    const nodeName = cursor.type.name as string;

    if (nodeName === 'PriceDate') {
      rawDate = text.slice(cursor.from, cursor.to).trim();
      continue;
    }

    if (nodeName === 'PriceCommodity') {
      fromCommodity = extractFirstChildText(cursor, text, 'Commodity');
      continue;
    }

    if (nodeName === 'PriceAmount') {
      if (cursor.firstChild()) {
        do {
          if ((cursor.type.name as string) === 'Amount') {
            amount = extractAmount(cursor, text);
            break;
          }
        } while (cursor.nextSibling());
        cursor.parent();
      }

      continue;
    }

    if (nodeName === 'InlineComment') {
      comment = extractCommentText(cursor, text);
    }
  } while (cursor.nextSibling());

  cursor.parent();

  const date = normalizeLedgerDate(rawDate);

  if (!date || !fromCommodity || !amount) {
    return null;
  }

  return {
    amount: amount.value,
    comment,
    date,
    fromCommodity,
    line: lineNumberAt(cursor.from, lineStarts),
    rawDate,
    source: 'directive',
    toCommodity: amount.commodity || null,
  } satisfies ParsedLedgerPrice;
}

function extractPostingPriceAnnotation(
  cursor: TreeCursor,
  text: string,
  postingAmount: null | number,
): ParsedLedgerPosting['priceAnnotation'] {
  if (!cursor.firstChild()) {
    return null;
  }

  let annotation: ParsedLedgerPosting['priceAnnotation'] = null;

  do {
    if ((cursor.type.name as string) !== 'CostAnnotation') {
      continue;
    }

    let kind: 'total' | 'unit' = 'unit';
    const amount = extractAmount(cursor, text);

    if (cursor.firstChild()) {
      do {
        if ((cursor.type.name as string) === 'CostOp') {
          kind = text.slice(cursor.from, cursor.to).trim() === '@@' ? 'total' : 'unit';
        }
      } while (cursor.nextSibling());
      cursor.parent();
    }

    if (amount) {
      const normalizedAmount =
        kind === 'total' ? normalizeTotalPriceAmount(amount.value, postingAmount) : amount.value;

      annotation = {
        amount: normalizedAmount,
        commodity: amount.commodity || null,
        kind,
        precision: amount.precision,
      };
    }

    break;
  } while (cursor.nextSibling());

  cursor.parent();
  return annotation;
}

function normalizeTotalPriceAmount(
  totalPriceAmount: number,
  postingAmount: null | number,
) {
  if (postingAmount == null || postingAmount === 0) {
    return totalPriceAmount;
  }

  return Math.sign(postingAmount) * Math.abs(totalPriceAmount);
}

function extractPostingBalanceAssertion(
  cursor: TreeCursor,
  text: string,
): ParsedLedgerPosting['balanceAssertion'] {
  if (!cursor.firstChild()) {
    return null;
  }

  let assertion: ParsedLedgerPosting['balanceAssertion'] = null;

  do {
    if ((cursor.type.name as string) !== 'BalanceAssertion') {
      continue;
    }

    let operator: ParsedLedgerBalanceAssertion['operator'] = '=';
    const amount = extractAmount(cursor, text);

    if (cursor.firstChild()) {
      do {
        if ((cursor.type.name as string) === 'BalanceOp') {
          operator = text.slice(cursor.from, cursor.to).trim() as ParsedLedgerBalanceAssertion['operator'];
        }
      } while (cursor.nextSibling());
      cursor.parent();
    }

    if (amount) {
      assertion = {
        amount: amount.value,
        commodity: amount.commodity,
        inclusive: operator.endsWith('*'),
        operator,
        total: operator.startsWith('=='),
      };
    }

    break;
  } while (cursor.nextSibling());

  cursor.parent();
  return assertion;
}

function extractFirstChildText(
  cursor: TreeCursor,
  text: string,
  childName: string,
) {
  if (!cursor.firstChild()) {
    return '';
  }

  let value = '';

  do {
    if ((cursor.type.name as string) === childName) {
      value = text.slice(cursor.from, cursor.to).trim();
      break;
    }
  } while (cursor.nextSibling());

  cursor.parent();
  return value;
}

function normalizeLedgerDate(rawDate: string) {
  const match = rawDate.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);

  if (!match) {
    return null;
  }

  return `${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}`;
}

function extractCommentText(
  cursor: TreeCursor,
  text: string,
) {
  if (!cursor.firstChild()) {
    return '';
  }

  let commentText = '';

  do {
    if (cursor.type.name === 'CommentBody') {
      commentText = text.slice(cursor.from, cursor.to);
      break;
    }
  } while (cursor.nextSibling());

  cursor.parent();
  return normalizeCommentText(commentText);
}

function normalizeCommentText(commentText: string) {
  return commentText.replace(/^\s+/, '').replace(/\s+$/, '');
}

function extractCommentMetadata(commentLines: string[]) {
  const lines = commentLines.map(normalizeCommentText);

  return {
    tags: extractTagsFromCommentLines(lines),
    text: lines.filter((line) => line.length > 0).join('\n'),
  };
}

function extractTagsFromCommentLines(commentLines: string[]) {
  const tags: LedgerTag[] = [];

  for (const line of commentLines) {
    if (!line) {
      continue;
    }

    tags.push(...extractBracketedDateTags(line));
    tags.push(...extractColonTags(line));
  }

  return tags;
}

function extractBracketedDateTags(line: string): LedgerTag[] {
  const tags: LedgerTag[] = [];

  for (const match of line.matchAll(/\[([^\]\n]+)\]/g)) {
    const body = match[1]?.trim() ?? '';

    if (!body || !/\d/.test(body) || !/[-/.]/.test(body)) {
      continue;
    }

    const equalsIndex = body.indexOf('=');

    if (equalsIndex === -1) {
      tags.push({ name: 'date', value: body });
      continue;
    }

    const date = body.slice(0, equalsIndex).trim();
    const date2 = body.slice(equalsIndex + 1).trim();

    if (date) {
      tags.push({ name: 'date', value: date });
    }

    if (date2) {
      tags.push({ name: 'date2', value: date2 });
    }
  }

  return tags;
}

function extractColonTags(line: string): LedgerTag[] {
  const tags: LedgerTag[] = [];
  const pattern =
    /(^|,\s*|\s+)([A-Za-z0-9_.-]+):\s*([^,\n]*?)(?=(?:,\s*[A-Za-z0-9_.-]+:)|$)/g;

  for (const match of line.matchAll(pattern)) {
    const name = match[2]?.trim() ?? '';
    const value = match[3]?.trim() ?? '';

    if (!name) {
      continue;
    }

    tags.push({ name, value });
  }

  return tags;
}

function createParserDiagnostic(
  path: string,
  line: number,
  message: string,
): LedgerDiagnostic {
  return {
    id: `${path}:${line}:${message}`,
    line,
    message,
    path,
    severity: 'error',
    source: 'parser',
  };
}

function parseLedgerTree(
  content: string,
  previousContent?: string,
  previousTree?: Tree,
) {
  if (!previousTree || previousContent == null) {
    return hledgerParser.parse(content);
  }

  const fragments = TreeFragment.applyChanges(
    TreeFragment.addTree(previousTree),
    computeChangedRanges(previousContent, content),
  );

  return hledgerParser.parse(content, fragments);
}

function computeChangedRanges(previousContent: string, nextContent: string) {
  if (previousContent === nextContent) {
    return [];
  }

  const maxPrefix = Math.min(previousContent.length, nextContent.length);
  let prefixLength = 0;

  while (
    prefixLength < maxPrefix &&
    previousContent.charCodeAt(prefixLength) === nextContent.charCodeAt(prefixLength)
  ) {
    prefixLength += 1;
  }

  let previousEnd = previousContent.length;
  let nextEnd = nextContent.length;

  while (
    previousEnd > prefixLength &&
    nextEnd > prefixLength &&
    previousContent.charCodeAt(previousEnd - 1) === nextContent.charCodeAt(nextEnd - 1)
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
  }

  return [
    {
      fromA: prefixLength,
      fromB: prefixLength,
      toA: previousEnd,
      toB: nextEnd,
    },
  ];
}

function extractDeclaredCommodity(argument: string) {
  const trimmed = argument.trim();

  if (!trimmed) {
    return null;
  }

  const quotedMatch = trimmed.match(/^"[^"\n]+"/);

  if (quotedMatch) {
    return quotedMatch[0];
  }

  const leadingMatch = trimmed.match(/^[^\s\d,+-]+/);

  if (leadingMatch) {
    return leadingMatch[0];
  }

  const trailingQuotedMatch = trimmed.match(/"[^"\n]+"$/);

  if (trailingQuotedMatch) {
    return trailingQuotedMatch[0];
  }

  const trailingMatch = trimmed.match(/[^\s\d,+-]+$/);

  return trailingMatch?.[0] ?? null;
}
