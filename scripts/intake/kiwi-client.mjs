import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIWI_SERVICE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'kiwi_service.py');
export const KIWI_BATCH_SIZE = 200;

// Real local analyzer: one Python process per bounded batch, never per word.
// Returns the same shape as kiwi_service.analyze_batch; an analyzer injected
// into the pipeline must match it (tests use a synthetic one).
export function createKiwiAnalyzer({ python = process.env.TYPEWRITER_PYTHON || 'python3', batchSize = KIWI_BATCH_SIZE } = {}) {
  return async function analyze(requests) {
    const results = [];
    let metadata = null;
    for (let offset = 0; offset < requests.length; offset += batchSize) {
      const response = await runBatch(python, requests.slice(offset, offset + batchSize));
      metadata ??= response.metadata;
      results.push(...response.results);
    }
    return { metadata, results };
  };
}

function runBatch(python, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [KIWI_SERVICE_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { /* fall through to explicit failure */ }
      if (code !== 0 || !parsed?.results) {
        reject(new Error(`Kiwi analysis failed (exit ${code}): ${parsed?.error ?? stderr.slice(0, 300)}`));
        return;
      }
      resolve(parsed);
    });
    child.stdin.end(JSON.stringify({ requests }));
  });
}
