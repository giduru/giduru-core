import { basename } from './path';
import { parseLedgerDocument, parseLedgerWorkspace } from './parser';
import { verifyLedgerWorkspace } from './verifier';
import type {
  LedgerAnalysis,
  LedgerDocumentChange,
  LedgerEngineState,
  LedgerSourceDocument,
  ParseLedgerProgress,
  ParsedLedgerWorkspace,
  VerifyLedgerOptions,
} from './types';

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

  return {
    documentsByPath,
    lastUpdateStats: {
      parsedFileCount: 0,
      parseMs: 0,
      reusedFileCount: 0,
    },
    parsedFilesByPath: new Map(),
  };
}

export async function applyLedgerDocumentChanges(
  state: LedgerEngineState,
  changes: LedgerDocumentChange[],
  options: ApplyLedgerDocumentChangesOptions = {},
): Promise<LedgerEngineState> {
  const documentsByPath = new Map(state.documentsByPath);
  const parsedFilesByPath = new Map(state.parsedFilesByPath);
  const changedPaths = new Set<string>();
  let knownPathSetChanged = false;

  for (const change of changes) {
    if (change.type === 'delete') {
      const hadDocument = documentsByPath.delete(change.path);
      const hadParsedFile = parsedFilesByPath.delete(change.path);

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
        continue;
      }

      if (parsedFile.includeDirectives.some((directive) => directive.isGlob)) {
        parseTargets.add(path);
      }
    }
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
      continue;
    }

    options.onProgress?.({
      completedFiles: index,
      currentPath: path,
      discoveredFiles: orderedTargets.length,
      phase: 'parsing',
    });

    const parsedFile = parseLedgerDocument(document, { knownFilePaths });
    parsedFilesByPath.set(path, parsedFile);
    totalParseMs += parsedFile.stats.parseMs;
  }

  options.onProgress?.({
    completedFiles: orderedTargets.length,
    currentPath: orderedTargets[orderedTargets.length - 1] ?? '',
    discoveredFiles: orderedTargets.length,
    phase: 'complete',
  });

  return {
    documentsByPath,
    lastUpdateStats: {
      parsedFileCount: orderedTargets.length,
      parseMs: totalParseMs,
      reusedFileCount: Math.max(parsedFilesByPath.size - orderedTargets.length, 0),
    },
    parsedFilesByPath,
  };
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
  const workspace = buildParsedLedgerWorkspace(state, {
    rootFilePaths: options.rootFilePaths,
  });
  const analysis = verifyLedgerWorkspace(workspace, options);

  return { analysis, workspace };
}

export async function analyzeLedgerDocuments(
  documentsByPath: Map<string, LedgerSourceDocument>,
  options: {
    onProgress?: (progress: ParseLedgerProgress) => void;
    verifyOptions?: VerifyLedgerOptions;
  } & Pick<AnalyzeLedgerStateOptions, 'rootFilePaths'>,
): Promise<{
  analysis: LedgerAnalysis;
  state: LedgerEngineState;
  workspace: ParsedLedgerWorkspace;
}> {
  const parsedWorkspace = await parseLedgerWorkspace(documentsByPath, {
    onProgress: options.onProgress,
    rootFilePaths: options.rootFilePaths ?? [],
  });
  const state = createLedgerEngineState(documentsByPath.values());

  for (const parsedFile of parsedWorkspace.files) {
    state.parsedFilesByPath.set(parsedFile.file.path, parsedFile);
  }

  state.lastUpdateStats = {
    parsedFileCount: parsedWorkspace.files.length,
    parseMs: parsedWorkspace.totalParseMs,
    reusedFileCount: parsedWorkspace.reusedFileCount,
  };

  return {
    analysis: verifyLedgerWorkspace(parsedWorkspace, options.verifyOptions),
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
