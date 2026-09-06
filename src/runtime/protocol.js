export const RUNTIME_PROTOCOL_VERSION = 1;

export const MESSAGE_TYPES = Object.freeze({
  request: 'typewriter/dictionary-request',
  response: 'typewriter/dictionary-response',
});

export const REQUEST_METHODS = Object.freeze({
  ready: 'ready',
  status: 'status',
  search: 'search',
  getRecord: 'get-record',
  getRelations: 'get-relations',
  metadata: 'metadata',
  close: 'close',
});

export const ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  UNSUPPORTED_REQUEST: 'UNSUPPORTED_REQUEST',
  ASSET_LOAD_FAILED: 'ASSET_LOAD_FAILED',
  WASM_LOAD_FAILED: 'WASM_LOAD_FAILED',
  DATABASE_LOAD_FAILED: 'DATABASE_LOAD_FAILED',
  QUERY_FAILED: 'QUERY_FAILED',
  WORKER_UNAVAILABLE: 'WORKER_UNAVAILABLE',
  WORKER_POST_FAILED: 'WORKER_POST_FAILED',
  WORKER_ERROR: 'WORKER_ERROR',
  WORKER_MESSAGE_ERROR: 'WORKER_MESSAGE_ERROR',
  PROTOCOL_ERROR: 'PROTOCOL_ERROR',
  RUNTIME_NOT_READY: 'RUNTIME_NOT_READY',
  RUNTIME_CLOSED: 'RUNTIME_CLOSED',
  TIMEOUT: 'TIMEOUT',
});

export const RUNTIME_STATES = Object.freeze({
  idle: 'idle',
  loading: 'loading',
  ready: 'ready',
  failed: 'failed',
  closed: 'closed',
});

export function createRequest(id, method, params = {}) {
  return {
    protocol: RUNTIME_PROTOCOL_VERSION,
    type: MESSAGE_TYPES.request,
    id,
    method,
    params,
  };
}

export function createSuccessResponse(id, result) {
  return {
    protocol: RUNTIME_PROTOCOL_VERSION,
    type: MESSAGE_TYPES.response,
    id,
    ok: true,
    result,
  };
}

export function createErrorResponse(id, error) {
  return {
    protocol: RUNTIME_PROTOCOL_VERSION,
    type: MESSAGE_TYPES.response,
    id,
    ok: false,
    error: normalizeErrorPayload(error),
  };
}

export function normalizeErrorPayload(error, fallbackCode = ERROR_CODES.QUERY_FAILED) {
  if (error && typeof error === 'object') {
    const code = typeof error.code === 'string' ? error.code : fallbackCode;
    const message = typeof error.message === 'string' && error.message.length > 0
      ? error.message
      : 'Dictionary runtime request failed.';
    const payload = { code, message };

    if (error.details !== undefined) {
      payload.details = error.details;
    }

    return payload;
  }

  return {
    code: fallbackCode,
    message: String(error || 'Dictionary runtime request failed.'),
  };
}
