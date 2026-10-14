import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { convertCodes, countBy, loadStdictSource } from './build-shard.mjs';
import { flattenSenses, mapPos } from './convert.mjs';
import { classifySense } from './policy.mjs';

const DEFAULT_SETTLEMENT = 'data/provenance/stdict-settlement.json';
const sourcePosOf = (info, sourcePos) => (info.word_unit === '단어' ? (sourcePos ?? '품사 없음') : `${info.word_unit}(${info.word_unit})`);

/**
 * Whole-source accounting: every source entry and sense lands in exactly one of included / excluded (by policy
 * reason) / held, so no loss is unexplained. Aggregates only; no source text.
 */
export async function settle({ source }) {
  const senseRows = [];
  const entryRows = [];
  for (const [code, item] of source.itemsByCode) {
    const info = item.word_info;
    const entry = source.index.entries.get(code);
    const verdicts = flattenSenses(item).map(({ sense, sourcePos }) => ({
      sourcePos: sourcePosOf(info, sourcePos),
      verdict: classifySense({ word: info.word, wordUnit: info.word_unit, sourcePos, definition: sense.definition }),
      pos: mapPos(sourcePos, info.word_unit),
    }));
    const eligible = entry.included > 0 && !entry.held;
    entryRows.push({
      code,
      unit: info.word_unit,
      status: entry.held ? 'held' : eligible ? 'included' : 'excluded',
      shape: eligible ? ([...new Set(verdicts.filter(({ verdict }) => verdict.include).map(({ sourcePos }) => sourcePos))].length > 1 ? 'multi-pos' : 'single-pos') : null,
      partial: eligible && verdicts.some(({ verdict }) => !verdict.include),
      excludedReasons: [...new Set(verdicts.filter(({ verdict }) => !verdict.include).map(({ verdict }) => verdict.reason))],
    });
    for (const { sourcePos, verdict, pos } of verdicts) {
      senseRows.push({
        sourcePos,
        status: !verdict.include ? 'excluded' : entry.held ? 'held' : 'included',
        reason: verdict.reason ?? null,
        pos: pos ?? 'unsupported',
      });
    }
  }
  const everything = convertCodes(source, source.shards.flat(), { isSelected: () => true });
  const held = [...source.index.entries]
    .filter(([, entry]) => entry.held)
    .map(([code]) => code);
  const cleaned = countBy(everything.markupReport, (row) => row.markup);
  return {
    contract: 'stdict-settlement-v1',
    source: { file_count: source.sourceFiles, entry_count: source.sourceEntryCount, sense_count: senseRows.length },
    entries: {
      by_status: countBy(entryRows, ({ status }) => status),
      included_by_unit: countBy(entryRows.filter(({ status }) => status === 'included'), ({ unit }) => unit),
      included_by_shape: countBy(entryRows.filter(({ status }) => status === 'included'), ({ shape }) => shape),
      included_with_excluded_senses: entryRows.filter(({ partial }) => partial).length,
      excluded_by_reason: countBy(entryRows.filter(({ status }) => status === 'excluded'), ({ excludedReasons }) => excludedReasons.join('+')),
      held_target_codes: held,
    },
    senses: {
      by_status: countBy(senseRows, ({ status }) => status),
      included_by_pos: countBy(senseRows.filter(({ status }) => status === 'included'), ({ pos }) => pos),
      included_by_source_pos: countBy(senseRows.filter(({ status }) => status === 'included'), ({ sourcePos }) => sourcePos),
      excluded_by_reason: countBy(senseRows.filter(({ status }) => status === 'excluded'), ({ reason }) => reason),
      excluded_by_reason_and_source_pos: countBy(senseRows.filter(({ status }) => status === 'excluded'), ({ reason, sourcePos }) => `${reason}:${sourcePos}`),
    },
    roots: {
      by_status: countBy(source.index.rootReport, ({ status }) => status),
      alias_target_records: source.index.aliasesByTarget.size,
      alias_forms: [...source.index.aliasesByTarget.values()].reduce((sum, forms) => sum + forms.length, 0),
    },
    relations_all_targets_loaded: countBy(everything.relationReport, (row) => `${row.source_type}:${row.status}`),
    definition_markup_cleaned: cleaned,
    shards: {
      count: source.shards.length,
      sizes: { first: source.shards[0].length, last: source.shards.at(-1).length, full: source.shards.slice(0, -1).every((codes) => codes.length === source.shards[0].length) },
      held_after_conversion: everything.held.length,
    },
    reconciliation: {
      source_inventory: source.sourceFiles === source.inventory.file_count && source.sourceEntryCount === source.inventory.entry_count
        && senseRows.length === source.inventory.sense_count,
      entries: entryRows.length === source.sourceEntryCount
        && entryRows.length === Object.values(countBy(entryRows, ({ status }) => status)).reduce((sum, value) => sum + value, 0),
      senses: everything.conversions.reduce((sum, row) => sum + row.kept_senses, 0)
        === senseRows.filter(({ status }) => status !== 'excluded').length,
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 ? args[at + 1] : fallback;
  };
  const file = path.resolve(option('out', DEFAULT_SETTLEMENT));
  const source = await loadStdictSource({ sourceDirectory: option('source', path.join(os.homedir(), '.cache/typewriter/dict/stdict')) });
  const text = `${JSON.stringify(await settle({ source }), null, 1)}\n`;
  if (args.includes('--verify')) {
    if (await readFile(file, 'utf8').catch(() => null) !== text) throw new Error('regenerated STDICT settlement differs from the committed file');
    console.log('verified settlement, byte-identical');
    return;
  }
  await writeFile(file, text);
  console.log(`wrote ${path.relative('.', file)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
