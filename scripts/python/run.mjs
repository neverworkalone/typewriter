#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { resolveManagedPython } from './env.mjs';

// Launcher: `node scripts/python/run.mjs <python args...>` runs the shared managed Python from any
// worktree; `--print` prints its path. Fails closed when the environment is absent or stale.
try {
  const python = resolveManagedPython();
  const args = process.argv.slice(2);
  if (args[0] === '--print') console.log(python);
  else process.exitCode = spawnSync(python, args, { stdio: 'inherit' }).status ?? 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
