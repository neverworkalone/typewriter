import { copyFile, mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { BuildError, verifyDatabase } from './dictionary.mjs';
import { assertDatabaseKind, writePackedTextRelations } from './lite-dictionary.mjs';
import { LITE_OPTIMIZATION } from './dictionary-config.mjs';
import {
  listApprovedRelationFiles,
  projectAuthoredRelations,
  scanApprovedRelationFiles,
  validateScannedApprovedRelations,
} from './authored-relations.mjs';
import { codeFingerprint, inputsDigest, traceInputs } from './build-inputs.mjs';
import { MANIFEST_NAME, cacheEnabled, createWorkDirectory, findEntry, publishEntry, touchEntry, verifyEntryFile } from './build-cache.mjs';
import { loadStaticBase } from './static-base.mjs';
import { progressStage } from './dictionary-progress.mjs';
import { resolveBuildProvenance } from './provenance.mjs';
import { DATABASE_KINDS, MEANING_RELATION_ORIGINS } from '../../src/runtime/dictionary-contract.js';
import { encodePackedRelations, meaningNumber } from '../../src/runtime/packed-relations.js';
import { validatePackedStorage } from '../../src/runtime/dictionary-validation.js';
import { DEFAULT_CANONICAL_DIRECTORY } from '../validate/canonical-jsonl.mjs';

/**
 * Direct Lite build (Issue #9931): the product (Lite) dictionary straight from a verified Static Base plus the current
 * Approved Relations, without a Full database.
 *
 *   Lite cache hit   (same code, Canonical, Approved Relations and every other recorded input): nothing is parsed,
 *                    validated, projected or packed; the verified cached Lite is only bound to the current provenance.
 *   Lite cache miss  Static Base (cached or regenerated) -> Approved Relation scan + validation -> authored projection
 *                    -> source-bound checks -> packing -> Lite verification -> VACUUM -> cache publication.
 *
 * Only a Lite that passed every check is published. The cached Lite carries placeholder provenance; `finalize` binds
 * the current provenance in place (metadata only), for a fresh build and a cache hit alike, so both give identical
 * bytes. `TYPEWRITER_BUILD_CACHE=off` neither reads nor writes the cache.
 */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DIRECT_LITE_ENTRY = 'scripts/build/direct-lite.mjs';
export const DEFAULT_BUILD_CACHE_DIRECTORY = path.join(PROJECT_ROOT, 'artifacts/build-cache');
const LITE_DATABASE = 'lite.sqlite';
/** Metadata bound per product build; everything else in a cached Lite is a pure function of its recorded inputs. */
export const PROVENANCE_KEYS = Object.freeze(['source_revision', 'source_revision_source', 'source_revision_verified', 'worktree_state']);
const UNBOUND = 'unbound';
const RELATION_COLUMNS = 'source_meaning_id, position, target_meaning_id, type, note, relevance, origin';

function sourceBoundError(message) {
  return new BuildError(`Direct Lite source-bound check failed: ${message}`, 'DIRECT_LITE_SOURCE_BOUND');
}

function readMetadata(database) {
  return Object.fromEntries(database.prepare('SELECT key, value FROM metadata ORDER BY key').all().map(({ key, value }) => [key, value]));
}

function setMetadata(database, values) {
  const update = database.prepare('UPDATE metadata SET value = ? WHERE key = ?');
  for (const [key, value] of Object.entries(values)) {
    if (Number(update.run(String(value), key).changes) !== 1) {
      throw new BuildError(`Lite metadata ${key} is missing from the Static Base`, 'DIRECT_LITE_METADATA');
    }
  }
}

/**
 * Write the authored ID and text relations into the private Base copy and prove, against the Base's own
 * `meaning_members` (not the projection's map), the contract the Full provenance tables prove: every approved ID row
 * reaches exactly one forward and one reverse entry whose Senses belong to the relation's source and target meanings,
 * every kept relation has its kept contributor with matching origin/type/tier, deduplicated rows have the same
 * pair/type and no better tier, authored positions follow the STDICT ones, and every approved text row is kept or a
 * duplicate of a kept `(meaning, text, type)` with no better tier.
 */
function writeAuthoredRelations(lite, { approved, authored, meanings, layout }) {
  const memberMeaning = new Map(lite.prepare('SELECT sense_id, meaning_id FROM meaning_members').all().map(({ sense_id: sense, meaning_id: meaning }) => [sense, meaning]));
  const staticNext = new Map();
  for (const { source, position } of lite.prepare('SELECT source_meaning_id AS source, MAX(position) AS position FROM meaning_relations GROUP BY source_meaning_id').all()) {
    staticNext.set(source, Number(position) + 1);
  }
  const { senseIds, types } = approved ?? { senseIds: [], types: [] };
  const id = approved?.id ?? { source: [], target: [], type: [], relevance: [] };
  const text = approved?.text ?? { source: [], values: [], type: [], relevance: [] };

  const insertPacked = layout.idCompression ? lite.prepare('INSERT INTO packed_meaning_relations(source, data) VALUES (?, ?)') : null;
  const insertPlain = layout.idCompression ? null : lite.prepare(`INSERT INTO meaning_relations (${RELATION_COLUMNS}) VALUES (?, ?, ?, ?, '', ?, ?)`);
  const seen = new Uint8Array(id.source.length);
  let contributions = 0;
  authored.forEachSourceGroup((sourceIndex, relations, entries) => {
    const source = meanings[sourceIndex].id;
    const byPosition = new Map();
    const first = staticNext.get(source) ?? 0;
    for (const relation of relations) {
      if (byPosition.has(relation.position) || relation.position < first) throw sourceBoundError(`${source} position ${relation.position} is reused`);
      byPosition.set(relation.position, { ...relation, kept: false });
    }
    for (const entry of entries) {
      const relation = byPosition.get(entry.position);
      if (!relation) throw sourceBoundError(`${source} position ${entry.position} has no relation`);
      const forwardSense = senseIds[id.source[entry.row]];
      const reverseSense = senseIds[id.target[entry.row]];
      const [from, to] = entry.reverse ? [reverseSense, forwardSense] : [forwardSense, reverseSense];
      if (memberMeaning.get(from) !== source || memberMeaning.get(to) !== meanings[relation.target].id) {
        throw sourceBoundError(`${from} -> ${to} is not bound to ${source} -> ${meanings[relation.target].id}`);
      }
      if (types[id.type[entry.row]] !== relation.type) throw sourceBoundError(`${source} position ${entry.position} type differs from its approved row`);
      if (entry.sourcePosition === 0) {
        const origin = entry.reverse ? MEANING_RELATION_ORIGINS.authoredReverse : MEANING_RELATION_ORIGINS.authored;
        if (relation.kept || relation.origin !== origin || relation.relevance !== id.relevance[entry.row]) {
          throw sourceBoundError(`${source} position ${entry.position} does not match its kept approved row`);
        }
        relation.kept = true;
      } else if (id.relevance[entry.row] < relation.relevance) {
        throw sourceBoundError(`${source} position ${entry.position} keeps a lower tier than a contributing row`);
      }
      const bit = entry.reverse ? 2 : 1;
      if (seen[entry.row] & bit) throw sourceBoundError(`approved row ${entry.row} reaches ${entry.reverse ? 'reverse' : 'forward'} twice`);
      seen[entry.row] |= bit;
      contributions += 1;
    }
    for (const relation of byPosition.values()) {
      if (!relation.kept) throw sourceBoundError(`${source} position ${relation.position} has no kept approved row`);
    }
    if (insertPacked) {
      insertPacked.run(meaningNumber(source), encodePackedRelations(relations.map((relation) => ({
        position: relation.position, target: meaningNumber(meanings[relation.target].id), type: relation.type,
        relevance: relation.relevance, origin: relation.origin, note: '',
      }))));
    } else {
      for (const relation of relations) {
        insertPlain.run(source, relation.position, meanings[relation.target].id, relation.type, relation.relevance, relation.origin);
      }
    }
  });
  for (let row = 0; row < seen.length; row += 1) {
    if (seen[row] !== 3) throw sourceBoundError(`approved ID row ${row} does not reach both directions`);
  }
  const idDeduplicated = contributions - authored.relationCount;

  // Text relations: kept rows are unique per (meaning, text, type) with positions 0..n-1 per meaning.
  const kept = new Map();
  const nextTextPosition = new Map();
  for (const relation of authored.textRelations) {
    const key = `${relation.source_meaning_id}\0${relation.text}\0${relation.type}`;
    if (kept.has(key)) throw sourceBoundError(`text relation ${key} is kept twice`);
    if (relation.position !== (nextTextPosition.get(relation.source_meaning_id) ?? 0)) throw sourceBoundError(`text positions of ${relation.source_meaning_id} are not contiguous`);
    nextTextPosition.set(relation.source_meaning_id, relation.position + 1);
    kept.set(key, relation.relevance);
  }
  for (let row = 0; row < text.source.length; row += 1) {
    const meaning = memberMeaning.get(senseIds[text.source[row]]);
    const relevance = kept.get(`${meaning}\0${text.values[row]}\0${types[text.type[row]]}`);
    if (relevance === undefined || relevance > text.relevance[row]) throw sourceBoundError(`approved text row ${row} has no kept relation`);
  }
  const textDeduplicated = text.source.length - authored.textRelations.length;
  if (idDeduplicated + textDeduplicated !== authored.stats.authored_deduplicated_count) {
    throw sourceBoundError('deduplicated row count does not match the projection');
  }

  const textRows = [...authored.textRelations].sort((left, right) => (left.source_meaning_id < right.source_meaning_id ? -1
    : left.source_meaning_id > right.source_meaning_id ? 1 : left.position - right.position));
  if (layout.textCompression) {
    writePackedTextRelations(lite, textRows);
  } else {
    const insert = lite.prepare('INSERT INTO meaning_text_relations (source_meaning_id, position, text, type, relevance) VALUES (?, ?, ?, ?, ?)');
    for (const row of textRows) insert.run(row.source_meaning_id, row.position, row.text, row.type, row.relevance);
  }
}

/** Approved Relations -> verified, VACUUMed, provenance-free Lite at `litePath` (a private copy of the Base). */
async function buildLite({ litePath, base, relationFiles, layout, onProgress }) {
  const { index } = base;
  let finish = progressStage(onProgress, 'Approved relation loading');
  const approved = relationFiles.length > 0 ? await scanApprovedRelationFiles(relationFiles, { collect: index.projected }) : undefined;
  finish();

  const lite = new DatabaseSync(litePath);
  try {
    lite.exec('PRAGMA foreign_keys = ON;');
    lite.exec('BEGIN IMMEDIATE;');
    if (index.projected) {
      if (approved) {
        if (!index.shardSenseIds) throw new BuildError(index.shardSenseIdsError, 'BUILD_ERROR');
        finish = progressStage(onProgress, 'Approved relation validation');
        await validateScannedApprovedRelations(approved, { index: index.canonicalIndex, shardSenseIds: index.shardSenseIds });
        finish();
      }
      finish = progressStage(onProgress, 'Authored relation projection, source checks and packing');
      const existing = lite.prepare('SELECT source_meaning_id, position, target_meaning_id, type FROM meaning_relations').all();
      const authored = projectAuthoredRelations({ approved, meanings: index.meanings, existing });
      writeAuthoredRelations(lite, { approved, authored, meanings: index.meanings, layout });
      const metadata = readMetadata(lite);
      setMetadata(lite, {
        meaning_relation_count: Number(metadata.meaning_relation_count) + authored.relationCount,
        meaning_text_relation_count: authored.textRelations.length,
        ...Object.fromEntries(Object.entries(authored.stats).map(([key, value]) => [`meaning_projection_${key}`, value])),
      });
      finish();
    }
    setMetadata(lite, Object.fromEntries(PROVENANCE_KEYS.map((key) => [key, UNBOUND])));
    lite.exec('COMMIT;');

    finish = progressStage(onProgress, 'Lite verification and VACUUM');
    verifyDatabase(lite);
    const packed = validatePackedStorage(lite, layout);
    const metadata = readMetadata(lite);
    const count = (table) => Number(lite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
    if (Number(metadata.meaning_relation_count) !== count('meaning_relations') + packed.idRelations
      || Number(metadata.meaning_text_relation_count) !== (layout.textCompression ? 0 : count('meaning_text_relations')) + packed.textRelations) {
      throw new BuildError('Direct Lite relation counts do not match its metadata', 'DIRECT_LITE_METADATA');
    }
    assertDatabaseKind(lite, DATABASE_KINDS.lite, 'Direct Lite dictionary');
    lite.exec('VACUUM;');
    finish();
    return metadata;
  } catch (error) {
    try { lite.exec('ROLLBACK;'); } catch {}
    throw error;
  } finally {
    lite.close();
  }
}

/**
 * Bind the current provenance to a copy of a verified provenance-free Lite and move it to `outputPath`. Only the
 * provenance metadata rows change; every other metadata value must equal `expectedMetadata`.
 */
async function finalize({ sourcePath, outputPath, expectedMetadata, provenance }) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp-${process.pid}`;
  await copyFile(sourcePath, temporary);
  try {
    const database = new DatabaseSync(temporary);
    try {
      database.exec('BEGIN IMMEDIATE;');
      setMetadata(database, Object.fromEntries(PROVENANCE_KEYS.map((key) => [key, provenance[key]])));
      database.exec('COMMIT;');
      const actual = readMetadata(database);
      const expected = { ...expectedMetadata, ...Object.fromEntries(PROVENANCE_KEYS.map((key) => [key, String(provenance[key])])) };
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new BuildError('Lite metadata changed beyond provenance while binding it', 'DIRECT_LITE_METADATA');
      }
    } finally {
      database.close();
    }
    await rename(temporary, outputPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Build `outputPath` (the product Lite dictionary). Returns `{ outputPath, cache: 'hit' | 'miss' | 'off', metadata }`.
 */
export async function buildProductDictionary({
  projectRoot = PROJECT_ROOT,
  canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  relationsDirectory,
  recordMeanings,
  outputPath,
  allowDirty = false,
  optimization = LITE_OPTIMIZATION,
  cache = cacheEnabled(),
  cacheDirectory = DEFAULT_BUILD_CACHE_DIRECTORY,
  onProgress,
}) {
  projectRoot = path.resolve(projectRoot);
  const resolvedCanonical = path.resolve(canonicalDirectory);
  const isDefault = resolvedCanonical === path.resolve(DEFAULT_CANONICAL_DIRECTORY);
  const resolvedRelations = relationsDirectory ? path.resolve(relationsDirectory) : (isDefault ? path.join(projectRoot, 'data/relations') : null);
  const layout = Object.freeze({ idCompression: optimization.idCompression, textCompression: optimization.textCompression });
  const resolvedOutput = path.resolve(outputPath);
  const resolvedCache = path.resolve(cacheDirectory);

  // Provenance first: a dirty worktree fails before any work, exactly as before.
  const provenance = await resolveBuildProvenance({ repositoryDirectory: projectRoot, allowDirty });
  let finish = progressStage(onProgress, 'Build input fingerprint');
  const codeKey = await codeFingerprint({ projectRoot, entryPoints: [path.join(PROJECT_ROOT, DIRECT_LITE_ENTRY)] });
  const options = {
    canonicalDirectory: path.relative(projectRoot, resolvedCanonical),
    relationsDirectory: resolvedRelations && path.relative(projectRoot, resolvedRelations),
    recordMeanings: recordMeanings ?? null,
    layout,
  };
  const accept = (manifest) => manifest.codeKey === codeKey && JSON.stringify(manifest.options) === JSON.stringify(options);
  const memo = new Map();
  const workDirectory = await createWorkDirectory(resolvedCache, cache);
  const exclude = [resolvedCache, resolvedOutput, `${resolvedOutput}.tmp-${process.pid}`, path.join(projectRoot, 'node_modules'), path.join(projectRoot, '.git')];
  const roots = [resolvedCanonical, ...(resolvedRelations ? [resolvedRelations] : [])];
  try {
    const privateLite = path.join(workDirectory, LITE_DATABASE);
    if (cache) {
      const found = await findEntry({ cacheDirectory: resolvedCache, kind: 'lite', root: projectRoot, memo, accept });
      if (found) {
        await copyFile(path.join(found.directory, LITE_DATABASE), privateLite);
        if (await verifyEntryFile(found.manifest, LITE_DATABASE, privateLite)) {
          await touchEntry(found.directory);
          finish();
          finish = progressStage(onProgress, 'Lite cache hit: provenance binding');
          await finalize({ sourcePath: privateLite, outputPath: resolvedOutput, expectedMetadata: found.manifest.metadata, provenance });
          finish();
          console.log(`Product (Lite) dictionary reused from ${path.basename(found.directory)}.`);
          return { outputPath: resolvedOutput, cache: 'hit', metadata: found.manifest.metadata };
        }
        // A corrupted entry is removed so the rebuilt one can take its place; other readers verify their own copies.
        await rm(found.directory, { recursive: true, force: true });
        console.log(`Lite cache ${path.basename(found.directory)} failed its digest check; removed and rebuilding.`);
      }
    }
    finish();

    const { result: built, inputs: liteInputs } = await traceInputs(async () => {
      const base = await loadStaticBase({
        projectRoot, canonicalDirectory: resolvedCanonical, recordMeanings, optimization: layout, codeKey,
        cacheDirectory: resolvedCache, cache, workDirectory, memo, exclude, roots, onProgress,
      });
      await rename(base.basePath, privateLite);
      const relationFiles = listApprovedRelationFiles(resolvedRelations);
      const metadata = await buildLite({ litePath: privateLite, base, relationFiles, layout, onProgress });
      return { metadata, baseInputs: base.inputs };
    }, { root: projectRoot, roots, exclude });

    // Bind provenance from our own verified file before (possibly) publishing it.
    await finalize({ sourcePath: privateLite, outputPath: resolvedOutput, expectedMetadata: built.metadata, provenance });
    if (cache) {
      const merged = new Map();
      for (const input of [...built.baseInputs, ...liteInputs]) merged.set(`${input.kind}\0${input.path}`, input);
      const inputs = [...merged.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : left.kind < right.kind ? -1 : 1));
      const id = createHash('sha256').update(`${codeKey}\0${JSON.stringify(options)}\0${inputsDigest(inputs)}`).digest('hex').slice(0, 32);
      const entryDirectory = path.join(workDirectory, 'lite-entry');
      await mkdir(entryDirectory);
      await rename(privateLite, path.join(entryDirectory, LITE_DATABASE));
      const published = await publishEntry({
        cacheDirectory: resolvedCache, kind: 'lite', id, temporaryDirectory: entryDirectory,
        manifest: { codeKey, options, inputs, metadata: built.metadata }, fileNames: [LITE_DATABASE],
      });
      console.log(published ? `Product (Lite) dictionary built and cached: lite-${id}` : 'Product (Lite) dictionary built.');
    } else {
      console.log('Product (Lite) dictionary built (build cache off).');
    }
    return { outputPath: resolvedOutput, cache: cache ? 'miss' : 'off', metadata: built.metadata };
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

export { MANIFEST_NAME };

/** Read a published entry manifest (tests and tooling). */
export async function readEntryManifest(directory) {
  return JSON.parse(await readFile(path.join(directory, MANIFEST_NAME), 'utf8'));
}
