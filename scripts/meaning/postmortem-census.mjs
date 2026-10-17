#!/usr/bin/env node
// Read-only census for Issue #814 initial-consonant Meaning postmortems.
// Joins data/meanings/cNN_*.jsonl to data/canonical sense text, reports
// coverage and structural indicators, and writes a per-lemma sidecar from a
// hand-authored annotation file. It never edits Meaning/canonical data.
//
// usage: node scripts/meaning/postmortem-census.mjs cNN [--annotations f.json] [--sidecar out.jsonl]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJsonl = (file) =>
  fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// Hangul syllables are grouped by initial consonant in 588-code-point blocks;
// cNN is the NN-th initial (c01 = ㄱ ... c19 = ㅎ), plus the bare jamo itself.
const JAMO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const initialRange = (code) => {
  const n = Number(code.slice(1)) - 1;
  const start = 0xac00 + n * 588;
  return [start, start + 587];
};

export function loadCensus(code) {
  const meaningDir = path.join(root, 'data/meanings');
  const meanings = fs
    .readdirSync(meaningDir)
    .filter((f) => f.startsWith(`${code}_`) && f.endsWith('.jsonl'))
    .sort()
    .flatMap((f) => readJsonl(path.join(meaningDir, f)).map((m) => ({ ...m, shard: f })));

  const [lo, hi] = initialRange(code);
  const canonDir = path.join(root, 'data/canonical');
  const senses = new Map();
  const initialSenses = new Set(); // every canonical sense whose lemma has this initial
  for (const f of fs.readdirSync(canonDir).filter((n) => n.endsWith('.jsonl')).sort()) {
    for (const rec of readJsonl(path.join(canonDir, f))) {
      const cp = rec.lemma?.codePointAt(0);
      const inInitial = (cp >= lo && cp <= hi) || rec.lemma === JAMO[Number(code.slice(1)) - 1];
      for (const s of rec.senses ?? []) {
        if (inInitial) initialSenses.add(s.id);
        senses.set(s.id, { entry: rec.id, lemma: rec.lemma, pos: s.pos, gloss: s.gloss });
      }
    }
  }

  const adjudicated = new Set();
  const adjDir = path.join(root, 'data/adjudication');
  for (const f of fs.readdirSync(adjDir).filter((n) => n.startsWith(`${code}_`))) {
    for (const a of readJsonl(path.join(adjDir, f))) adjudicated.add(a.sense_id);
  }

  const byLemma = new Map();
  for (const m of meanings) {
    if (!byLemma.has(m.lemma)) byLemma.set(m.lemma, []);
    byLemma.get(m.lemma).push(m);
  }
  return { meanings, senses, initialSenses, adjudicated, byLemma };
}

const reference = (g) => /^→ /.test(g);

// Structural indicators: priority aids only, never a semantic verdict.
export function indicators(ctx) {
  const out = { voiceConflict: [], multiTargetReference: [], crossPos: [], mixedReference: [] };
  for (const m of ctx.meanings) {
    const ss = m.sense_ids.map((s) => ctx.senses.get(s));
    const passive = ss.some((s) => /의 피동사/.test(s.gloss));
    const causative = ss.some((s) => /의 사동사/.test(s.gloss));
    if (passive && causative) out.voiceConflict.push(m.id);
    const refs = ss.filter((s) => reference(s.gloss));
    if (new Set(refs.map((s) => s.gloss)).size > 1) out.multiTargetReference.push(m.id);
    if (refs.length && refs.length < ss.length) out.mixedReference.push(m.id);
    if (new Set(ss.map((s) => s.pos)).size > 1) out.crossPos.push(m.id);
  }
  return out;
}

export function census(code, ctx = loadCensus(code)) {
  const { meanings, senses, byLemma, initialSenses, adjudicated } = ctx;
  const owners = new Map();
  for (const m of meanings) for (const s of m.sense_ids) owners.set(s, (owners.get(s) ?? 0) + 1);
  const lemmas = [...byLemma.values()];
  const mergeScope = meanings.filter((m) => m.sense_ids.length > 1);
  const splitScope = lemmas.filter((l) => l.length > 1);
  const readLemmas = new Set([...mergeScope.map((m) => m.lemma), ...splitScope.map((l) => l[0].lemma)]);
  return {
    code,
    shards: new Set(meanings.map((m) => m.shard)).size,
    lemmas: lemmas.length,
    canonicalRecords: new Set([...owners.keys()].map((s) => senses.get(s).entry)).size,
    canonicalSensesOfInitial: initialSenses.size,
    meaningSenses: owners.size,
    meanings: meanings.length,
    adjudicatedSenses: adjudicated.size,
    sensesWithoutMeaningOrAdjudication: [...initialSenses].filter((s) => !owners.has(s) && !adjudicated.has(s)).length,
    sensesOwnedByMoreThanOneMeaning: [...owners].filter(([, n]) => n > 1).length,
    meaningSensesMissingFromCanonical: [...owners.keys()].filter((s) => !senses.has(s)).length,
    singleSenseSingleMeaningLemmas: lemmas.filter((l) => l.length === 1 && l[0].sense_ids.length === 1).length,
    overMergeScopeMeanings: mergeScope.length,
    overMergeScopeSenses: mergeScope.reduce((n, m) => n + m.sense_ids.length, 0),
    overSplitScopeLemmas: splitScope.length,
    overSplitScopeMeanings: splitScope.reduce((n, l) => n + l.length, 0),
    semanticReadLemmas: readLemmas.size,
    indicators: Object.fromEntries(Object.entries(indicators(ctx)).map(([k, v]) => [k, v.length])),
  };
}

const RANK = { over_merge_confirmed: 5, over_split_confirmed: 5, gloss_error_confirmed: 5, suspect_hold: 3, keep_reviewed: 2, unreviewed: 0 };

// Resolve annotations to Meaning ids and build one sidecar row per lemma.
export function sidecar(code, annotationDoc, ctx = loadCensus(code)) {
  const { byLemma, meanings } = ctx;
  const byId = new Map(meanings.map((m) => [m.id, m]));
  const hits = new Map(); // meaning id -> [{status,class}]
  const add = (id, a) => {
    if (!byId.has(id)) throw new Error(`annotation targets unknown Meaning ${id}`);
    if (!hits.has(id)) hits.set(id, []);
    hits.get(id).push({ status: a.status, class: a.class });
  };
  for (const a of annotationDoc.annotations) {
    for (const id of a.meaning_ids ?? []) add(id, a);
    for (const lemma of a.lemmas ?? []) {
      if (!byLemma.has(lemma)) throw new Error(`annotation targets unknown lemma ${lemma}`);
      for (const m of byLemma.get(lemma)) {
        if (a.scope === 'merged' && m.sense_ids.length < 2) continue;
        add(m.id, a);
      }
    }
  }
  const rows = [];
  for (const [lemma, ms] of byLemma) {
    const merged = ms.some((m) => m.sense_ids.length > 1);
    const split = ms.length > 1;
    const scope = merged && split ? 'over_merge+over_split' : merged ? 'over_merge' : split ? 'over_split' : 'single';
    const found = ms.flatMap((m) => hits.get(m.id) ?? []);
    let status;
    if (found.length) status = found.map((f) => f.status).sort((x, y) => RANK[y] - RANK[x])[0];
    else status = scope === 'single' ? 'unreviewed' : 'keep_reviewed';
    rows.push({
      lemma,
      scope,
      status,
      meanings: ms.map((m) => m.id),
      sense_ids: ms.flatMap((m) => m.sense_ids),
      classes: [...new Set(found.map((f) => f.class))].sort(),
    });
  }
  return rows;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const code = process.argv[2];
  if (!/^c(0[1-9]|1[0-9])$/.test(code ?? '')) {
    console.error('usage: postmortem-census.mjs cNN [--annotations f.json] [--sidecar out.jsonl]');
    process.exit(2);
  }
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const ctx = loadCensus(code);
  const summary = census(code, ctx);
  const annPath = arg('--annotations');
  if (annPath) {
    const rows = sidecar(code, JSON.parse(fs.readFileSync(annPath, 'utf8')), ctx);
    summary.statusByLemma = rows.reduce((o, r) => ({ ...o, [r.status]: (o[r.status] ?? 0) + 1 }), {});
    const out = arg('--sidecar');
    if (out) fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  console.log(JSON.stringify(summary, null, 2));
}
