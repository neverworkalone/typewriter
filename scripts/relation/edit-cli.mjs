// Stage 3 editor CLI (#2450): the Refinement Engine core with the Stage 3 rule (Drop and Link Repair).
import { chunkSenseGroups as chunkGroups, createRefineCli, runAsScript } from './refine/core.mjs';
import * as stage3 from './refine/rules/s3.mjs';

export { escapeField, parsePromptView, renderPromptView } from './refine/rules/s3.mjs';
export const chunkSenseGroups = (groups, options = {}) => chunkGroups(groups, { ...options, label: stage3.label });
export const { run } = createRefineCli(stage3);

runAsScript(import.meta.url, run);
