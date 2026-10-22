// Raw Garmin responses, exactly as stored.
//   /api/raw?kind=daily              -> every day's raw summary
//   /api/raw?kind=daily&key=2026-10-21 -> one day
//   /api/raw?kind=extra&key=trainingStatus -> latest answer from a discovered endpoint
// kinds: activities, daily, sleep, hrv, weight, bb (keyed), extra (keyed), zones, fitnessAge, profile, probe, shapes
import { DATA_PATH, isAuthed, readStore, sendJson } from '../lib/common.js';

const KEYED = ['activities', 'daily', 'sleep', 'hrv', 'weight', 'bb'];
const SINGLE = ['zones', 'fitnessAge', 'profile', 'probe', 'shapes'];

export default async function handler(req, res) {
  if (!isAuthed(req)) return sendJson(res, 401, { error: 'login' });
  const { kind, key } = req.query || {};
  const state = await readStore(DATA_PATH);
  if (!state || !state.raw) return sendJson(res, 404, { error: 'no data yet' });

  if (KEYED.includes(kind)) {
    const map = state.raw[kind];
    if (key) return map[key] ? sendJson(res, 200, map[key]) : sendJson(res, 404, { error: 'not found' });
    return sendJson(res, 200, map);
  }
  if (kind === 'extra') {
    const all = state.extra || {};
    if (key) return all[key] ? sendJson(res, 200, all[key]) : sendJson(res, 404, { error: 'not found' });
    return sendJson(res, 200, all);
  }
  if (SINGLE.includes(kind)) return sendJson(res, 200, state[kind] ?? null);
  return sendJson(res, 400, { error: 'unknown kind' });
}
