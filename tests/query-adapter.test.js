import { afterEach, describe, expect, it } from 'vitest';

import {
  DictionaryRuntime,
  DictionaryRuntimeError,
} from '../src/runtime/query-adapter.js';
import {
  createSuccessResponse,
  ERROR_CODES,
  REQUEST_METHODS,
} from '../src/runtime/protocol.js';
import searchRegressionCorpus from './fixtures/search-regressions/m4-baseline.json';
import { expectedBrowserQueries } from './helpers/search-regressions.js';

class FakeWorker {
  constructor(handler) {
    this.handler = handler;
    this.listeners = new Map();
    this.messages = [];
    this.terminated = false;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) {
      this.listeners.delete(type);
    }
  }

  postMessage(message) {
    this.messages.push(message);
    this.handler(message, this);
  }

  emit(type, event) {
    this.listeners.get(type)?.(event);
  }

  terminate() {
    this.terminated = true;
  }
}

const workers = [];

afterEach(() => {
  for (const worker of workers.splice(0)) {
    worker.terminate();
  }
});

function respond(worker, request, result) {
  queueMicrotask(() => {
    worker.emit('message', { data: createSuccessResponse(request.id, result) });
  });
}

describe('DictionaryRuntime', () => {
  it('reuses the shared baseline corpus for exact browser query requests', async () => {
    let worker;
    const baselineQueries = expectedBrowserQueries(searchRegressionCorpus);
    const resultsByQuery = new Map(
      baselineQueries.map(({ query, result_ids }) => [
        query,
        result_ids.map((id) => ({ id })),
      ]),
    );
    const runtime = new DictionaryRuntime({
      timeoutMs: 100,
      workerFactory: () => {
        worker = new FakeWorker((request, currentWorker) => {
          if (request.method === REQUEST_METHODS.ready) {
            respond(currentWorker, request, { ready: true, query_only: 1 });
            return;
          }

          if (request.method === REQUEST_METHODS.search) {
            respond(currentWorker, request, resultsByQuery.get(request.params.term) || []);
          }
        });
        workers.push(worker);
        return worker;
      },
    });

    await runtime.ready();
    for (const { query, result_ids } of baselineQueries) {
      await expect(runtime.search(query)).resolves.toEqual(
        result_ids.map((id) => ({ id })),
      );
      expect(worker.messages.at(-1)).toMatchObject({
        method: REQUEST_METHODS.search,
        params: { term: query },
      });
    }
  });

  it('preserves the structured worker response while forwarding the raw query', async () => {
    let worker;
    const rawQuery = '  담담하다  ';
    const response = {
      rawQuery,
      normalizedQuery: '담담하다',
      normalizationRules: ['trim-surrounding-whitespace'],
      status: 'ready',
      reason: null,
      matches: [{
        id: 'w026',
        record_type: 'entry',
        role: 'start',
        candidate_id: 'w026',
        lemma: '담담하다',
        match: {
          kind: 'normalized',
          field: 'lemma',
          value: '담담하다',
          normalizationRules: ['trim-surrounding-whitespace'],
        },
      }],
    };
    const runtime = new DictionaryRuntime({
      timeoutMs: 100,
      workerFactory: () => {
        worker = new FakeWorker((request, currentWorker) => {
          if (request.method === REQUEST_METHODS.ready) {
            respond(currentWorker, request, { ready: true, query_only: 1 });
          }
          if (request.method === REQUEST_METHODS.search) {
            respond(currentWorker, request, response);
          }
        });
        workers.push(worker);
        return worker;
      },
    });

    await runtime.ready();
    await expect(runtime.search(rawQuery)).resolves.toEqual(response);
    expect(worker.messages.at(-1)).toMatchObject({
      method: REQUEST_METHODS.search,
      params: { term: rawQuery },
    });
  });

  it('deduplicates initialization and exposes read-only lookup methods', async () => {
    let factoryCalls = 0;
    let worker;
    const runtime = new DictionaryRuntime({
      timeoutMs: 100,
      workerFactory: () => {
        factoryCalls += 1;
        worker = new FakeWorker((request, currentWorker) => {
          if (request.method === REQUEST_METHODS.ready) {
            respond(currentWorker, request, {
              ready: true,
              query_only: 1,
              sqlite_version: '3.53.0',
            });
            return;
          }

          if (request.method === REQUEST_METHODS.search) {
            respond(currentWorker, request, [{
              id: 'w026',
              record_type: 'entry',
              role: 'start',
              candidate_id: null,
              lemma: '담담하다',
            }]);
            return;
          }

          if (request.method === REQUEST_METHODS.getRecord) {
            respond(currentWorker, request, {
              id: 'w026',
              role: 'start',
              lemma: '담담하다',
              search_forms: ['담담'],
              senses: [{ id: 'w026-s1', relations: [] }],
            });
          }
        });
        workers.push(worker);
        return worker;
      },
    });

    const firstReady = runtime.ready();
    const secondReady = runtime.ready();

    expect(firstReady).toBe(secondReady);
    await expect(firstReady).resolves.toMatchObject({ query_only: 1, ready: true });
    expect(factoryCalls).toBe(1);
    expect(worker.messages.filter(({ method }) => method === REQUEST_METHODS.ready)).toHaveLength(1);

    await expect(runtime.findRecordsByExactTerm('담담')).resolves.toEqual([
      expect.objectContaining({ id: 'w026', role: 'start' }),
    ]);
    await expect(runtime.getRecord('w026')).resolves.toMatchObject({
      id: 'w026',
      senses: [{ id: 'w026-s1' }],
    });

    expect(worker.messages.map(({ method }) => method)).toEqual([
      REQUEST_METHODS.ready,
      REQUEST_METHODS.search,
      REQUEST_METHODS.getRecord,
    ]);
  });

  it('returns structured worker errors and supports retry after a failed load', async () => {
    let factoryCalls = 0;
    const runtime = new DictionaryRuntime({
      timeoutMs: 5,
      workerFactory: () => {
        factoryCalls += 1;
        if (factoryCalls === 1) {
          const worker = new FakeWorker(() => {});
          workers.push(worker);
          return worker;
        }

        const worker = new FakeWorker((request, currentWorker) => {
          respond(currentWorker, request, {
            ready: true,
            query_only: 1,
          });
        });
        workers.push(worker);
        return worker;
      },
    });

    await expect(runtime.ready()).rejects.toMatchObject({
      code: ERROR_CODES.TIMEOUT,
      details: { phase: 'load' },
    });
    expect(runtime.state).toBe('failed');

    await expect(runtime.retry()).resolves.toMatchObject({
      ready: true,
      query_only: 1,
    });
    expect(factoryCalls).toBe(2);
  });

  it('marks a timeout after readiness as a query failure without unloading the runtime', async () => {
    const worker = new FakeWorker((request, currentWorker) => {
      if (request.method === REQUEST_METHODS.ready) {
        respond(currentWorker, request, { ready: true, query_only: 1 });
      }
    });
    workers.push(worker);
    const runtime = new DictionaryRuntime({
      timeoutMs: 5,
      workerFactory: () => worker,
    });

    await runtime.ready();
    await expect(runtime.search('담담하다')).rejects.toMatchObject({
      code: ERROR_CODES.TIMEOUT,
      details: { method: REQUEST_METHODS.search, phase: 'query' },
    });
    expect(runtime.state).toBe('ready');
    expect(worker.terminated).toBe(false);
  });

  it('marks a worker failure during initialization as a load failure', async () => {
    const worker = new FakeWorker((_, currentWorker) => {
      queueMicrotask(() => currentWorker.emit('error', { message: 'worker boot failed' }));
    });
    workers.push(worker);
    const runtime = new DictionaryRuntime({
      timeoutMs: 100,
      workerFactory: () => worker,
    });

    await expect(runtime.ready()).rejects.toMatchObject({
      code: ERROR_CODES.WORKER_ERROR,
      details: { phase: 'load' },
    });
    expect(runtime.state).toBe('failed');
  });

  it('rejects pending operations when closed and validates arguments', async () => {
    const worker = new FakeWorker(() => {});
    workers.push(worker);
    const runtime = new DictionaryRuntime({
      timeoutMs: 100,
      workerFactory: () => worker,
    });
    const pending = runtime.ready();

    runtime.close();

    await expect(pending).rejects.toMatchObject({
      code: ERROR_CODES.RUNTIME_CLOSED,
    });
    expect(runtime.state).toBe('closed');
    expect(() => runtime.search('')).toThrow(DictionaryRuntimeError);
    expect(() => runtime.getRecord(null)).toThrow(DictionaryRuntimeError);
  });
});
