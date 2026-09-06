import {
  createRequest,
  ERROR_CODES,
  MESSAGE_TYPES,
  normalizeErrorPayload,
  REQUEST_METHODS,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_STATES,
} from './protocol.js';

export const DEFAULT_RUNTIME_TIMEOUT_MS = 5000;

export class DictionaryRuntimeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DictionaryRuntimeError';
    this.code = code;

    if (details !== undefined) {
      this.details = details;
    }
  }
}

function toRuntimeError(error, fallbackCode = ERROR_CODES.QUERY_FAILED) {
  if (error instanceof DictionaryRuntimeError) {
    return error;
  }

  const payload = normalizeErrorPayload(error, fallbackCode);
  return new DictionaryRuntimeError(payload.code, payload.message, payload.details);
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DictionaryRuntimeError(
      ERROR_CODES.INVALID_ARGUMENT,
      `${name} must be a non-empty string.`,
    );
  }

  return value;
}

export function resolveDictionaryWorkerUrl(workerPath = 'runtime/dictionary-worker.mjs') {
  if (typeof chrome !== 'undefined' && typeof chrome.runtime?.getURL === 'function') {
    return chrome.runtime.getURL(workerPath);
  }

  return new URL(workerPath, import.meta.url);
}

export function createDefaultDictionaryWorker(workerPath) {
  if (typeof Worker === 'undefined') {
    throw new DictionaryRuntimeError(
      ERROR_CODES.WORKER_UNAVAILABLE,
      'The browser does not provide module workers.',
    );
  }

  return new Worker(resolveDictionaryWorkerUrl(workerPath), { type: 'module' });
}

/**
 * Main-thread adapter for the packaged dictionary worker.
 *
 * The adapter deliberately exposes read operations only. It never receives a
 * database handle and the worker protocol has no write method.
 */
export class DictionaryRuntime {
  constructor({
    timeoutMs = DEFAULT_RUNTIME_TIMEOUT_MS,
    workerFactory = createDefaultDictionaryWorker,
    workerPath = 'runtime/dictionary-worker.mjs',
  } = {}) {
    this.timeoutMs = timeoutMs;
    this.workerFactory = workerFactory;
    this.workerPath = workerPath;

    this._worker = null;
    this._pending = new Map();
    this._nextRequestId = 0;
    this._state = RUNTIME_STATES.idle;
    this._readyPromise = null;
    this._runtimeStatus = null;
    this._lastError = null;

    this._handleMessage = (event) => this._onMessage(event);
    this._handleWorkerError = (event) => this._onWorkerError(event);
    this._handleWorkerMessageError = (event) => this._onWorkerMessageError(event);
  }

  get state() {
    return this._state;
  }

  get lastError() {
    return this._lastError;
  }

  get status() {
    return {
      ...(this._runtimeStatus || {}),
      state: this._state,
      ready: this._state === RUNTIME_STATES.ready,
      error: this._lastError
        ? { code: this._lastError.code, message: this._lastError.message }
        : null,
    };
  }

  ready() {
    if (this._state === RUNTIME_STATES.ready) {
      return Promise.resolve(this._runtimeStatus);
    }

    if (this._state === RUNTIME_STATES.loading && this._readyPromise) {
      return this._readyPromise;
    }

    if (this._state === RUNTIME_STATES.failed) {
      return Promise.reject(this._lastError);
    }

    if (this._state === RUNTIME_STATES.closed) {
      return Promise.reject(new DictionaryRuntimeError(
        ERROR_CODES.RUNTIME_CLOSED,
        'The dictionary runtime has been closed.',
      ));
    }

    this._state = RUNTIME_STATES.loading;

    try {
      this._ensureWorker();
    } catch (error) {
      const runtimeError = this._fail(error, ERROR_CODES.WORKER_UNAVAILABLE);
      this._readyPromise = Promise.reject(runtimeError);
      return this._readyPromise;
    }

    this._readyPromise = this._request(REQUEST_METHODS.ready)
      .then((status) => {
        this._runtimeStatus = { ...status, state: RUNTIME_STATES.ready, ready: true };
        this._lastError = null;
        this._state = RUNTIME_STATES.ready;
        return this._runtimeStatus;
      })
      .catch((error) => {
        if (this._state === RUNTIME_STATES.closed) {
          throw toRuntimeError(error, ERROR_CODES.RUNTIME_CLOSED);
        }

        throw this._fail(error);
      });

    return this._readyPromise;
  }

  initialize() {
    return this.ready();
  }

  retry() {
    if (this._state === RUNTIME_STATES.closed) {
      return Promise.reject(new DictionaryRuntimeError(
        ERROR_CODES.RUNTIME_CLOSED,
        'The dictionary runtime has been closed.',
      ));
    }

    if (this._state === RUNTIME_STATES.failed) {
      this._disposeWorker();
      this._state = RUNTIME_STATES.idle;
      this._readyPromise = null;
      this._lastError = null;
    }

    return this.ready();
  }

  search(term) {
    requireString(term, 'term');
    return this._afterReady(REQUEST_METHODS.search, { term });
  }

  findRecordsByExactTerm(term) {
    return this.search(term);
  }

  getRecord(recordId) {
    requireString(recordId, 'recordId');
    return this._afterReady(REQUEST_METHODS.getRecord, { recordId });
  }

  getSenseRelations(senseId) {
    requireString(senseId, 'senseId');
    return this._afterReady(REQUEST_METHODS.getRelations, { senseId });
  }

  getMetadata() {
    return this._afterReady(REQUEST_METHODS.metadata);
  }

  getRuntimeStatus() {
    return this.ready().then(() => this._request(REQUEST_METHODS.status));
  }

  close() {
    if (this._state === RUNTIME_STATES.closed) {
      return;
    }

    const error = new DictionaryRuntimeError(
      ERROR_CODES.RUNTIME_CLOSED,
      'The dictionary runtime has been closed.',
    );

    this._state = RUNTIME_STATES.closed;
    this._lastError = error;
    this._rejectPending(error);
    this._disposeWorker();
    this._readyPromise = null;
  }

  dispose() {
    this.close();
  }

  _afterReady(method, params) {
    return this.ready().then(() => this._request(method, params));
  }

  _ensureWorker() {
    if (this._worker) {
      return this._worker;
    }

    let worker;
    try {
      worker = this.workerFactory(this.workerPath);
    } catch (error) {
      throw toRuntimeError(error, ERROR_CODES.WORKER_UNAVAILABLE);
    }

    if (!worker || typeof worker.postMessage !== 'function') {
      throw new DictionaryRuntimeError(
        ERROR_CODES.WORKER_UNAVAILABLE,
        'The dictionary worker factory did not return a worker.',
      );
    }

    this._worker = worker;
    this._addWorkerListener('message', this._handleMessage);
    this._addWorkerListener('error', this._handleWorkerError);
    this._addWorkerListener('messageerror', this._handleWorkerMessageError);
    return worker;
  }

  _addWorkerListener(type, listener) {
    if (typeof this._worker.addEventListener === 'function') {
      this._worker.addEventListener(type, listener);
      return;
    }

    this._worker[`on${type}`] = listener;
  }

  _removeWorkerListener(type, listener) {
    if (!this._worker) {
      return;
    }

    if (typeof this._worker.removeEventListener === 'function') {
      this._worker.removeEventListener(type, listener);
      return;
    }

    if (this._worker[`on${type}`] === listener) {
      this._worker[`on${type}`] = null;
    }
  }

  _request(method, params = {}) {
    if (!this._worker) {
      return Promise.reject(new DictionaryRuntimeError(
        ERROR_CODES.RUNTIME_NOT_READY,
        'The dictionary worker has not been initialized.',
      ));
    }

    if (this._state === RUNTIME_STATES.closed) {
      return Promise.reject(new DictionaryRuntimeError(
        ERROR_CODES.RUNTIME_CLOSED,
        'The dictionary runtime has been closed.',
      ));
    }

    const id = `dictionary-${++this._nextRequestId}`;
    const request = createRequest(id, method, params);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        const error = new DictionaryRuntimeError(
          ERROR_CODES.TIMEOUT,
          `Dictionary runtime request timed out: ${method}.`,
          { method },
        );
        reject(error);

        if (method === REQUEST_METHODS.ready) {
          this._fail(error);
        }
      }, this.timeoutMs);

      this._pending.set(id, { resolve, reject, timeout, method });

      try {
        this._worker.postMessage(request);
      } catch (error) {
        clearTimeout(timeout);
        this._pending.delete(id);
        reject(this._fail(error, ERROR_CODES.WORKER_POST_FAILED));
      }
    });
  }

  _onMessage(event) {
    const message = event?.data ?? event;
    const pending = message && this._pending.get(message.id);

    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this._pending.delete(message.id);

    if (
      message.protocol !== RUNTIME_PROTOCOL_VERSION
      || message.type !== MESSAGE_TYPES.response
    ) {
      pending.reject(new DictionaryRuntimeError(
        ERROR_CODES.PROTOCOL_ERROR,
        'The dictionary worker returned an invalid response.',
      ));
      return;
    }

    if (message.ok === true) {
      pending.resolve(message.result);
      return;
    }

    const payload = normalizeErrorPayload(message.error);
    pending.reject(new DictionaryRuntimeError(payload.code, payload.message, payload.details));
  }

  _onWorkerError(event) {
    const message = event?.message || event?.error?.message || 'The dictionary worker failed.';
    this._fail(new DictionaryRuntimeError(ERROR_CODES.WORKER_ERROR, message));
  }

  _onWorkerMessageError() {
    this._fail(new DictionaryRuntimeError(
      ERROR_CODES.WORKER_MESSAGE_ERROR,
      'The dictionary worker could not deserialize a message.',
    ));
  }

  _fail(error, fallbackCode = ERROR_CODES.QUERY_FAILED) {
    const runtimeError = toRuntimeError(error, fallbackCode);
    this._state = RUNTIME_STATES.failed;
    this._lastError = runtimeError;
    this._rejectPending(runtimeError);
    this._disposeWorker();
    return runtimeError;
  }

  _rejectPending(error) {
    for (const { reject, timeout } of this._pending.values()) {
      clearTimeout(timeout);
      reject(error);
    }

    this._pending.clear();
  }

  _disposeWorker() {
    if (!this._worker) {
      return;
    }

    this._removeWorkerListener('message', this._handleMessage);
    this._removeWorkerListener('error', this._handleWorkerError);
    this._removeWorkerListener('messageerror', this._handleWorkerMessageError);

    if (typeof this._worker.terminate === 'function') {
      this._worker.terminate();
    }

    this._worker = null;
  }
}

export const DictionaryQueryAdapter = DictionaryRuntime;

export function createDictionaryRuntime(options) {
  return new DictionaryRuntime(options);
}
