import { assertSourceDigestRetained } from './repository-source-digest.mjs';

export const ISSUE_221_SOURCE_TOOLS = Object.freeze([
  Object.freeze({ key: 'extractor_script_sha256', label: 'extractor', relativePath: 'scripts/reference/corpus_lemma_pilot.py' }),
  Object.freeze({ key: 'orchestrator_script_sha256', label: 'orchestrator', relativePath: 'scripts/reference/run-corpus-lemma-pilot.mjs' }),
]);

export async function assertIssue221SourceDigestsRetained({ tools, repositoryRoot }) {
  for (const { key, label, relativePath } of ISSUE_221_SOURCE_TOOLS) {
    await assertSourceDigestRetained({
      relativePath,
      expectedDigest: tools?.[key],
      label: `Issue #221 ${label}`,
      repositoryRoot,
    });
  }
  return true;
}
