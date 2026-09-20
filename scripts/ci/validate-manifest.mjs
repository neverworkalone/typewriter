import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(SCRIPT_DIRECTORY, '../../public/manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
  throw new Error('public/manifest.json must contain a non-empty string version');
}

console.log(`Manifest version: ${manifest.version}`);
