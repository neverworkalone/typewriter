import { createHash } from 'node:crypto';
import path from 'node:path';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function verifiedExclusionManifestLemmas(artifact, relativePath) {
  const { schema_version: schema, lemmas, source_artifacts: sources, exclusion_sha256: recordedDigest } = artifact;
  if (schema !== 'm9-reviewed-lemma-exclusions-v1' || !Array.isArray(lemmas) || !Array.isArray(sources)) {
    throw new Error(`Unsupported or incomplete prior exclusion manifest: ${relativePath}`);
  }
  if (lemmas.length === 0 || lemmas.some((lemma) => (
    typeof lemma !== 'string'
    || lemma.length === 0
    || lemma !== lemma.trim()
    || lemma.normalize('NFC') !== lemma
  ))) {
    throw new Error(`Prior exclusion manifest must contain trimmed NFC lemmas: ${relativePath}`);
  }
  if (sources.length === 0) {
    throw new Error(`Prior exclusion manifest with lemmas must bind at least one source artifact: ${relativePath}`);
  }
  const sortedLemmas = [...new Set(lemmas)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (sortedLemmas.length !== lemmas.length || sortedLemmas.some((lemma, index) => lemma !== lemmas[index])) {
    throw new Error(`Prior exclusion manifest lemmas must be unique and deterministically sorted: ${relativePath}`);
  }
  if (sources.some((source) => !source || typeof source.path !== 'string' || !source.path
    || !/^[0-9a-f]{64}$/u.test(String(source.sha256 ?? '')))) {
    throw new Error(`Prior exclusion manifest sources must bind paths and SHA-256 digests: ${relativePath}`);
  }
  const payload = { lemmas, schema_version: schema, source_artifacts: sources };
  if (recordedDigest !== sha256(JSON.stringify(payload))) {
    throw new Error(`Prior exclusion manifest digest does not match its contents: ${relativePath}`);
  }
  return lemmas;
}

export function excludedLemmasForArtifact(artifact, relativePath) {
  let sourceLemmas;
  if ((artifact.contract_version === 'issue-204-pilot-review-v1'
    || artifact.contract_version === 'm9-corpus-candidate-review-v1')
    && Array.isArray(artifact.decisions)) {
    sourceLemmas = artifact.decisions.map((row) => row?.morphology_proposal?.lemma);
  } else if (Array.isArray(artifact.candidate_records)) {
    sourceLemmas = artifact.candidate_records.map((row) => row?.lemma);
  } else if (Array.isArray(artifact.targets)) {
    sourceLemmas = artifact.targets.map((row) => row?.lemma);
  } else if (artifact.selection?.contract_version === 'm9-corpus-candidate-selection-v1'
    && Array.isArray(artifact.candidates)) {
    sourceLemmas = artifact.candidates.map((row) => row?.proposed_lemma);
  } else if (artifact.schema_version === 'm9-reviewed-lemma-exclusions-v1') {
    sourceLemmas = verifiedExclusionManifestLemmas(artifact, relativePath);
  } else {
    throw new Error(`Unsupported exclusion decision contract: ${relativePath}`);
  }
  if (sourceLemmas.length === 0 || sourceLemmas.some((lemma) => (
    typeof lemma !== 'string'
    || lemma.length === 0
    || lemma !== lemma.trim()
    || lemma.normalize('NFC') !== lemma
  ))) {
    throw new Error(`Exclusion decisions must contain reviewed trimmed NFC lemmas: ${relativePath}`);
  }
  return sourceLemmas;
}

export function exclusionSourceLemmas(relativePath, sourceBytes, { emptyCandidateManifestBytes } = {}) {
  if (relativePath.startsWith('data/candidate-trash/')) {
    const rows = sourceBytes.toString('utf8').split(/\r?\n/u).filter(Boolean).map(JSON.parse);
    const lemmas = rows.map((row) => row.identity?.[4]).filter(Boolean);
    if (lemmas.some((lemma) => typeof lemma !== 'string' || lemma !== lemma.trim() || lemma.normalize('NFC') !== lemma)) {
      throw new Error(`Archived exclusion source contains an invalid lemma: ${relativePath}`);
    }
    return lemmas;
  }
  if (path.posix.basename(relativePath) === 'candidates.jsonl') {
    const rows = sourceBytes.toString('utf8').split(/\r?\n/u).filter(Boolean).map(JSON.parse);
    if (rows.length === 0) {
      if (!emptyCandidateManifestBytes) throw new Error(`Empty candidate exclusion source has no bound manifest: ${relativePath}`);
      const manifest = JSON.parse(emptyCandidateManifestBytes.toString('utf8'));
      if (manifest.contract !== 'lexical-factory-candidate-manifest-v3'
        || manifest.status !== 'exhausted' || manifest.candidate_count !== 0
        || manifest.production?.exhausted !== true || manifest.candidates_sha256 !== sha256(sourceBytes)) {
        throw new Error(`Empty candidate source is not a bound exhausted Stage 1 result: ${relativePath}`);
      }
      return [];
    }
    return excludedLemmasForArtifact({ candidate_records: rows.map((row) => ({ lemma: row?.input })) }, relativePath);
  }
  return excludedLemmasForArtifact(JSON.parse(sourceBytes.toString('utf8')), relativePath);
}

export function exclusionManifestSha256(lemmas, sourceArtifacts) {
  const payload = { lemmas, schema_version: 'm9-reviewed-lemma-exclusions-v1', source_artifacts: sourceArtifacts };
  return sha256(JSON.stringify(payload));
}
