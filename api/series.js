// Any numeric Garmin field as a time series.
//   /api/series?kind=daily               -> list of numeric fields with how many days have them
//   /api/series?kind=daily&path=a.b.c    -> [[date, value], ...]
// kinds: daily, sleep, hrv, weight, activities (activities are keyed by start time)
import { DATA_PATH, isAuthed, readStore, sendJson, flatten, getPath } from '../lib/common.js';

const KINDS = ['daily', 'sleep', 'hrv', 'weight', 'activities'];

export default async function handler(req, res) {
  if (!isAuthed(req)) return sendJson(res, 401, { error: 'login' });
  const { kind, path } = req.query || {};
  if (!KINDS.includes(kind)) return sendJson(res, 400, { error: 'unknown kind' });
  const state = await readStore(DATA_PATH);
  if (!state || !state.raw) return sendJson(res, 404, { error: 'no data yet' });

  const entries = Object.entries(state.raw[kind]).map(([k, v]) => [kind === 'activities' ? v.startTimeLocal : k, v]);
  if (!path) {
    const counts = {};
    for (const [, v] of entries) {
      for (const [p, val] of Object.entries(flatten(v))) {
        if (typeof val === 'number' && Number.isFinite(val) && !/(^|\.)(\w*[Ii]d|\w*Pk|\w*Timestamp\w*|\w*GMT)$/.test(p)) counts[p] = (counts[p] || 0) + 1;
      }
    }
    const fields = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([p, n]) => ({ path: p, n }));
    return sendJson(res, 200, { kind, total: entries.length, fields });
  }
  const points = entries
    .map(([k, v]) => [k, getPath(v, path)])
    .filter(([k, val]) => k && typeof val === 'number' && Number.isFinite(val))
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return sendJson(res, 200, { kind, path, points });
}
