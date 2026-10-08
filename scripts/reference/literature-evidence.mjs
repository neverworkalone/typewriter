import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { DEFAULT_FULL_LITERATURE_INDEX_PATH, REPOSITORY_DIRECTORY } from './literature-index.mjs';
import { assertWithinDirectory, resolveTypewriterCachePaths } from '../typewriter-cache.mjs';

// When a form exceeds HIT_FETCH_CAP the fetched sample is a deterministic scatter of unit rowids (not the first works in file order).
// Stage 2 literature-evidence retriever (#391). Evidence supply only: it never decides POS, sense,
// disposition, literal/figurative use or relation type, and an empty result is not negative
// evidence. It reads the existing literature SQLite read-only and changes no schema.

export const EVIDENCE_TOOL_IDENTITY = 'typewriter/scripts/reference/literature-evidence.mjs';
export const EVIDENCE_CONTRACT = 'literature-evidence-pack-v1';
export const DEFAULT_MAX_CONTEXTS = 8;
export const MAX_CONTEXTS_LIMIT = 10;
export const DEFAULT_MAX_PER_WORK = 1;
export const MAX_BLOCK_UNITS = 12;
export const MAX_BLOCK_CHARS = 1200;
export const FALLBACK_NEIGHBOR_UNITS = 3;
export const MIN_FORM_CHARACTERS = 2;
export const HIT_FETCH_CAP = 2000;
const CACHE_PATHS = resolveTypewriterCachePaths();
export const EVIDENCE_OUTPUT_DIRECTORY = CACHE_PATHS.evidence;

const BATCH_ID = /^C\d{6}$/u;
const CANDIDATE_ID = /^C\d{6}-\d{4}$/u;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

// ------------------------------------------------------------------- candidate

export async function loadFactoryCandidate({ batchId, candidateId, root = REPOSITORY_DIRECTORY }) {
  if (!BATCH_ID.test(batchId ?? '')) throw new TypeError('batch id must look like C000001.');
  if (!CANDIDATE_ID.test(candidateId ?? '') || !candidateId.startsWith(batchId + '-')) {
    throw new TypeError('candidate id must be <batch id>-<4 digits> of the given batch.');
  }
  const directory = path.join(root, 'data/candidates', batchId);
  const text = await readFile(path.join(directory, 'candidates.jsonl'), 'utf8');
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (sha256(text) !== manifest.candidates_sha256) throw new Error(batchId + ': candidates.jsonl does not match candidates_sha256.');
  const rows = text.split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.candidate_id === candidateId);
  if (rows.length !== 1) throw new Error(candidateId + ': expected exactly one candidate row, found ' + rows.length + '.');
  return rows[0];
}

const surfacesOf = (row) => (Array.isArray(row.observations)
  ? row.forms.map((form) => form.surface)
  : row.observedForms ?? []);

/**
 * Query forms: citation lemma, observed surfaces and (optionally) already-supported generated
 * forms of existing canonical entries (`supportedForms`, from the shared search-form support).
 * No new morphology is invented. Forms shorter than MIN_FORM_CHARACTERS are skipped and reported.
 */
export function deriveSearchForms(row, supportedForms = []) {
  const sources = [['lemma', [row.input]], ['observed', surfacesOf(row)], ['supported', supportedForms]];
  const used = new Map();
  const skipped = [];
  for (const [origin, forms] of sources) {
    for (const form of forms) {
      if (typeof form !== 'string' || /[\r\n\u0000]/u.test(form)) continue;
      if ([...form].length < MIN_FORM_CHARACTERS) { skipped.push(form); continue; }
      if (!used.has(form)) used.set(form, origin);
    }
  }
  return {
    forms: [...used].map(([form, origin]) => ({ form, origin })).sort((a, b) => compare(a.form, b.form)),
    skipped: [...new Set(skipped)].sort(compare),
  };
}

/** Pilot trigger policy: reasons Stage 2 may need more semantic evidence. Never decides a disposition. */
export function pilotTriggerReasons(row, route = null) {
  const reasons = [];
  if (route === 'new_sense_on_existing_entry') reasons.push('new_sense_on_existing_entry');
  if (Array.isArray(row.usage_groups) && row.usage_groups.length > 1) reasons.push('multiple_usage_groups');
  if (Array.isArray(row.pos_hypotheses) && row.pos_hypotheses.length > 1) reasons.push('multiple_pos_hypotheses');
  const held = Array.isArray(row.observations) ? row.observations.some((o) => o.holds?.length) : Boolean(row.holds?.length);
  if (held) reasons.push('held_observation');
  return reasons;
}

// -------------------------------------------------------------------- retrieval

function ftsPattern(form) {
  return '"' + form.replaceAll('"', '""') + '"';
}

function metadataOf(database) {
  const metadata = Object.fromEntries(database.prepare('SELECT key, value FROM index_metadata').all().map((r) => [r.key, r.value]));
  for (const key of ['schema_version', 'logical_rows_sha256', 'input_manifest_sha256']) {
    if (typeof metadata[key] !== 'string') throw new Error('literature index_metadata lacks ' + key + '.');
  }
  return {
    schema_version: metadata.schema_version,
    builder_version: metadata.builder_version ?? null,
    logical_rows_sha256: metadata.logical_rows_sha256,
    input_manifest_sha256: metadata.input_manifest_sha256,
    file_count: metadata.file_count ?? null,
    unit_count: metadata.unit_count ?? null,
  };
}

function formQuery(form) {
  const useFts = [...form].length >= 3;
  const where = (useFts ? 'unit_fts MATCH ? AND ' : '') + 'instr(u.text, ?) > 0';
  const parameters = [...(useFts ? [ftsPattern(form)] : []), form];
  const from = `FROM text_units u JOIN source_files f USING (file_id) JOIN works w ON w.file_id = f.file_id
      ${useFts ? 'JOIN unit_fts ON unit_fts.rowid = u.unit_rowid' : ''} WHERE u.kind = 'text' AND ${where}`;
  return { from, parameters };
}

// Exact union over all forms, independent of the fetch cap.
function exactTotals(database, forms) {
  const parts = forms.map(({ form }) => formQuery(form));
  const sql = parts.map(({ from }) => `SELECT u.unit_rowid AS unit, w.work_id AS work ${from}`).join(' UNION ');
  const { units, works } = database.prepare(`SELECT count(*) AS units, count(DISTINCT work) AS works FROM (${sql})`).get(...parts.flatMap(({ parameters }) => parameters));
  return { units, works };
}

function collectHits(database, forms, fetchCap) {
  const hits = new Map(); // unit_rowid → hit
  const perForm = [];
  for (const { form } of forms) {
    const { from, parameters } = formQuery(form);
    const { n, works } = database.prepare(`SELECT count(*) AS n, count(DISTINCT w.work_id) AS works ${from}`).get(...parameters);
    const rows = database.prepare(`
      SELECT u.unit_rowid, u.file_id, u.ordinal, u.block_ordinal, w.work_id, w.author, f.genre, f.source_sha256
      ${from} ORDER BY (u.unit_rowid * 2654435761) % 4294967296, u.unit_rowid LIMIT ?`).all(...parameters, fetchCap);
    perForm.push({ form, unit_matches: n, distinct_works: works, fetched: rows.length, truncated: rows.length < n });
    for (const row of rows) {
      const hit = hits.get(row.unit_rowid) ?? { ...row, matched_forms: [] };
      hit.matched_forms.push(form);
      hits.set(row.unit_rowid, hit);
    }
  }
  return { hits: [...hits.values()], perForm };
}

/**
 * Deterministic diversified selection. Hits sharing a text unit are merged; hits in the same
 * block of a work count once. Rounds of at most `maxPerWork` hits per work; within a round the
 * next pick favours an unrepresented genre, then an unrepresented author (weak: filename-derived,
 * unverified), then a stable hash order. Pure function of its inputs.
 */
export function selectRepresentativeHits(hits, { maxContexts = DEFAULT_MAX_CONTEXTS, maxPerWork = DEFAULT_MAX_PER_WORK, seed = '' } = {}) {
  if (!Number.isSafeInteger(maxContexts) || maxContexts < 1 || maxContexts > MAX_CONTEXTS_LIMIT) {
    throw new TypeError('maxContexts must be an integer from 1 to ' + MAX_CONTEXTS_LIMIT + '.');
  }
  if (!Number.isSafeInteger(maxPerWork) || maxPerWork < 1 || maxPerWork > 3) throw new TypeError('maxPerWork must be an integer from 1 to 3.');
  const blockSeen = new Set();
  const byWork = new Map();
  for (const hit of [...hits].sort((a, b) => a.file_id - b.file_id || a.ordinal - b.ordinal)) {
    const blockKey = hit.file_id + ':' + hit.block_ordinal;
    if (blockSeen.has(blockKey)) continue;
    blockSeen.add(blockKey);
    const list = byWork.get(hit.work_id) ?? [];
    list.push({ ...hit, order: sha256(seed + '\0' + hit.source_sha256 + '\0' + hit.ordinal) });
    byWork.set(hit.work_id, list);
  }
  for (const list of byWork.values()) list.sort((a, b) => compare(a.order, b.order));
  const selected = [];
  const genres = new Map();
  const authors = new Map();
  const taken = new Map();
  for (let round = 1; round <= maxPerWork && selected.length < maxContexts; round += 1) {
    const pool = [...byWork].filter(([, list]) => list.length >= round && (taken.get(list[0].work_id) ?? 0) < round);
    while (selected.length < maxContexts && pool.length > 0) {
      let best = 0;
      const rank = ([, list]) => [genres.get(list[0].genre) ?? 0, list[0].author ? (authors.get(list[0].author) ?? 0) : 0, list[round - 1].order];
      for (let index = 1; index < pool.length; index += 1) {
        const a = rank(pool[index]);
        const b = rank(pool[best]);
        if (a[0] - b[0] < 0 || (a[0] === b[0] && (a[1] - b[1] < 0 || (a[1] === b[1] && compare(a[2], b[2]) < 0)))) best = index;
      }
      const [workId, list] = pool.splice(best, 1)[0];
      const hit = list[round - 1];
      selected.push(hit);
      taken.set(workId, round);
      genres.set(hit.genre, (genres.get(hit.genre) ?? 0) + 1);
      if (hit.author) authors.set(hit.author, (authors.get(hit.author) ?? 0) + 1);
    }
  }
  return selected;
}

/** Whole block when small, else ±FALLBACK_NEIGHBOR_UNITS units clipped to the block. Never leaves the file or block. */
export function expandContext(database, hit) {
  const block = database.prepare(`SELECT ordinal, text FROM text_units
    WHERE file_id = ? AND block_ordinal = ? AND kind = 'text' ORDER BY ordinal`).all(hit.file_id, hit.block_ordinal);
  const chars = block.reduce((total, unit) => total + [...unit.text].length, 0);
  const whole = block.length <= MAX_BLOCK_UNITS && chars <= MAX_BLOCK_CHARS;
  const units = whole ? block : block.filter((unit) => Math.abs(unit.ordinal - hit.ordinal) <= FALLBACK_NEIGHBOR_UNITS);
  return { expansion: whole ? 'block' : 'neighbor_units', units: units.map(({ ordinal, text }) => ({ ordinal, text, is_hit: ordinal === hit.ordinal })) };
}

export function retrieveLiteratureEvidence({
  databasePath = DEFAULT_FULL_LITERATURE_INDEX_PATH,
  identity,
  searchForms,
  maxContexts = DEFAULT_MAX_CONTEXTS,
  maxPerWork = DEFAULT_MAX_PER_WORK,
  hitFetchCap = HIT_FETCH_CAP,
}) {
  if (!searchForms?.forms?.length) throw new Error('No usable search forms.');
  const startedAt = process.hrtime.bigint();
  const database = new DatabaseSync(path.resolve(databasePath), { readOnly: true });
  try {
    const metadata = metadataOf(database);
    const { hits, perForm } = collectHits(database, searchForms.forms, hitFetchCap);
    const totals = exactTotals(database, searchForms.forms);
    const seed = (identity.batch_id ?? '') + '/' + (identity.candidate_id ?? '');
    const selected = selectRepresentativeHits(hits, { maxContexts, maxPerWork, seed });
    const contexts = selected.map((hit) => {
      const { expansion, units } = expandContext(database, hit);
      return {
        work_id: hit.work_id,
        genre: hit.genre,
        author_unverified: hit.author,
        unit_ordinal: hit.ordinal,
        block_ordinal: hit.block_ordinal,
        matched_forms: hit.matched_forms,
        expansion,
        location_digest: sha256(hit.source_sha256 + ':' + hit.ordinal),
        context_digest: sha256(units.map((unit) => unit.ordinal + ':' + unit.text).join('\n')),
        units,
      };
    });
    const works = database.prepare('SELECT count(DISTINCT work_id) AS n FROM works').get().n;
    const lookupMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    const summary = {
      contract: EVIDENCE_CONTRACT,
      tool_identity: EVIDENCE_TOOL_IDENTITY,
      ...identity,
      lemma: identity.lemma,
      search_forms: searchForms.forms,
      skipped_forms: searchForms.skipped,
      per_form: perForm,
      // Exact over all forms (not limited by the fetch cap).
      total_match_units: totals.units,
      distinct_works_matched: totals.works,
      // Fetched pool the selection drew from; smaller than the totals when `fetch_truncated`.
      sampled_match_units: hits.length,
      sampled_works: new Set(hits.map((hit) => hit.work_id)).size,
      fetch_truncated: perForm.some((entry) => entry.truncated),
      genres_matched: [...new Set(hits.map((hit) => hit.genre))].sort(compare),
      contexts_returned: contexts.length,
      distinct_works_returned: new Set(contexts.map((c) => c.work_id)).size,
      genres_returned: [...new Set(contexts.map((c) => c.genre))].sort(compare),
      bounds: { max_contexts: maxContexts, max_per_work: maxPerWork, hit_fetch_cap: hitFetchCap },
      useful_evidence: contexts.length > 0,
      no_evidence_note: contexts.length === 0 ? 'no literature hits; this is not negative evidence' : null,
      literature_works_total: works,
      literature_index: metadata,
      selected_location_digests: contexts.map((c) => c.location_digest),
      lookup_ms: lookupMs,
    };
    return { summary, contexts };
  } finally {
    database.close();
  }
}

// ------------------------------------------------------------------------- pack

export function assertLocalOutputDirectory(directory, cacheRoot = CACHE_PATHS.root) {
  assertWithinDirectory(cacheRoot, directory, { label: 'Literature evidence output' });
  return assertWithinDirectory(path.join(cacheRoot, 'evidence'), directory, {
    label: 'Literature evidence output',
  });
}

export function renderEvidenceMarkdown({ summary, contexts }) {
  const lines = [
    `# ${summary.candidate_id} ${summary.lemma} — literature evidence (local only)`,
    '',
    'Evidence only: no POS, sense, disposition or literal/figurative decision. No hits is not negative evidence.',
    `Forms: ${summary.search_forms.map((f) => f.form).join(', ')} · matches ${summary.total_match_units} units in ${summary.distinct_works_matched} works${summary.fetch_truncated ? ` (selected from a sample of ${summary.sampled_match_units} units in ${summary.sampled_works} works; fetch cap reached)` : ''} · returned ${summary.contexts_returned}`,
    '',
  ];
  contexts.forEach((context, index) => {
    lines.push(`## ${index + 1}. work ${context.work_id} (${context.genre}; ${context.expansion}; forms ${context.matched_forms.join(', ')})`, '');
    for (const unit of context.units) lines.push((unit.is_hit ? '> ' : '  ') + unit.text);
    lines.push('');
  });
  return lines.join('\n');
}

export async function writeEvidencePack(result, { outputDirectory = EVIDENCE_OUTPUT_DIRECTORY, cacheRoot = CACHE_PATHS.root } = {}) {
  const directory = assertLocalOutputDirectory(path.join(outputDirectory, result.summary.batch_id), cacheRoot);
  await mkdir(directory, { recursive: true });
  const candidateDirectory = path.join(directory, result.summary.candidate_id);
  await mkdir(candidateDirectory);
  const files = {
    pack: path.join(candidateDirectory, 'pack.json'),
    markdown: path.join(candidateDirectory, 'evidence.md'),
    summary: path.join(candidateDirectory, 'summary.json'),
  };
  await writeFile(files.pack, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  await writeFile(files.markdown, renderEvidenceMarkdown(result), { flag: 'wx' });
  await writeFile(files.summary, JSON.stringify(result.summary, null, 2) + '\n', { flag: 'wx' });
  return files;
}
