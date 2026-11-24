/** Notify observers without allowing logging failures to affect the build. */
export function progressStage(onProgress, stage) {
  const started = performance.now();
  try { onProgress?.({ type: 'start', stage }); } catch {}
  return () => {
    try { onProgress?.({ type: 'complete', stage, elapsedMs: performance.now() - started }); } catch {}
  };
}

export function createDictionaryProgress(stream = process.stdout) {
  let activeLine = false;
  let finalCount;
  return (event) => {
    if (event.type === 'count') {
      const value = event.count === undefined
        ? 'in progress'
        : event.total === undefined ? `${event.count}` : `${event.count} / ${event.total}`;
      const line = `${event.stage}: ${value}`;
      // The completion summary keeps the record count; later phases only update the live line.
      if (event.stage === 'Full SQLite records') finalCount = line;
      if (stream.isTTY) {
        stream.write(`\r\u001b[2KDictionary ${line}`);
        activeLine = true;
      }
      return;
    }
    if (activeLine) {
      stream.write('\n');
      activeLine = false;
    }
    if (event.type === 'start') {
      stream.write(`Dictionary ${event.stage}: started\n`);
    } else if (event.type === 'complete') {
      const count = event.stage === 'Full SQLite writing' && finalCount ? `; ${finalCount}` : '';
      stream.write(`Dictionary ${event.stage}: completed (${(event.elapsedMs / 1000).toFixed(1)}s${count})\n`);
    }
  };
}
