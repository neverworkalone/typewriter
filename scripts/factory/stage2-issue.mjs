// Structure of a Stage 2 per-batch tracking Issue. Recovery treats an Issue as a prior
// tracking Issue only when its title and body have exactly this shape; a bare mention of a
// claim ref (design documents, examples, discussion) is never ownership evidence.

const claimBatchId = (claimRef) => claimRef.slice(claimRef.lastIndexOf('/') + 1);

export const trackingIssueTitle = (batchId) => '[Stage 2] ' + batchId + ' lexical authoring and QA';

export function trackingIssueBody({ batchId, claimRef, baseSha, attempt, rejectedPr }) {
  const lines = [
    'Tracks full Stage 2 lexical authoring and source-bound semantic QA for ' + batchId + '.',
    '',
    'Claim ref: ' + claimRef,
    'Master snapshot: ' + baseSha,
    'Implementation scope: #265',
    'Attempt: ' + attempt,
    'Result PR: the Stage 2 result PR should close this tracking issue when merged.',
  ];
  if (rejectedPr) lines.push('Prior rejected admission PR: #' + rejectedPr);
  return lines.join('\n');
}

export function isStage2TrackingIssue(issue, claimRef) {
  if (!issue || issue.pull_request || typeof issue.title !== 'string' || typeof issue.body !== 'string') return false;
  const batchId = claimBatchId(claimRef);
  const lines = issue.body.split(/\r?\n/u);
  return issue.title === trackingIssueTitle(batchId)
    && lines[0] === 'Tracks full Stage 2 lexical authoring and source-bound semantic QA for ' + batchId + '.'
    && lines.includes('Claim ref: ' + claimRef);
}
