import { loadReviewBatchesForRescueReport, runBoundedLiteratureLookup, summarizeLiteratureRescue } from './literature-rescue.mjs';

const USAGE = 'Usage: node scripts/factory/literature-rescue-cli.mjs lookup <batch id> <candidate id> <group id> | report';

try {
  const [command, batchId, candidateId, groupId] = process.argv.slice(2);
  if (command === 'lookup' && batchId && candidateId && groupId) {
    // Run only immediately before finalizing an evidence-insufficiency deferral. Local packs stay in the ignored cache.
    const result = await runBoundedLiteratureLookup({ batchId, candidateId, groupId, reasonClass: 'insufficient_context_evidence' });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'report') {
    console.log(JSON.stringify(summarizeLiteratureRescue(await loadReviewBatchesForRescueReport()), null, 2));
  } else throw new Error(USAGE);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
