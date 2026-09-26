import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSyntheticBenchmarkRecord,
  runBenchmarkCli,
} from '../scripts/benchmark/canonical-validation.mjs';
import { findAmbiguousParticleFragments } from '../scripts/validate/lexical-quality.mjs';

const templates = [
  {
    id: 'w001',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w001',
    lemma: '기대다',
    search_forms: ['기대다', '기대'],
    senses: [{
      id: 'w001-s1',
      pos: 'verb',
      gloss: '원본 문장',
      relations: [{
        target: 'r001',
        target_sense: 'r001-s1',
        type: 'near',
        note: '원본 관계 문장',
      }],
    }],
  },
  {
    id: 'r001',
    record_type: 'entry',
    role: 'reference-only',
    lemma: '기대',
    search_forms: ['기대'],
    senses: [{ id: 'r001-s1', pos: 'noun', gloss: '참조 뜻' }],
  },
];
const templateIndexById = new Map(templates.map(({ id }, index) => [id, index]));
const fixtureDigest = 'a'.repeat(64);

function validCliReport() {
  return {
    release_performance_baseline: { data_kind: 'real-current-canonical' },
    sqlite_scales: [100],
    results: [{
      scale: 100,
      failure_stage: null,
      error: null,
      product_performance: {
        shared_sqlite_sha256: fixtureDigest,
        product_dictionary_sha256: fixtureDigest,
        package: {
          zip_package_bytes: 1234,
          synthetic_canonical_jsonl_excluded: true,
        },
        sqlite_wasm_runtime: {
          database: { file_bytes: 4321 },
          database_lifecycle: {
            max_live_databases: 1,
            events: ['cold_open', 'cold_close', 'warm_open', 'warm_close'],
          },
        },
      },
      corpus_cost: {
        fast: { wall_clock_ms: 1 },
        normal: { wall_clock_ms: 2 },
        deep: { wall_clock_ms: 3, reproducible: true },
      },
      shared_sqlite_sha256: fixtureDigest,
      product_dictionary_sha256: fixtureDigest,
      reproducible_sqlite_sha256: fixtureDigest,
      reproducible_second_sqlite_sha256: fixtureDigest,
    }],
  };
}

function invokeBenchmarkCli(report, options = {}) {
  const printedReports = [];
  const printedErrors = [];
  const exitCodes = [];
  const runPromise = runBenchmarkCli({
    benchmark: options.benchmark ?? (async () => report),
    sizes: options.sizes ?? [100],
    sqliteScales: options.sqliteScales ?? new Set([100]),
    releasePerformance: options.releasePerformance ?? true,
    writeReport: (value) => printedReports.push(JSON.stringify(value)),
    writeError: (message) => printedErrors.push(message),
    setExitCode: (code) => exitCodes.push(code),
  });
  return { printedReports, printedErrors, exitCodes, runPromise };
}

test('synthetic scale records deterministically retain structure and relation shape without copying canonical text', () => {
  const first = createSyntheticBenchmarkRecord(0, templates, templateIndexById, 100);
  const repeated = createSyntheticBenchmarkRecord(0, templates, templateIndexById, 100);

  assert.deepEqual(first, repeated);
  assert.equal(first.id, 'w0000001');
  assert.equal(first.role, 'start');
  assert.equal(first.record_type, 'entry');
  assert.equal(first.candidate_id, first.id);
  assert.equal(first.senses.length, 1);
  assert.equal(first.senses[0].pos, 'verb');
  assert.equal(first.search_forms.length, 2);
  assert.notEqual(first.search_forms[1], first.lemma);
  assert.equal([...first.senses[0].gloss].length, [...templates[0].senses[0].gloss].length);
  assert.notEqual(first.senses[0].gloss, templates[0].senses[0].gloss);
  assert.deepEqual(first.senses[0].relations, [{
    target: 'r0000002',
    target_sense: 'r0000002-s1',
    type: 'near',
    note: '합성 관계 가가',
  }]);
  assert.notEqual(first.senses[0].relations[0].note, templates[0].senses[0].relations[0].note);

  const reference = createSyntheticBenchmarkRecord(1, templates, templateIndexById, 100);
  assert.equal(reference.id, 'r0000002');
  assert.equal(reference.role, 'reference-only');
  assert.equal(Object.hasOwn(reference, 'candidate_id'), false);
});

test('synthetic multi-sense glosses retain whitespace and remain mechanically distinguishable', () => {
  const multiSenseTemplates = [{
    ...templates[0],
    senses: [
      { id: 'w001-s1', pos: 'verb', gloss: '원본 의미 한 가지' },
      { id: 'w001-s2', pos: 'verb', gloss: '또 다른 원본 의미' },
    ],
  }];
  const generated = createSyntheticBenchmarkRecord(
    10,
    multiSenseTemplates,
    new Map([['w001', 0]]),
    100,
  );
  const laterGenerated = createSyntheticBenchmarkRecord(
    11172,
    multiSenseTemplates,
    new Map([['w001', 0]]),
    1000000,
  );

  assert.equal(generated.senses.length, 2);
  assert.notEqual(generated.senses[0].gloss, generated.senses[1].gloss);
  assert.notEqual(generated.senses[0].gloss, laterGenerated.senses[0].gloss);
  for (const [index, sense] of generated.senses.entries()) {
    assert.equal([...sense.gloss].length, [...multiSenseTemplates[0].senses[index].gloss].length);
    assert.equal(sense.gloss.split(/\s+/u).length, multiSenseTemplates[0].senses[index].gloss.split(/\s+/u).length);
    assert.equal(sense.gloss.includes('원본'), false);
    assert.deepEqual(findAmbiguousParticleFragments(sense.gloss), []);
  }
});

test('release benchmark CLI accepts complete scale and reproducibility results', async () => {
  const report = validCliReport();
  const { printedReports, exitCodes, runPromise } = invokeBenchmarkCli(report);

  assert.strictEqual(await runPromise, report);
  assert.equal(printedReports.length, 1);
  assert.deepEqual(JSON.parse(printedReports[0]), report);
  assert.deepEqual(exitCodes, []);
});

test('release benchmark CLI prints diagnostics and fails closed for incomplete scale results', async (t) => {
  await t.test('a failed scale result', async () => {
    const report = validCliReport();
    report.results[0].failure_stage = 'sqlite-build';
    report.results[0].error = 'fixture build failed';
    const { printedReports, printedErrors, exitCodes, runPromise } = invokeBenchmarkCli(report);

    assert.equal(await runPromise, undefined);
    assert.match(printedReports[0], /fixture build failed/u);
    assert.match(printedErrors[0], /scale 100 failed at sqlite-build: fixture build failed/u);
    assert.deepEqual(exitCodes, [1]);
  });

  await t.test('a requested scale missing from the report', async () => {
    const report = validCliReport();
    report.results = [];
    const { printedReports, printedErrors, exitCodes, runPromise } = invokeBenchmarkCli(report);

    assert.equal(await runPromise, undefined);
    assert.deepEqual(JSON.parse(printedReports[0]).results, []);
    assert.match(printedErrors[0], /missing requested scale 100/u);
    assert.deepEqual(exitCodes, [1]);
  });

  await t.test('missing product and reproducibility outputs', async () => {
    const missingProduct = validCliReport();
    delete missingProduct.results[0].product_performance;
    const productCall = invokeBenchmarkCli(missingProduct);
    assert.equal(await productCall.runPromise, undefined);
    assert.match(productCall.printedErrors[0], /missing product performance result/u);
    assert.deepEqual(productCall.exitCodes, [1]);

    const missingDigest = validCliReport();
    delete missingDigest.results[0].reproducible_second_sqlite_sha256;
    const digestCall = invokeBenchmarkCli(missingDigest);
    assert.equal(await digestCall.runPromise, undefined);
    assert.match(digestCall.printedErrors[0], /missing matching SQLite and product reproducibility digests/u);
    assert.deepEqual(digestCall.exitCodes, [1]);
  });

  await t.test('SQLite scales omitted from --sizes are rejected before benchmarking', async () => {
    let benchmarkWasCalled = false;
    const { printedErrors, exitCodes, runPromise } = invokeBenchmarkCli(validCliReport(), {
      sizes: [100],
      sqliteScales: new Set([200]),
      benchmark: async () => {
        benchmarkWasCalled = true;
        return validCliReport();
      },
    });

    assert.equal(await runPromise, undefined);
    assert.match(printedErrors[0], /SQLite scales must also be listed in --sizes: 200/u);
    assert.deepEqual(exitCodes, [1]);
    assert.equal(benchmarkWasCalled, false);
  });
});
