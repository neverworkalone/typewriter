/**
 * Prepare the committed M5-10D calibration sample for manual recording.
 *
 * This command creates only the pre-review workload. It deliberately has no
 * editorial verdict plan, decision-row factory, audit-row factory, or recovery
 * builder. Each judgment must be performed through separate recorder CLI
 * invocations after the source context is opened.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { buildM5DWorkload } from './build-m5-10d-workload.mjs';
import {
  DEFAULT_PROPOSAL_PATH,
  DEFAULT_WORKLOAD_PATH,
} from './validate-m5-10d-recovery.mjs';

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export async function prepareM5DCalibration({
  proposalPath = DEFAULT_PROPOSAL_PATH,
  outputPath = DEFAULT_WORKLOAD_PATH,
  frozenAt = new Date(Date.now() - 1000).toISOString(),
} = {}) {
  const proposal = await readJson(proposalPath);
  if (!Array.isArray(proposal.cases) || proposal.cases.length !== 20) {
    throw new Error('M5-10D calibration preparation requires the committed 20-case proposal');
  }
  const workload = await buildM5DWorkload({
    proposalPath,
    outputPath,
    provisional: true,
    frozenAt,
  });
  return {
    proposal_path: proposalPath,
    workload_path: outputPath,
    case_count: workload.case_count,
    declaration_status: workload.declaration_status,
    next_step: 'Use record-m5-10d-timing.mjs start-pass, record-proposal, start-judgment, and complete-judgment as separate invocations. This command creates no decisions, follow-up source, recovery, or authorization.',
  };
}

function parseArguments(argv) {
  const args = {};
  for (const argument of argv) {
    if (!argument.startsWith('--') || !argument.includes('=')) {
      throw new Error(`arguments must use --name=value form (received ${argument})`);
    }
    const separator = argument.indexOf('=');
    args[argument.slice(2, separator)] = argument.slice(separator + 1);
  }
  return args;
}

const isMainModule = process.argv[1]
  && process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  const args = parseArguments(process.argv.slice(2));
  prepareM5DCalibration({
    ...(args.proposal ? { proposalPath: args.proposal } : {}),
    ...(args.output ? { outputPath: args.output } : {}),
  })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}
