import { DATA_PATH, isAuthed, readStore, sendJson } from '../lib/common.js';
import { summarize } from '../lib/sync.js';
import { normalize } from '../lib/normalize.js';

export default async function handler(req, res) {
  if (!isAuthed(req)) return sendJson(res, 401, { error: 'login' });
  const state = await readStore(DATA_PATH);
  if (!state || !state.raw) return sendJson(res, 200, { empty: true });

  const n = normalize(state);
  const p = state.profile || {};
  return sendJson(res, 200, {
    summary: summarize(state),
    syncing: !state.lastSync || !state.act.backfillDone || !(state.cursors?.bb || state.errors?.bb),
    ...n,
    zones: state.zones,
    fitnessAge: state.fitnessAge,
    profile: { name: p.fullName || p.displayName || null, image: p.profileImageUrlMedium || null, location: p.location || null },
    extra: Object.fromEntries(Object.entries(state.extra || {}).map(([k, v]) => [k, v.at])),
    probe: state.probe,
    errors: state.errors || null,
  });
}
