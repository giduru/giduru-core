import type {
  LedgerAnalysis,
  LedgerAnalysisIndex,
  LedgerPostingFilter,
  LedgerTag,
  LedgerTagFilter,
  Posting,
} from './types';

type PostingsQueryable = Pick<LedgerAnalysis, 'index' | 'postings'>;
type PostingTagIndex = Pick<LedgerAnalysisIndex, 'postingIdsByTag' | 'postingIdsByTagName'>;

export function createLedgerTagKey(
  tag: Pick<LedgerTag, 'name' | 'value'> | LedgerTagFilter,
) {
  return `${tag.name}:${tag.value ?? ''}`;
}

export function getPostingIdsForTag(
  index: PostingTagIndex,
  tag: LedgerTagFilter,
) {
  if (tag.value == null) {
    return [...(index.postingIdsByTagName[tag.name] ?? [])];
  }

  return [...(index.postingIdsByTag[createLedgerTagKey(tag)] ?? [])];
}

export function filterPostingIds(
  analysis: PostingsQueryable,
  filter: LedgerPostingFilter = {},
) {
  const orderedIds = analysis.postings.map((posting) => posting.id);
  const included = intersectSets([
    buildUnionSet(filter.includeAccounts, (account) => analysis.index.postingIdsByAccount[account]),
    buildUnionSet(
      filter.includeAccountTypes,
      (accountType) => analysis.index.postingIdsByAccountType[accountType],
    ),
    ...((filter.includeTags ?? []).map(
      (tag) => new Set(getPostingIdsForTag(analysis.index, tag)),
    )),
  ]);

  const remaining = included ?? new Set(orderedIds);
  removeAll(
    remaining,
    buildUnionSet(filter.excludeAccounts, (account) => analysis.index.postingIdsByAccount[account]),
  );
  removeAll(
    remaining,
    buildUnionSet(
      filter.excludeAccountTypes,
      (accountType) => analysis.index.postingIdsByAccountType[accountType],
    ),
  );
  removeAll(
    remaining,
    unionSets((filter.excludeTags ?? []).map((tag) => new Set(getPostingIdsForTag(analysis.index, tag)))),
  );

  return orderedIds.filter((id) => remaining.has(id));
}

export function filterPostings(
  analysis: PostingsQueryable,
  filter: LedgerPostingFilter = {},
) {
  return filterPostingIds(analysis, filter).map((id) => {
    const position = analysis.index.postingPositionById[id];

    return analysis.postings[position] as Posting;
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
