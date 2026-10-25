import { appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_DIRECTORY = path.resolve(path.dirname(SCRIPT_PATH), '../..');

// Keep this list limited to files that own the actual SQLite DDL or its schema
// version. If a schema definition moves, --no-renames makes both paths visible;
// the new DDL path is rejected until this ownership list is updated.
export const SQLITE_SCHEMA_OWNER_PATHS = Object.freeze([
  'scripts/build/sqlite-schema.mjs',
]);

const SQL_COMMENT_PATTERN = '(?:/\\*[\\s\\S]*?\\*/|--[^\\r\\n]*(?:\\r?\\n|$))';
const SQL_TOKEN_GAP_PATTERN = '(?:\\s|' + SQL_COMMENT_PATTERN + ')+';
const SQL_TOKEN_GAP_OPTIONAL_PATTERN = '(?:\\s|' + SQL_COMMENT_PATTERN + ')*';
const SQL_CREATE_OBJECT_PATTERN = '(?:VIRTUAL' + SQL_TOKEN_GAP_PATTERN
  + 'TABLE|(?:UNIQUE' + SQL_TOKEN_GAP_PATTERN + ')?(?:TABLE|INDEX|VIEW|TRIGGER))';
const SQL_TEMP_KEYWORD_DDL_PREFIX_PATTERN = new RegExp(
  '\\bCREATE' + SQL_TOKEN_GAP_PATTERN
    + '(?:TEMP|TEMPORARY)' + SQL_TOKEN_GAP_PATTERN
    + SQL_CREATE_OBJECT_PATTERN + SQL_TOKEN_GAP_PATTERN
    + '(?:IF' + SQL_TOKEN_GAP_PATTERN + 'NOT' + SQL_TOKEN_GAP_PATTERN
    + 'EXISTS' + SQL_TOKEN_GAP_PATTERN + ')?[^\\s(;,]+',
  'giu',
);
const SQL_TEMP_SCHEMA_DDL_PREFIX_PATTERN = new RegExp(
  '\\bCREATE' + SQL_TOKEN_GAP_PATTERN
    + SQL_CREATE_OBJECT_PATTERN + SQL_TOKEN_GAP_PATTERN
    + '(?:IF' + SQL_TOKEN_GAP_PATTERN + 'NOT' + SQL_TOKEN_GAP_PATTERN
    + 'EXISTS' + SQL_TOKEN_GAP_PATTERN + ')?'
    + '(?:temp|"temp"|`temp`|\\[temp\\])' + SQL_TOKEN_GAP_OPTIONAL_PATTERN + '\\.[^\\s(;,]+',
  'giu',
);
const SQL_SCHEMA_DEFINITION_PATTERN = new RegExp(
  '\\b(?:CREATE' + SQL_TOKEN_GAP_PATTERN
    + '(?:VIRTUAL' + SQL_TOKEN_GAP_PATTERN + 'TABLE|(?:UNIQUE' + SQL_TOKEN_GAP_PATTERN
    + ')?(?:TABLE|INDEX|VIEW|TRIGGER))|ALTER' + SQL_TOKEN_GAP_PATTERN
    + 'TABLE|DROP' + SQL_TOKEN_GAP_PATTERN + '(?:TABLE|INDEX|VIEW|TRIGGER)|UPDATE'
    + SQL_TOKEN_GAP_PATTERN + '(?:(?:main)' + SQL_TOKEN_GAP_PATTERN + '\\.'
    + SQL_TOKEN_GAP_PATTERN + ')?sqlite_(?:schema|master))\\b',
  'iu',
);
const SQL_SCHEMA_GREP_PATTERN = '(CREATE|ALTER|DROP|UPDATE)';

function containsSqlSchemaMutation(text) {
  const persistentSchemaText = text
    .replace(SQL_TEMP_KEYWORD_DDL_PREFIX_PATTERN, '')
    .replace(SQL_TEMP_SCHEMA_DDL_PREFIX_PATTERN, '');
  return SQL_SCHEMA_DEFINITION_PATTERN.test(persistentSchemaText);
}

function decodeGitText(value, label) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label}: Git returned a non-UTF-8 path or value.`);
  }
}

function runGit(args, repositoryDirectory, { allowNoMatch = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: repositoryDirectory,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    if (allowNoMatch && error?.status === 1) return Buffer.alloc(0);
    const detail = Number.isInteger(error?.status)
      ? `status=${error.status}`
      : typeof error?.code === 'string' ? `code=${error.code}` : 'process-failure';
    throw new Error(`git ${args[0]} failed (${detail}).`);
  }
}

function validateSha(value, name) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new TypeError(`${name} must be a full lowercase 40-character Git SHA.`);
  }
}

function nulPaths(bytes, label) {
  const text = decodeGitText(bytes, label);
  if (text.length === 0) return [];
  if (!text.endsWith('\0')) throw new Error(`${label}: Git path output was not NUL-terminated.`);
  return text.slice(0, -1).split('\0');
}

function schemaPathsAtRevision(revision, repositoryDirectory) {
  const output = runGit([
    'grep', '-I', '-l', '-z', '-i', '-E', SQL_SCHEMA_GREP_PATTERN,
    revision, '--', 'scripts', 'src',
    ':(exclude,glob)**/*.test.*',
    ':(exclude,glob)**/*.spec.*',
  ], repositoryDirectory, { allowNoMatch: true });
  const candidates = nulPaths(output, `SQL schema owner scan at ${revision}`)
    .map((value) => value.startsWith(`${revision}:`) ? value.slice(revision.length + 1) : value)
    .sort();
  return candidates.filter((filePath) => {
    const bytes = runGit(['show', `${revision}:${filePath}`], repositoryDirectory);
    return containsSqlSchemaMutation(decodeGitText(bytes, `${revision}:${filePath}`));
  });
}

function changedFileContainsSchemaSql(filePath, revision, repositoryDirectory) {
  // Test suites may create temporary SQLite fixture tables. Those fixtures
  // are not production schema owners and must not select the product build.
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(filePath)) return false;
  try {
    const bytes = runGit(['show', `${revision}:${filePath}`], repositoryDirectory);
    return containsSqlSchemaMutation(decodeGitText(bytes, `${revision}:${filePath}`));
  } catch (error) {
    // A path absent at a revision is expected for additions and deletions. The
    // exact diff already validates both revisions and the other side is checked.
    if (/git show failed \(status=128\)/u.test(error.message)) return false;
    throw error;
  }
}

/**
 * Classify an exact BASE...HEAD diff for the dedicated SQL schema build gate.
 * The path diff disables rename detection so deleted/moved owners remain
 * visible. Unknown source files containing SQL DDL fail closed.
 */
export function classifySqliteSchemaDiff(baseSha, headSha, {
  repositoryDirectory = REPOSITORY_DIRECTORY,
  runCommand = runGit,
  ownerPaths = SQLITE_SCHEMA_OWNER_PATHS,
} = {}) {
  validateSha(baseSha, 'baseSha');
  validateSha(headSha, 'headSha');
  const diffBytes = runCommand([
    'diff', '--no-renames', '--name-only', '-z', `${baseSha}...${headSha}`,
  ], repositoryDirectory);
  const changedPaths = nulPaths(diffBytes, 'exact SQL schema diff');
  const owners = new Set(ownerPaths);

  for (const pathValue of schemaPathsAtRevision(headSha, repositoryDirectory)) {
    if (!owners.has(pathValue)) {
      throw new Error(`Unregistered SQL schema owner in HEAD: ${pathValue}`);
    }
  }

  for (const pathValue of changedPaths) {
    if (owners.has(pathValue)) continue;
    if (
      changedFileContainsSchemaSql(pathValue, baseSha, repositoryDirectory)
      || changedFileContainsSchemaSql(pathValue, headSha, repositoryDirectory)
    ) {
      throw new Error(`Changed SQL schema definition has no registered owner: ${pathValue}`);
    }
  }

  return Object.freeze({
    schemaChanged: changedPaths.some((pathValue) => owners.has(pathValue)),
    changedPathCount: changedPaths.length,
    changedSchemaOwnerPaths: changedPaths.filter((pathValue) => owners.has(pathValue)),
    schemaOwnerPaths: [...owners],
  });
}

async function writeWorkflowOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) await appendFile(outputPath, `${name}=${value}\n`, 'utf8');
}

export async function runCli(argv = process.argv.slice(2)) {
  const [baseSha, headSha] = argv;
  if (argv.length !== 2) {
    throw new Error('Usage: node scripts/ci/sqlite-schema-change.mjs <base-sha> <head-sha>');
  }
  const result = classifySqliteSchemaDiff(baseSha, headSha);
  await writeWorkflowOutput('schema_changed', String(result.schemaChanged));
  await writeWorkflowOutput('schema_changed_path_count', String(result.changedSchemaOwnerPaths.length));
  console.log(JSON.stringify(result, null, 2));
  console.log(
    result.schemaChanged
      ? 'SQL schema owner changed: the schema-only Full/Lite build gate must run.'
      : 'No registered SQL schema owner changed: the schema-only Full/Lite build gate is not required.',
  );
}

if (path.resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  runCli().catch((error) => {
    console.error(`SQL schema change classification failed closed: ${error.message}`);
    process.exitCode = 1;
  });
}
