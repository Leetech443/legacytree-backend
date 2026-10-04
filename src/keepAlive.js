// Keep-alive cron: pings this API's PUBLIC /health URL on a schedule so Render's free plan
// (which sleeps after ~15 min without inbound traffic) never goes idle. Every run is logged.
import cron from 'node-cron';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_SCHEDULE = '*/10 * * * *'; // every 10 minutes

export function startKeepAlive() {
  // Render sets RENDER_EXTERNAL_URL automatically. Set KEEP_ALIVE_URL to override (e.g. a custom domain).
  const url = (process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  if (!url || process.env.KEEP_ALIVE === 'false') {
    console.log('[keep-alive] disabled (runs automatically on Render, or set KEEP_ALIVE_URL to enable elsewhere)');
    return null;
  }
  let schedule = process.env.KEEP_ALIVE_CRON || DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    console.error(`[keep-alive] invalid KEEP_ALIVE_CRON "${schedule}", falling back to "${DEFAULT_SCHEDULE}"`);
    schedule = DEFAULT_SCHEDULE;
  }

  let running = false;
  async function ping(trigger) {
    if (running) return; // never overlap runs
    running = true;
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const t0 = Date.now();
        const stamp = () => `[keep-alive] ${new Date().toISOString()} (${trigger}) GET ${url}/health`;
        try {
          const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'legacytree-keep-alive' } });
          const body = await res.json().catch(() => ({}));
          console.log(`${stamp()} -> ${res.status} in ${Date.now() - t0}ms${body.version ? ` (api v${body.version})` : ''}`);
          if (res.ok) return;
        } catch (e) {
          console.error(`${stamp()} -> FAILED${attempt === 1 ? ', retrying in 5s' : ''}: ${e.name === 'TimeoutError' ? 'timed out after 20s' : e.message}`);
        }
        if (attempt === 1) await sleep(5000);
      }
    } finally { running = false; }
  }

  const task = cron.schedule(schedule, () => ping('scheduled'));
  console.log(`[keep-alive] enabled: pinging ${url}/health on schedule "${schedule}"`);
  setTimeout(() => ping('startup'), 5000); // first check shortly after boot
  return task;
}
