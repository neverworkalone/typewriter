import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { canonicalRecordsSha256, sha256Json } from '../../scripts/validate/semantic-audit.mjs';
import { readShardedJson } from '../../scripts/lib/sharded-json.mjs';

const BASE_ENTRIES = [
  {
    lemma: '합성기둥',
    senses: [
      { gloss: '건물이나 구조물을 받쳐 세운 곧은 부분.', relations: [{ to: 1, type: 'near', note: '둘 다 단단히 서 있는 사물이지만 바꿔 쓸 수는 없다.', relevance: 5 }, { to: 3, type: 'association', note: '기둥을 보며 떠올릴 수 있는 시간감이다.', relevance: 2 }] },
      { gloss: '어떤 조직의 중심이 되어 지탱하는 사람.' },
    ],
  },
  { lemma: '합성바위', senses: [{ gloss: '산이나 들에 놓인 큰 돌덩이.', relations: [{ to: 2, type: 'near', note: '풍경 속의 단단한 사물이지만 바꿔 쓸 수는 없다.', relevance: 3 }] }] },
  { lemma: '합성지붕', senses: [{ gloss: '집이나 건물의 맨 위를 덮는 덮개.' }] },
  { lemma: '합성순간', senses: [{ gloss: '짧은 시간 동안.' }] },
];

function canonicalRecords() {
  const ids = BASE_ENTRIES.map((_, index) => `w${String(900001 + index)}`);
  return BASE_ENTRIES.map((entry, index) => {
    const id = ids[index];
    return {
      id,
      record_type: 'entry',
      role: 'start',
      candidate_id: id,
      source: 'stdict',
      lemma: entry.lemma,
      search_forms: [entry.lemma],
      senses: entry.senses.map((sense, senseIndex) => ({
        id: `${id}-s${senseIndex + 1}`,
        pos: 'noun',
        gloss: sense.gloss,
        ...(sense.relations ? {
          relations: sense.relations.map(({ to, type, note, relevance }) => ({
            target: ids[to],
            target_sense: `${ids[to]}-s1`,
            type,
            note,
            relevance,
          })),
        } : {}),
      })),
    };
  });
}

/** A small licensed-source Canonical fixture; no retired candidate admission or Meaning editor is run. */
export async function syntheticCanonicalBase() {
  const records = canonicalRecords();
  const root = await mkdtemp(path.join(os.tmpdir(), 'synthetic-canonical-base-'));
  const canonicalDirectory = path.join(root, 'data/canonical');
  const validationDirectory = path.join(root, 'data/validation');
  await mkdir(canonicalDirectory, { recursive: true });
  await mkdir(validationDirectory, { recursive: true });
  await writeFile(path.join(canonicalDirectory, 'synthetic.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

  const authority = await readShardedJson('data/validation/canonical-semantic-decision-source.json');
  const revision = canonicalRecordsSha256(records.map((record) => ({ record })));
  authority.source.canonical_records_sha256 = revision;
  authority.authored_review.source.canonical_records_sha256 = revision;
  authority.authored_review.records = [];
  authority.authored_review_sha256 = sha256Json(authority.authored_review);
  authority.factory_admissions = [];
  await writeFile(path.join(validationDirectory, 'canonical-semantic-decision-source.json'), `${JSON.stringify(authority, null, 2)}\n`);

  for (const name of ['m6-2-inflection-exceptions.json', 'm6-3-surface-form-review.json']) {
    await cp(path.join('data/validation', name), path.join(validationDirectory, name));
  }
  return {
    root,
    canonicalRecords: records,
    recordPathById: new Map(records.map((record) => [record.id, 'data/canonical/synthetic.jsonl'])),
  };
}
