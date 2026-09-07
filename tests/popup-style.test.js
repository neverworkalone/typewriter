import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('popup layout contract', () => {
  it('keeps the popup and its panel at a fixed width in every search state', async () => {
    const css = await readFile(path.join(repositoryRoot, 'src/popup/style.css'), 'utf8');

    expect(css).toMatch(
      /html,\s*\nbody,\s*\n#app\s*\{[\s\S]*?width:\s*420px;[\s\S]*?min-width:\s*420px;[\s\S]*?max-width:\s*420px;/,
    );
    expect(css).toMatch(
      /\.popup-app\s*\{[\s\S]*?width:\s*420px;[\s\S]*?min-width:\s*420px;[\s\S]*?max-width:\s*420px;/,
    );
    expect(css).toMatch(
      /\.popup-app \.dictionary-panel\s*\{[\s\S]*?width:\s*420px;[\s\S]*?min-width:\s*420px;[\s\S]*?max-width:\s*420px;/,
    );
  });
});
