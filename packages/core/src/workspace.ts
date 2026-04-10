import { basename } from './path';
import {
  type LedgerDocumentParseCache,
  parseLedgerDocumentWithCache,
  parseLedgerWorkspaceWithCache,
} from './parser';
import { verifyLedgerWorkspaceWithCache } from './verifier';
import type {
  AnalyzeLedgerDocumentsOptions,
  LedgerAnalysis,
  LedgerDocumentChange,
  LedgerEngineState,
  LedgerSourceDocument,
  ParseLedgerProgress,
  ParsedLedgerWorkspace,
  VerifyLedgerOptions,
} from './types';

const PARSE_CACHES_BY_STATE = new WeakMap<
  LedgerEngineState,
  Map<string, LedgerDocumentParseCache>
>();
const ANALYSIS_RESULTS_BY_STATE = new WeakMap<
  LedgerEngineState,
  Map<string, { analysis: LedgerAnalysis; workspace: ParsedLedgerWorkspace }>
>();

type ApplyLedgerDocumentChangesOptions = {
  onProgress?: (progress: ParseLedgerProgress) => void;
};

type AnalyzeLedgerStateOptions = VerifyLedgerOptions;

export function createLedgerEngineState(
  documents: Iterable<LedgerSourceDocument> = [],
): LedgerEngineState {
  const documentsByPath = new Map<string, LedgerSourceDocument>();

  for (const document of documents) {
    documentsByPath.set(document.path, document);
  }

  const state = {
    documentsByPath,
    lastUpdateStats: {
      parsedFileCount: 0,
      parseMs: 0,
      reusedFileCount: 0,
    },
    parsedFilesByPath: new Map(),
    verificationCache: null,
  };

  PARSE_CACHES_BY_STATE.set(state, new Map());
  ANALYSIS_RESULTS_BY_STATE.set(state, new Map());
  return state;
}

export async function applyLedgerDocumentChanges(
  state: LedgerEngineState,
  changes: LedgerDocumentChange[],
  options: ApplyLedgerDocumentChangesOptions = {},
): Promise<LedgerEngineState> {
  if (changes.length === 0) {
    return state;
  }

  const documentsByPath = new Map(state.documentsByPath);
  const parsedFilesByPath = new Map(state.parsedFilesByPath);
  const previousParseCaches = PARSE_CACHES_BY_STATE.get(state) ?? new Map();
  const parseCachesByPath = new Map(previousParseCaches);
  const changedPaths = new Set<string>();
  let knownPathSetChanged = false;

  for (const change of changes) {
    if (change.type === 'delete') {
      const hadDocument = documentsByPath.delete(change.path);
      const hadParsedFile = parsedFilesByPath.delete(change.path);
      parseCachesByPath.delete(change.path);

      if (hadDocument || hadParsedFile) {
        changedPaths.add(change.path);
        knownPathSetChanged = true;
      }

      continue;
    }

    const previousDocument = documentsByPath.get(change.document.path);
    const nextDocument = normalizeDocument(change.document);
    const changed =
      !previousDocument ||
      previousDocument.content !== nextDocument.content ||
      previousDocument.isLedger !== nextDocument.isLedger ||
      previousDocument.lastModified !== nextDocument.lastModified ||
      previousDocument.name !== nextDocument.name;

    documentsByPath.set(nextDocument.path, nextDocument);

    if (!previousDocument) {
      knownPathSetChanged = true;
    }

    if (changed) {
      changedPaths.add(nextDocument.path);
    }
  }

  const parseTargets = new Set<string>();

  for (const path of changedPaths) {
    if (documentsByPath.get(path)?.isLedger) {
      parseTargets.add(path);
    }
  }

  if (knownPathSetChanged) {
    for (const [path, parsedFile] of parsedFilesByPath.entries()) {
      if (!documentsByPath.get(path)?.isLedger) {
        parsedFilesByPath.delete(path);
        parseCachesByPath.delete(path);
        continue;
      }

      if (parsedFile.includeDirectives.some((directive) => directive.isGlob)) {
        parseTargets.add(path);
      }
    }
  }

  if (changedPaths.size === 0 && !knownPathSetChanged) {
    return state;
  }

  const knownFilePaths = Array.from(documentsByPath.keys()).sort((left, right) =>
    left.localeCompare(right),
  );
  const orderedTargets = Array.from(parseTargets).sort((left, right) => left.localeCompare(right));
  let totalParseMs = 0;

  for (let index = 0; index < orderedTargets.length; index += 1) {
    const path = orderedTargets[index];
    const document = documentsByPath.get(path);

    if (!document?.isLedger) {
      parsedFilesByPath.delete(path);
      parseCachesByPath.delete(path);
      continue;
    }

    options.onProgress?.({
      completedFiles: index,
      currentPath: path,
      discoveredFiles: orderedTargets.length,
      phase: 'parsing',
    });

    const previousDocument = state.documentsByPath.get(path);
    const previousCache = previousParseCaches.get(path);
    const { cache, parsedFile } = parseLedgerDocumentWithCache(document, {
      knownFilePaths,
      previousContent: previousDocument?.content,
      previousTree: previousCache?.tree,
    });
    parsedFilesByPath.set(path, parsedFile);
    parseCachesByPath.set(path, cache);
    totalParseMs += parsedFile.stats.parseMs;
  }

  options.onProgress?.({
    completedFiles: orderedTargets.length,
    currentPath: orderedTargets[orderedTargets.length - 1] ?? '',
    discoveredFiles: orderedTargets.length,
    phase: 'complete',
  });

  const nextState = {
    documentsByPath,
    lastUpdateStats: {
      parsedFileCount: orderedTargets.length,
      parseMs: totalParseMs,
      reusedFileCount: Math.max(parsedFilesByPath.size - orderedTargets.length, 0),
    },
    parsedFilesByPath,
    verificationCache: state.verificationCache,
  };

  PARSE_CACHES_BY_STATE.set(nextState, parseCachesByPath);
  ANALYSIS_RESULTS_BY_STATE.set(
    nextState,
    orderedTargets.length === 0 && !knownPathSetChanged
      ? new Map(ANALYSIS_RESULTS_BY_STATE.get(state) ?? [])
      : new Map(),
  );
  return nextState;
}

export function buildParsedLedgerWorkspace(
  state: LedgerEngineState,
  options: Pick<AnalyzeLedgerStateOptions, 'rootFilePaths'>,
): ParsedLedgerWorkspace {
  const rootFilePaths = Array.from(
    new Set((options.rootFilePaths ?? []).filter((path) => state.parsedFilesByPath.has(path))),
  ).sort((left, right) => left.localeCompare(right));
  const includeGraph = new Map(
    Array.from(state.parsedFilesByPath.entries()).map(([path, parsedFile]) => [
      path,
      parsedFile.includeTargets,
    ]),
  );
  const reachablePaths = collectReachablePaths(rootFilePaths, includeGraph);

  return {
    files: reachablePaths
      .map((path) => state.parsedFilesByPath.get(path))
      .filter((file): file is NonNullable<typeof file> => Boolean(file)),
    reusedFileCount: state.lastUpdateStats.reusedFileCount,
    rootFilePaths,
    totalParseMs: state.lastUpdateStats.parseMs,
  };
}

export function analyzeLedgerState(
  state: LedgerEngineState,
  options: AnalyzeLedgerStateOptions,
) {
  const analysisCacheKey = createAnalysisCacheKey(options);
  const cachedResult = ANALYSIS_RESULTS_BY_STATE.get(state)?.get(analysisCacheKey);

  if (cachedResult) {
    return { ...cachedResult, state };
  }

  const workspace = buildParsedLedgerWorkspace(state, {
    rootFilePaths: options.rootFilePaths,
  });
  const { analysis, cache } = verifyLedgerWorkspaceWithCache(
    workspace,
    options,
    state.verificationCache,
  );
  const nextState =
    state.verificationCache === cache ? state : { ...state, verificationCache: cache };
  const parseCachesByPath = PARSE_CACHES_BY_STATE.get(state);

  if (nextState !== state && parseCachesByPath) {
    PARSE_CACHES_BY_STATE.set(nextState, parseCachesByPath);
    ANALYSIS_RESULTS_BY_STATE.set(nextState, new Map());
  }

  ANALYSIS_RESULTS_BY_STATE.get(nextState)?.set(analysisCacheKey, { analysis, workspace });

  return { analysis, state: nextState, workspace };
}

export async function analyzeLedgerDocuments(
  documentsByPath: Map<string, LedgerSourceDocument>,
  options: AnalyzeLedgerDocumentsOptions,
): Promise<{
  analysis: LedgerAnalysis;
  state: LedgerEngineState;
  workspace: ParsedLedgerWorkspace;
}> {
  const { parseCachesByPath, workspace: parsedWorkspace } = await parseLedgerWorkspaceWithCache(
    documentsByPath,
    {
    onProgress: options.onProgress,
    rootFilePaths: options.rootFilePaths ?? [],
    },
  );
  const state = createLedgerEngineState(documentsByPath.values());

  for (const parsedFile of parsedWorkspace.files) {
    state.parsedFilesByPath.set(parsedFile.file.path, parsedFile);
  }

  state.lastUpdateStats = {
    parsedFileCount: parsedWorkspace.files.length,
    parseMs: parsedWorkspace.totalParseMs,
    reusedFileCount: parsedWorkspace.reusedFileCount,
  };
  const { analysis, cache } = verifyLedgerWorkspaceWithCache(
    parsedWorkspace,
    options.verifyOptions,
    null,
  );
  state.verificationCache = cache;
  PARSE_CACHES_BY_STATE.set(state, new Map(parseCachesByPath));
  ANALYSIS_RESULTS_BY_STATE.set(
    state,
    new Map([
      [
        createAnalysisCacheKey({
          availableFilePaths: options.verifyOptions?.availableFilePaths,
          rootFilePaths: options.verifyOptions?.rootFilePaths ?? options.rootFilePaths,
        }),
        { analysis, workspace: parsedWorkspace },
      ],
    ]),
  );

  return {
    analysis,
    state,
    workspace: parsedWorkspace,
  };
}

function collectReachablePaths(
  rootFilePaths: string[],
  includeGraph: Map<string, string[]>,
) {
  const visited = new Set<string>();
  const queue = [...rootFilePaths];

  while (queue.length > 0) {
    queue.sort((left, right) => left.localeCompare(right));
    const currentPath = queue.shift();

    if (!currentPath || visited.has(currentPath)) {
      continue;
    }

    visited.add(currentPath);

    for (const dependency of [...(includeGraph.get(currentPath) ?? [])].sort((left, right) =>
      left.localeCompare(right),
    )) {
      if (!visited.has(dependency)) {
        queue.push(dependency);
      }
    }
  }

  return Array.from(visited).sort((left, right) => left.localeCompare(right));
}

function normalizeDocument(document: LedgerSourceDocument): LedgerSourceDocument {
  return {
    ...document,
    name: document.name || basename(document.path),
  };
}

function createAnalysisCacheKey(options: AnalyzeLedgerStateOptions) {
  const availableFilePaths = Array.from(new Set(options.availableFilePaths ?? [])).sort((left, right) =>
    left.localeCompare(right),
  );
  const rootFilePaths = Array.from(new Set(options.rootFilePaths ?? [])).sort((left, right) =>
    left.localeCompare(right),
  );

  return JSON.stringify({
    availableFilePaths,
    rootFilePaths,
  });
}
