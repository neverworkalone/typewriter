import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readRepositoryJson(relativePath) {
  const source = await readFile(path.join(repositoryRoot, relativePath), 'utf8');
  return JSON.parse(source);
}

describe('product MV3 manifest', () => {
  it('declares the Vue popup and options entrypoints with only local storage permission', async () => {
    const manifest = await readRepositoryJson('public/manifest.json');

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.action.default_popup).toBe('popup.html');
    expect(manifest.options_ui.page).toBe('options.html');
    expect(manifest.permissions).toEqual(['storage']);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.web_accessible_resources).toBeUndefined();
    expect(manifest.content_security_policy.extension_pages).toBe(
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    );
  });

  it('keeps both declared HTML entrypoints in the product source', async () => {
    const packageJson = await readRepositoryJson('package.json');
    const manifest = await readRepositoryJson('public/manifest.json');

    expect(packageJson.scripts.build).toBe('vite build');
    for (const entrypoint of [manifest.action.default_popup, manifest.options_ui.page]) {
      const source = await readFile(path.join(repositoryRoot, entrypoint), 'utf8');
      expect(source).toContain('id="app"');
      expect(source).toContain('type="module"');
    }
  });
});
