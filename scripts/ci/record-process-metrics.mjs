import { appendFileSync } from 'node:fs';
import process from 'node:process';

const metricsPath = process.env.TYPEWRITER_PROCESS_METRICS_PATH;

if (metricsPath) {
  process.once('exit', () => {
    appendFileSync(
      metricsPath,
      `${JSON.stringify({
        pid: process.pid,
        peak_rss_kb: process.resourceUsage().maxRSS,
      })}\n`,
      'utf8',
    );
  });
}
