import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateCanonicalRecord } from '../validate/canonical-jsonl.mjs';
import {
  STDICT_SHARD_SIZE,
  addToSenseIndex,
  convertItem,
  createSenseIndex,
  finalizeSenseIndex,
  flattenSenses,
  mapPos,
  readStdictItems,
  recordIdFor,
  serializeRecord,
  surfaceForms,
} from './convert.mjs';

export const SELECTION_VERSION = 'stdict-selection-v2';
/** Hash order of the 1,000-record pilot; the first shard keeps every pilot record that the inclusion policy still admits. */
const PILOT_SELECTION_VERSION = 'stdict-pilot-selection-v1';
const DEFAULT_SOURCE = path.join(os.homedir(), '.cache/typewriter/dict/stdict');

const hashOf = (targetCode) => createHash('sha256')
  .update(`${PILOT_SELECTION_VERSION}:${targetCode}`)
  .digest('hex');

/** One compact summary per source entry; everything selection needs. */
function summarize(item) {
  const info = item.word_info;
  const flat = flattenSenses(item);
  const sourcePos = [...new Set((info.pos_info ?? []).map((posInfo) => posInfo.pos ?? '품사 없음'))];
  const links = { 동의어: [], 반대말: [] };
  let brokenLink = false;
  for (const { sense } of flat) {
    for (const link of sense.lexical_info ?? []) {
      if (links[link.type] && link.unit === '의미') links[link.type].push(Number(link.link_target_code));
    }
  }
  return {
    code: item.target_code,
    unit: info.word_unit,
    word: info.word,
    sourcePos,
    canonicalPos: [...new Set(flat.map(({ sourcePos: pos }) => mapPos(pos, info.word_unit)))],
    senseCount: flat.length,
    links,
    brokenLink,
    hash: hashOf(item.target_code),
    lemma: surfaceForms(info.word, info.word_unit).lemma,
  };
}

const has = (summary, pos) => summary.sourcePos.includes(pos);
const single = (summary, pos) => summary.unit === '단어' && summary.sourcePos.length === 1 && has(summary, pos);

/** Ordered strata: [tag, quota, predicate]. Order is part of the selection contract. */
export function strataDefinitions() {
  return [
    ['verb', 100, (s) => single(s, '동사')],
    ['adjective', 60, (s) => single(s, '형용사')],
    ['adverb', 60, (s) => single(s, '부사')],
    ['noun-polysemous', 50, (s) => single(s, '명사') && s.senseCount >= 4],
    ['noun', 120, (s) => single(s, '명사') && s.senseCount <= 2],
    ['phrase', 40, (s) => s.unit === '구'],
    ['proverb', 40, (s) => s.unit === '속담'],
    ['idiom', 40, (s) => s.unit === '관용구'],
    ['multi-pos', 40, (s) => s.unit === '단어' && s.sourcePos.length > 1],
    ['caret-word', 6, (s) => s.unit === '단어' && s.word.includes('^')],
    ['inner-hyphen-word', 30, (s) => s.unit === '단어' && /.-./u.test(s.word) && !/^-|-$/u.test(s.word) && has(s, '명사')],
    ['dependent-noun', 15, (s) => has(s, '의존 명사')],
    ['pronoun', 10, (s) => has(s, '대명사')],
    ['numeral', 8, (s) => has(s, '수사')],
    ['determiner', 15, (s) => has(s, '관형사')],
    ['interjection', 15, (s) => has(s, '감탄사')],
    ['auxiliary-verb', 6, (s) => has(s, '보조 동사')],
    ['auxiliary-adjective', 6, (s) => has(s, '보조 형용사')],
    ['particle', 15, (s) => has(s, '조사')],
    ['ending', 20, (s) => has(s, '어미')],
    ['affix', 20, (s) => has(s, '접사')],
    ['pos-less-word', 25, (s) => s.unit === '단어' && s.sourcePos.every((pos) => pos === '품사 없음')],
  ];
}

function pickByHash(summaries, predicate, quota, taken) {
  return summaries
    .filter((summary) => !taken.has(summary.code) && predicate(summary))
    .sort((left, right) => (left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : left.code - right.code))
    .slice(0, quota);
}

export function selectPilot(summaries, { index, count = STDICT_SHARD_SIZE }) {
  const byCode = new Map(summaries.map((summary) => [summary.code, summary]));
  const taken = new Map();
  const take = (summary, tag) => {
    if (taken.size < count && !taken.has(summary.code)) taken.set(summary.code, tag);
  };
  for (const [tag, quota, predicate] of strataDefinitions()) {
    for (const summary of pickByHash(summaries, predicate, quota, taken)) take(summary, tag);
  }
  // Homograph groups: complete groups of 2-3 same-lemma entries for navigation.
  const groups = new Map();
  for (const summary of summaries) {
    if (summary.unit !== '단어' || !/\d{2}$/u.test(summary.word)) continue;
    (groups.get(summary.lemma) ?? groups.set(summary.lemma, []).get(summary.lemma)).push(summary);
  }
  const groupLeaders = [...groups.values()]
    .filter((members) => members.length >= 2 && members.length <= 3 && members.every((member) => !taken.has(member.code)))
    .map((members) => ({ members, hash: hashOf(`group:${members[0].lemma}`) }))
    .sort((left, right) => (left.hash < right.hash ? -1 : 1))
    .slice(0, 25);
  for (const { members } of groupLeaders) for (const member of members) take(member, 'homograph-group');
  // Official relation pairs whose both ends are plain lexical words.
  const plain = (summary) => summary && summary.unit === '단어' && !taken.has(summary.code);
  const pairsFor = (type, quota, tag) => {
    const pairs = [];
    for (const summary of summaries) {
      if (!plain(summary)) continue;
      for (const sense of summary.links[type]) {
        const resolved = index.senseByCode.get(sense);
        const other = resolved && byCode.get(resolved.targetCode);
        if (plain(other) && other.code !== summary.code && summary.canonicalPos[0] === other.canonicalPos[0]) {
          pairs.push({ a: summary, b: other, hash: hashOf(`pair:${type}:${summary.code}:${other.code}`) });
          break;
        }
      }
    }
    pairs.sort((left, right) => (left.hash < right.hash ? -1 : 1));
    let used = 0;
    for (const { a, b } of pairs) {
      if (used >= quota) break;
      if (taken.has(a.code) || taken.has(b.code)) continue;
      take(a, tag);
      take(b, tag);
      used += 1;
    }
  };
  pairsFor('동의어', 50, 'synonym-pair');
  pairsFor('반대말', 20, 'antonym-pair');
  // Edge-case sources: links that never resolve by sense_code.
  const brokenIds = summaries
    .filter((summary) => !taken.has(summary.code) && [...summary.links.동의어, ...summary.links.반대말]
      .some((code) => !index.senseByCode.has(code)))
    .sort((left, right) => (left.hash < right.hash ? -1 : 1))
    .slice(0, 5);
  for (const summary of brokenIds) take(summary, 'broken-source-link');
  // Remaining capacity: global deterministic hash order.
  for (const summary of [...summaries].sort((left, right) => (left.hash < right.hash ? -1 : 1))) {
    if (taken.size >= count) break;
    take(summary, 'hash-fill');
  }
  return taken;
}

const shardName = (number) => `stdict-${String(number).padStart(4, '0')}.jsonl`;

/**
 * Deterministic shard membership from the source and the inclusion policy alone.
 *   shard 1  = pilot records the policy still admits (identity and shard are kept), refilled with the lowest
 *              unassigned eligible target_codes up to the shard size
 *   shard n  = the remaining eligible target_codes in ascending order, `STDICT_SHARD_SIZE` per file
 * A loaded record is never moved: a later policy-compatible rebuild yields the same membership.
 */
export function assignShards({ eligibleCodes, pilotCodes, shardSize = STDICT_SHARD_SIZE }) {
  const eligible = new Set(eligibleCodes);
  const first = [...pilotCodes].filter((code) => eligible.has(code)).sort((left, right) => left - right);
  const firstSet = new Set(first);
  const ascending = [...eligible].sort((left, right) => left - right);
  const rest = [];
  for (const code of ascending) {
    if (firstSet.has(code)) continue;
    if (first.length < shardSize) {
      first.push(code);
      firstSet.add(code);
    } else {
      rest.push(code);
    }
  }
  first.sort((left, right) => left - right);
  const shards = [first];
  for (let at = 0; at < rest.length; at += shardSize) shards.push(rest.slice(at, at + shardSize));
  return shards;
}

/** Reads the whole source once and returns what shard assignment and conversion need. */
export async function loadStdictSource({ sourceDirectory = DEFAULT_SOURCE } = {}) {
  const index = createSenseIndex();
  const summaries = [];
  const itemsByCode = new Map();
  const files = await readStdictItems(sourceDirectory, (item) => {
    addToSenseIndex(index, item);
    summaries.push(summarize(item));
    itemsByCode.set(item.target_code, item);
  });
  finalizeSenseIndex(index);
  const eligibleCodes = [...index.entries]
    .filter(([, entry]) => entry.included > 0 && !entry.held)
    .map(([code]) => code);
  const pilotCodes = [...selectPilot(summaries, { index, count: STDICT_SHARD_SIZE }).keys()];
  return {
    index, summaries, itemsByCode, sourceFiles: files.length, sourceEntryCount: summaries.length,
    shards: assignShards({ eligibleCodes, pilotCodes }),
  };
}

/** Converts the given target_codes in order; `isSelected` says which relation targets are loaded. */
export function convertCodes(source, codes, { isSelected }) {
  const lines = [];
  const records = [];
  const held = [];
  const relationReport = [];
  const markupReport = [];
  const conversions = [];
  for (const code of codes) {
    const item = source.itemsByCode.get(code);
    const { record, report } = convertItem(item, { index: source.index, isSelected });
    try {
      validateCanonicalRecord(record);
    } catch (error) {
      held.push({ target_code: code, word_unit: item.word_info.word_unit, reason: error.message });
      continue;
    }
    lines.push(serializeRecord(record));
    records.push(record);
    relationReport.push(...report.relations.map((row) => ({ ...row, target_code: code })));
    markupReport.push(...report.markup);
    conversions.push({
      target_code: code,
      id: record.id,
      word_unit: item.word_info.word_unit,
      source_pos: [...new Set((item.word_info.pos_info ?? []).map((posInfo) => posInfo.pos ?? '품사 없음'))],
      sense_codes: flattenSenses(item).map(({ sense }) => Number(sense.sense_code)),
      kept_senses: record.senses.length,
      excluded_senses: report.excluded.length,
    });
  }
  return { shard: lines.length ? `${lines.join('\n')}\n` : '', records, held, relationReport, markupReport, conversions };
}

/**
 * Builds shards 1..`through`. Relations are only emitted to targets inside the loaded shards; a target that
 * is eligible but not loaded yet is `out-of-sample` and is added to its source record by a later `through`.
 */
export async function buildShards({ source, through = 1 }) {
  const loaded = new Set(source.shards.slice(0, through).flat());
  return source.shards.slice(0, through).map((codes, position) => ({
    name: shardName(position + 1),
    ...convertCodes(source, codes, { isSelected: (code) => loaded.has(code) }),
  }));
}

export function countBy(rows, keyOf) {
  const counts = {};
  for (const row of rows) {
    const key = keyOf(row);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => (left < right ? -1 : 1)));
}

export function provenanceManifest(result, { source }) {
  const sha256 = createHash('sha256').update(result.shard).digest('hex');
  return {
    contract: 'stdict-shard-provenance-v2',
    selection_version: SELECTION_VERSION,
    source: {
      dictionary: '표준국어대사전 (STDICT)',
      file_count: source.sourceFiles,
      entry_count: source.sourceEntryCount,
    },
    id_contract: {
      record: 'w<target_code>, zero-padded to the three digits the canonical id pattern requires',
      sense: '<record id>-s<n>, n = 1-based source order of the sense within the entry; a policy-excluded sense leaves a gap and is never renumbered',
      sense_codes: 'every original sense_code in source order; the suffix n of a kept sense id indexes into it',
      note: 'A loaded record keeps its id, shard and sense numbers; later shards take the remaining eligible target_codes in ascending order.',
    },
    shard: result.name,
    shard_sha256: sha256,
    record_count: result.records.length,
    held_count: result.held.length,
    summary: {
      by_word_unit: countBy(result.conversions, (row) => row.word_unit),
      by_source_pos: countBy(result.conversions, (row) => row.source_pos.join('/')),
      relations_by_status: countBy(result.relationReport, (row) => `${row.source_type}:${row.status}`),
      definition_markup_cleaned: countBy(result.markupReport, (row) => row.markup),
      kept_senses: result.conversions.reduce((sum, row) => sum + row.kept_senses, 0),
      excluded_senses: result.conversions.reduce((sum, row) => sum + row.excluded_senses, 0),
    },
    records: result.conversions.map(({ target_code, id, sense_codes }) => ({ target_code, id, sense_codes })),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 ? args[at + 1] : fallback;
  };
  const outDirectory = path.resolve(option('out', 'data/canonical'));
  const provenanceDirectory = path.resolve(option('provenance', 'data/provenance'));
  const through = Number(option('through', '1'));
  const source = await loadStdictSource({ sourceDirectory: option('source', DEFAULT_SOURCE) });
  const built = await buildShards({ source, through });
  const provenanceText = (result) => `${JSON.stringify(provenanceManifest(result, { source }), null, 1)}\n`;
  const outputs = built.flatMap((result) => [
    [path.join(outDirectory, result.name), result.shard],
    [path.join(provenanceDirectory, result.name.replace(/\.jsonl$/u, '.json')), provenanceText(result)],
  ]);
  if (args.includes('--verify')) {
    for (const [file, text] of outputs) {
      if (await readFile(file, 'utf8').catch(() => null) !== text) {
        throw new Error(`regenerated STDICT output differs from the committed file: ${path.relative('.', file)}`);
      }
    }
    console.log(`verified ${built.length} shard(s), ${built.reduce((sum, result) => sum + result.records.length, 0)} records, byte-identical`);
    return;
  }
  await mkdir(outDirectory, { recursive: true });
  await mkdir(provenanceDirectory, { recursive: true });
  for (const result of built) {
    await writeFile(path.join(outDirectory, result.name), result.shard);
    await writeFile(path.join(provenanceDirectory, result.name.replace(/\.jsonl$/u, '.json')), provenanceText(result));
  }
  console.log(`wrote ${built.length} shard(s): ${built.map((result) => `${result.name} ${result.records.length}`).join(', ')}; ${source.shards.length} shard(s) in total`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
