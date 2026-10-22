import { DATA_PATH, isAuthed, readStore, sendJson } from '../lib/common.js';
import { summarize } from '../lib/sync.js';

export default async function handler(req, res) {
  if (!isAuthed(req)) return sendJson(res, 401, { error: 'login' });
  const state = await readStore(DATA_PATH);
  if (!state) return sendJson(res, 200, { empty: true });

  const activities = Object.values(state.activities).sort((a, b) => (a.start < b.start ? -1 : 1));
  return sendJson(res, 200, {
    summary: summarize(state),
    syncing: !state.lastSync || !state.act.backfillDone,
    activities,
    daily: state.daily,
    sleep: state.sleep,
    hrv: state.hrv,
    weight: state.weight,
    zones: state.zones,
    fitnessAge: state.fitnessAge,
    shapes: state.shapes,
    errors: state.errors || null,
  });
}
