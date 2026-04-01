import type { AccountType, LedgerTag } from './types';

export function inferAccountTypeFromName(account: string): AccountType {
  const firstSegment = account.split(':')[0]?.toLowerCase().trim() ?? '';

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

export function resolveAccountTypeFromTags(tags: LedgerTag[]) {
  const values = tags
    .filter((tag) => tag.name.toLowerCase() === 'type')
    .map((tag) => tag.value.trim())
    .filter((value) => value.length > 0);

  if (values.length === 0) {
    return {
      type: null,
      typeAnnotationValues: [],
      typeDiagnostic: null,
    };
  }

  const normalizedTypes = values.map(normalizeAccountTypeAnnotation);

  if (normalizedTypes.some((type) => type == null)) {
    return {
      type: null,
      typeAnnotationValues: values,
      typeDiagnostic: `Unsupported account type annotation "${values.find((value, index) => normalizedTypes[index] == null) ?? ''}". Expected A, L, R, X, E, or the full account-type name.`,
    };
  }

  const uniqueTypes = Array.from(new Set(normalizedTypes));

  if (uniqueTypes.length > 1) {
    return {
      type: null,
      typeAnnotationValues: values,
      typeDiagnostic: `Conflicting account type annotations: ${values.join(', ')}.`,
    };
  }

  return {
    type: uniqueTypes[0] ?? null,
    typeAnnotationValues: values,
    typeDiagnostic: null,
  };
}

function normalizeAccountTypeAnnotation(value: string): AccountType | null {
  switch (value.trim().toLowerCase()) {
    case 'a':
    case 'asset':
    case 'assets':
      return 'asset';
    case 'l':
    case 'liability':
    case 'liabilities':
      return 'liability';
    case 'e':
    case 'equity':
      return 'equity';
    case 'r':
    case 'revenue':
    case 'revenues':
    case 'income':
      return 'income';
    case 'x':
    case 'expense':
    case 'expenses':
      return 'expense';
    default:
      return null;
  }
}
