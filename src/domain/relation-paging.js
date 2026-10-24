import { UI_GROUP_IDS } from './relation-groups.js';

export const RELATION_PAGE_SIZE = 20;

const PAGED_GROUP_IDS = Object.freeze([UI_GROUP_IDS.texture, UI_GROUP_IDS.association]);

export function isPagedRelationGroup(groupId) {
  return PAGED_GROUP_IDS.includes(groupId);
}

/**
 * Items are already in the existing relation order; paging only slices that order.
 * Non-exploratory groups are returned unchanged.
 */
export function pageRelationItems(groupId, items, requestedPage = 1) {
  if (!isPagedRelationGroup(groupId)) {
    return {
      items,
      page: 1,
      pageCount: 1,
      total: items.length,
      start: items.length > 0 ? 1 : 0,
      end: items.length,
      hasPrevious: false,
      hasNext: false,
    };
  }

  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / RELATION_PAGE_SIZE));
  const requested = Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1;
  const page = Math.min(Math.max(requested, 1), pageCount);
  const startIndex = (page - 1) * RELATION_PAGE_SIZE;
  const endIndex = Math.min(startIndex + RELATION_PAGE_SIZE, total);

  return {
    items: items.slice(startIndex, endIndex),
    page,
    pageCount,
    total,
    start: total > 0 ? startIndex + 1 : 0,
    end: endIndex,
    hasPrevious: page > 1,
    hasNext: page < pageCount,
  };
}
