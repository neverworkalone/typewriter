import { UI_GROUP_IDS } from './relation-groups.js';

export const RELATION_PAGE_SIZE = 20;
export const RELATION_PAGE_MAX = 100;

const PAGED_GROUP_IDS = Object.freeze([UI_GROUP_IDS.texture, UI_GROUP_IDS.association]);

export function isPagedRelationGroup(groupId) {
  return PAGED_GROUP_IDS.includes(groupId);
}

/**
 * Items are already in the existing relation order; paging only slices that order.
 * Non-exploratory groups are returned unchanged.
 */
export function pageRelationItems(groupId, items, pagesShown = 1) {
  if (!isPagedRelationGroup(groupId)) {
    return { items, hasMore: false };
  }

  const maxPages = RELATION_PAGE_MAX / RELATION_PAGE_SIZE;
  const pages = Math.min(Math.max(Math.floor(pagesShown) || 1, 1), maxPages);
  const limit = pages * RELATION_PAGE_SIZE;
  const capped = Math.min(items.length, RELATION_PAGE_MAX);

  return {
    items: items.slice(0, limit),
    hasMore: capped > limit,
  };
}
