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
  const timingSummary = () => ({
    sample_count: 40,
    median_ms: 1,
    p95_ms: 2,
    max_ms: 3,
  });
  const memoryPhases = [
    'before_wasm_init',
    'after_wasm_init',
    'after_database_read',
    'after_first_database_open',
    'after_queries',
    'after_cold_database_close',
    'after_warm_database_open',
    'after_warm_database_close',
  ].map((phase, index) => ({
    phase,
    rss_mb: 100 + index,
    heap_used_mb: 10 + index,
    external_mb: 5 + index,
    array_buffers_mb: 2 + index,
  }));
  return {
    contract_version: 'canonical-validation-benchmark-v6',
    runner_memory_contract: {
      contract_version: 'runner-memory-contract-v1',
      rss_metric: 'process_max_rss_mb',
      rss_source: 'process.resourceUsage().maxRSS',
      rss_scope: 'cumulative-process-high-water-at-ascending-scale-boundary',
      sampled_heap_metric: 'max_sampled_heap_used_mb',
      sampled_heap_source: 'process.memoryUsage().heapUsed',
      sampled_heap_scope: 'max-phase-boundary-sample-not-true-peak',
    },
    synthetic_record_shape: {
      strategy: 'cycle a canonical template profile and replace lexical values',
      text_policy: 'preserve the canonical record structure',
      canonical_template_profile: {
        record_count: 2,
        sense_count: 2,
        relation_count: 0,
        search_form_count: 2,
        record_roles: { start: 2 },
        record_types: { entry: 2 },
        senses_per_record: { 1: 2 },
        search_forms_per_record: { 1: 2 },
        parts_of_speech: { noun: 2 },
        relation_types: {},
        records_with_relations: 0,
        start_records_with_non_lemma_search_forms: 0,
        non_lemma_search_form_count: 0,
        average_lemma_codepoints: 2,
        average_gloss_codepoints: 10,
      },
    },
    release_performance_baseline: {
      data_kind: 'real-current-canonical',
      input_record_count: 2,
      database_counts: {
        records: 2,
        senses: 2,
        relations: 0,
        search_forms: 2,
      },
    },
    sqlite_scales: [100],
    results: [{
      scale: 100,
      failure_stage: null,
      error: null,
      normalize_ms: 2,
      sqlite_build_ms: 3,
      synthetic_workload_shape: {
        template_record_count: 2,
        record_count: 100,
        sense_count: 100,
        relation_count: 0,
        search_form_count: 100,
        record_roles: { start: 100 },
        record_types: { entry: 100 },
        senses_per_record: { 1: 100 },
        search_forms_per_record: { 1: 100 },
        parts_of_speech: { noun: 100 },
        relation_types: {},
        records_with_relations: 0,
        start_records_with_non_lemma_search_forms: 0,
        non_lemma_search_form_count: 0,
        average_lemma_codepoints: 2,
        average_gloss_codepoints: 10,
        generated_surface_form_count: 1,
      },
      runner_memory: {
        process_max_rss_mb: 200,
        max_sampled_rss_mb: 199,
        max_sampled_heap_used_mb: 100,
      },
      product_performance: {
        elapsed_ms: 10,
        shared_database_validation_ms: 1,
        product_build_ms: 2,
        package_build_ms: 3,
        runtime_measurement_ms: 4,
        shared_sqlite_sha256: fixtureDigest,
        product_dictionary_sha256: fixtureDigest,
        package: {
          raw_package_bytes: 5000,
          zip_package_bytes: 3500,
          zip_entry_count: 4,
          dictionary_bytes: 4321,
          dictionary_compressed_bytes: 2200,
          dictionary_raw_package_share_percent: 86.42,
          dictionary_zip_package_share_percent: 62.86,
          synthetic_canonical_jsonl_excluded: true,
          package_is_temporary_benchmark_output: true,
        },
        sqlite_wasm_runtime: {
          database: {
            file_bytes: 4321,
            page_size_bytes: 4096,
            page_count: 2,
            index_count: 2,
            index_bytes: 1000,
            index_pages: [
              { name: 'idx_records_lemma', bytes: 400 },
              { name: 'idx_search_forms_form', bytes: 600 },
            ],
          },
          database_lifecycle: {
            max_live_databases: 1,
            events: ['cold_open', 'cold_close', 'warm_open', 'warm_close'],
          },
          startup: {
            wasm_module_init_ms: 10,
            database_file_read_ms: 20,
            first_database_open_ms: 30,
            first_ready_ms: 60,
            warm_database_reopen_ms: 5,
          },
          query_paths: [
            {
              category: 'exact-lemma',
              first_query_ms: 1,
              repeated_query: timingSummary(),
              result_count: 1,
              result_match_fields: ['lemma'],
            },
            {
              category: 'search-form',
              first_query_ms: 1,
              repeated_query: timingSummary(),
              result_count: 1,
              result_match_fields: ['search-form'],
            },
            {
              category: 'generated-surface-form',
              first_query_ms: 1,
              repeated_query: timingSummary(),
              result_count: 1,
              result_match_fields: ['generated-surface-form'],
            },
            {
              category: 'ambiguous-multi-sense',
              first_query_ms: 1,
              repeated_query: timingSummary(),
              result_count: 1,
              result_match_fields: ['lemma'],
              ambiguous_sense_count: 2,
              ambiguous_record_load: timingSummary(),
            },
          ],
          memory: {
            scope: 'benchmark Node process; only one live database',
            phase_snapshots: memoryPhases,
            cold_load: {
              peak_rss_mb: 104,
              steady_state_rss_mb: 104,
              after_close_rss_mb: 105,
            },
            warm_reopen: {
              baseline_rss_mb: 105,
              after_open_rss_mb: 106,
              open_ms: 5,
              after_close_rss_mb: 107,
            },
            peak_observed_rss_mb: 107,
            process_max_rss_mb: 108,
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

test('release benchmark CLI fails closed when a required SQLite scale evidence axis is missing or invalid', async (t) => {
  const evidenceCases = [
    {
      name: 'SQLite index breakdown',
      mutate: (result) => {
        delete result.product_performance.sqlite_wasm_runtime.database.index_pages;
      },
      error: /missing SQLite index-size breakdown/u,
    },
    {
      name: 'startup timing',
      mutate: (result) => {
        delete result.product_performance.sqlite_wasm_runtime.startup.warm_database_reopen_ms;
      },
      error: /invalid SQLite startup warm_database_reopen_ms/u,
    },
    {
      name: 'representative query category',
      mutate: (result) => {
        result.product_performance.sqlite_wasm_runtime.query_paths.pop();
      },
      error: /missing representative SQLite query paths/u,
    },
    {
      name: 'query latency quantile',
      mutate: (result) => {
        result.product_performance.sqlite_wasm_runtime.query_paths[0].repeated_query.p95_ms = Number.NaN;
      },
      error: /invalid exact-lemma repeated query p95_ms/u,
    },
    {
      name: 'query result',
      mutate: (result) => {
        result.product_performance.sqlite_wasm_runtime.query_paths[1].result_count = 0;
      },
      error: /invalid search-form result count/u,
    },
    {
      name: 'runtime memory',
      mutate: (result) => {
        delete result.product_performance.sqlite_wasm_runtime.memory.phase_snapshots;
      },
      error: /missing SQLite runtime memory phase snapshots/u,
    },
    {
      name: 'runtime memory range',
      mutate: (result) => {
        result.product_performance.sqlite_wasm_runtime.memory.phase_snapshots[0].rss_mb = 0;
      },
      error: /empty runtime RSS snapshot/u,
    },
    {
      name: 'runtime phase exceeds reported maximum',
      mutate: (result) => {
        result.product_performance.sqlite_wasm_runtime.memory.phase_snapshots
          .find(({ phase }) => phase === 'after_queries').rss_mb = 130;
      },
      error: /cold-load steady-state RSS does not match the after_queries snapshot/u,
    },
    {
      name: 'cold runtime summary matches its phase',
      mutate: (result) => {
        result.product_performance.sqlite_wasm_runtime.memory.cold_load.steady_state_rss_mb = 103;
      },
      error: /cold-load steady-state RSS does not match the after_queries snapshot/u,
    },
    {
      name: 'observed runtime maximum matches all phases',
      mutate: (result) => {
        result.product_performance.sqlite_wasm_runtime.memory.peak_observed_rss_mb = 106;
      },
      error: /observed RSS summary does not match the phase maximum/u,
    },
    {
      name: 'warm reopen timing matches startup',
      mutate: (result) => {
        result.product_performance.sqlite_wasm_runtime.memory.warm_reopen.open_ms = 6;
      },
      error: /warm-reopen timing does not match startup evidence/u,
    },
    {
      name: 'single database lifecycle',
      mutate: (result) => {
        result.product_performance.sqlite_wasm_runtime.database_lifecycle.max_live_databases = 2;
      },
      error: /did not complete the single-database cold\/warm lifecycle/u,
    },
    {
      name: 'runner maximum RSS',
      mutate: (result) => {
        result.runner_memory.process_max_rss_mb = 0;
      },
      error: /inconsistent scale-runner memory measurements/u,
    },
    {
      name: 'runner sampled heap',
      mutate: (result) => {
        delete result.runner_memory.max_sampled_heap_used_mb;
      },
      error: /invalid scale-runner sampled heap maximum/u,
    },
    {
      name: 'package size',
      mutate: (result) => {
        delete result.product_performance.package.dictionary_bytes;
      },
      error: /invalid product package dictionary_bytes/u,
    },
    {
      name: 'synthetic workload shape',
      mutate: (result) => {
        result.synthetic_workload_shape.sense_count = 99;
      },
      error: /synthetic sense shape does not match its counts/u,
    },
    {
      name: 'synthetic workload shape matches the canonical template profile',
      mutate: (result) => {
        result.synthetic_workload_shape.record_roles = { start: 80, 'reference-only': 20 };
      },
      error: /synthetic record_roles includes a category outside the canonical template profile/u,
    },
    {
      name: 'generated surface query has generated surface forms',
      mutate: (result) => {
        result.synthetic_workload_shape.generated_surface_form_count = 0;
      },
      error: /no generated surface forms for its representative query/u,
    },
    {
      name: 'missing synthetic workload shape',
      mutate: (result) => {
        delete result.synthetic_workload_shape;
      },
      error: /missing synthetic workload shape/u,
    },
    {
      name: 'SQLite build timing',
      mutate: (result) => {
        delete result.sqlite_build_ms;
      },
      error: /invalid SQLite build timing/u,
    },
    {
      name: 'runner memory contract',
      mutate: (_result, report) => {
        report.runner_memory_contract.sampled_heap_metric = 'peak_memory.heap_used_mb';
      },
      error: /missing the v6 scale-runner memory contract/u,
    },
    {
      name: 'canonical template profile matches the release baseline',
      mutate: (_result, report) => {
        report.release_performance_baseline.input_record_count = 3;
      },
      error: /canonical template profile does not match the release input record count/u,
    },
  ];

  for (const evidenceCase of evidenceCases) {
    await t.test(evidenceCase.name, async () => {
      const report = validCliReport();
      evidenceCase.mutate(report.results[0], report);
      const { printedErrors, exitCodes, runPromise } = invokeBenchmarkCli(report);

      assert.equal(await runPromise, undefined);
      assert.match(printedErrors[0], evidenceCase.error);
      assert.deepEqual(exitCodes, [1]);
    });
  }
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
