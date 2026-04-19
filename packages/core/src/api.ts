import {
  analyzeLedgerDocuments as analyzeLedgerDocumentsWithState,
} from './workspace';
import type {
  AnalyzeLedgerDocumentsOptions,
  LedgerAnalysis,
  LedgerSourceDocument,
  LedgerSourceDocumentsInput,
} from './types';

export async function analyzeLedgerDocuments(
  documents: LedgerSourceDocumentsInput,
  options: AnalyzeLedgerDocumentsOptions = {},
): Promise<LedgerAnalysis> {
  const { analysis } = await analyzeLedgerDocumentsWithState(
    normalizeLedgerSourceDocuments(documents),
    options,
  );
  return analysis;
}

function normalizeLedgerSourceDocuments(documents: LedgerSourceDocumentsInput) {
  if (documents instanceof Map) {
    return new Map(documents);
  }

  const documentsByPath = new Map<string, LedgerSourceDocument>();
  const sourceDocuments = documents as Iterable<LedgerSourceDocument>;

  for (const document of sourceDocuments) {
    documentsByPath.set(document.path, document);
  }

  return documentsByPath;
}
