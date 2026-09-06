export {
  getRelationGroupDefinition,
  getRelationGroupId,
  RELATION_GROUP_DEFINITIONS,
  RELATION_TYPES,
  RELATION_TYPE_TO_GROUP,
  UI_GROUP_IDS,
} from './relation-groups.js';

export {
  projectRecord,
  projectRelation,
  projectRelationTarget,
  projectSearchResults,
  projectSense,
} from './projection.js';

export {
  createEmptySearchState,
  createErrorSearchState,
  createInitialSearchState,
  createLoadingSearchState,
  createReadySearchState,
  SEARCH_ACTIONS,
  SEARCH_MODES,
  SEARCH_STATUS,
  classifySearchError,
  withHistoryFlags,
} from './search-state.js';

export {
  DictionarySearchService,
  SearchController,
  SearchDomainError,
  SearchSession,
} from './search-session.js';

export {
  SEARCH_MATCH_FIELDS,
  SEARCH_MATCH_KINDS,
  SEARCH_NORMALIZATION_RULES,
  SEARCH_RESULT_STATUSES,
  SEARCH_UNSUPPORTED_REASONS,
  createLegacySearchResponse,
  createSearchMatch,
  createSearchResponse,
  normalizeSearchInput,
  normalizeSearchResponse,
} from '../runtime/search-query.js';
