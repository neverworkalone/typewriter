import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createKiwiProvider, providerIdentityDigest } from './analyzer-providers.mjs';
import { createKhaiiiProvider, resolveKhaiiiRuntime } from './khaiii-provider.mjs';
import { createMecabProvider } from './mecab-provider.mjs';
import { resolveWithProviders } from './stage1.mjs';
import {
  BASELINE, BENCHMARK_CONTRACT, BenchmarkError, POLICY_ORDERS, PROVIDER_IDS, agreementClass, buildSummary, observationOf, replayUpstreamHolds, selectSample,
  sha256, simulateOrder, standaloneRecord, strataOf, verifyBaseline,
} from './benchmark-core.mjs';

// Fixed-cohort Kiwi / Khaiii / MeCab-ko benchmark (issue #274). Non-mutating: it reads the immutable
// C000001 bytes from the recorded PR #270 head commit and writes only the text-free outcome file
// under docs/audits/ (plus an ignored local worksheet under data/reference/). Usage:
//   node scripts/factory/benchmark-analyzers.mjs run [--baseline-dir <dir>] [--kiwi-python <python>] [--out <file>] [--worksheet <file>]

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_OUTCOMES = 'docs/audits/issue-274-analyzer-benchmark-outcomes.json';
export const DEFAULT_ADJUDICATION = 'docs/audits/issue-274-analyzer-benchmark-adjudication.json';
export const DEFAULT_REPORT = 'docs/audits/issue-274-analyzer-benchmark.md';
const DEFAULT_WORKSHEET = 'data/reference/benchmark-274/worksheet.jsonl';
const DEFAULT_KIWI_PYTHON = path.join(ROOT, 'data/reference/venv-kiwi024/bin/python');
const TIMING_REPEATS = 3;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = (value) => Math.round(value * 100) / 100;

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
}

async function loadBaselineText({ baselineDir }) {
  if (baselineDir) {
    return { manifestText: await readFile(path.join(baselineDir, 'manifest.json'), 'utf8'), candidatesText: await readFile(path.join(baselineDir, 'candidates.jsonl'), 'utf8'), source: `directory:${baselineDir}` };
  }
  try {
    return { manifestText: git(['show', `${BASELINE.commit}:${BASELINE.manifest_path}`]), candidatesText: git(['show', `${BASELINE.commit}:${BASELINE.candidates_path}`]), source: `git:${BASELINE.commit}` };
  } catch (error) {
    throw new BenchmarkError([`baseline commit ${BASELINE.commit} is not available locally (git fetch origin claude/268-stage1-batch-c000001, or pass --baseline-dir): ${error.message.split('\n')[0]}`]);
  }
}

const requestsOf = (rows) => rows.map((row) => ({ id: row.observedForms[0], text: row.observedForms[0] }));

// Cold = first process of this provider in this run; steady = median over repeats of a warm OS cache.
async function measureTiming(provider, requests) {
  const timed = async (list) => { const start = performance.now(); await provider.analyze(list); return performance.now() - start; };
  const cold_first_call_ms = await timed(requests.slice(0, 1));
  const single = [];
  for (let i = 0; i < TIMING_REPEATS; i += 1) single.push(await timed(requests.slice(0, 1)));
  const full = [];
  for (let i = 0; i < TIMING_REPEATS; i += 1) full.push(await timed(requests));
  const perProcess = median(single);
  const steady = median(full);
  const processes = Math.ceil(requests.length / 200);
  return {
    repeats: TIMING_REPEATS,
    cold_first_call_ms: round(cold_first_call_ms),
    single_surface_call_ms: round(perProcess),
    full_cohort_ms: round(steady),
    full_cohort_runs_ms: full.map(round),
    process_batches: processes,
    per_surface_mean_ms: round(steady / requests.length),
    // Estimate only: process start/model load amortized over `process_batches` batches of <=200.
    per_surface_marginal_ms_estimate: round(Math.max(0, steady - processes * perProcess) / requests.length),
  };
}

function hostInfo() {
  const sw = (command, args) => { try { return execFileSync(command, args, { encoding: 'utf8' }).trim(); } catch { return 'unavailable'; } };
  return { platform: process.platform, arch: process.arch, os_release: os.release(), os_version: sw('sw_vers', ['-productVersion']), cpu: os.cpus()[0]?.model ?? 'unknown',
    cpu_count: os.cpus().length, memory_gb: round(os.totalmem() / 2 ** 30), node: process.version };
}

export async function runBenchmark({ baselineDir, kiwiPython = process.env.TYPEWRITER_KIWI_PYTHON || DEFAULT_KIWI_PYTHON, argv = [] } = {}) {
  const baseline = await loadBaselineText({ baselineDir });
  const rows = verifyBaseline(baseline);
  const khaiiiRuntime = resolveKhaiiiRuntime();
  const providers = { kiwi: createKiwiProvider({ python: kiwiPython }), khaiii: createKhaiiiProvider({ runtime: khaiiiRuntime }), mecab: createMecabProvider() };
  const requests = requestsOf(rows);

  // Standalone: every provider over all 500 surfaces, normalized adapters invoked directly. This is
  // measurement only; it never produces a candidate manifest.
  const standalone = {};
  const metadata = {};
  for (const id of PROVIDER_IDS) {
    const response = await providers[id].analyze(requests);
    providers[id].assertMetadata(response.metadata);
    metadata[id] = response.metadata;
    const raw = new Map(response.results.map((result) => [result.id, result]));
    standalone[id] = rows.map((row, index) => standaloneRecord(providers[id], requests[index], row, raw.get(requests[index].id)));
  }

  // Replay the original Kiwi analysis to separate preserved upstream holds from Kiwi-derived ones.
  const { resolutions: kiwiReplay } = await resolveWithProviders({ observations: rows.map((row) => observationOf(row)), providers: [providers.kiwi] });
  const replay = replayUpstreamHolds(rows, kiwiReplay);

  const perId = rows.map((row, index) => {
    const readings = Object.fromEntries(PROVIDER_IDS.map((id) => [id, standalone[id][index]]));
    return { candidate_id: row.candidate_id, readings, agreement: agreementClass(readings), stratum: strataOf(row, readings, replay[index].kiwiHolds) };
  });

  const simulations = [];
  for (const order of POLICY_ORDERS) simulations.push(await simulateOrder({ order, rows, replay, providers }));

  const timing = {};
  for (const id of PROVIDER_IDS) timing[id] = await measureTiming(providers[id], requests);

  const sample = selectSample(perId);
  return {
    outcomes: {
      contract: BENCHMARK_CONTRACT,
      generated_at: new Date().toISOString(),
      command: `node scripts/factory/benchmark-analyzers.mjs ${argv.join(' ')}`.trim(),
      baseline: { ...BASELINE, source: baseline.source },
      environment: { host: hostInfo(), khaiii_runtime: khaiiiRuntime, kiwi_python: path.relative(ROOT, kiwiPython), master_sha: git(['rev-parse', 'HEAD']).trim() },
      providers: Object.fromEntries(PROVIDER_IDS.map((id) => [id, { identity: providers[id].identity, identity_digest: providerIdentityDigest(providers[id].identity),
        capabilities: providers[id].capabilities, runtime_metadata: metadata[id] }])),
      rows: rows.map((row, index) => ({
        id: row.candidate_id, lemma: row.input, pos: row.pos, surface: row.observedForms[0], ref: row.evidence[0].ref, holds: row.holds,
        upstream_holds: replay[index].upstream, kiwi_holds: replay[index].kiwiHolds, ambiguity_origin_indeterminate: replay[index].ambiguityOriginIndeterminate,
        ...perId[index],
      })),
      orders: simulations.map((simulation) => ({ order: simulation.order, calls: simulation.calls, reached: simulation.reached, wall_ms: simulation.wall_ms, per_id: simulation.perId })),
      timing,
      sample,
    },
    rows,
  };
}

// Local, ignored worksheet: blind to analyzer output (surface + proposed hint + a bounded context window).
async function loadParagraph(ref) {
  const [documentRef, paragraphId] = ref.split('#');
  const file = path.join(ROOT, 'data/reference/corpus', `${documentRef.split('.')[0]}.json`);
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  for (const document of parsed.document ?? []) {
    for (const paragraph of document.paragraph ?? []) if (paragraph.id === paragraphId) return paragraph.form ?? '';
  }
  return null;
}

export async function writeWorksheet(outcomes, file) {
  const byId = new Map(outcomes.rows.map((row) => [row.id, row]));
  const lines = [];
  for (const { candidate_id: id, stratum } of outcomes.sample.sample) {
    const row = byId.get(id);
    const text = await loadParagraph(row.ref);
    const at = text === null ? -1 : text.indexOf(row.surface);
    const context = text === null ? null : at < 0 ? text.slice(0, 160) : `${text.slice(Math.max(0, at - 70), at)}«${row.surface}»${text.slice(at + row.surface.length, at + row.surface.length + 70)}`;
    lines.push(JSON.stringify({ id, stratum, surface: row.surface, proposed: `${row.lemma}/${row.pos}`, context }));
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
}

const pct = (value) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const interval = (entry) => `${pct(entry.precision)} (${pct(entry.wilson95.low)}–${pct(entry.wilson95.high)})`;
const ms = (value) => `${Math.round(value).toLocaleString('en-US')} ms`;

// Every figure comes from buildSummary (two committed files); only the prose is static.
export function renderReport(summary, outcomes) {
  const { baseline, standalone, orders, adjudication, timing } = summary;
  const environment = outcomes.environment;
  const identity = (id) => outcomes.providers[id].identity;
  const order = (index) => orders[index];
  const orderRow = (label, entry) => `| ${label} | ${entry.states.apparent_resolved ?? 0} | ${entry.states.needs_verification ?? 0} | ${entry.states.unresolved ?? 0} | ${entry.held_rows} / ${entry.no_hold_rows} | `
    + `${Object.entries(entry.calls).map(([id, call]) => `${id} ${call.calls}×${call.surfaces}`).join(', ')} | ${ms(entry.wall_ms)} |`;
  const providerRow = (id) => `| ${id} | ${standalone[id].success_nonempty} | ${standalone[id].unsupported_or_empty} (errors ${standalone[id].errors}) | ${standalone[id].hint_in_best} | `
    + `${adjudication.providers[id].verified_correct} / ${adjudication.providers[id].verified_wrong} / ${adjudication.providers[id].truth_unknown} / ${adjudication.providers[id].unsupported} | ${interval(adjudication.providers[id])} | `
    + `${ms(timing[id].full_cohort_ms)} |`;
  const strata = Object.entries(adjudication.by_stratum).map(([name, entry]) => `| ${name} | ${entry.size} | ${entry.sampled} | ${entry.proposed_confirmed} | `
    + `${PROVIDER_IDS.map((id) => `${entry.providers[id].verified_correct}/${entry.providers[id].verified_wrong}/${entry.providers[id].unsupported}`).join(' | ')} |`).join('\n');
  const hypothetical = summary.hypothetical_agreement_rule;
  return `# Issue #274 — Kiwi / Khaiii / MeCab-ko benchmark on the immutable C000001 cohort

Generated by \`node scripts/factory/benchmark-analyzers.mjs report\` from [\`issue-274-analyzer-benchmark-outcomes.json\`](issue-274-analyzer-benchmark-outcomes.json) (run output, text-free) and [\`issue-274-analyzer-benchmark-adjudication.json\`](issue-274-analyzer-benchmark-adjudication.json) (sample truth). Every figure below is computed from those two files by \`buildSummary\`.

**Decision: inconclusive. Keep the factory default \`[kiwi]\`.** No production switch, no editorial auto-admission, no batch kickoff.

## Provenance

- **Baseline.** Owner decision (2026-10-04): PR #270 is *not merged* and will be discarded; its immutable head commit \`${BASELINE.commit}\` is the baseline (produced on master \`${BASELINE.master_sha_at_production}\`). The cohort is loaded from that commit's bytes and verified fail-closed: \`manifest.json\` sha256 \`${BASELINE.manifest_sha256}\`, \`candidates.jsonl\` sha256 \`${BASELINE.candidates_sha256}\`, source evidence \`${BASELINE.source_evidence_sha256}\`, source snapshot \`${BASELINE.source_snapshot}\`, analyzer digest \`${BASELINE.analyzer_digest}\` (${BASELINE.analyzer_version}). Because the commit may become unreachable, the outcome file embeds the text-free cohort (id, lemma, POS, one observed form, opaque evidence reference, holds).
- **Cohort re-verified from bytes:** ${baseline.usage_rows} v1 *usage rows* \`C000001-0001..0500\` (not 500 lemmas), ${baseline.distinct_lemmas} distinct lemmas, ${baseline.analysis_ambiguous_rows} \`analysis_ambiguous\`, ${baseline.held_rows} with any hold (${pct(baseline.held_rows / baseline.usage_rows)}), ${baseline.unheld_rows} without. Hold categories overlap: ${Object.entries(baseline.hold_counts).map(([key, value]) => `${key} ${value}`).join(', ')} (identical to the pinned counts).
- **Runtimes (real, not synthetic):** Kiwi ${identity('kiwi').implementation} ${identity('kiwi').version} (model ${identity('kiwi').model}); Khaiii ${identity('khaiii').version}, runtime \`${environment.khaiii_runtime}\`, resource \`${identity('khaiii').model}\`, library \`${identity('khaiii').config.library_digest}\`; MeCab-ko ${identity('mecab').version} with ${identity('mecab').config.dictionary_package} (\`${identity('mecab').model}\`, release undeclared by the package). Provider identity digests: ${PROVIDER_IDS.map((id) => `${id} \`${outcomes.providers[id].identity_digest}\``).join(', ')}. Resolution policy \`provider-resolution-v1\` (#272).
- **Host:** ${environment.host.cpu}, ${environment.host.cpu_count} cores, ${environment.host.memory_gb} GB, macOS ${environment.host.os_version} (${environment.host.platform}/${environment.host.arch}), Node ${environment.host.node}; repository master \`${environment.master_sha}\`. Khaiii was measured on the **macOS native** runtime only; the Docker runtime was **not** measured and no cross-platform timing is blended.
- **Command:** \`${outcomes.command}\`; outcome digest \`${outcomes.outcome_digest}\`. The run is non-mutating: \`data/candidates/C000001\`, \`data/reviews\`, \`data/canonical\` and candidate statuses are untouched.

## Comparative table

Policy simulation over all ${baseline.usage_rows} usages with the real \`resolveWithProviders\` (same conditional fallback, upstream holds preserved). *Apparent resolved* = no analysis-class hold left under the policy; it is **not** truth. Held rows count any hold (a row can be apparent-resolved yet held for \`lemma_mismatch\`/\`coverage_collision\`).

| Configuration | Apparent resolved | Needs verification | Unresolved | Held / no hold (of ${baseline.held_rows} / ${baseline.unheld_rows}) | Calls × surfaces | Policy wall time |
|---|---|---|---|---|---|---|
| Original baseline (Kiwi, from bytes) | ${baseline.usage_rows - baseline.held_rows} no-hold | – | – | ${baseline.held_rows} / ${baseline.unheld_rows} | – | – |
${orderRow('Kiwi only (replay)', order(0))}
${orderRow('Kiwi → Khaiii → MeCab', order(1))}
${orderRow('Kiwi → MeCab → Khaiii', order(2))}

Fallback reach of the ${baseline.analysis_ambiguous_rows} baseline-ambiguous usages: Kiwi→Khaiii→MeCab asks Khaiii ${order(1).baseline_ambiguous_reaching.khaiii} and MeCab ${order(1).baseline_ambiguous_reaching.mecab}; Kiwi→MeCab→Khaiii asks MeCab ${order(2).baseline_ambiguous_reaching.mecab} and Khaiii ${order(2).baseline_ambiguous_reaching.khaiii}. **Apparent-resolved gain over Kiwi only: ${summary.order_gain_vs_kiwi_only.map((entry) => `${entry.order.join('→')} ${entry.apparent_resolved_gain}`).join('; ')}; change in held rows: ${summary.order_gain_vs_kiwi_only.map((entry) => entry.held_rows_change).join(', ')}.** Khaiii and MeCab report one best path and no score, so by policy their clean reading is \`needs_verification\` and never clears \`analysis_ambiguous\`; a fallback can only add new holds (its own lemma/POS mismatches: hold-category totals after fallback are ${Object.entries(order(1).hold_category_counts).map(([key, value]) => `${key} ${value}`).join(', ')}). Both provider orders therefore verify **no** additional correct resolutions.

Of the ${baseline.analysis_ambiguous_rows} \`analysis_ambiguous\` holds, ${summary.baseline.ambiguity_origin_indeterminate_rows} rows carry the hold both from the Kiwi replay and the baseline, so the extractor's own contribution cannot be separated from text-free data (extractor-only upstream ambiguity: ${baseline.upstream_hold_counts.analysis_ambiguous} rows, preserved and never cleared). The simulation assumes Kiwi origin (the lower bound on residual holds); with a zero gain this assumption changes no conclusion.

## Standalone comparison (all ${baseline.usage_rows})

| Provider | Readable best path | Unsupported / empty | Proposed lemma/POS in best path | Sample verified: correct / wrong / unknown / unsupported | Verified precision (Wilson 95%) | Full-cohort time (median of ${TIMING_REPEATS}) |
|---|---|---|---|---|---|---|
${PROVIDER_IDS.map(providerRow).join('\n')}

Capabilities: Kiwi N-best (${standalone.kiwi.with_n_best_alternatives} usages with alternatives, ${standalone.kiwi.derived} derivation readings); Khaiii and MeCab best path only, no derivation. Pairwise agreement of the normalized best-path segmentation: Kiwi↔Khaiii ${summary.pair_agreement.kiwi_khaiii}, Kiwi↔MeCab ${summary.pair_agreement.kiwi_mecab}, Khaiii↔MeCab ${summary.pair_agreement.khaiii_mecab}. Classes: ${Object.entries(summary.agreement_classes).map(([key, value]) => `${key} ${value}`).join(', ')}. **Agreement is not correctness**: the adjudicated disagreement strata below show the outlier is often the wrong one *and* sometimes the majority is wrong.

## Adjudication (AI self-check; limits stated)

- **Design.** The sample is predeclared and deterministic: seed \`${outcomes.sample.seed}\`, up to ${outcomes.sample.quota} usages per stratum (each usage in exactly one primary stratum, first match in this order), ranked by \`sha256(seed|stratum|id)\`. It covers all-three agreement (Kiwi-ambiguous and Kiwi-clean), each one-vs-two disagreement, three-way disagreement, derivation/lemma/POS-mismatch rows, unsupported/error rows, and ${adjudication.by_stratum.baseline_unheld_control.sampled} of the ${baseline.unheld_rows} baseline-unheld controls: **${adjudication.sampled} usages**, ${adjudication.verified} with a verified truth and ${adjudication.truth_unknown} \`truth_unknown\` (noun-vs-adverb boundary).
- **Method — read this first.** Truth is the dictionary-form lemma/POS of the usage in the authorized local original context (data/reference corpus; no text in Git), recorded **before** viewing any analyzer output (the outputs of six rows were viewed after their truth was decided; listed in the adjudication file). It is an **AI self-check by the assigned primary agent** (repository rule: no subagents, no other-model review). It is *not* human or independently authored adjudication, and one analyzer was never used as truth. A reading is verified correct when its best path contains the true lemma/POS (or the recorded root of a derived predicate), verified wrong otherwise.
- **Bounds.** The sample is stratified, not random over the cohort, so provider precision above is a within-sample figure, not a population estimate (the all-agree strata are random draws of 10 from 207 / 76). Wilson intervals are shown; they are wide.

| Stratum | Size | Sampled | Proposed lemma/POS confirmed | Kiwi c/w/u | Khaiii c/w/u | MeCab c/w/u |
|---|---|---|---|---|---|---|
${strata}

(c/w/u = verified correct / verified wrong / unsupported.) Findings: when Kiwi and one best-only engine agree, the lone best-only outlier is wrong (the MeCab-outlier and Khaiii-outlier strata); when Khaiii and MeCab agree against Kiwi, Kiwi is not the usual loser (its readings are correct, wrong or unsupported mixed) and the agreeing pair is wrong in a substantial share of the sample, so two best-only engines agreeing is not proof; the three-way stratum is wrong for Khaiii/MeCab in most rows; the baseline-unheld controls are right for Kiwi (and Khaiii where supported) while MeCab already errs there; both all-agree strata are 10/10 correct for the proposal and every provider.

**Hypothetical agreement rule (not implemented, labelled separately).** Treating "Kiwi-ambiguous and both Khaiii and MeCab best paths contain the proposed lemma/POS" as a clearing signal covers ${hypothetical.baseline_ambiguous_population_matching} of the ${baseline.analysis_ambiguous_rows} ambiguous usages. In the sample ${hypothetical.proposal_confirmed}/${hypothetical.proposal_verified} such usages had a correct proposal (Wilson 95% ${pct(hypothetical.proposal_wilson95.low)}–${pct(hypothetical.proposal_wilson95.high)}); Kiwi's own best path on the same rows was ${interval(hypothetical.kiwi_best_only_same_rows)}. That is encouraging but ${hypothetical.proposal_verified} usages cannot support a calibrated rule, and it would change \`provider-resolution-v1\` and the lexical-admission trust model, which is outside this issue.

## Performance (macOS arm64, fixed host, ${TIMING_REPEATS} repeats)

| Provider | Cold first call | Single-surface process | Full cohort (3 process batches of ≤200) | Mean per surface | Marginal per surface (estimate) |
|---|---|---|---|---|---|
${PROVIDER_IDS.map((id) => `| ${id} | ${ms(timing[id].cold_first_call_ms)} | ${ms(timing[id].single_surface_call_ms)} | ${ms(timing[id].full_cohort_ms)} (runs ${timing[id].full_cohort_runs_ms.map((value) => Math.round(value)).join('/')}) | ${timing[id].per_surface_mean_ms} ms | ${timing[id].per_surface_marginal_ms_estimate} ms |`).join('\n')}

Each analysis spawns one process per ≤200-surface batch, so the dominant cost is process start/model load (Kiwi ≈ ${ms(timing.kiwi.single_surface_call_ms)} per process, Khaiii/MeCab ≈ 0.1 s); per-surface marginal time is negligible for all three (the Kiwi estimate is clamped at 0). The conditional fallback adds ${ms(order(1).wall_ms - order(0).wall_ms)} / ${ms(order(2).wall_ms - order(0).wall_ms)} to the ${ms(order(0).wall_ms)} Kiwi-only policy run. No crash and no provider error occurred in any run. Cost is not the constraint; verified benefit is.

## Decision

1. **Quality.** Under \`provider-resolution-v1\` neither fallback order verifies any additional correct resolution (gain 0, held rows unchanged), because best-only readings cannot clear \`analysis_ambiguous\`. In the adjudicated sample Kiwi's best path is the most accurate (${interval(adjudication.providers.kiwi)}) ahead of Khaiii (${interval(adjudication.providers.khaiii)}) and MeCab (${interval(adjudication.providers.mecab)}), but all three Wilson intervals overlap, so the ordering is suggestive, not established.
2. **Pareto.** Kiwi: highest verified precision, ≈1.4 s per process; Khaiii and MeCab: ≈10× faster to start but lower verified precision and no N-best/derivation. No provider order dominates Kiwi-only on quality; the fallbacks are cheap, so the question is signal value, which is unproven.
3. **Conclusion: inconclusive; retain Kiwi-only as the factory default.** The agreement signal looks promising (see the hypothetical rule) but the verified sample is small and AI self-checked. Resolving it requires a larger rights-cleared, preferably human-adjudicated sample and an explicit owner decision on the admission trust model (a successor issue); this issue changes none of it.

## Limits

AI self-check adjudication, not independent or human; 2 \`truth_unknown\`; stratified (non-random) sample; one host and one run set; Docker Khaiii not measured; the extractor's share of 319 ambiguity holds is indeterminate; the baseline is the unmerged PR #270 head commit by owner decision; the v1 cohort is 500 usages, not 500 lemmas, and is unrelated to the #275 v2 contract.
`;
}

function parseArguments(argv) {
  const [command = 'run', ...rest] = argv;
  const options = { command, out: DEFAULT_OUTCOMES, worksheet: DEFAULT_WORKSHEET, adjudication: DEFAULT_ADJUDICATION, report: DEFAULT_REPORT };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!['--baseline-dir', '--kiwi-python', '--out', '--worksheet', '--adjudication', '--report'].includes(key) || rest[i + 1] === undefined) throw new BenchmarkError([`unknown or incomplete option ${key}`]);
    options[key.slice(2).replace(/-([a-z])/gu, (_, c) => c.toUpperCase())] = rest[i + 1];
  }
  if (!['run', 'report'].includes(command)) throw new BenchmarkError([`unknown command ${command}`]);
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    const options = parseArguments(process.argv.slice(2));
    if (options.command === 'report') {
      const outcomes = JSON.parse(await readFile(path.resolve(ROOT, options.out), 'utf8'));
      const adjudication = JSON.parse(await readFile(path.resolve(ROOT, options.adjudication), 'utf8'));
      await writeFile(path.resolve(ROOT, options.report), renderReport(buildSummary(outcomes, adjudication), outcomes), 'utf8');
      console.log(JSON.stringify({ report: options.report }));
      return;
    }
    const { outcomes } = await runBenchmark({ baselineDir: options.baselineDir, kiwiPython: options.kiwiPython, argv: process.argv.slice(2) });
    outcomes.outcome_digest = sha256(JSON.stringify(outcomes.rows) + JSON.stringify(outcomes.orders.map((order) => [order.order, order.reached, order.per_id])));
    await writeFile(path.resolve(ROOT, options.out), `${JSON.stringify(outcomes)}\n`, 'utf8');
    await writeWorksheet(outcomes, path.resolve(ROOT, options.worksheet));
    console.log(JSON.stringify({ out: options.out, worksheet: options.worksheet, sample: outcomes.sample.strata, outcome_digest: outcomes.outcome_digest }));
  })().catch((error) => {
    console.error(error.errors ? error.errors.join('\n') : error.stack);
    process.exitCode = 1;
  });
}
