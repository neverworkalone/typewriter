import { createHash } from 'node:crypto';

import { PARTS_OF_SPEECH } from '../validate/canonical-jsonl.mjs';

// Relation candidate retrieval (issue #397). Cheap, deterministic, machine-only shortlist of plausible
// relation TARGET senses for reviewed source senses, so Stage 2 inspects a bounded list instead of the
// whole dictionary. This module only proposes candidates: it never judges validity, never picks a relation
// type or relevance, never mutates canonical data and never creates a reverse edge. Internal similarity
// scores order the pool but are intentionally NOT part of the artifact (they are not lexical truth).

export const RETRIEVER_CONTRACT = 'relation-candidate-retrieval-v1';
export const ARTIFACT_AUTHORITY = 'candidates_only';

export const SIGNAL_CODES = Object.freeze([
  'explicit_hint',
  'relation_neighbor_of_hint',
  'relation_neighbor_of_related',
  'incoming_relation',
  'shared_search_form',
  'lemma_in_target_gloss',
  'target_lemma_in_gloss',
  'gloss_overlap',
  'literature_cooccurrence',
]);

// Ordering weights (retrieval-internal only).
const WEIGHTS = Object.freeze({
  explicit_hint: 100,
  relation_neighbor_of_hint: 12,
  relation_neighbor_of_related: 8,
  incoming_relation: 10,
  shared_search_form: 6,
  lemma_in_target_gloss: 7,
  target_lemma_in_gloss: 7,
  gloss_overlap: 20, // multiplied by the normalized cosine score
  literature_cooccurrence: 2,
});

// Pool limits are configuration, not lexical truth. 200 is twice the 100-result exploratory UI so the UI
// can always be populated after Stage 2 drops rejected candidates; it is a pilot-measured default.
export const DEFAULT_CONFIG = Object.freeze({
  max_candidates: 200,
  min_shared_bigrams: 2,
  min_gloss_cosine: 0.12,
  stop_bigram_df_ratio: 0.02,
  max_literature_digests: 3,
});

const CONFIG_RULES = Object.freeze({
  max_candidates: { integer: true, min: 1, max: 1000 },
  min_shared_bigrams: { integer: true, min: 1, max: 20 },
  min_gloss_cosine: { min: 0, max: 1 },
  stop_bigram_df_ratio: { min: 0.0001, max: 1 },
  max_literature_digests: { integer: true, min: 1, max: 20 },
});

/** Merges and validates retrieval settings; unbounded or malformed values would disable the pool contract. */
export function resolveConfig(...layers) {
  const settings = Object.assign({}, ...layers);
  for (const key of Object.keys(settings)) if (!(key in CONFIG_RULES)) throw new Error(`unknown retrieval setting ${key}`);
  for (const [key, rule] of Object.entries(CONFIG_RULES)) {
    const value = settings[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || (rule.integer && !Number.isInteger(value)) || value < rule.min || value > rule.max) {
      throw new Error(`retrieval setting ${key} must be a finite ${rule.integer ? 'integer' : 'number'} in [${rule.min}, ${rule.max}]`);
    }
  }
  return settings;
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const isPos = (value) => typeof value === 'string' && PARTS_OF_SPEECH.includes(value);
const HANGUL = /[\p{Script=Hangul}A-Za-z0-9]/u;

const bigramsOf = (text) => {
  const chars = [...String(text ?? '')].filter((ch) => HANGUL.test(ch));
  const out = new Set();
  for (let i = 0; i + 1 < chars.length; i += 1) out.add(chars[i] + chars[i + 1]);
  return out;
};

// Dictionary-form stem: 먹다 -> 먹, 따뜻하다 -> 따뜻하 -> kept whole when the stem is a single character.
// Without a trusted canonical revision, hash every canonical field retrieval depends on.
const fallbackDigest = (senses) => sha256(JSON.stringify(senses.map((s) => [
  s.record_id, s.sense_id, s.pos, s.lemma, s.gloss, s.search_forms,
  s.relations.map((r) => [r.target, r.target_sense]),
])));

const stemOf = (lemma, pos) => {
  const chars = [...lemma];
  const isPredicate = pos === 'verb' || pos === 'adjective';
  if (isPredicate && chars.length >= 3 && chars.at(-1) === '다') return chars.slice(0, -1).join('');
  return lemma;
};
const MIN_FORM_CHARS = 2;

/**
 * Index the canonical snapshot once; reuse for every source of a batch/session.
 * `canonical` is `{ canonicalRevision, records }` where each record is a canonical entry or `{ record }`.
 */
export function buildRelationIndex(canonical, config = {}) {
  const settings = Object.freeze(resolveConfig(DEFAULT_CONFIG, config)); // fixed once postings are built
  const senses = [];
  const bySenseId = new Map();
  const byRecordId = new Map();
  const byLemma = new Map();
  const bySearchForm = new Map();

  for (const info of canonical.records) {
    const record = info.record ?? info;
    if (!record || !Array.isArray(record.senses)) continue;
    byRecordId.set(record.id, record);
    for (const sense of record.senses) {
      const entry = {
        record_id: record.id,
        sense_id: sense.id,
        pos: sense.pos,
        lemma: record.lemma,
        stem: stemOf(record.lemma, sense.pos),
        gloss: sense.gloss ?? '',
        search_forms: record.search_forms ?? [],
        relations: sense.relations ?? [],
        index: senses.length,
      };
      senses.push(entry);
      bySenseId.set(sense.id, entry);
      for (const key of [record.lemma, ...entry.search_forms]) {
        const list = bySearchForm.get(key) ?? [];
        if (!list.includes(entry.index)) list.push(entry.index);
        bySearchForm.set(key, list);
      }
      const lemmaList = byLemma.get(record.lemma) ?? [];
      lemmaList.push(entry.index);
      byLemma.set(record.lemma, lemmaList);
    }
  }

  // Relation graph over sense indexes (outgoing/incoming), canonical targets only.
  const outgoing = senses.map(() => new Set());
  const incoming = senses.map(() => new Set());
  for (const entry of senses) {
    for (const relation of entry.relations) {
      const target = bySenseId.get(relation.target_sense);
      if (!target) continue;
      outgoing[entry.index].add(target.index);
      incoming[target.index].add(entry.index);
    }
  }

  // Gloss+lemma bigram postings with IDF; very common bigrams (particles/endings) are stop-grams.
  const postings = new Map();
  const bigramSets = senses.map((entry) => bigramsOf(`${entry.lemma} ${entry.gloss}`));
  bigramSets.forEach((set, index) => {
    for (const gram of set) {
      const list = postings.get(gram);
      if (list) list.push(index); else postings.set(gram, [index]);
    }
  });
  const stopLimit = Math.max(20, Math.floor(senses.length * settings.stop_bigram_df_ratio));
  const idf = new Map();
  for (const [gram, list] of postings) {
    if (list.length > stopLimit) { postings.delete(gram); continue; }
    idf.set(gram, Math.log(1 + senses.length / list.length));
  }
  const norms = bigramSets.map((set) => Math.sqrt([...set].reduce((sum, gram) => sum + (idf.get(gram) ?? 0) ** 2, 0)) || 1);

  // Literature scanning: lemma stems and search forms of at least MIN_FORM_CHARS characters.
  const literatureForms = new Map();
  for (const entry of senses) {
    for (const form of new Set([entry.stem, ...entry.search_forms])) {
      if ([...form].length < MIN_FORM_CHARS) continue;
      const list = literatureForms.get(form) ?? [];
      list.push(entry.index);
      literatureForms.set(form, list);
    }
  }
  const literatureFormLengths = [...new Set([...literatureForms.keys()].map((form) => [...form].length))].sort((a, b) => a - b);

  return Object.freeze({
    contract: RETRIEVER_CONTRACT,
    settings,
    canonical_snapshot_digest: canonical.canonicalRevision ?? fallbackDigest(senses),
    senses, bySenseId, byRecordId, byLemma, bySearchForm, outgoing, incoming,
    postings, idf, norms, bigramSets, literatureForms, literatureFormLengths,
  });
}

const provisionalKey = (source) => `provisional:${source.batch_id}/${source.candidate_id}/${source.sense_key}`;

function normalizeSource(source) {
  const isProvisional = source.kind === 'provisional';
  if (isProvisional) {
    if (!isPos(source.pos) || typeof source.gloss !== 'string') throw new Error('provisional source requires a supported pos and a gloss');
    const parts = [source.batch_id, source.candidate_id, source.sense_key];
    if (parts.some((part) => typeof part !== 'string' || part === '' || part.includes('/')) || !source.lemma) throw new Error('provisional source requires non-empty batch_id, candidate_id, sense_key (without "/") and lemma');
    return { ...source, kind: 'provisional', provisional_id: provisionalKey(source) };
  }
  return { ...source, kind: 'canonical' };
}

function resolveHint(index, hint, provisionalByLemma) {
  if (hint.sense_id && index.bySenseId.has(hint.sense_id)) return { canonical: [index.bySenseId.get(hint.sense_id).index], provisional: [] };
  if (hint.record_id && index.byRecordId.has(hint.record_id)) {
    const record = index.byRecordId.get(hint.record_id);
    return { canonical: record.senses.map((s) => index.bySenseId.get(s.id).index), provisional: [] };
  }
  if (hint.lemma) {
    const canonical = (index.bySearchForm.get(hint.lemma) ?? []).filter((i) => !hint.pos || index.senses[i].pos === hint.pos);
    return { canonical, provisional: provisionalByLemma.get(hint.lemma) ?? [] };
  }
  return { canonical: [], provisional: [] };
}

function scanLiterature(index, contexts) {
  // form -> Set(location_digest); text is read in memory only and never emitted.
  const found = new Map();
  for (const context of contexts) {
    const chars = [...(context.units ? context.units.map((u) => u.text).join('\n') : context.text ?? '')];
    for (const length of index.literatureFormLengths) {
      for (let i = 0; i + length <= chars.length; i += 1) {
        const form = chars.slice(i, i + length).join('');
        if (!index.literatureForms.has(form)) continue;
        const set = found.get(form) ?? new Set();
        set.add(context.location_digest);
        found.set(form, set);
      }
    }
  }
  return found;
}

function addSignal(map, key, code, weight, extra) {
  const entry = map.get(key) ?? { signals: new Map(), score: 0, literature: new Set() };
  if (!entry.signals.has(code)) { entry.signals.set(code, true); entry.score += weight; }
  if (extra) for (const digest of extra) entry.literature.add(digest);
  map.set(key, entry);
}

/**
 * Retrieve candidates for each source. Sources of kind `provisional` are not in the canonical snapshot and
 * may also be targets for the other sources of the same call (same-batch provisional identities).
 */
export function retrieveRelationCandidates(index, rawSources, { config = {}, literature = {} } = {}) {
  if ('stop_bigram_df_ratio' in config && config.stop_bigram_df_ratio !== index.settings.stop_bigram_df_ratio) {
    throw new Error('stop_bigram_df_ratio is fixed when the index is built and cannot be overridden at retrieval time');
  }
  const settings = resolveConfig(index.settings, config);
  const sources = rawSources.map(normalizeSource).map((source) => {
    if (source.kind !== 'canonical') return source;
    // Canonical sources are bound to the snapshot: pos/gloss come from the indexed sense, never the caller.
    const sense = index.bySenseId.get(source.sense_id);
    if (!sense) throw new Error(`unknown canonical source sense ${source.sense_id}`);
    if ((source.pos !== undefined && source.pos !== sense.pos) || (source.gloss !== undefined && source.gloss !== sense.gloss)) {
      throw new Error(`canonical source ${source.sense_id} pos/gloss differs from the canonical snapshot`);
    }
    return { ...source, pos: sense.pos, gloss: sense.gloss };
  });
  const seen = new Set();
  for (const source of sources) {
    const id = source.kind === 'provisional' ? source.provisional_id : source.sense_id;
    if (seen.has(id)) throw new Error(`duplicate source identity ${id}`);
    seen.add(id);
    if (source.kind === 'canonical' && !index.bySenseId.has(source.sense_id)) throw new Error(`unknown canonical source sense ${source.sense_id}`);
  }
  const provisionals = sources.filter((s) => s.kind === 'provisional');
  if (new Set(provisionals.map((p) => p.batch_id)).size > 1) throw new Error('provisional sources of one retrieval call must belong to a single batch');
  const provisionalByLemma = new Map();
  for (const p of provisionals) provisionalByLemma.set(p.lemma, [...(provisionalByLemma.get(p.lemma) ?? []), p.provisional_id]);
  const provisionalGrams = new Map(provisionals.map((p) => [p.provisional_id, bigramsOf(`${p.lemma} ${p.gloss}`)]));

  const results = sources.map((source) => {
    const sourceId = source.kind === 'provisional' ? source.provisional_id : source.sense_id;
    const own = source.kind === 'canonical' ? index.bySenseId.get(source.sense_id) : null;
    const sourceLemma = own ? own.lemma : source.lemma;
    const sourceStem = own ? own.stem : stemOf(source.lemma, source.pos);
    const sourceForms = own ? own.search_forms : (source.search_forms ?? [source.lemma]);
    const ctx = literature[sourceId] ?? [];
    const canonicalHits = new Map(); // sense index -> accumulator
    const provisionalHits = new Map(); // provisional id -> accumulator

    const exclude = new Set();
    if (own) {
      for (const sibling of index.byRecordId.get(own.record_id).senses) exclude.add(index.bySenseId.get(sibling.id).index);
    }
    const existingTargets = own ? index.outgoing[own.index] : new Set();

    // Explicit hints (treated only as hints).
    const hintSenses = new Set();
    for (const hint of source.hints ?? []) {
      const resolved = resolveHint(index, hint, provisionalByLemma);
      for (const i of resolved.canonical) { hintSenses.add(i); addSignal(canonicalHits, i, 'explicit_hint', WEIGHTS.explicit_hint); }
      for (const p of resolved.provisional) addSignal(provisionalHits, p, 'explicit_hint', WEIGHTS.explicit_hint);
    }
    for (const h of hintSenses) {
      for (const n of [...index.outgoing[h], ...index.incoming[h]]) addSignal(canonicalHits, n, 'relation_neighbor_of_hint', WEIGHTS.relation_neighbor_of_hint);
    }

    // Graph neighborhood of the source's own relations.
    if (own) {
      for (const t of existingTargets) {
        for (const n of [...index.outgoing[t], ...index.incoming[t]]) addSignal(canonicalHits, n, 'relation_neighbor_of_related', WEIGHTS.relation_neighbor_of_related);
      }
      for (const from of index.incoming[own.index]) addSignal(canonicalHits, from, 'incoming_relation', WEIGHTS.incoming_relation);
    }

    // Shared search forms (e.g. homograph of another POS).
    for (const form of new Set([sourceLemma, ...sourceForms])) {
      for (const i of index.bySearchForm.get(form) ?? []) addSignal(canonicalHits, i, 'shared_search_form', WEIGHTS.shared_search_form);
    }

    // Lemma <-> gloss containment.
    const stemChars = [...sourceStem].length;
    if (stemChars >= MIN_FORM_CHARS) {
      for (const entry of index.senses) {
        if (entry.gloss.includes(sourceStem)) addSignal(canonicalHits, entry.index, 'lemma_in_target_gloss', WEIGHTS.lemma_in_target_gloss);
      }
      for (const p of provisionals) {
        if (p.provisional_id !== sourceId && p.gloss.includes(sourceStem)) addSignal(provisionalHits, p.provisional_id, 'lemma_in_target_gloss', WEIGHTS.lemma_in_target_gloss);
      }
    }
    for (const [form, list] of index.literatureForms) {
      if (!source.gloss.includes(form)) continue;
      for (const i of list) if (index.senses[i].stem === form || index.senses[i].search_forms.includes(form)) addSignal(canonicalHits, i, 'target_lemma_in_gloss', WEIGHTS.target_lemma_in_gloss);
    }
    for (const p of provisionals) {
      if (p.provisional_id !== sourceId && [...stemOf(p.lemma, p.pos)].length >= MIN_FORM_CHARS && source.gloss.includes(stemOf(p.lemma, p.pos))) addSignal(provisionalHits, p.provisional_id, 'target_lemma_in_gloss', WEIGHTS.target_lemma_in_gloss);
    }

    // IDF-weighted bigram cosine over lemma+gloss.
    const sourceGrams = bigramsOf(`${sourceLemma} ${source.gloss}`);
    const shared = new Map();
    for (const gram of sourceGrams) {
      const list = index.postings.get(gram);
      if (!list) continue;
      for (const i of list) {
        const acc = shared.get(i) ?? { count: 0, dot: 0 };
        acc.count += 1; acc.dot += index.idf.get(gram) ** 2;
        shared.set(i, acc);
      }
    }
    const sourceNorm = Math.sqrt([...sourceGrams].reduce((sum, gram) => sum + (index.idf.get(gram) ?? 0) ** 2, 0)) || 1;
    for (const [i, acc] of shared) {
      const cosine = acc.dot / (sourceNorm * index.norms[i]);
      if (acc.count >= settings.min_shared_bigrams && cosine >= settings.min_gloss_cosine) addSignal(canonicalHits, i, 'gloss_overlap', WEIGHTS.gloss_overlap * cosine);
    }
    for (const p of provisionals) {
      if (p.provisional_id === sourceId) continue;
      const grams = provisionalGrams.get(p.provisional_id);
      const common = [...sourceGrams].filter((g) => grams.has(g));
      const cosine = common.length / Math.sqrt(Math.max(1, sourceGrams.size) * Math.max(1, grams.size));
      if (common.length >= settings.min_shared_bigrams && cosine >= settings.min_gloss_cosine) addSignal(provisionalHits, p.provisional_id, 'gloss_overlap', WEIGHTS.gloss_overlap * cosine);
    }

    // Literature co-occurrence (digests only; text never leaves memory). No hit adds nothing.
    const found = ctx.length > 0 ? scanLiterature(index, ctx) : new Map();
    for (const [form, digests] of found) {
      if (form === sourceStem || sourceForms.includes(form)) continue;
      for (const i of index.literatureForms.get(form)) {
        const entry = index.senses[i];
        if (entry.stem !== form && !entry.search_forms.includes(form)) continue;
        addSignal(canonicalHits, i, 'literature_cooccurrence', WEIGHTS.literature_cooccurrence * Math.min(digests.size, 3), digests);
      }
    }

    const candidates = [];
    for (const [i, acc] of canonicalHits) {
      if (exclude.has(i) || i === own?.index) continue;
      if (existingTargets.has(i)) continue;
      const entry = index.senses[i];
      candidates.push({
        sort: [-acc.score, entry.sense_id],
        record: {
          target: { kind: 'canonical', record_id: entry.record_id, sense_id: entry.sense_id, pos: entry.pos },
          signals: SIGNAL_CODES.filter((code) => acc.signals.has(code)),
          ...(acc.literature.size ? { literature_location_digests: [...acc.literature].sort(compare).slice(0, settings.max_literature_digests) } : {}),
        },
      });
    }
    for (const [pid, acc] of provisionalHits) {
      const p = provisionals.find((x) => x.provisional_id === pid);
      candidates.push({
        sort: [-acc.score, pid],
        record: {
          target: { kind: 'provisional', provisional_id: pid, candidate_id: p.candidate_id, pos: p.pos },
          signals: SIGNAL_CODES.filter((code) => acc.signals.has(code)),
        },
      });
    }
    candidates.sort((a, b) => a.sort[0] - b.sort[0] || compare(a.sort[1], b.sort[1]));
    const pool = candidates.slice(0, settings.max_candidates);
    return {
      source: own
        ? { kind: 'canonical', record_id: own.record_id, sense_id: own.sense_id, pos: own.pos }
        : { kind: 'provisional', provisional_id: sourceId, candidate_id: source.candidate_id, pos: source.pos },
      literature: {
        status: ctx.length > 0 ? 'attempted' : 'not_provided',
        contexts_scanned: ctx.length,
        no_hit_is_negative_evidence: false,
      },
      candidates_total: candidates.length,
      already_related_excluded: existingTargets.size,
      candidates: pool.map((c, position) => ({ rank: position + 1, ...c.record })),
    };
  });

  return {
    contract: RETRIEVER_CONTRACT,
    authority: ARTIFACT_AUTHORITY,
    canonical_snapshot_digest: index.canonical_snapshot_digest,
    config: { max_candidates: settings.max_candidates, min_shared_bigrams: settings.min_shared_bigrams, min_gloss_cosine: settings.min_gloss_cosine, stop_bigram_df_ratio: settings.stop_bigram_df_ratio, max_literature_digests: settings.max_literature_digests },
    signal_codes: SIGNAL_CODES,
    sources: results,
  };
}

const HEX64 = /^[0-9a-f]{64}$/u;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasExactKeys = (value, required, optional = []) => {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key));
};
const PROVISIONAL_ID = /^provisional:([^/]+)\/([^/]+)\/([^/]+)$/u;

/**
 * Strict structural validation of an artifact; returns error strings (never throws on malformed input).
 * `index` additionally binds canonical identities and the snapshot digest to the current canonical.
 */
export function validateRelationCandidateArtifact(artifact, index = null, { expectedSourceIds = null } = {}) {
  const errors = [];
  if (!isObject(artifact)) return ['artifact must be an object'];
  if (!hasExactKeys(artifact, ['contract', 'authority', 'canonical_snapshot_digest', 'config', 'signal_codes', 'sources'])) errors.push('artifact must have exactly contract, authority, canonical_snapshot_digest, config, signal_codes, sources');
  if (artifact.contract !== RETRIEVER_CONTRACT) errors.push('contract mismatch');
  if (artifact.authority !== ARTIFACT_AUTHORITY) errors.push('artifact must be candidates_only');
  if (!HEX64.test(artifact.canonical_snapshot_digest ?? '')) errors.push('missing canonical_snapshot_digest');
  if (index && artifact.canonical_snapshot_digest !== index.canonical_snapshot_digest) errors.push('canonical snapshot digest differs from the current canonical');
  if (index && artifact.config?.stop_bigram_df_ratio !== index.settings.stop_bigram_df_ratio) errors.push('config: stop_bigram_df_ratio differs from the index build setting');
  if (JSON.stringify(artifact.signal_codes) !== JSON.stringify(SIGNAL_CODES)) errors.push('signal_codes mismatch');
  let config = null;
  try { config = isObject(artifact.config) && hasExactKeys(artifact.config, Object.keys(CONFIG_RULES)) ? resolveConfig(artifact.config) : null; } catch (error) { errors.push(`config: ${error.message}`); }
  if (config === null && !errors.some((e) => e.startsWith('config:'))) errors.push('config must contain exactly the retrieval settings');
  if (!Array.isArray(artifact.sources)) return [...errors, 'sources must be an array'];

  const batches = new Set();
  const noteBatch = (id) => { const match = PROVISIONAL_ID.exec(id ?? ''); if (match) batches.add(match[1]); };
  const allowed = new Set(SIGNAL_CODES);
  const sourceIds = new Set();
  const provisionalSources = new Map();
  for (const entry of artifact.sources) if (entry?.source?.kind === 'provisional') provisionalSources.set(entry.source.provisional_id, entry.source);
  for (const [s, entry] of artifact.sources.entries()) {
    const at = `sources[${s}]`;
    if (!isObject(entry) || !hasExactKeys(entry, ['source', 'literature', 'candidates_total', 'already_related_excluded', 'candidates'])) { errors.push(`${at}: invalid shape`); continue; }
    const source = entry.source;
    if (!isObject(source)) errors.push(`${at}: source must be an object`);
    else if (source.kind === 'canonical') {
      if (!hasExactKeys(source, ['kind', 'record_id', 'sense_id', 'pos']) || ![source.record_id, source.sense_id].every((v) => typeof v === 'string' && v) || !isPos(source.pos)) errors.push(`${at}: invalid canonical source identity`);
      else if (index) { const sense = index.bySenseId.get(source.sense_id); if (!sense || sense.record_id !== source.record_id || sense.pos !== source.pos) errors.push(`${at}: source does not match canonical`); }
      if (sourceIds.has(source.sense_id)) errors.push(`${at}: duplicate source ${source.sense_id}`); sourceIds.add(source.sense_id);
    } else if (source.kind === 'provisional') {
      if (!hasExactKeys(source, ['kind', 'provisional_id', 'candidate_id', 'pos']) || !PROVISIONAL_ID.test(source.provisional_id ?? '') || !source.candidate_id || !isPos(source.pos)) errors.push(`${at}: invalid provisional source identity`);
      else if (PROVISIONAL_ID.exec(source.provisional_id)[2] !== source.candidate_id) errors.push(`${at}: provisional_id does not carry candidate_id`);
      noteBatch(source.provisional_id);
      if (sourceIds.has(source.provisional_id)) errors.push(`${at}: duplicate source ${source.provisional_id}`); sourceIds.add(source.provisional_id);
    } else errors.push(`${at}: source kind must be canonical or provisional`);

    const lit = entry.literature;
    if (!isObject(lit) || !hasExactKeys(lit, ['status', 'contexts_scanned', 'no_hit_is_negative_evidence']) || !['attempted', 'not_provided'].includes(lit.status) || !Number.isInteger(lit.contexts_scanned) || lit.contexts_scanned < 0 || lit.no_hit_is_negative_evidence !== false) errors.push(`${at}: invalid literature record (no-hit must not be negative evidence)`);
    if (!Array.isArray(entry.candidates)) { errors.push(`${at}: candidates must be an array`); continue; }
    if (!Number.isInteger(entry.candidates_total) || entry.candidates_total < entry.candidates.length) errors.push(`${at}: invalid candidates_total`);
    if (!Number.isInteger(entry.already_related_excluded) || entry.already_related_excluded < 0) errors.push(`${at}: invalid already_related_excluded`);
    if (config && entry.candidates.length > config.max_candidates) errors.push(`${at}: pool exceeds declared max_candidates`);

    const targets = new Set();
    for (const [position, candidate] of entry.candidates.entries()) {
      const here = `${at}.candidates[${position}]`;
      if (!isObject(candidate) || !hasExactKeys(candidate, ['rank', 'target', 'signals'], ['literature_location_digests'])) { errors.push(`${here}: invalid shape (editorial fields are not allowed)`); continue; }
      if (candidate.rank !== position + 1) errors.push(`${here}: rank order broken`);
      if (!Array.isArray(candidate.signals) || candidate.signals.length === 0 || candidate.signals.some((code) => !allowed.has(code))) errors.push(`${here}: invalid signals`);
      const digests = candidate.literature_location_digests;
      if (candidate.signals?.includes?.('literature_cooccurrence') && (!Array.isArray(digests) || digests.length === 0)) errors.push(`${here}: literature_cooccurrence requires at least one location digest`);
      if (digests !== undefined) {
        if (!Array.isArray(digests) || digests.length === 0 || !digests.every((d) => HEX64.test(d)) || (config && digests.length > config.max_literature_digests)) errors.push(`${here}: invalid literature_location_digests`);
        if (!candidate.signals?.includes?.('literature_cooccurrence')) errors.push(`${here}: literature digests without literature_cooccurrence signal`);
      }
      const target = candidate.target;
      if (!isObject(target)) { errors.push(`${here}: target must be an object`); continue; }
      let key = null;
      if (target.kind === 'canonical') {
        if (!hasExactKeys(target, ['kind', 'record_id', 'sense_id', 'pos']) || ![target.record_id, target.sense_id].every((v) => typeof v === 'string' && v) || !isPos(target.pos)) errors.push(`${here}: invalid canonical target identity`);
        else {
          key = target.sense_id;
          if (index) { const sense = index.bySenseId.get(target.sense_id); if (!sense || sense.record_id !== target.record_id || sense.pos !== target.pos) errors.push(`${here}: target does not match canonical`); }
        }
      } else if (target.kind === 'provisional') {
        const match = PROVISIONAL_ID.exec(target.provisional_id ?? '');
        if (!hasExactKeys(target, ['kind', 'provisional_id', 'candidate_id', 'pos']) || !match || !target.candidate_id || !isPos(target.pos)) errors.push(`${here}: invalid provisional target identity`);
        else {
          key = target.provisional_id;
          noteBatch(target.provisional_id);
          if (match[2] !== target.candidate_id) errors.push(`${here}: provisional_id does not carry candidate_id`);
          const declared = provisionalSources.get(target.provisional_id);
          if (!declared) errors.push(`${here}: provisional target is not a source of this artifact`);
          else if (declared.candidate_id !== target.candidate_id || declared.pos !== target.pos) errors.push(`${here}: provisional target candidate_id/pos differs from its source identity`);
        }
      } else errors.push(`${here}: target kind must be canonical or provisional`);
      if (key !== null) { if (targets.has(key)) errors.push(`${here}: duplicate target ${key}`); targets.add(key); }
    }
  }
  if (batches.size > 1) errors.push('provisional identities span more than one batch');
  if (expectedSourceIds) {
    for (const id of expectedSourceIds) if (!sourceIds.has(id)) errors.push(`missing expected source ${id}`);
    for (const id of sourceIds) if (!expectedSourceIds.includes(id)) errors.push(`unexpected source ${id}`);
  }
  return errors;
}
