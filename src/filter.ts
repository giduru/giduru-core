import type {
  LedgerAnalysis,
  LedgerAnalysisIndex,
  LedgerRegisterFilter,
  LedgerTag,
  LedgerTagFilter,
  RegisterEntry,
} from './types';

type RegisterQueryable = Pick<LedgerAnalysis, 'index' | 'register'>;
type RegisterTagIndex = Pick<LedgerAnalysisIndex, 'registerIdsByTag' | 'registerIdsByTagName'>;

export function createLedgerTagKey(
  tag: Pick<LedgerTag, 'name' | 'value'> | LedgerTagFilter,
) {
  return `${tag.name}:${tag.value ?? ''}`;
}

export function getRegisterEntryIdsForTag(
  index: RegisterTagIndex,
  tag: LedgerTagFilter,
) {
  if (tag.value == null) {
    return [...(index.registerIdsByTagName[tag.name] ?? [])];
  }

  return [...(index.registerIdsByTag[createLedgerTagKey(tag)] ?? [])];
}

export function filterRegisterEntryIds(
  analysis: RegisterQueryable,
  filter: LedgerRegisterFilter = {},
) {
  const orderedIds = analysis.register.map((entry) => entry.id);
  const included = intersectSets([
    buildUnionSet(filter.includeAccounts, (account) => analysis.index.registerIdsByAccount[account]),
    buildUnionSet(
      filter.includeAccountTypes,
      (accountType) => analysis.index.registerIdsByAccountType[accountType],
    ),
    ...((filter.includeTags ?? []).map(
      (tag) => new Set(getRegisterEntryIdsForTag(analysis.index, tag)),
    )),
  ]);

  const remaining = included ?? new Set(orderedIds);
  removeAll(
    remaining,
    buildUnionSet(filter.excludeAccounts, (account) => analysis.index.registerIdsByAccount[account]),
  );
  removeAll(
    remaining,
    buildUnionSet(
      filter.excludeAccountTypes,
      (accountType) => analysis.index.registerIdsByAccountType[accountType],
    ),
  );
  removeAll(
    remaining,
    unionSets((filter.excludeTags ?? []).map((tag) => new Set(getRegisterEntryIdsForTag(analysis.index, tag)))),
  );

  return orderedIds.filter((id) => remaining.has(id));
}

export function filterRegisterEntries(
  analysis: RegisterQueryable,
  filter: LedgerRegisterFilter = {},
) {
  return filterRegisterEntryIds(analysis, filter).map((id) => {
    const position = analysis.index.registerPositionById[id];

    return analysis.register[position] as RegisterEntry;
  });
}

function buildUnionSet<T extends string>(
  values: T[] | undefined,
  selectIds: (value: T) => string[] | undefined,
) {
  if (!values || values.length === 0) {
    return null;
  }

  return unionSets(values.map((value) => new Set(selectIds(value) ?? [])));
}

function intersectSets(sets: Array<Set<string> | null>) {
  const presentSets = sets.filter((set): set is Set<string> => set != null);

  if (presentSets.length === 0) {
    return null;
  }

  const [first, ...rest] = presentSets;
  const intersection = new Set(first);

  for (const id of intersection) {
    if (rest.every((set) => set.has(id))) {
      continue;
    }

    intersection.delete(id);
  }

  return intersection;
}

function removeAll(target: Set<string>, ids: Set<string> | null) {
  if (!ids) {
    return;
  }

  for (const id of ids) {
    target.delete(id);
  }
}

function unionSets(sets: Array<Set<string>>) {
  const union = new Set<string>();

  for (const set of sets) {
    for (const id of set) {
      union.add(id);
    }
  }

  return union;
}
