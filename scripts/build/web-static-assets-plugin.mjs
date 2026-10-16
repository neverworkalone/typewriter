import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveBuildProvenance } from './provenance.mjs';

export const PAGES_LEGAL_FILES = Object.freeze([
  'Apache-2.0.txt',
  'LICENSE.md',
  'DATA-LICENSE.md',
  'BRAND.md',
  'THIRD-PARTY-NOTICES.txt',
]);
export const PAGES_BUILD_INFO_FILE = 'pages-build-info.json';
export const PAGES_BUILD_INFO_SCHEMA = 'typewriter-pages-build-info/1';

// The static Pages product ships no dictionary or search runtime. It only adds
// the legal files and the exact source revision it was built from.
export function createWebStaticAssets({
  projectRoot,
  basePath,
  allowDirty = process.env.TYPEWRITER_ALLOW_DIRTY === 'true',
}) {
  return {
    name: 'typewriter-web-static-assets',
    apply: 'build',
    async generateBundle() {
      for (const fileName of PAGES_LEGAL_FILES) {
        this.emitFile({
          type: 'asset',
          fileName,
          source: await readFile(path.join(projectRoot, fileName)),
        });
      }
      const provenance = await resolveBuildProvenance({
        repositoryDirectory: projectRoot,
        allowDirty,
      });
      this.emitFile({
        type: 'asset',
        fileName: PAGES_BUILD_INFO_FILE,
        source: JSON.stringify({
          schema: PAGES_BUILD_INFO_SCHEMA,
          source_revision: provenance.source_revision,
          source_revision_source: provenance.source_revision_source,
          source_revision_verified: provenance.source_revision_verified,
          worktree_state: provenance.worktree_state,
          base_path: basePath,
        }, null, 2) + '\n',
      });
    },
  };
}
