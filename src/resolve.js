import { getRank } from "./priorityMatrix.js";

/**
 * Groups raw per-source hits by normalized entity name. Entities appearing
 * under one category pass through unchanged. Entities appearing under
 * multiple categories (BRD #6) get a single final category chosen by
 * Priority Matrix rank (BRD #5), while every category they actually belong
 * to is preserved in memberships for audit/traceability.
 */
export function resolveWithPriorityMatrix(rawHits, keyer) {
  const byName = new Map();

  for (const hit of rawHits) {
    const key = keyer(hit.name);
    if (!byName.has(key)) byName.set(key, { name: hit.name, memberships: [] });
    byName.get(key).memberships.push(hit);
  }

  const resolved = [];
  const multiCategoryEntities = [];

  for (const { name, memberships } of byName.values()) {
    const ranked = memberships
      .map((m) => ({ ...m, rank: getRank(m.categoryAsPerRegulator) }))
      .sort((a, b) => a.rank - b.rank);
    const winner = ranked[0];

    resolved.push({
      name,
      category: winner.categoryAsPerRegulator,
      categoryAsPerReturn: winner.categoryAsPerReturn,
      classification: winner.categoryAsPerRegulator,
      institution: winner.categoryAsPerReturn,
      regulator: winner.regulator,
      sourceKey: winner.sourceKey,
      status: winner.status,
      allCategories: memberships.map((m) => m.categoryAsPerRegulator).join(" | "),
      categoryCount: new Set(memberships.map((m) => m.categoryAsPerRegulator)).size,
    });

    const distinctCategories = new Set(memberships.map((m) => m.categoryAsPerRegulator));
    if (distinctCategories.size > 1) {
      multiCategoryEntities.push({
        name,
        finalCategory: winner.categoryAsPerRegulator,
        finalCategoryRank: winner.rank,
        allMemberships: ranked.map((m) => ({
          category: m.categoryAsPerRegulator,
          rank: m.rank,
          regulator: m.regulator,
          sourceKey: m.sourceKey,
        })),
      });
    }
  }

  return { resolved, multiCategoryEntities };
}

