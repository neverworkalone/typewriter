import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CANDIDATE_BATCH_SIZE, normalizeCandidate, parseCandidateJsonl, validateCandidateBatch } from './candidate-contract.mjs';

export { normalizeCandidate };

/**
 * Stage 2 Relation Admission tooling (Issue #928). Rule it guarantees: every unique Stage 1 candidate of a shard ends
 * in exactly one of {new Relation, real Drop, exact-duplicate merge, existing approved Relation}, and every approved
 * Relation names a real Canonical source sense (and, for an ID link, a real target record/sense of the same spelling).
 * It never creates candidates, never rescoring existing Relations and never reads Stage 1 files other than as input.
 */
const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const ADMISSION_TYPES = Object.freeze(['near', 'mood', 'scene', 'sensory', 'action', 'association']);
/** Required Stage 1 producers per batch: A/B by Codex and Claude, C and D by one owner-assigned model each. */
export const REQUIRED_PRODUCERS = Object.freeze(['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c', 'd']);
export const BATCHES = Object.freeze(['01', '02']);

const ID_ROW_KEYS = 'relevance,reverse_relevance,reverse_type,source_record_id,source_sense_id,target_record_id,target_sense_id,type';
const TEXT_ROW_KEYS = 'relevance,source_record_id,source_sense_id,text,type';
const DROP_ROW_KEYS = 'candidate,reason,source_record_id,source_sense_id';

const keysOf = (row) => Object.keys(row).sort().join(',');
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTier = (value) => Number.isInteger(value) && value >= 1 && value <= 9;
const isText = (value) => typeof value === 'string' && value.trim().length > 0;

export const shardCanonicalPath = (shard, root = REPOSITORY_DIRECTORY) => path.join(root, 'data/canonical', `stdict-${shard.padStart(4, '0')}.jsonl`);
export const shardRelationPath = (shard, root = REPOSITORY_DIRECTORY) => path.join(root, 'data/relations', `relation-${shard}.jsonl`);
export const shardDropPath = (shard, root = REPOSITORY_DIRECTORY) => path.join(root, 'data/relation-drops', `drop-${shard}.jsonl`);

export function assertShard(shard) {
  if (!/^\d{3}$/u.test(shard ?? '') || Number(shard) < 1 || Number(shard) > 428) throw new Error('shard must be 001..428');
}

/** Producer key of a Candidate file name: `001_01_a_codex.jsonl` -> `a_codex`; C/D collapse to `c`/`d` (single owner-assigned model). */
export function producerOf(fileName) {
  const match = /^\d{3}_(01|02)_([a-d])_([a-z0-9_-]+)\.jsonl$/u.exec(fileName);
  if (!match) throw new Error(`${fileName} does not follow the Candidate v1 filename contract`);
  const [, batch, method, model] = match;
  return { batch, method, model, key: method === 'c' || method === 'd' ? method : `${method}_${model}` };
}

/**
 * Which required (batch, producer) Candidate files are present; optional files (e.g. DeepSeek) are carried along.
 * C and D each have one owner-assigned model per batch, so a second C (or D) file of another model is rejected rather
 * than silently merged under the same producer key.
 */
export function candidateInventory(fileNames, { batches = BATCHES } = {}) {
  const present = new Map();
  for (const name of fileNames) {
    const { batch, key } = producerOf(name);
    const slot = `${batch}/${key}`;
    if (present.has(slot) && (key === 'c' || key === 'd')) {
      throw new Error(`batch ${batch} has more than one ${key.toUpperCase()} producer file (${present.get(slot)}, ${name}); C and D allow exactly one owner-assigned model`);
    }
    present.set(slot, name);
  }
  const missing = [];
  for (const batch of batches) {
    for (const key of REQUIRED_PRODUCERS) if (!present.has(`${batch}/${key}`)) missing.push(`${batch}/${key}`);
  }
  return { files: [...fileNames].sort(), missing };
}

/**
 * Restrict a shard run to one 500-record batch: its Canonical rows and its Candidate files. Relation/Drop rows of the
 * other batch of the same shard file are outside this run's accounting.
 */
export function batchScope(canonicalRows, candidateFiles, batch) {
  if (!BATCHES.includes(batch)) throw new Error('batch must be 01 or 02');
  const offset = (Number(batch) - 1) * CANDIDATE_BATCH_SIZE;
  const scopeRows = canonicalRows.slice(offset, offset + CANDIDATE_BATCH_SIZE);
  if (scopeRows.length === 0) throw new Error(`shard has no records for batch ${batch}`);
  return { scopeRows, files: candidateFiles.filter((file) => producerOf(path.basename(file.name)).batch === batch) };
}

/**
 * Merge Stage 1 Candidate rows into unique candidates per source sense. Each file must already satisfy Candidate v1
 * for its batch. Exact duplicates (after `normalizeCandidate`) merge; the producer list is kept as evidence.
 * @param {{ name: string, rows: object[] }[]} candidateFiles
 */
export function mergeCandidates(canonicalRows, candidateFiles, { canonicalLemmaForms } = {}) {
  const merged = new Map();
  let raw = 0;
  const independentLemmaForms = canonicalLemmaForms ?? new Set(canonicalRows.map((row) => normalizeCandidate(row.lemma ?? '')));
  for (const file of candidateFiles) {
    const { batch, key } = producerOf(path.basename(file.name));
    validateCandidateBatch(canonicalRows, file.rows, {
      batch,
      candidateName: file.name,
      canonicalLemmaForms: independentLemmaForms,
    });
    for (const row of file.rows) {
      for (const sense of row.senses) {
        const bySense = merged.get(sense.sense_id) ?? { record_id: row.record_id, candidates: new Map() };
        merged.set(sense.sense_id, bySense);
        for (const text of sense.candidates) {
          raw += 1;
          const normalized = normalizeCandidate(text);
          const producers = bySense.candidates.get(normalized) ?? [];
          if (!producers.includes(key)) producers.push(key);
          bySense.candidates.set(normalized, producers);
        }
      }
    }
  }
  return { merged, rawCandidateCount: raw };
}

/** Orthographic variants emitted by the Canonical converter: only spacing/hyphenation variants of the lemma. */
function canonicalOrthographicForms(record) {
  const lemma = normalizeCandidate(record.lemma ?? '');
  const foldedLemma = lemma.replace(/[\s-]/gu, '');
  if (!foldedLemma) return [];
  return [...new Set([record.lemma, ...(Array.isArray(record.search_forms) ? record.search_forms : [])]
    .filter((form) => typeof form === 'string')
    .map(normalizeCandidate)
    .filter((form) => form.replace(/[\s-]/gu, '') === foldedLemma))];
}

function canonicalRecordsForOrthographicForm(index, form) {
  const normalized = normalizeCandidate(form);
  // An exact Canonical lemma owns its spelling. Do not make that target ambiguous merely because
  // another record lists the same spelling as an orthographic search form.
  return index.byNormalizedLemma?.get(normalized) ?? index.byOrthographicForm?.get(normalized) ?? index.byLemma.get(normalized) ?? [];
}

function uniquelyIdentifyingOrthographicForms(record, index) {
  return canonicalOrthographicForms(record).filter((form) => {
    const matches = canonicalRecordsForOrthographicForm(index, form);
    return matches.length === 1 && matches[0].id === record.id;
  });
}

/** Lemma, orthographic search-form, and id lookups over the full Canonical (all shards). */
export function buildCanonicalIndex(rows) {
  const byId = new Map();
  const byLemma = new Map();
  const byNormalizedLemma = new Map();
  const byOrthographicForm = new Map();
  const senses = new Map();
  for (const row of rows) {
    byId.set(row.id, row);
    byLemma.set(row.lemma, [...(byLemma.get(row.lemma) ?? []), row]);
    const normalizedLemma = normalizeCandidate(row.lemma);
    byNormalizedLemma.set(normalizedLemma, [...(byNormalizedLemma.get(normalizedLemma) ?? []), row]);
    for (const form of canonicalOrthographicForms(row)) {
      const matches = byOrthographicForm.get(form) ?? [];
      if (!matches.some((match) => match.id === row.id)) byOrthographicForm.set(form, [...matches, row]);
    }
    for (const sense of row.senses) senses.set(sense.id, { record: row, sense });
  }
  return { byId, byLemma, byNormalizedLemma, byOrthographicForm, senses };
}

/**
 * Validate approved Relation + Drop rows of one shard against the Canonical index. Pure; throws one aggregated error.
 * `otherRelationRows` are approved rows of every other shard (duplicate/reverse-duplicate detection).
 */
export function validateRelationRows({ relationRows, dropRows = [], index, shardSenseIds, otherRelationRows = [] }) {
  const errors = [];
  const seenPairs = new Map();
  const pairKey = (sourceSense, targetRecord, targetSense) => `${sourceSense}\u0000${targetRecord}\u0000${targetSense}`;
  const textKey = (sourceSense, text) => `${sourceSense}\u0000${normalizeCandidate(text)}`;

  for (const row of otherRelationRows) {
    if ('text' in row) seenPairs.set(textKey(row.source_sense_id, row.text), 'other shard');
    else {
      seenPairs.set(pairKey(row.source_sense_id, row.target_record_id, row.target_sense_id), 'other shard');
      seenPairs.set(pairKey(row.target_sense_id, row.source_record_id, row.source_sense_id), 'other shard');
    }
  }

  const checkSource = (row, at) => {
    const found = index.senses.get(row.source_sense_id);
    if (!found || found.record.id !== row.source_record_id) errors.push(`${at}: source_sense_id ${row.source_sense_id} is not a sense of ${row.source_record_id}`);
    else if (!shardSenseIds.has(row.source_sense_id)) errors.push(`${at}: source sense ${row.source_sense_id} is outside this shard`);
    return found;
  };

  relationRows.forEach((row, position) => {
    const at = `relation:${position + 1}`;
    if (!isPlainObject(row)) { errors.push(`${at}: must be an object`); return; }
    const isText_ = 'text' in row;
    const expected = isText_ ? TEXT_ROW_KEYS : ID_ROW_KEYS;
    if (keysOf(row) !== expected) { errors.push(`${at}: must have exactly ${expected}`); return; }
    const source = checkSource(row, at);
    if (!ADMISSION_TYPES.includes(row.type)) errors.push(`${at}: type ${JSON.stringify(row.type)} is not one of ${ADMISSION_TYPES.join('/')}`);
    if (!isTier(row.relevance)) errors.push(`${at}: relevance must be an integer 1..9`);
    if (isText_) {
      if (!isText(row.text) || row.text !== normalizeCandidate(row.text)) errors.push(`${at}: text must be a non-empty normalized string`);
      else {
        if (source && row.text === normalizeCandidate(source.record.lemma)) errors.push(`${at}: text repeats the source lemma`);
        const key = textKey(row.source_sense_id, row.text);
        if (seenPairs.has(key)) errors.push(`${at}: duplicate text relation ${row.source_sense_id} -> ${row.text} (${seenPairs.get(key)})`);
        seenPairs.set(key, 'this shard');
      }
      return;
    }
    if (!ADMISSION_TYPES.includes(row.reverse_type)) errors.push(`${at}: reverse_type ${JSON.stringify(row.reverse_type)} is not one of ${ADMISSION_TYPES.join('/')}`);
    if (!isTier(row.reverse_relevance)) errors.push(`${at}: reverse_relevance must be an integer 1..9`);
    const target = index.senses.get(row.target_sense_id);
    if (!target || target.record.id !== row.target_record_id) { errors.push(`${at}: target_sense_id ${row.target_sense_id} is not a sense of ${row.target_record_id}`); return; }
    if (row.target_record_id === row.source_record_id) errors.push(`${at}: relation targets its own record`);
    const forward = pairKey(row.source_sense_id, row.target_record_id, row.target_sense_id);
    if (seenPairs.has(forward)) errors.push(`${at}: duplicate or reverse-duplicate ID relation ${row.source_sense_id} <-> ${row.target_sense_id} (${seenPairs.get(forward)})`);
    seenPairs.set(forward, 'this shard');
    seenPairs.set(pairKey(row.target_sense_id, row.source_record_id, row.source_sense_id), 'this shard');
  });

  const dropSeen = new Set();
  dropRows.forEach((row, position) => {
    const at = `drop:${position + 1}`;
    if (!isPlainObject(row) || keysOf(row) !== DROP_ROW_KEYS) { errors.push(`${at}: must have exactly ${DROP_ROW_KEYS}`); return; }
    checkSource(row, at);
    if (!isText(row.candidate) || row.candidate !== normalizeCandidate(row.candidate)) errors.push(`${at}: candidate must be a non-empty normalized string`);
    if (!isText(row.reason)) errors.push(`${at}: reason must be non-empty text`);
    const key = textKey(row.source_sense_id, row.candidate ?? '');
    if (dropSeen.has(key)) errors.push(`${at}: duplicate drop ${row.source_sense_id} -> ${row.candidate}`);
    dropSeen.add(key);
  });

  if (errors.length > 0) throw new Error(`Relation Admission rows are invalid:\n${errors.map((error) => `- ${error}`).join('\n')}`);
  return { relationCount: relationRows.length, dropCount: dropRows.length };
}

/**
 * Coarse existing approved Relation coverage mapped to `sourceSenseId\0normalizedCandidate`, without retaining the
 * target sense. Target-sensitive preparation and accounting use existingCandidateLinks instead. An ID relation is
 * mapped only when the candidate equals the counterpart lemma AND that lemma identifies one Canonical record.
 */
export function existingCandidateKeys(relationRows, index) {
  const covered = new Map();
  for (const [key, links] of existingCandidateLinks(relationRows, index)) covered.set(key, links.at(-1).why);
  return covered;
}

/** Existing approved candidate links, retaining the exact target sense for ID relations. */
function existingCandidateLinks(relationRows, index) {
  const links = new Map();
  const add = (senseId, text, link) => {
    const key = `${senseId}\u0000${normalizeCandidate(text)}`;
    links.set(key, [...(links.get(key) ?? []), link]);
  };
  for (const row of relationRows) {
    if ('text' in row) { add(row.source_sense_id, row.text, { kind: 'text', why: 'text-only' }); continue; }
    const target = index.byId.get(row.target_record_id);
    const source = index.byId.get(row.source_record_id);
    if (target) {
      for (const form of uniquelyIdentifyingOrthographicForms(target, index)) {
        add(row.source_sense_id, form, { kind: 'id', targetSenseId: row.target_sense_id, why: 'id-forward' });
      }
    }
    if (source) {
      for (const form of uniquelyIdentifyingOrthographicForms(source, index)) {
        add(row.target_sense_id, form, { kind: 'id', targetSenseId: row.source_sense_id, why: 'id-reverse' });
      }
    }
  }
  return links;
}

/**
 * Prepare the editing input of a shard: unique candidates with the exact source sense/gloss, minus candidates already
 * fully covered by text-only approval or by ID links to every sense of the unique target record. Never an editorial
 * judgement; nothing is dropped here.
 */
export function prepareShard({ canonicalRows, candidateFiles, approvedRelationRows = [], dropRows = [], index, scopeRows = canonicalRows }) {
  const canonicalLemmaForms = new Set([...index.byLemma.keys()].map(normalizeCandidate));
  const { merged, rawCandidateCount } = mergeCandidates(canonicalRows, candidateFiles, { canonicalLemmaForms });
  const covered = existingCandidateLinks(approvedRelationRows, index);
  const dropped = new Set(dropRows.map((row) => `${row.source_sense_id}\u0000${normalizeCandidate(row.candidate)}`));
  const items = [];
  const stats = { raw: rawCandidateCount, unique: 0, merged_duplicates: 0, skipped_existing: 0, skipped_dropped: 0, to_edit: 0 };
  for (const record of scopeRows) {
    for (const sense of record.senses) {
      const entry = merged.get(sense.id);
      if (!entry) continue;
      const fresh = [];
      for (const [text, producers] of entry.candidates) {
        stats.unique += 1;
        if (text === normalizeCandidate(record.lemma)) throw new Error(`${sense.id}: candidate ${JSON.stringify(text)} repeats the source lemma`);
        const links = covered.get(`${sense.id}\u0000${text}`) ?? [];
        const nonIdLink = links.some((link) => link.kind !== 'id');
        const targetRecords = canonicalRecordsForOrthographicForm(index, text);
        const targetSenseIds = targetRecords.length === 1 ? targetRecords[0].senses.map((targetSense) => targetSense.id) : [];
        const allTargetSensesCovered = targetSenseIds.length > 0 && targetSenseIds.every((targetSenseId) =>
          links.some((link) => link.kind === 'id' && link.targetSenseId === targetSenseId));
        if (nonIdLink || allTargetSensesCovered) { stats.skipped_existing += 1; continue; }
        if (dropped.has(`${sense.id}\u0000${text}`)) { stats.skipped_dropped += 1; continue; }
        fresh.push({ text, producers, same_spelling_records: targetRecords.map((target) => target.id) });
      }
      if (fresh.length === 0) continue;
      stats.to_edit += fresh.length;
      items.push({ record_id: record.id, sense_id: sense.id, lemma: record.lemma, pos: sense.pos, gloss: sense.gloss, candidates: fresh });
    }
  }
  stats.merged_duplicates = stats.raw - stats.unique;
  return { items, stats };
}

const GLOSS_GRAMMATICAL_SUFFIXES = [
  '으로부터', '에서부터', '에게서', '한테서', '은커녕', '는커녕', '이라도', '이든지', '으로', '에서',
  '에게', '한테', '께서', '까지', '부터', '보다', '처럼', '만큼', '조차', '마저', '밖에', '마다', '든지',
  '이라', '이랑', '이며', '이고', '이라서', '인데', '이면', '이라면', '으로는', '에서는', '에게는',
  '은', '는', '이', '가', '을', '를', '의', '에', '와', '과', '도', '만', '로', '나', '야', '요', '든', '들',
].sort((left, right) => right.length - left.length);

const GLOSS_NUMERIC_UNITS = [
  '센티미터', '킬로미터', '세기', '단계', '미터', '년', '월', '일', 'cm', 'mm', 'km',
].sort((left, right) => right.length - left.length);

const isWordCharacter = (character) => Boolean(character) && /[\p{L}\p{N}]/u.test(character);

function endsAtGlossWordBoundary(text, { allowNumericUnit = false, depth = 0 } = {}) {
  const firstCharacter = Array.from(text)[0] ?? '';
  if (!isWordCharacter(firstCharacter)) return true;
  if (depth >= 3) return false;
  const hasNumericUnit = allowNumericUnit && GLOSS_NUMERIC_UNITS.some((unit) => text.startsWith(unit)
    && endsAtGlossWordBoundary(text.slice(unit.length), { depth: depth + 1 }));
  return hasNumericUnit || GLOSS_GRAMMATICAL_SUFFIXES.some((suffix) => text.startsWith(suffix)
    && endsAtGlossWordBoundary(text.slice(suffix.length), { depth: depth + 1 }));
}

/**
 * A gloss names a candidate only when the occurrence has lexical boundaries. Plain substring matching mistakes a
 * short word inside a different compound (for example, `떡` inside `떡갈나무`) for a direct mention. A candidate may
 * still be named with an attached Korean particle/plural marker or a numeric unit (`가로에`, `수들`, `1971년에`).
 * Recognize grammatical suffixes at a word boundary, and numeric units only after a numeric candidate, so `소` inside
 * `소년` is not a match.
 */
function glossNamesExactCandidate(gloss, candidate) {
  const normalizedGloss = normalizeCandidate(gloss);
  const normalizedCandidate = normalizeCandidate(candidate);
  if (!normalizedCandidate) return false;
  let offset = normalizedGloss.indexOf(normalizedCandidate);
  const isNumericCandidate = /^\d+(?:[,.]\d+)*$/u.test(normalizedCandidate);
  while (offset !== -1) {
    const before = Array.from(normalizedGloss.slice(0, offset)).at(-1) ?? '';
    const afterText = normalizedGloss.slice(offset + normalizedCandidate.length);
    if (!isWordCharacter(before) && endsAtGlossWordBoundary(afterText, { allowNumericUnit: isNumericCandidate })) return true;
    offset = normalizedGloss.indexOf(normalizedCandidate, offset + 1);
  }
  return false;
}

function glossNamesCandidate(gloss, candidate, index) {
  const normalized = normalizeCandidate(candidate);
  const forms = new Set([normalized]);
  for (const record of canonicalRecordsForOrthographicForm(index, normalized)) {
    for (const form of canonicalOrthographicForms(record)) forms.add(form);
  }
  return [...forms].some((form) => glossNamesExactCandidate(gloss, form));
}

/**
 * Account for every unique candidate: new Relation, real Drop or existing approved Relation (excluding this shard's own
 * rows, which are the result being checked). Throws on a missing, doubly-assigned or unknown candidate.
 */
export function verifyAccounting({ canonicalRows, candidateFiles, relationRows: allRelationRows, dropRows: allDropRows, otherRelationRows, index, scopeRows = canonicalRows }) {
  const canonicalLemmaForms = new Set([...index.byLemma.keys()].map(normalizeCandidate));
  const { merged, rawCandidateCount } = mergeCandidates(canonicalRows, candidateFiles, { canonicalLemmaForms });
  const scopeSenses = new Set(scopeRows.flatMap((record) => record.senses.map((sense) => sense.id)));
  const relationRows = allRelationRows.filter((row) => scopeSenses.has(row.source_sense_id));
  const dropRows = allDropRows.filter((row) => scopeSenses.has(row.source_sense_id));
  // Keep the bound sense as well as the candidate spelling. A single lexical candidate can point to distinct senses
  // of a polysemous lemma; only a repeated sense pair is a duplicate disposition.
  const approvedLinks = existingCandidateLinks(otherRelationRows, index);
  const errors = [];
  const claimed = new Map();
  const canShareCandidate = (left, right) => left.kind === 'id' && right.kind === 'id' && left.targetSenseId !== right.targetSenseId;
  const claim = (senseId, text, how, link, at) => {
    const key = `${senseId}\u0000${text}`;
    const priorClaims = claimed.get(key) ?? [];
    const conflict = priorClaims.find((prior) => !canShareCandidate(prior.link, link));
    if (conflict) errors.push(`${at}: candidate ${JSON.stringify(text)} of ${senseId} is already ${conflict.how}`);
    claimed.set(key, [...priorClaims, { how, link }]);
    const entry = merged.get(senseId);
    if (!entry || !entry.candidates.has(text)) errors.push(`${at}: ${JSON.stringify(text)} is not a Stage 1 candidate of ${senseId}`);
  };
  relationRows.forEach((row, position) => {
    const at = `relation:${position + 1}`;
    if ('text' in row) claim(row.source_sense_id, row.text, 'a text-only relation', { kind: 'text' }, at);
    else {
      const target = index.byId.get(row.target_record_id);
      if (!target) return;
      const sourceCandidates = merged.get(row.source_sense_id)?.candidates;
      const matchingForms = uniquelyIdentifyingOrthographicForms(target, index).filter((form) => sourceCandidates?.has(form));
      const formsToClaim = matchingForms.length > 0 ? matchingForms : [normalizeCandidate(target.lemma)];
      for (const form of formsToClaim) claim(row.source_sense_id, form, 'an ID relation', { kind: 'id', targetSenseId: row.target_sense_id }, at);
    }
  });
  dropRows.forEach((row, position) => claim(row.source_sense_id, row.candidate, 'a drop', { kind: 'drop' }, `drop:${position + 1}`));
  // A Drop says the candidate is unrelated to the source meaning; the source's own gloss naming it is direct counter-evidence.
  const glossOf = new Map(scopeRows.flatMap((record) => record.senses.map((sense) => [sense.id, sense.gloss])));
  dropRows.forEach((row, position) => {
    if (glossNamesCandidate(glossOf.get(row.source_sense_id) ?? '', row.candidate, index)) errors.push(`drop:${position + 1}: ${JSON.stringify(row.candidate)} is named by the gloss of ${row.source_sense_id} and cannot be dropped as unrelated`);
  });

  // An ID pair is stored once. When both senses listed each other as a Stage 1 candidate, the stored row's reverse
  // direction answers the other candidate, provided the source spelling identifies one Canonical record.
  const reverseCovered = new Map();
  for (const row of allRelationRows) {
    if ('text' in row) continue;
    const source = index.byId.get(row.source_record_id);
    if (source) {
      for (const form of uniquelyIdentifyingOrthographicForms(source, index)) {
        const key = `${row.target_sense_id}\u0000${form}`;
        reverseCovered.set(key, [...(reverseCovered.get(key) ?? []), { kind: 'id', targetSenseId: row.source_sense_id }]);
      }
    }
  }

  const counts = { unique: 0, relation: relationRows.length, drop: dropRows.length, skipped_existing: 0, reverse_covered: 0, missing: 0 };
  for (const record of scopeRows) {
    for (const sense of record.senses) {
      for (const text of merged.get(sense.id)?.candidates.keys() ?? []) {
        if (text === normalizeCandidate(record.lemma)) throw new Error(`${sense.id}: candidate ${JSON.stringify(text)} repeats the source lemma`);
        counts.unique += 1;
        const key = `${sense.id}\u0000${text}`;
        const claims = claimed.get(key) ?? [];
        const approved = approvedLinks.get(key) ?? [];
        const reverse = reverseCovered.get(key) ?? [];
        if (claims.length > 0) {
          const priorApproval = approved.find((link) => claims.some((claim_) => !canShareCandidate(claim_.link, link)));
          if (priorApproval) errors.push(`${sense.id}: ${JSON.stringify(text)} is already answered by an approved Relation (${priorApproval.why}) and must not be re-authored`);
          const priorReverse = reverse.find((link) => claims.some((claim_) => !canShareCandidate(claim_.link, link)));
          if (priorReverse) {
            const conflictingClaim = claims.find((claim_) => !canShareCandidate(claim_.link, priorReverse));
            errors.push(`${sense.id}: ${JSON.stringify(text)} is already answered by the reverse of a stored ID pair (${priorReverse.targetSenseId}) and cannot also be ${conflictingClaim.how}`);
          }
          continue;
        }
        if (approved.length > 0) { counts.skipped_existing += 1; continue; }
        if (reverse.length > 0) { counts.reverse_covered += 1; continue; }
        counts.missing += 1;
        errors.push(`${sense.id}: candidate ${JSON.stringify(text)} has no relation, drop or existing approved relation`);
      }
    }
  }
  if (errors.length > 0) throw new Error(`Relation Admission accounting failed:\n${errors.slice(0, 50).map((error) => `- ${error}`).join('\n')}${errors.length > 50 ? `\n- ... ${errors.length - 50} more` : ''}`);
  return { ...counts, raw: rawCandidateCount, merged_duplicates: rawCandidateCount - counts.unique };
}

// ---- file IO -------------------------------------------------------------------------------------------------

async function readJsonl(file) {
  return parseCandidateJsonl(await readFile(file, 'utf8'), file);
}

export async function loadAllCanonical(root = REPOSITORY_DIRECTORY) {
  const directory = path.join(root, 'data/canonical');
  const files = (await readdir(directory)).filter((name) => /^stdict-\d{4}\.jsonl$/u.test(name)).sort();
  const rows = [];
  for (const file of files) rows.push(...await readJsonl(path.join(directory, file)));
  return rows;
}

export async function loadApprovedRelations(root = REPOSITORY_DIRECTORY, { exceptShard = null } = {}) {
  const directory = path.join(root, 'data/relations');
  if (!existsSync(directory)) return [];
  const rows = [];
  for (const name of (await readdir(directory)).filter((item) => /^relation-\d{3}\.jsonl$/u.test(item)).sort()) {
    if (exceptShard && name === `relation-${exceptShard}.jsonl`) continue;
    rows.push(...await readJsonl(path.join(directory, name)));
  }
  return rows;
}

/**
 * With `batch`, files that belong to the other batch are neither inventoried nor parsed: a batch run depends only on its
 * own Candidate files, so a conflicting or unfinished file of the other batch cannot block it.
 */
export async function loadShardCandidateFiles(shard, root = REPOSITORY_DIRECTORY, { batch = null } = {}) {
  const directory = path.join(root, 'data/relation-candidates', shard);
  const otherBatch = (name) => batch !== null && /^\d{3}_(01|02)_/u.test(name) && !new RegExp(`^\\d{3}_${batch}_`, 'u').test(name);
  const names = existsSync(directory) ? (await readdir(directory)).filter((name) => name.endsWith('.jsonl') && !otherBatch(name)).sort() : [];
  const inventory = candidateInventory(names, batch === null ? {} : { batches: [batch] });
  const files = [];
  for (const name of inventory.files) files.push({ name, rows: await readJsonl(path.join(directory, name)) });
  return { files, inventory };
}

export async function loadShard(shard, root = REPOSITORY_DIRECTORY, { batch = null } = {}) {
  assertShard(shard);
  const canonicalRows = await readJsonl(shardCanonicalPath(shard, root));
  const [{ files, inventory }, allCanonical] = await Promise.all([loadShardCandidateFiles(shard, root, { batch }), loadAllCanonical(root)]);
  return { canonicalRows, candidateFiles: files, inventory, index: buildCanonicalIndex(allCanonical), batchSize: CANDIDATE_BATCH_SIZE };
}

export async function loadOptionalJsonl(file) {
  return existsSync(file) ? readJsonl(file) : [];
}
