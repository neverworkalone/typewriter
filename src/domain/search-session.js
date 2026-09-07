import {
  projectRelationTarget,
  projectSearchResults,
} from './projection.js';
import {
  createEmptySearchState,
  createErrorSearchState,
  createInitialSearchState,
  createLoadingSearchState,
  createReadySearchState,
  SEARCH_ACTIONS,
  SEARCH_MODES,
  SEARCH_STATUS,
  withHistoryFlags,
} from './search-state.js';
import { normalizeSearchResponse } from '../runtime/search-query.js';

export class SearchDomainError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'SearchDomainError';
    this.code = code;

    if (details !== undefined) {
      this.details = details;
    }
  }
}

function requireTerm(term) {
  if (typeof term !== 'string' || term.length === 0) {
    throw new SearchDomainError('INVALID_TERM', '검색어는 비어 있지 않은 문자열이어야 합니다.');
  }

  return term;
}

function resolveTarget(target, context = {}) {
  if (typeof target === 'string') {
    return {
      targetRecordId: target,
      sourceSenseId: context.sourceSenseId ?? null,
      targetSenseId: context.targetSenseId ?? null,
      relationType: context.relationType ?? null,
    };
  }

  const relation = target || {};
  const targetRecordId = relation.targetRecordId
    ?? relation.targetId
    ?? relation.target
    ?? relation.action?.targetRecordId;

  if (typeof targetRecordId !== 'string' || targetRecordId.length === 0) {
    throw new SearchDomainError(
      'INVALID_TARGET',
      '관계 대상 record ID가 필요합니다.',
    );
  }

  return {
    targetRecordId,
    sourceSenseId: relation.sourceSenseId ?? context.sourceSenseId ?? null,
    targetSenseId: relation.targetSenseId
      ?? relation.target_sense
      ?? context.targetSenseId
      ?? null,
    relationType: relation.canonicalType
      ?? relation.type
      ?? context.relationType
      ?? null,
  };
}

function hasFullRecord(record) {
  return record && Array.isArray(record.senses);
}

export class SearchSession {
  constructor({ runtime, initialState = createInitialSearchState() } = {}) {
    if (!runtime || typeof runtime.getRecord !== 'function') {
      throw new SearchDomainError(
        'INVALID_RUNTIME',
        '검색 세션에는 dictionary runtime이 필요합니다.',
      );
    }

    if (typeof runtime.search !== 'function' && typeof runtime.findRecordsByExactTerm !== 'function') {
      throw new SearchDomainError(
        'INVALID_RUNTIME',
        'dictionary runtime에는 exact search가 필요합니다.',
      );
    }

    this.runtime = runtime;
    this._state = initialState;
    this._listeners = new Set();
    this._historySequence = 0;
    this._requestSequence = 0;
    this._history = [{
      id: 'history-0',
      kind: 'initial',
      action: SEARCH_ACTIONS.initial,
      snapshot: initialState,
    }];
    this._historyIndex = 0;
    this._activeRequest = 0;
    this._pendingOperation = null;
  }

  get state() {
    return this._state;
  }

  get history() {
    return this._history
      .filter(({ kind }) => kind !== 'initial')
      .map(({ snapshot, ...entry }) => ({
        ...entry,
        status: snapshot?.status ?? null,
        queryMeta: snapshot?.queryMeta ?? null,
        selectedRecordId: snapshot?.selectedRecordId ?? null,
        selectedSenseId: snapshot?.selectedSenseId ?? null,
      }));
  }

  getHistory() {
    return this.history;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new SearchDomainError('INVALID_LISTENER', '검색 상태 listener가 필요합니다.');
    }

    this._listeners.add(listener);
    listener(this._state);
    return () => this._listeners.delete(listener);
  }

  searchExact(term) {
    requireTerm(term);

    const request = {
      mode: SEARCH_MODES.exact,
      action: SEARCH_ACTIONS.exact,
      query: term,
      targetRecordId: null,
      queryMeta: null,
      selectedRecordId: null,
      selectedSenseId: null,
      navigation: {
        kind: 'exact-search',
        term,
      },
    };
    const operation = this._begin(request, {
      kind: 'exact',
      action: SEARCH_ACTIONS.exact,
      query: term,
    });

    return this._run(operation, async () => {
      const search = typeof this.runtime.search === 'function'
        ? this.runtime.search
        : this.runtime.findRecordsByExactTerm;
      const rawResponse = await search.call(this.runtime, term);
      let response;
      try {
        response = normalizeSearchResponse(rawResponse, term);
      } catch (error) {
        throw new SearchDomainError(
          'INVALID_QUERY_RESULT',
          'dictionary runtime search 결과가 구조화된 응답이 아닙니다.',
          { cause: error?.message || String(error) },
        );
      }
      operation.request = {
        ...operation.request,
        queryMeta: response,
      };
      operation.historyEntry.queryMeta = response;
      operation.emptyReason = response.reason || 'no-exact-match';

      const startSummaries = response.matches.filter(
        (summary) => summary.role !== 'reference-only',
      );
      const records = await Promise.all(startSummaries.map((summary) => (
        hasFullRecord(summary) ? summary : this.runtime.getRecord(summary.id)
      )));

      if (records.some((record) => !record)) {
        throw new SearchDomainError(
          'MISSING_RECORD',
          '검색 결과 record를 불러오지 못했습니다.',
        );
      }

      const results = projectSearchResults(records, startSummaries);
      operation.request = {
        ...operation.request,
        selectedRecordId: results[0]?.id ?? null,
        selectedSenseId: results[0]?.senses?.[0]?.id ?? null,
      };
      return results;
    });
  }

  newSearch(term) {
    return this.searchExact(term);
  }

  selectCandidate(recordId, senseId = null) {
    if (typeof recordId !== 'string' || recordId.length === 0) {
      throw new SearchDomainError(
        'INVALID_CANDIDATE',
        '선택할 검색 후보 record ID가 필요합니다.',
      );
    }

    if (this._state.status !== SEARCH_STATUS.ready || this._state.mode !== SEARCH_MODES.exact) {
      throw new SearchDomainError(
        'CANDIDATE_NOT_AVAILABLE',
        'exact 검색 결과가 준비된 뒤 후보를 선택할 수 있습니다.',
      );
    }

    const record = this._state.results.find(({ id }) => id === recordId);
    if (!record) {
      throw new SearchDomainError(
        'CANDIDATE_NOT_FOUND',
        '현재 검색 결과에 없는 후보입니다.',
        { recordId },
      );
    }

    const senses = Array.isArray(record.senses) ? record.senses : [];
    const selectedSenseId = senseId ?? senses[0]?.id ?? null;
    if (selectedSenseId !== null && !senses.some(({ id }) => id === selectedSenseId)) {
      throw new SearchDomainError(
        'CANDIDATE_SENSE_NOT_FOUND',
        '현재 후보 record에 없는 뜻풀이입니다.',
        { recordId, senseId: selectedSenseId },
      );
    }

    if (
      this._state.selectedRecordId === recordId
      && this._state.selectedSenseId === selectedSenseId
    ) {
      return this._state;
    }

    this._setState({
      ...this._state,
      selectedRecordId: recordId,
      selectedSenseId,
    });
    return this._state;
  }

  openRelationTarget(target, context = {}) {
    const resolved = resolveTarget(target, context);
    const request = {
      mode: SEARCH_MODES.relationTarget,
      action: SEARCH_ACTIONS.relationTarget,
      query: null,
      targetRecordId: resolved.targetRecordId,
      selectedRecordId: null,
      selectedSenseId: null,
      navigation: {
        kind: 'relation-target',
        targetRecordId: resolved.targetRecordId,
        sourceSenseId: resolved.sourceSenseId,
        targetSenseId: resolved.targetSenseId,
        relationType: resolved.relationType,
      },
    };
    const operation = this._begin(request, {
      kind: 'relation-target',
      action: SEARCH_ACTIONS.relationTarget,
      targetRecordId: resolved.targetRecordId,
      sourceSenseId: resolved.sourceSenseId,
      targetSenseId: resolved.targetSenseId,
      relationType: resolved.relationType,
    });

    return this._run(operation, async () => {
      const record = await this.runtime.getRecord(resolved.targetRecordId);
      if (!record) {
        return null;
      }

      return projectRelationTarget(record, {
        targetRecordId: resolved.targetRecordId,
        sourceSenseId: resolved.sourceSenseId,
        targetSenseId: resolved.targetSenseId,
        relationType: resolved.relationType,
      });
    }, { emptyReason: 'relation-target-not-found' });
  }

  navigateToRelationTarget(target, context = {}) {
    return this.openRelationTarget(target, context);
  }

  back() {
    if (this._pendingOperation) {
      return this.cancelPending();
    }

    this._activeRequest = ++this._requestSequence;
    if (this._historyIndex === 0) {
      return this._state;
    }

    this._historyIndex -= 1;
    this._restoreHistoryState();
    return this._state;
  }

  forward() {
    if (this._pendingOperation) {
      this._invalidatePending();
      this._restoreHistoryState();
      return this._state;
    }

    this._activeRequest = ++this._requestSequence;
    if (this._historyIndex >= this._history.length - 1) {
      return this._state;
    }

    this._historyIndex += 1;
    this._restoreHistoryState();
    return this._state;
  }

  reset() {
    this._invalidatePending();
    this._history = [{
      id: 'history-0',
      kind: 'initial',
      action: SEARCH_ACTIONS.initial,
      snapshot: createInitialSearchState(),
    }];
    this._historyIndex = 0;
    this._setState(this._history[0].snapshot);
    return this._state;
  }

  cancelPending() {
    if (!this._pendingOperation) {
      return this._state;
    }

    this._invalidatePending();
    this._restoreHistoryState();
    return this._state;
  }

  _begin(request, entry) {
    this._invalidatePending();
    this._history = this._history.slice(0, this._historyIndex + 1);
    const historyEntry = {
      id: `history-${++this._historySequence}`,
      ...entry,
      snapshot: null,
    };
    const operation = {
      token: this._activeRequest,
      request,
      historyEntry,
    };
    this._pendingOperation = operation;
    this._setState(createLoadingSearchState(request), { recordHistory: false });
    return operation;
  }

  async _run(operation, load, { emptyReason = 'no-exact-match' } = {}) {
    try {
      const result = await load();
      if (!this._isCurrent(operation)) {
        return this._state;
      }

      const nextState = result === null || result.length === 0
        ? createEmptySearchState(
          operation.request,
          operation.emptyReason || emptyReason,
        )
        : createReadySearchState(
          operation.request,
          Array.isArray(result) ? result : [result],
        );
      return this._commit(operation, nextState);
    } catch (error) {
      if (!this._isCurrent(operation)) {
        return this._state;
      }

      return this._commit(operation, createErrorSearchState(operation.request, error));
    }
  }

  _isCurrent(operation) {
    return operation.token === this._activeRequest && this._pendingOperation === operation;
  }

  _commit(operation, state) {
    if (!this._isCurrent(operation)) {
      return this._state;
    }

    this._pendingOperation = null;
    this._history.push(operation.historyEntry);
    this._historyIndex = this._history.length - 1;
    operation.historyEntry.snapshot = state;
    this._setState(state);
    return this._state;
  }

  _restoreHistoryState() {
    const snapshot = this._history[this._historyIndex].snapshot || createInitialSearchState();
    this._setState(snapshot);
  }

  _setState(state, { recordHistory = true } = {}) {
    this._state = withHistoryFlags(state, {
      canGoBack: this._historyIndex > 0,
      canGoForward: this._historyIndex < this._history.length - 1,
    });
    if (recordHistory) {
      this._history[this._historyIndex].snapshot = this._state;
    }

    for (const listener of this._listeners) {
      listener(this._state);
    }
  }

  _invalidatePending() {
    if (this._pendingOperation) {
      this._pendingOperation.cancelled = true;
      this._pendingOperation = null;
    }

    this._activeRequest = ++this._requestSequence;
  }
}

export const DictionarySearchService = SearchSession;
export const SearchController = SearchSession;
