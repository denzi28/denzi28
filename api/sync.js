import { isAuthed, isCron, sendJson, GarminKeyError } from '../lib/common.js';
import { runSync, summarize } from '../lib/sync.js';

export default async function handler(req, res) {
  const cron = isCron(req);
  if (!cron && !isAuthed(req)) return sendJson(res, 401, { error: 'login' });
  if (!cron && req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });

  // The browser calls in short slices so it can show progress; the daily cron gets the full budget.
  const deadline = Date.now() + (cron ? 270e3 : 40e3);
  try {
    const { done, state } = await runSync({ deadline, full: req.query?.full === '1' });
    return sendJson(res, 200, { done, summary: summarize(state), errors: state.errors || null });
  } catch (err) {
    console.error('sync failed:', err.message);
    if (err instanceof GarminKeyError) return sendJson(res, 502, { error: 'garmin_key', message: err.message });
    return sendJson(res, 500, { error: 'sync_failed', message: err.message });
  }
}
