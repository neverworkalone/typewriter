import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

const require = createRequire(import.meta.url);
const CANONICAL_SCHEMA = require('../../schema/canonical-record.schema.json');

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CANONICAL_DIRECTORY = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/canonical',
);
const SHARED_CONTEXT_CONTRACT_VERSION = 'canonical-context-v1';
const canonicalLoadObservers = [];

/**
 * Observe every canonical loader boundary, including calls that bypass a
 * supplied shared context.  This is intentionally process-local so tests can
 * prove that a consumer uses its injected context without changing production
 * data or loader behavior.
 */
export async function withCanonicalLoadObserver(observer, callback) {
  if (typeof observer !== 'function' || typeof callback !== 'function') {
    throw new TypeError('canonical load observer and callback are required');
  }
  canonicalLoadObservers.push(observer);
  try {
    return await callback();
  } finally {
    canonicalLoadObservers.pop();
  }
}

function observeCanonicalLoad(event) {
  const observer = canonicalLoadObservers.at(-1);
  if (observer) observer(event);
}

export class ValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

function displayPath(filePath) {
  const relativePath = path.relative(process.cwd(), filePath);
  if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
    return relativePath;
  }
  return filePath;
}

export function getCanonicalSchema() {
  return CANONICAL_SCHEMA;
}

export const RECORD_TYPES = Object.freeze(
  [...CANONICAL_SCHEMA.properties.record_type.enum],
);
export const ROLES = Object.freeze([...CANONICAL_SCHEMA.properties.role.enum]);
export const PARTS_OF_SPEECH = Object.freeze(
  [...CANONICAL_SCHEMA.$defs.sense.properties.pos.enum],
);
export const RELATION_TYPES = Object.freeze(
  [...CANONICAL_SCHEMA.$defs.relation.properties.type.enum],
);

async function collectJsonlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectJsonlFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(entryPath);
    }
  }

  return files;
}

function splitByteLines(bytes) {
  if (bytes.length === 0) {
    return [];
  }

  const lines = [];
  let lineStart = 0;

  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) {
      lines.push(bytes.subarray(lineStart, index));
      lineStart = index + 1;
    }
  }

  // A single final LF terminates the last JSON value; it is not an extra row.
  if (lineStart < bytes.length) {
    lines.push(bytes.subarray(lineStart));
  }

  return lines;
}

function schemaPath(pathParts) {
  if (pathParts.length === 0) {
    return '$';
  }

  return pathParts.reduce(
    (result, part) =>
      typeof part === 'number' ? `${result}[${part}]` : `${result}.${part}`,
    '$',
  );
}

function resolveSchema(schema) {
  if (schema.$ref === '#/$defs/sense') {
    return CANONICAL_SCHEMA.$defs.sense;
  }

  if (schema.$ref === '#/$defs/relation') {
    return CANONICAL_SCHEMA.$defs.relation;
  }

  return schema;
}

function matchesSchema(value, schema) {
  const resolvedSchema = resolveSchema(schema);

  if (resolvedSchema.const !== undefined && value !== resolvedSchema.const) {
    return false;
  }

  if (resolvedSchema.enum && !resolvedSchema.enum.includes(value)) {
    return false;
  }

  if (resolvedSchema.type === 'object') {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  if (resolvedSchema.type === 'array') {
    return Array.isArray(value);
  }

  if (resolvedSchema.type === 'string') {
    return typeof value === 'string';
  }

  return true;
}

function schemaError(pathParts, message) {
  return { path: schemaPath(pathParts), message };
}

function validateSchemaValue(value, schema, pathParts = []) {
  const resolvedSchema = resolveSchema(schema);
  const errors = [];

  if (!matchesSchema(value, resolvedSchema)) {
    if (resolvedSchema.const !== undefined) {
      return [schemaError(pathParts, `must be ${JSON.stringify(resolvedSchema.const)}`)];
    }

    if (resolvedSchema.enum) {
      return [
        schemaError(
          pathParts,
          `must be one of: ${resolvedSchema.enum.join(', ')}`,
        ),
      ];
    }

    return [schemaError(pathParts, `must be a ${resolvedSchema.type}`)];
  }

  if (resolvedSchema.type === 'string') {
    if (resolvedSchema.minLength !== undefined && value.length < resolvedSchema.minLength) {
      errors.push(
        schemaError(
          pathParts,
          `must contain at least ${resolvedSchema.minLength} character(s)`,
        ),
      );
    }

    if (resolvedSchema.pattern && !new RegExp(resolvedSchema.pattern, 'u').test(value)) {
      errors.push(
        schemaError(
          pathParts,
          'must contain a non-whitespace character and match the required format',
        ),
      );
    }

    return errors;
  }

  if (resolvedSchema.type === 'array') {
    if (resolvedSchema.minItems !== undefined && value.length < resolvedSchema.minItems) {
      errors.push(
        schemaError(
          pathParts,
          `must contain at least ${resolvedSchema.minItems} item(s)`,
        ),
      );
    }

    if (resolvedSchema.items) {
      value.forEach((item, index) => {
        errors.push(
          ...validateSchemaValue(item, resolvedSchema.items, [...pathParts, index]),
        );
      });
    }

    return errors;
  }

  if (resolvedSchema.type !== 'object') {
    return errors;
  }

  for (const requiredProperty of resolvedSchema.required ?? []) {
    if (!Object.hasOwn(value, requiredProperty)) {
      errors.push(schemaError([...pathParts, requiredProperty], 'is required'));
    }
  }

  if (resolvedSchema.additionalProperties === false) {
    for (const property of Object.keys(value)) {
      if (!Object.hasOwn(resolvedSchema.properties ?? {}, property)) {
        errors.push(
          schemaError([...pathParts, property], 'is not an allowed property'),
        );
      }
    }
  }

  for (const [property, propertySchema] of Object.entries(
    resolvedSchema.properties ?? {},
  )) {
    if (Object.hasOwn(value, property)) {
      errors.push(
        ...validateSchemaValue(value[property], propertySchema, [
          ...pathParts,
          property,
        ]),
      );
    }
  }

  for (const conditional of resolvedSchema.allOf ?? []) {
    const conditionMatches =
      validateSchemaValue(value, conditional.if, pathParts).length === 0;
    if (conditionMatches && conditional.then) {
      errors.push(...validateSchemaValue(value, conditional.then, pathParts));
    }
  }

  return errors;
}

export function validateCanonicalRecord(
  record,
  filePath = '<record>',
  lineNumber = 1,
) {
  const errors = validateSchemaValue(record, CANONICAL_SCHEMA);
  if (errors.length === 0) {
    return;
  }

  const details = errors
    .map((error) => `${error.path}: ${error.message}`)
    .join('; ');
  throw new ValidationError(
    `${displayPath(filePath)}:${lineNumber}: schema validation failed (${details})`,
    'SCHEMA_ERROR',
  );
}

async function readJsonlFile(filePath, { onBytes } = {}) {
  const bytes = await readFile(filePath);
  onBytes?.(bytes);
  const byteLines = splitByteLines(bytes);

  // An empty file is allowed while the canonical dataset is being bootstrapped.
  // A blank row inside a non-empty file is rejected as a formatting error.
  if (byteLines.length === 0) {
    return [];
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const records = [];

  for (const [index, byteLine] of byteLines.entries()) {
    const lineNumber = index + 1;
    let rawLine;

    try {
      // UTF-8 continuation bytes cannot contain LF, so decoding one LF-delimited
      // slice preserves the row where the first malformed sequence occurs.
      rawLine = decoder.decode(byteLine);
    } catch (error) {
      throw new ValidationError(
        `${displayPath(filePath)}:${lineNumber}: invalid UTF-8 encoding (${error.message})`,
        'INVALID_UTF8',
      );
    }

    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (line.trim().length === 0) {
      throw new ValidationError(
        `${displayPath(filePath)}:${lineNumber}: empty lines are not allowed in canonical JSONL`,
        'EMPTY_LINE',
      );
    }

    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new ValidationError(
        `${displayPath(filePath)}:${lineNumber}: invalid JSON (${error.message})`,
        'INVALID_JSON',
      );
    }

    validateCanonicalRecord(record, filePath, lineNumber);
    records.push({ record, filePath, lineNumber });
  }

  return records;
}

async function readSharedCanonicalContext(directory) {
  const contextPath = process.env.TYPEWRITER_CANONICAL_CONTEXT_PATH;
  const contextDirectory = process.env.TYPEWRITER_CANONICAL_CONTEXT_DIRECTORY;
  if (
    !contextPath
      || !contextDirectory
      || path.resolve(directory) !== path.resolve(contextDirectory)
  ) {
    return undefined;
  }

  let context;
  try {
    context = JSON.parse(await readFile(contextPath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ValidationError(
        `${contextPath}: shared canonical context is not valid JSON (${error.message})`,
        'SHARED_CONTEXT_JSON',
      );
    }
    throw error;
  }

  if (context.contract_version !== SHARED_CONTEXT_CONTRACT_VERSION) {
    throw new ValidationError(
      `${contextPath}: unsupported shared canonical context contract`,
      'SHARED_CONTEXT_CONTRACT',
    );
  }
  if (
    typeof context.canonical_directory !== 'string'
    || path.resolve(context.canonical_directory) !== path.resolve(contextDirectory)
  ) {
    throw new ValidationError(
      `${contextPath}: shared canonical context directory does not match the default canonical directory`,
      'SHARED_CONTEXT_DIRECTORY',
    );
  }
  const expectedRevision = process.env.TYPEWRITER_CANONICAL_REVISION;
  if (!expectedRevision) {
    throw new ValidationError(
      `${contextPath}: shared canonical context requires TYPEWRITER_CANONICAL_REVISION`,
      'SHARED_CONTEXT_REVISION_REQUIRED',
    );
  }
  if (expectedRevision && context.canonical_revision !== expectedRevision) {
    throw new ValidationError(
      `${contextPath}: shared canonical context revision does not match the expected current revision`,
      'SHARED_CONTEXT_REVISION',
    );
  }
  if (typeof context.canonical_revision !== 'string' || !Array.isArray(context.records)) {
    throw new ValidationError(
      `${contextPath}: shared canonical context is missing records`,
      'SHARED_CONTEXT_SHAPE',
    );
  }

  return {
    fileCount: context.file_count ?? 0,
    canonicalRevision: context.canonical_revision,
    records: context.records,
  };
}

export async function validateCanonicalFile(filePath) {
  const records = await readJsonlFile(filePath);
  return { fileCount: 1, recordCount: records.length };
}

export async function readCanonicalRecords(
  directory = DEFAULT_CANONICAL_DIRECTORY,
  { useSharedContext = true } = {},
) {
  observeCanonicalLoad({
    directory: path.resolve(directory),
    useSharedContext,
  });
  const sharedContext = useSharedContext
    ? await readSharedCanonicalContext(directory)
    : undefined;
  if (sharedContext) {
    return sharedContext;
  }

  let files;

  try {
    files = await collectJsonlFiles(directory);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        fileCount: 0,
        canonicalRevision: createHash('sha256').digest('hex'),
        records: [],
      };
    }

    if (error.code === 'ENOTDIR') {
      if (directory.endsWith('.jsonl')) {
        const digest = createHash('sha256');
        digest.update(path.basename(directory), 'utf8');
        digest.update(Buffer.from([0]));
        const records = await readJsonlFile(directory, {
          onBytes: (bytes) => {
            digest.update(bytes);
            digest.update(Buffer.from([0]));
          },
        });
        return { fileCount: 1, canonicalRevision: digest.digest('hex'), records };
      }

      throw new ValidationError(
        `${displayPath(directory)}: canonical input path is not a directory`,
        'INVALID_ROOT',
      );
    }

    throw error;
  }

  files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  const digest = createHash('sha256');
  const records = [];
  for (const filePath of files) {
    digest.update(path.relative(directory, filePath), 'utf8');
    digest.update(Buffer.from([0]));
    const fileRecords = await readJsonlFile(filePath, {
      onBytes: (bytes) => {
        digest.update(bytes);
        digest.update(Buffer.from([0]));
      },
    });
    for (const recordInfo of fileRecords) {
      records.push(recordInfo);
    }
  }

  return {
    fileCount: files.length,
    canonicalRevision: digest.digest('hex'),
    records,
  };
}

export async function validateCanonicalDirectory(
  directory = DEFAULT_CANONICAL_DIRECTORY,
) {
  const result = await readCanonicalRecords(directory);
  return { fileCount: result.fileCount, recordCount: result.records.length };
}

export async function main() {
  const summary = await validateCanonicalDirectory();

  if (summary.fileCount === 0) {
    console.log(
      'No canonical JSONL files found. Validated 0 files / 0 records. This does not indicate that dictionary data is complete.',
    );
    return;
  }

  console.log(
    `Validated ${summary.fileCount} canonical JSONL file(s) / ${summary.recordCount} record(s) with schema.`,
  );
}

const isMainModule =
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
