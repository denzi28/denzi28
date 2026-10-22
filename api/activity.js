// Everything about one activity: the list summary we already have, plus the full detail and
// second-by-second streams (with the GPS track), fetched from Garmin on first open and cached.
import { DATA_PATH, isAuthed, readStore, writeStore, sendJson, garminTry, GarminKeyError } from '../lib/common.js';

// Laps, HR zones and weather return 404 on the Personal API, so only these two are fetched.
const PARTS = [
  ['detail', (id) => `/activity-service/activity/${id}`],
  ['streams', (id) => `/activity-service/activity/${id}/details?maxChartSize=600&maxPolylineSize=3000`],
];

export default async function handler(req, res) {
  if (!isAuthed(req)) return sendJson(res, 401, { error: 'login' });
  const id = String(req.query?.id || '');
  if (!/^\d+$/.test(id)) return sendJson(res, 400, { error: 'bad id' });

  const state = await readStore(DATA_PATH);
  const summary = state?.raw?.activities?.[id];
  if (!summary) return sendJson(res, 404, { error: 'not found' });

  const cachePath = `garmin/act/${id}.enc`;
  let cached = await readStore(cachePath);
  // Re-fetch if never fetched, on request, or hourly for activities from the last two days
  // (Garmin may still be processing them).
  const age = Date.now() - Date.parse(String(summary.startTimeLocal).replace(' ', 'T'));
  const stale = !cached || cached.v !== 2 || req.query?.refresh === '1' || (age < 2 * 86400e3 && Date.now() - Date.parse(cached.at) > 3600e3);
  if (stale) {
    try {
      const parts = {}, status = {};
      for (const [name, url] of PARTS) {
        const r = await garminTry(url(id));
        status[name] = r.status;
        if (r.ok) parts[name] = r.data;
      }
      cached = { v: 2, at: new Date().toISOString(), parts, status };
      await writeStore(cachePath, cached);
      console.log(`activity parts: ${JSON.stringify(status)} metrics: ${JSON.stringify((parts.streams?.metricDescriptors || []).map((d) => d.key))} polyline: ${parts.streams?.geoPolylineDTO?.polyline?.length ?? 0}`);
    } catch (err) {
      if (err instanceof GarminKeyError) return sendJson(res, 502, { error: 'garmin_key', message: err.message });
      if (!cached) return sendJson(res, 502, { error: 'garmin', message: err.message });
    }
  }
  return sendJson(res, 200, { summary, ...cached });
}
