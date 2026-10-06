import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  assertLiteraturePermission,
  buildFullLiteratureIndex,
  buildLiteratureIndex,
  DEFAULT_FULL_LITERATURE_INDEX_PATH,
  DEFAULT_FULL_LITERATURE_MANIFEST_PATH,
  DEFAULT_LITERATURE_INDEX_PATH,
  DEFAULT_LITERATURE_INPUT_DIRECTORY,
  DEFAULT_LITERATURE_MANIFEST_PATH,
  inventoryLiterature,
  literatureManifestDigest,
  readLiteratureManifest,
  selectLiteraturePilotSample,
  verifyFullLiteratureIndex,
  verifyLiteratureIndex,
} from './literature-index.mjs';

const USAGE = `Usage: node scripts/reference/build-literature-index.mjs <command> [options]
  select  [--input <dir>] [--manifest <path>] [--per-genre <3-5>]  inventory all TXT, write the pilot manifest (local-only)
  build   [--input <dir>] [--manifest <path>] [--output <path>]    build the pilot DB from the manifest works only
  verify  [--input <dir>] [--output <path>]                        compare stored works with current decoded TXT
  full-build  [--input <dir>] [--manifest <path>] [--output <path>]  inventory all TXT, build the full DB from every ok|warning file (atomic)
  full-verify [--input <dir>] [--manifest <path>] [--output <path>]  verify the full DB, manifest binding and exact reconstruction`;

function parseOptions(argumentsList, full = false) {
  const options = {
    input: DEFAULT_LITERATURE_INPUT_DIRECTORY,
    manifest: DEFAULT_LITERATURE_MANIFEST_PATH,
    output: DEFAULT_LITERATURE_INDEX_PATH,
    perGenre: 4,
  };
  if (full) {
    options.manifest = DEFAULT_FULL_LITERATURE_MANIFEST_PATH;
    options.output = DEFAULT_FULL_LITERATURE_INDEX_PATH;
  }
  const names = { '--input': 'input', '--manifest': 'manifest', '--output': 'output', '--per-genre': 'perGenre' };
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = names[argumentsList[index]];
    const value = argumentsList[index + 1];
    if (!name || !value || value.startsWith('--')) {
      throw new Error('Invalid or incomplete option: ' + argumentsList[index]);
    }
    options[name] = name === 'perGenre' ? Number(value) : path.resolve(value);
  }
  return options;
}

try {
  const [command, ...rest] = process.argv.slice(2);
  if (!['select', 'build', 'verify', 'full-build', 'full-verify'].includes(command)) {
    console.log(USAGE);
    process.exitCode = command === undefined || command === '--help' ? 0 : 1;
  } else {
    const options = parseOptions(rest, command.startsWith('full-'));
    await assertLiteraturePermission();
    if (command === 'full-build') {
      console.log(JSON.stringify(await buildFullLiteratureIndex({
        inputDirectory: options.input,
        outputPath: options.output,
        manifestPath: options.manifest,
      }), null, 2));
    } else if (command === 'full-verify') {
      const result = await verifyFullLiteratureIndex({
        inputDirectory: options.input,
        databasePath: options.output,
        manifestPath: options.manifest,
      });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    } else if (command === 'select') {
      const inventory = await inventoryLiterature({ inputDirectory: options.input });
      const sample = selectLiteraturePilotSample(inventory, options.perGenre);
      const byStatus = {};
      for (const file of inventory) {
        const key = file.genre + ':' + file.status + (file.error ? ':' + file.error : '');
        byStatus[key] = (byStatus[key] ?? 0) + 1;
      }
      await mkdir(path.dirname(options.manifest), { recursive: true });
      await writeFile(options.manifest, JSON.stringify({
        input_manifest_sha256: literatureManifestDigest(sample),
        works: sample.map(({ genre, relative_path, source_bytes, source_sha256, encoding, selection_rule }) => ({
          genre, relative_path, source_bytes, source_sha256, encoding, selection_rule,
        })),
      }, null, 2) + '\n');
      console.log(JSON.stringify({ inventoried: inventory.length, selected: sample.length, byStatus }, null, 2));
    } else if (command === 'build') {
      const relativePaths = await readLiteratureManifest(options.manifest);
      console.log(JSON.stringify(await buildLiteratureIndex({
        inputDirectory: options.input,
        outputPath: options.output,
        relativePaths,
      }), null, 2));
    } else {
      const results = await verifyLiteratureIndex({ inputDirectory: options.input, databasePath: options.output });
      console.log(JSON.stringify(results, null, 2));
      if (results.some((result) => !result.source_unchanged || !result.text_identical)) process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
