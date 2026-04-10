import type {
  LedgerAnalysis,
  LedgerPrice,
  LedgerPriceResolutionQuery,
} from './types';

type PriceQueryable = LedgerPrice[] | Pick<LedgerAnalysis, 'prices'>;

export function resolveLedgerPrice(
  queryable: PriceQueryable,
  query: LedgerPriceResolutionQuery,
) {
  const prices = Array.isArray(queryable) ? queryable : queryable.prices;
  const mode = query.mode ?? 'latest-on-or-before';
  let resolvedPrice: LedgerPrice | null = null;

  for (const price of prices) {
    if (!matchesResolvedPriceQuery(price, query)) {
      continue;
    }

    if (mode === 'exact') {
      if (price.date !== query.date) {
        continue;
      }
    } else if (price.date > query.date) {
      continue;
    }

    resolvedPrice = price;
  }

  return resolvedPrice;
}

export function resolveLedgerPriceOnDate(
  queryable: PriceQueryable,
  query: Omit<LedgerPriceResolutionQuery, 'mode'>,
) {
  return resolveLedgerPrice(queryable, {
    ...query,
    mode: 'exact',
  });
}

export function resolveLatestLedgerPrice(
  queryable: PriceQueryable,
  query: Omit<LedgerPriceResolutionQuery, 'mode'>,
) {
  return resolveLedgerPrice(queryable, {
    ...query,
    mode: 'latest-on-or-before',
  });
}

function matchesResolvedPriceQuery(
  price: LedgerPrice,
  query: Omit<LedgerPriceResolutionQuery, 'mode'>,
) {
  return (
    price.fromCommodity === query.fromCommodity &&
    (price.toCommodity ?? null) === (query.toCommodity ?? null)
  );
}
