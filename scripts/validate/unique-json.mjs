/**
 * Parse JSON while rejecting duplicate object keys.
 *
 * JSON.parse follows the last-value-wins convention for duplicate keys. That
 * is unsafe for digest-bound durable evidence because the bytes being hashed
 * can contain information that the parsed consumer never sees.
 */

export class DuplicateJsonKeyError extends Error {
  constructor(label, key, objectPath) {
    super(`${label} contains duplicate JSON key ${JSON.stringify(key)} at ${objectPath}`);
    this.name = 'DuplicateJsonKeyError';
    this.code = 'DUPLICATE_JSON_KEY';
  }
}

function skipWhitespace(source, index) {
  let cursor = index;
  while (cursor < source.length && /\s/u.test(source[cursor])) cursor += 1;
  return cursor;
}

function scanString(source, index) {
  if (source[index] !== '"') throw new SyntaxError('JSON string must start with a quote');
  let cursor = index + 1;
  while (cursor < source.length) {
    const code = source.charCodeAt(cursor);
    if (code < 0x20) throw new SyntaxError('JSON string contains an unescaped control character');
    if (source[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (source[cursor] === '"') return cursor + 1;
    cursor += 1;
  }
  throw new SyntaxError('JSON string is not terminated');
}

function scanObject(source, index, label, objectPath) {
  let cursor = skipWhitespace(source, index + 1);
  const keys = new Set();
  if (source[cursor] === '}') return cursor + 1;

  while (cursor < source.length) {
    cursor = skipWhitespace(source, cursor);
    const keyStart = cursor;
    cursor = scanString(source, cursor);
    const key = JSON.parse(source.slice(keyStart, cursor));
    if (keys.has(key)) throw new DuplicateJsonKeyError(label, key, objectPath);
    keys.add(key);

    cursor = skipWhitespace(source, cursor);
    if (source[cursor] !== ':') throw new SyntaxError('JSON object key must be followed by a colon');
    cursor = scanValue(source, cursor + 1, label, `${objectPath}.${key}`);
    cursor = skipWhitespace(source, cursor);
    if (source[cursor] === '}') return cursor + 1;
    if (source[cursor] !== ',') throw new SyntaxError('JSON object member must be followed by a comma');
    cursor += 1;
  }

  throw new SyntaxError('JSON object is not terminated');
}

function scanArray(source, index, label, arrayPath) {
  let cursor = skipWhitespace(source, index + 1);
  if (source[cursor] === ']') return cursor + 1;

  while (cursor < source.length) {
    cursor = scanValue(source, cursor, label, `${arrayPath}[]`);
    cursor = skipWhitespace(source, cursor);
    if (source[cursor] === ']') return cursor + 1;
    if (source[cursor] !== ',') throw new SyntaxError('JSON array value must be followed by a comma');
    cursor = skipWhitespace(source, cursor + 1);
  }

  throw new SyntaxError('JSON array is not terminated');
}

function scanPrimitive(source, index) {
  let cursor = index;
  while (cursor < source.length
    && !/[\s,[\]}]/u.test(source[cursor])) cursor += 1;
  if (cursor === index) throw new SyntaxError('JSON value is missing');
  return cursor;
}

function scanValue(source, index, label, valuePath) {
  const cursor = skipWhitespace(source, index);
  if (source[cursor] === '{') return scanObject(source, cursor, label, valuePath);
  if (source[cursor] === '[') return scanArray(source, cursor, label, valuePath);
  if (source[cursor] === '"') return scanString(source, cursor);
  return scanPrimitive(source, cursor);
}

export function parseJsonWithUniqueKeys(input, label = 'JSON') {
  const source = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  const end = scanValue(source, 0, label, '$');
  if (skipWhitespace(source, end) !== source.length) {
    throw new SyntaxError('JSON contains trailing content');
  }
  return JSON.parse(source);
}
