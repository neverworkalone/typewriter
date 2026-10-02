/**
 * Slice a batch's local candidate inventory into bounded worker packets.
 *
 * Authors and independent reviewers each receive a packet containing only the
 * evidence they need: the candidate's identity fields, coverage state, observed
 * forms, and up to three bounded context windows. The packet holds corpus text,
 * so it is written under ignored `data/reference/` and is never tracked; only
 * its SHA-256 is recorded in the tracked reviewer run record.
 *
 *   node scripts/batch/make-review-packets.mjs --directory=data/reference/production/issue-240/corpus-batch-10 --shards=5
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WINDOW_BEFORE = 170;
const WINDOW_AFTER = 170;
const TOP_FORMS = 6;

const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** A context window around the observed eojeol; whole paragraphs are not sent. */
export function contextWindow(paragraph, surface) {
  const text = String(paragraph).replace(/\s+/gu, ' ').trim();
  const at = typeof surface === 'string' && surface.length > 0 ? text.indexOf(surface) : -1;
  if (at < 0) return text.slice(0, WINDOW_BEFORE + WINDOW_AFTER);
  const start = Math.max(0, at - WINDOW_BEFORE);
  const end = Math.min(text.length, at + surface.length + WINDOW_AFTER);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

export function packetCandidate(candidate, ordinal) {
  return {
    ordinal,
    lemma: candidate.proposed_lemma,
    proposed_pos: candidate.proposed_pos,
    analyzer_pos: candidate.analyzer_pos,
    coverage_status: candidate.coverage_status,
    ambiguity_status: candidate.ambiguity_status,
    pos_interpretation_count: candidate.pos_interpretation_count_in_sample,
    ambiguous_observed_surface_count: candidate.ambiguous_observed_surface_count_in_sample,
    observed_forms: candidate.observed_surface_forms.slice(0, TOP_FORMS).map((form) => ({
      surface: form.surface,
      count: form.kiwi_morpheme_occurrences_in_sample,
    })),
    observed_morpheme_spans: candidate.observed_morpheme_spans.map((span) => span.surface),
    contexts: candidate.evidence.representative_hits.map((hit, index) => ({
      index,
      observed_form: hit.matched_surface_form ?? null,
      text: contextWindow(hit.context ?? '', hit.matched_surface_form),
    })),
  };
}

/** Even contiguous ranges, e.g. 500 over 5 shards → 100 each. */
export function shardRanges(total, shards) {
  const base = Math.floor(total / shards);
  const extra = total % shards;
  const ranges = [];
  let next = 1;
  for (let shard = 0; shard < shards; shard += 1) {
    const size = base + (shard < extra ? 1 : 0);
    if (size === 0) continue;
    ranges.push({ shard: shard + 1, first_ordinal: next, last_ordinal: next + size - 1 });
    next += size;
  }
  return ranges;
}

export async function makePackets({ directory, shards }) {
  const absolute = path.resolve(ROOT, directory);
  const inventory = JSON.parse(await readFile(path.join(absolute, 'candidate-inventory.json'), 'utf8'));
  const candidates = inventory.candidates.map((candidate, index) => packetCandidate(candidate, index + 1));
  const outputDirectory = path.join(absolute, 'packets');
  await mkdir(outputDirectory, { recursive: true });
  const manifest = [];
  for (const range of shardRanges(candidates.length, shards)) {
    const packet = {
      kind: 'candidate-evidence-packet',
      batch_directory: directory,
      shard: range.shard,
      first_ordinal: range.first_ordinal,
      last_ordinal: range.last_ordinal,
      candidates: candidates.slice(range.first_ordinal - 1, range.last_ordinal),
    };
    const bytes = Buffer.from(`${JSON.stringify(packet, null, 1)}\n`, 'utf8');
    const name = `packet-${String(range.shard).padStart(2, '0')}.json`;
    await writeFile(path.join(outputDirectory, name), bytes);
    manifest.push({ ...range, file: `packets/${name}`, packet_sha256: sha256Bytes(bytes), candidate_count: packet.candidates.length });
  }
  await writeFile(path.join(outputDirectory, 'packet-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = Object.fromEntries(process.argv.slice(2).map((argument) => {
    const match = /^--([a-z-]+)=(.*)$/u.exec(argument);
    if (!match) throw new Error(`invalid argument ${argument}; use --name=value`);
    return [match[1], match[2]];
  }));
  if (!options.directory) throw new Error('usage: make-review-packets.mjs --directory=data/reference/... [--shards=5]');
  const shards = Number(options.shards ?? 5);
  if (!Number.isSafeInteger(shards) || shards < 1 || shards > 20) throw new Error('--shards must be an integer from 1 to 20');
  console.log(JSON.stringify(await makePackets({ directory: options.directory, shards }), null, 2));
}
