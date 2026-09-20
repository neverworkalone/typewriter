import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');

const NPM_EXECUTABLE = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function nodeCommand(args) {
  return {
    executable: process.execPath,
    args,
  };
}

function npmCommand(script, args = []) {
  return {
    executable: NPM_EXECUTABLE,
    args: ['run', script, ...(args.length > 0 ? ['--', ...args] : [])],
  };
}

function commandCheck(label, args, testFiles = []) {
  return {
    label,
    command: () => nodeCommand(args),
    testFiles,
  };
}

function npmCheck(label, script, args = [], testFiles = []) {
  return {
    label,
    command: () => npmCommand(script, args),
    testFiles,
  };
}

function allowDirtyArguments() {
  return process.env.TYPEWRITER_ALLOW_DIRTY === 'true' ? ['--allow-dirty'] : [];
}

function testCheck(file, label = `Run ${file}`) {
  return commandCheck(label, ['--test', file], [file]);
}

function contractCheck(label, script, testFile) {
  return npmCheck(label, script, [], [testFile]);
}

export const CI_CATEGORY_ORDER = Object.freeze([
  'canonical',
  'lexical',
  'batch',
  'historical',
  'toolchain',
  'product',
  'artifacts',
]);

export const CI_CATEGORIES = Object.freeze({
  canonical: {
    label: 'Core canonical and dataset validation',
    checks: [
      commandCheck('Validate manifest version', ['scripts/ci/validate-manifest.mjs']),
      commandCheck('Validate canonical JSONL', ['scripts/validate/canonical-jsonl.mjs']),
      testCheck('tests/validate-canonical-jsonl.test.mjs', 'Test canonical JSONL validator'),
      commandCheck('Validate dataset integrity', ['scripts/validate/dataset-integrity.mjs']),
      testCheck('tests/validate-dataset-integrity.test.mjs', 'Test dataset validator'),
      commandCheck('Validate M5 target inventory', ['scripts/validate/target-inventory.mjs']),
      testCheck('tests/target-inventory.test.mjs', 'Test target inventory'),
      npmCheck('Validate lexical rule inventory', 'validate:rules'),
      testCheck('tests/lexical-rule-inventory.test.mjs', 'Test lexical rule inventory'),
      testCheck('tests/ci-runner.test.mjs', 'Test CI category runner fail-fast behavior'),
      testCheck('tests/ci-registry.test.mjs', 'Test CI check ownership registry'),
    ],
  },

  lexical: {
    label: 'Shared lexical and semantic validation',
    checks: [
      npmCheck('Validate shared lexical quality and semantic audit', 'validate:lexical'),
      testCheck('tests/lexical-quality.test.mjs', 'Test shared lexical quality'),
      testCheck('tests/relation-admission.test.mjs', 'Test relation admission'),
      testCheck('tests/semantic-audit-decision-source.test.mjs', 'Test semantic audit decision source'),
      testCheck('tests/semantic-corrections.test.mjs', 'Test semantic corrections'),
      testCheck('tests/semantic-decision-source-locality.test.mjs', 'Test semantic decision-source locality'),
    ],
  },

  batch: {
    label: 'Batch process, contract, recovery, and authorization validation',
    checks: [
      npmCheck('Validate M5-8 process contract', 'batch:process:check'),
      npmCheck('Validate M5-9A repair authorization', 'batch:repair:check'),
      npmCheck('Validate M5-10A candidate-generation calibration', 'batch:m5-10a:calibration:check'),
      npmCheck('Validate M5-10A process correction', 'batch:m5-10a:process:check'),
      npmCheck('Validate M5-10A repair authorization', 'batch:m5-10a:repair:check'),
      contractCheck(
        'Run M5-10C recovery contract tests',
        'batch:m5-10c:contract:check',
        'tests/m5-10c-recovery.test.mjs',
      ),
      npmCheck('Validate M5-10C recovery and authorization contract', 'batch:m5-10c:recovery:contract:check'),
      contractCheck(
        'Run M5-10D workload contract tests',
        'batch:m5-10d:contract:check',
        'tests/m5-10d-workload.test.mjs',
      ),
      npmCheck('Validate M5-10D recovery and authorization contract', 'batch:m5-10d:recovery:contract:check'),
      npmCheck('Validate committed M5-10D recovery artifact', 'batch:m5-10d:recovery:check'),
      npmCheck('Validate committed M5-10D authorization artifact', 'batch:m5-10d:authorization:check'),
      testCheck('tests/batch-workflow.test.mjs', 'Test shared batch workflow'),
      testCheck('tests/m5-8-process.test.mjs', 'Test M5-8 process contract'),
      testCheck('tests/m5-9a-repair.test.mjs', 'Test M5-9A repair authorization'),
      testCheck('tests/m5-9-expansion.test.mjs', 'Test M5-9 expansion'),
      testCheck('tests/m5-calibration.test.mjs', 'Test M5 calibration'),
      testCheck('tests/m5-recalibration.test.mjs', 'Test M5 recalibration'),
      testCheck('tests/m5-10a-process.test.mjs', 'Test M5-10A process correction'),
      testCheck('tests/batch-measurement.test.mjs', 'Test batch measurement'),
      testCheck('tests/lexical-production-state.test.mjs', 'Test lexical production state'),
      testCheck('tests/m5-11.test.mjs', 'Test M5-11 expansion'),
      testCheck('tests/m5-11-admission.test.mjs', 'Test M5-11 admission'),
      npmCheck('Validate M5-12 pre-admission gate', 'batch:m5-12:check'),
      testCheck('tests/m5-12.test.mjs', 'Test M5-12 pre-admission gate'),
    ],
  },

  historical: {
    label: 'Historical replay and staged batch validation',
    checks: [
      {
        label: 'Validate M5-10A Wave A2 stage',
        command: ({ historicalInputs }) => npmCommand('batch:m5-10a:wave-a2:check', [
          `--staged=${historicalInputs.waveA2Reviewed}`,
          `--semantic-audit=${historicalInputs.waveA2SemanticAudit}`,
          '--canonical-dir=data/batches/m5-10-wave-b-base-canonical',
          '--canonical-source-dir=data/canonical',
        ]),
        testFiles: [],
      },
      {
        label: 'Validate M5-10 Wave B stage',
        command: ({ historicalInputs }) => npmCommand('batch:m5-10:wave-b:check', [
          `--staged=${historicalInputs.waveBReviewed}`,
          `--semantic-audit=${historicalInputs.waveBSemanticAudit}`,
        ]),
        testFiles: [],
      },
      testCheck('tests/historical-replay-cli.test.mjs', 'Test historical replay CLIs'),
      testCheck('tests/m5-10a-wave-a2.test.mjs', 'Test M5-10A Wave A2 replay'),
      testCheck('tests/m5-10-wave-a.test.mjs', 'Test M5-10 Wave A replay'),
      testCheck('tests/m5-10-wave-b-timing.test.mjs', 'Test M5-10 Wave B timing'),
      testCheck('tests/m5-10-wave-b.test.mjs', 'Test M5-10 Wave B replay'),
    ],
  },

  toolchain: {
    label: 'Normalization, dictionary build, and integrated audit',
    checks: [
      commandCheck('Normalize canonical data', ['scripts/normalize/canonical.mjs']),
      testCheck('tests/normalize-canonical.test.mjs', 'Test canonical normalization'),
      {
        label: 'Build SQLite dictionary',
        command: () => nodeCommand(['scripts/build/dictionary.mjs', ...allowDirtyArguments()]),
        testFiles: [],
      },
      {
        label: 'Run integrated M2 audit',
        command: () => nodeCommand(['scripts/verify/m2-pipeline.mjs', ...allowDirtyArguments()]),
        testFiles: [],
      },
      testCheck('tests/build-dictionary.test.mjs', 'Test SQLite dictionary build'),
      testCheck('tests/m2-pipeline.test.mjs', 'Test integrated M2 audit'),
      testCheck('tests/reproducibility.test.mjs', 'Test reproducible dictionary builds'),
    ],
  },

  product: {
    label: 'Product tests and extension build',
    checks: [
      testCheck('tests/search-query.test.mjs', 'Test shared search query contract'),
      testCheck('tests/search-regressions.test.mjs', 'Test search regressions'),
      npmCheck('Run product unit tests', 'test:unit'),
      npmCheck('Build product extension', 'build'),
    ],
  },

  artifacts: {
    label: 'Generated-artifact and clean-checkout enforcement',
    checks: [
      testCheck('tests/artifact-policy.test.mjs', 'Test artifact policy'),
      testCheck('tests/validate-package.test.mjs', 'Test package validation'),
      commandCheck('Enforce generated-artifact policy and clean checkout', [
        'scripts/validate/artifact-policy.mjs',
        '--clean',
      ]),
    ],
  },
});

export function collectTestOwnership() {
  return CI_CATEGORY_ORDER.flatMap((categoryName) => (
    CI_CATEGORIES[categoryName].checks.flatMap((check) => (
      (check.testFiles ?? []).map((file) => ({
        category: categoryName,
        check: check.label,
        file,
      }))
    ))
  ));
}
