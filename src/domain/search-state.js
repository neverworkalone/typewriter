import { ERROR_CODES } from '../runtime/protocol.js';

export const SEARCH_STATUS = Object.freeze({
  idle: 'idle',
  loading: 'loading',
  ready: 'ready',
  empty: 'empty',
  error: 'error',
});

export const SEARCH_MODES = Object.freeze({
  idle: 'idle',
  exact: 'exact',
  relationTarget: 'relation-target',
});

export const SEARCH_ACTIONS = Object.freeze({
  exact: 'exact-search',
  relationTarget: 'relation-target',
  initial: 'initial',
});

const LOAD_FAILURE_CODES = new Set([
  ERROR_CODES.ASSET_LOAD_FAILED,
  ERROR_CODES.WASM_LOAD_FAILED,
  ERROR_CODES.DATABASE_LOAD_FAILED,
  ERROR_CODES.WORKER_UNAVAILABLE,
  ERROR_CODES.WORKER_ERROR,
  ERROR_CODES.WORKER_MESSAGE_ERROR,
  ERROR_CODES.RUNTIME_CLOSED,
]);

export function createInitialSearchState() {
  return {
    status: SEARCH_STATUS.idle,
    mode: SEARCH_MODES.idle,
    action: SEARCH_ACTIONS.initial,
    query: null,
    targetRecordId: null,
    navigation: null,
    queryMeta: null,
    selectedRecordId: null,
    selectedSenseId: null,
    results: [],
    error: null,
    emptyReason: null,
    canGoBack: false,
    canGoForward: false,
  };
}

function requestFields({
  mode,
  action,
  query = null,
  targetRecordId = null,
  navigation = null,
  queryMeta = null,
  selectedRecordId = null,
  selectedSenseId = null,
}) {
  return {
    mode,
    action,
    query,
    targetRecordId,
    navigation,
    queryMeta,
    selectedRecordId,
    selectedSenseId,
  };
}

export function createLoadingSearchState(request) {
  return {
    status: SEARCH_STATUS.loading,
    ...requestFields(request),
    results: [],
    error: null,
    emptyReason: null,
  };
}

export function createReadySearchState(request, results) {
  return {
    status: SEARCH_STATUS.ready,
    ...requestFields(request),
    results: [...results],
    error: null,
    emptyReason: null,
  };
}

export function createEmptySearchState(request, emptyReason) {
  return {
    status: SEARCH_STATUS.empty,
    ...requestFields(request),
    results: [],
    error: null,
    emptyReason,
  };
}

export function classifySearchError(error) {
  const code = typeof error?.code === 'string' ? error.code : ERROR_CODES.QUERY_FAILED;
  const message = typeof error?.message === 'string' && error.message.length > 0
    ? error.message
    : '검색 중 오류가 발생했습니다.';
  const phase = error?.details?.phase;
  const kind = phase === 'load' || phase === 'query'
    ? phase
    : LOAD_FAILURE_CODES.has(code) ? 'load' : 'query';

  return {
    kind,
    code,
    message,
    ...(error?.details === undefined ? {} : { details: error.details }),
  };
}

export function createErrorSearchState(request, error) {
  return {
    status: SEARCH_STATUS.error,
    ...requestFields(request),
    results: [],
    error: classifySearchError(error),
    emptyReason: null,
  };
}

export function withHistoryFlags(state, { canGoBack, canGoForward }) {
  return {
    ...state,
    canGoBack,
    canGoForward,
  };
}
