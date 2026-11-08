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
      finalCount = `${event.stage}: ${event.count} / ${event.total}`;
      if (stream.isTTY) {
        stream.write(`\r\u001b[2KDictionary ${finalCount}`);
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
