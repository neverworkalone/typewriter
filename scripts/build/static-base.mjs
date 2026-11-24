import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { createHash } from 'node:crypto';

import { buildDictionary } from './dictionary.mjs';
import { extractLiteDictionary } from './lite-dictionary.mjs';
import { buildShardSenseIdsFromCanonicalRecords } from './authored-relations.mjs';
import { projectRecordMeanings } from './record-meanings.mjs';
import { inputsDigest, traceInputs } from './build-inputs.mjs';
import { findEntry, publishEntry, touchEntry, verifyEntryFile } from './build-cache.mjs';
import { progressStage } from './dictionary-progress.mjs';
import { buildCanonicalIndex } from '../relation/admission.mjs';
import { loadCanonicalContext } from '../validate/canonical-context.mjs';
import { DEFAULT_CANONICAL_DIRECTORY } from '../validate/canonical-jsonl.mjs';
import { normalizeCanonicalDirectory } from '../normalize/canonical.mjs';

/**
 * Static Base (Issue #9931): everything the product dictionary derives from Canonical alone, built only when one of its
 * inputs changes.
 *
 *   base.sqlite      the verified Lite extraction of an STDICT-only Full build (no Approved Relations): every product
 *                    table, the STDICT/gloss/direct-reverse meaning relations and the empty packed tables;
 *   static-index.v8  what Approved Relation validation and projection need: the normalized records, the complete
 *                    Canonical index, source-shard Sense ownership and the record meanings.
 *
 * The temporary STDICT-only Full database exists only while a Base is generated and is deleted afterwards; it is the
 * only Full database the product build ever creates.
 */
export const BASE_DATABASE = 'base.sqlite';
export const BASE_INDEX = 'static-index.v8';

async function generate({ projectRoot, canonicalDirectory, recordMeanings, optimization, directory, exclude, roots, onProgress }) {
  return traceInputs(async () => {
    let finish = progressStage(onProgress, 'Static Base: Canonical loading and normalization');
    const context = await loadCanonicalContext({ directory: canonicalDirectory });
    const model = await normalizeCanonicalDirectory(canonicalDirectory, { canonicalContext: context });
    finish();
    finish = progressStage(onProgress, 'Static Base: STDICT-only Full build and verification');
    const fullPath = path.join(directory, 'stdict-only-full.sqlite');
    await buildDictionary({
      inputDirectory: canonicalDirectory,
      outputPath: fullPath,
      repositoryDirectory: projectRoot,
      // Provenance is bound per product build; the Base never carries a revision of its own.
      allowDirty: true,
      canonicalContext: context,
      normalizedModel: model,
      recordMeanings,
      relationsDirectory: path.join(directory, 'no-approved-relations'),
      onProgress,
    });
    finish();
    finish = progressStage(onProgress, 'Static Base: Lite extraction');
    await extractLiteDictionary({ fullPath, litePath: path.join(directory, BASE_DATABASE), optimization });
    await rm(fullPath, { force: true });
    finish();

    let shardSenseIds = null;
    let shardSenseIdsError = null;
    try {
      shardSenseIds = buildShardSenseIdsFromCanonicalRecords(context.records);
    } catch (error) {
      // Only an input with Approved Relations needs shard ownership; the Full builder fails the same way then.
      shardSenseIdsError = error.message;
    }
    // Same rule as the Full builder: the official Canonical always projects record meanings, fixtures opt in.
    const projected = recordMeanings ?? path.resolve(canonicalDirectory) === path.resolve(DEFAULT_CANONICAL_DIRECTORY);
    const index = {
      records: model.records,
      canonicalIndex: buildCanonicalIndex(model.records),
      shardSenseIds,
      shardSenseIdsError,
      projected,
      meanings: projected ? projectRecordMeanings(model.records) : [],
      canonicalRevision: context.canonicalRevision ?? null,
    };
    await writeFile(path.join(directory, BASE_INDEX), serialize(index));
    return index;
  }, { root: projectRoot, roots, exclude });
}

/**
 * The Static Base for the current inputs: a verified cache entry, or a fresh one (published when caching). Returns a
 * private copy of `base.sqlite` at `<workDirectory>/base.sqlite`, the loaded index and the Base's recorded inputs.
 */
export async function loadStaticBase({
  projectRoot,
  canonicalDirectory,
  recordMeanings,
  optimization,
  codeKey,
  cacheDirectory,
  cache,
  workDirectory,
  memo,
  exclude,
  roots = [],
  onProgress,
}) {
  const options = { canonicalDirectory: path.relative(projectRoot, canonicalDirectory), recordMeanings: recordMeanings ?? null, optimization };
  const privateBase = path.join(workDirectory, BASE_DATABASE);
  const accept = (manifest) => manifest.codeKey === codeKey && JSON.stringify(manifest.options) === JSON.stringify(options);

  if (cache) {
    const finish = progressStage(onProgress, 'Static Base: cache check');
    const found = await findEntry({ cacheDirectory, kind: 'base', root: projectRoot, memo, accept });
    if (found) {
      await copyFile(path.join(found.directory, BASE_DATABASE), privateBase);
      const indexBytes = await readFile(path.join(found.directory, BASE_INDEX)).catch(() => null);
      const indexDigest = indexBytes && createHash('sha256').update(indexBytes).digest('hex');
      if (await verifyEntryFile(found.manifest, BASE_DATABASE, privateBase) && indexDigest === found.manifest.files?.[BASE_INDEX]) {
        await touchEntry(found.directory);
        finish();
        console.log(`Static Base reused: ${path.basename(found.directory)}`);
        return { basePath: privateBase, index: deserialize(indexBytes), inputs: found.manifest.inputs };
      }
      await rm(found.directory, { recursive: true, force: true });
      console.log(`Static Base ${path.basename(found.directory)} failed its digest check; removed and regenerating.`);
    }
    finish();
  }

  const temporaryDirectory = path.join(workDirectory, 'base-entry');
  await mkdir(temporaryDirectory, { recursive: true });
  const { result: index, inputs } = await generate({
    projectRoot, canonicalDirectory, recordMeanings, optimization, directory: temporaryDirectory, exclude, roots, onProgress,
  });
  await copyFile(path.join(temporaryDirectory, BASE_DATABASE), privateBase);
  if (cache) {
    const id = createHash('sha256').update(`${codeKey}\0${JSON.stringify(options)}\0${inputsDigest(inputs)}`).digest('hex').slice(0, 32);
    const published = await publishEntry({
      cacheDirectory,
      kind: 'base',
      id,
      temporaryDirectory,
      manifest: { codeKey, options, inputs },
      fileNames: [BASE_DATABASE, BASE_INDEX],
    });
    console.log(published ? `Static Base generated and cached: base-${id}` : `Static Base generated (base-${id} already cached).`);
  } else {
    await rm(temporaryDirectory, { recursive: true, force: true });
    console.log('Static Base generated (build cache off).');
  }
  return { basePath: privateBase, index, inputs };
}
