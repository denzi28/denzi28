// Pulls Garmin history into encrypted storage, keeping every response exactly as Garmin
// sent it. Resumable: each run works until its deadline, saves progress, and the next run
// carries on. Re-runs only fetch what is new.
import { DATA_PATH, readStore, writeStore, garminGet, garminTry, GarminKeyError, GarminTooBigError } from './common.js';

const VERSION = 2;
const DAY = 86400e3;
const PROBE_EVERY_MS = 3 * DAY;
const PROBE_V = 2;
const SHAPES_V = 3;
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => iso(new Date(Date.parse(`${s}T00:00:00Z`) + n * DAY));
const minDate = (a, b) => (a < b ? a : b);
const todayStr = () => iso(new Date(Date.now() + 3 * 3600e3)); // Garmin day boundaries are local; lean ahead a little.

function emptyState(full) {
  return {
    version: VERSION,
    full: Boolean(full),
    rangeStart: full ? '2000-01-01' : addDays(todayStr(), -365),
    raw: { activities: {}, daily: {}, sleep: {}, hrv: {}, weight: {}, bb: {} },
    zones: null,
    fitnessAge: null,
    profile: null,
    extra: {},
    probe: null,
    cursors: {},
    act: { backfillDone: false, offset: 0 },
    shapes: {},
    errors: null,
    lastSync: null,
  };
}

// Records just the field names Garmin returned (never values), to help debug odd responses.
function noteShape(state, name, res) {
  if (res == null) return;
  const top = Array.isArray(res) ? `[array ${res.length}]` : Object.keys(res).slice(0, 30);
  const list = Array.isArray(res) ? res : Object.values(res).find(Array.isArray);
  state.shapes[name] = { top, item: list && list[0] && typeof list[0] === 'object' ? Object.keys(list[0]).slice(0, 80) : null };
}

// Field names (never values) two levels deep, for checking how Garmin structures a record.
function deepShape(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) out[k] = v.length && v[0] && typeof v[0] === 'object' && !Array.isArray(v[0]) ? Object.keys(v[0]) : `[${v.length}${Array.isArray(v[0]) ? ` x ${v[0].length}` : ''}]`;
    else if (v && typeof v === 'object') out[k] = Object.keys(v);
    else out[k] = typeof v;
  }
  return out;
}

const dateOf = (x) => String(x?.calendarDate || x?.summaryDate || x?.date || '').slice(0, 10) || null;
const listIn = (res, ...keys) => {
  if (Array.isArray(res)) return res;
  for (const k of keys) if (Array.isArray(res?.[k])) return res[k];
  return [];
};

// ---------- activities ----------

async function syncActivities(state, deadline) {
  const known = state.raw.activities;
  const page = async (start) => (await garminGet(`/activitylist-service/activities/search/activities?start=${start}&limit=20`)) || [];
  if (!state.act.backfillDone) {
    let start = state.act.offset || 0;
    while (Date.now() < deadline) {
      const items = await page(start);
      noteShape(state, 'activities', items);
      for (const a of items) known[a.activityId] = a;
      const oldest = items.length ? items[items.length - 1].startTimeLocal?.slice(0, 10) : null;
      if (items.length < 20 || (oldest && oldest < state.rangeStart)) {
        state.act = { backfillDone: true, offset: 0 };
        return true;
      }
      start += 20;
      state.act.offset = start;
    }
    return false;
  }
  for (let start = 0; Date.now() < deadline; start += 20) {
    const items = await page(start);
    let sawKnown = false;
    for (const a of items) {
      if (known[a.activityId]) sawKnown = true;
      known[a.activityId] = a;
    }
    if (sawKnown || items.length < 20) return true;
  }
  return false;
}

// ---------- date-range endpoints ----------

async function fetchRange(urlFor, from, to) {
  try {
    return [await garminGet(urlFor(from, to))];
  } catch (err) {
    if (!(err instanceof GarminTooBigError)) throw err;
    if (from === to) return []; // a single day that still fails: skip it
    const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY);
    const mid = addDays(from, Math.floor(days / 2));
    return [...(await fetchRange(urlFor, from, mid)), ...(await fetchRange(urlFor, addDays(mid, 1), to))];
  }
}

async function syncRanges(state, key, { start, chunk, urlFor, store }, deadline) {
  const today = todayStr();
  const cursor = state.cursors[key];
  // Always re-read the last few days: today's numbers keep changing.
  let from = cursor ? minDate(addDays(cursor, 1), addDays(today, -3)) : start;
  while (from <= today) {
    if (Date.now() > deadline) return false;
    const to = minDate(addDays(from, chunk - 1), today);
    for (const res of await fetchRange(urlFor, from, to)) {
      noteShape(state, key, res);
      if (res) store(res);
    }
    state.cursors[key] = to;
    from = addDays(to, 1);
  }
  return true;
}

const storeByDate = (target, ...listKeys) => (res) => {
  for (const item of listIn(res, ...listKeys)) {
    const day = dateOf(item);
    if (day && item && typeof item === 'object') target[day] = item;
  }
};

// ---------- endpoint discovery ----------
// Garmin documents only a few Personal API endpoints. These are other Garmin Connect
// endpoints; we try each one and keep the latest answer for the ones this key can read.
function probeList(displayName) {
  const d = addDays(todayStr(), -1), s = addDays(todayStr(), -7);
  const dn = displayName ? encodeURIComponent(displayName) : null;
  return [
    ['userSettings', '/userprofile-service/userprofile/user-settings'],
    ['trainingReadiness', `/metrics-service/metrics/trainingreadiness/${d}`],
    ['trainingStatus', `/metrics-service/metrics/trainingstatus/aggregated/${d}`],
    ['vo2MaxHistory', `/metrics-service/metrics/maxmet/daily/${s}/${d}`],
    ['enduranceScore', `/metrics-service/metrics/endurancescore?calendarDate=${d}`],
    ['hillScore', `/metrics-service/metrics/hillscore?calendarDate=${d}`],
    ['racePredictions', dn && `/metrics-service/metrics/racepredictions/latest/${dn}`],
    ['personalRecords', dn && `/personalrecord-service/personalrecord/prs/${dn}`],
    ['dailySummaryV1', dn && `/usersummary-service/usersummary/daily/${dn}?calendarDate=${d}`],
    ['dailyHeartRate', dn && `/wellness-service/wellness/dailyHeartRate/${dn}?date=${d}`],
    ['dailyStress', `/wellness-service/wellness/dailyStress/${d}`],
    ['bodyBatteryReports', `/wellness-service/wellness/bodyBattery/reports/daily?startDate=${s}&endDate=${d}`],
    ['sleepDetail', `/sleep-service/sleep/dailySleepData?date=${d}&nonSleepBufferMinutes=60`],
    ['hrvDetail', `/hrv-service/hrv/${d}`],
    ['spo2', `/wellness-service/wellness/daily/spo2/${d}`],
    ['respiration', `/wellness-service/wellness/daily/respiration/${d}`],
    ['intensityMinutes', `/wellness-service/wellness/daily/im/${d}`],
    ['floors', `/wellness-service/wellness/floorsChartData/daily/${d}`],
    ['stepsDaily', `/usersummary-service/stats/steps/daily/${s}/${d}`],
    ['hydration', `/usersummary-service/usersummary/hydration/daily/${d}`],
    ['bodyComposition', `/weight-service/weight/dateRange?startDate=${s}&endDate=${d}`],
    ['lactateThreshold', '/biometric-service/biometric/latestLactateThreshold'],
    ['devices', '/device-service/deviceregistration/devices'],
    ['badges', '/badge-service/badge/earned'],
    ['goals', '/goal-service/goal/goals?status=active'],
    // second round: forms that don't need your Garmin username, and other services
    ['profileMe', '/userprofile-service/userprofile/profile'],
    ['personalInfo', '/userprofile-service/userprofile/personal-information'],
    ['dailyHeartRateQ', `/wellness-service/wellness/dailyHeartRate?date=${d}`],
    ['dailyStressQ', `/wellness-service/wellness/dailyStress?date=${d}`],
    ['dailySummaryQ', `/usersummary-service/usersummary/daily?calendarDate=${d}`],
    ['dailyEvents', `/wellness-service/wellness/dailyEvents?calendarDate=${d}`],
    ['bodyBatteryEvents', `/wellness-service/wellness/bodyBattery/events/${d}`],
    ['raceLatest', '/metrics-service/metrics/racepredictions/latest'],
    ['raceDaily', `/metrics-service/metrics/racepredictions/daily?fromCalendarDate=${s}&toCalendarDate=${d}`],
    ['prsMine', '/personalrecord-service/personalrecord/prs'],
    ['trainingStatusDaily', `/metrics-service/metrics/trainingstatus/daily/${d}`],
    ['readinessRange', `/metrics-service/metrics/trainingreadiness/daily/${s}/${d}`],
    ['enduranceStats', `/metrics-service/metrics/endurancescore/stats?startDate=${s}&endDate=${d}&aggregation=daily`],
    ['hillStats', `/metrics-service/metrics/hillscore/stats?startDate=${s}&endDate=${d}&aggregation=daily`],
    ['stressStats', `/usersummary-service/stats/stress/daily/${s}/${d}`],
    ['imStats', `/usersummary-service/stats/im/daily/${s}/${d}`],
    ['hydrationStats', `/usersummary-service/stats/hydration/daily/${s}/${d}`],
    ['sleepStats', `/sleep-service/stats/sleep/daily/${s}/${d}`],
    ['weightDay', `/weight-service/weight/dayview/${d}`],
    ['lastDevice', '/device-service/deviceservice/mylastused'],
    ['workouts', '/workout-service/workouts?start=0&limit=20'],
    ['gear', '/gear-service/gear/filterGear'],
    ['zonesV1', '/biometric-service/heartRateZones'],
    ['ltHistory', `/biometric-service/stats/lactateThresholdHeartRate/range/${s}/${d}?sport=RUNNING&aggregation=daily&aggregationStrategy=LATEST`],
    ['fitnessStats', `/fitnessstats-service/activity?aggregation=daily&startDate=${s}&endDate=${d}&metric=duration&groupByParentActivityType=true`],
    ['calendarMonth', `/calendar-service/year/${d.slice(0, 4)}/month/${Number(d.slice(5, 7)) - 1}`],
  ].filter(([, path]) => path);
}

async function runProbe(state, deadline) {
  const profile = await garminTry('/userprofile-service/socialProfile');
  const results = { profile: { status: profile.status, ok: profile.ok, bytes: profile.bytes } };
  if (profile.ok) state.profile = profile.data;
  const displayName = profile.ok ? profile.data.displayName || profile.data.userName : null;
  for (const [name, path] of probeList(displayName)) {
    if (Date.now() > deadline) return false; // finish next run rather than save half a result
    const r = await garminTry(path);
    results[name] = { status: r.status, ok: r.ok, bytes: r.bytes, path: path.split('?')[0].replace(displayName || '\u0000', '{you}') };
    if (r.ok) {
      state.extra[name] = { at: new Date().toISOString(), data: r.data };
      noteShape(state, `extra.${name}`, r.data);
    }
  }
  state.probe = { v: PROBE_V, at: new Date().toISOString(), results };
  console.log('probe:', JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, `${v.status}${v.ok ? ' ok' : ''} ${v.bytes}b`]))));
  return true;
}

// ---------- overnight HRV readings ----------
// One call per night, only for nights that have an HRV summary. Resumable like everything else.
async function syncHrvDetail(state, deadline) {
  const raw = state.raw;
  raw.hrvDetail ||= {};
  const today = todayStr();
  const want = Object.keys(raw.hrv).sort().reverse().filter((d) => !raw.hrvDetail[d] || d >= addDays(today, -1));
  for (const day of want) {
    if (Date.now() > deadline) return false;
    try {
      const res = await garminGet(`/hrv-service/hrv/${day}`);
      raw.hrvDetail[day] = res || { empty: true };
    } catch (err) {
      if (err instanceof GarminKeyError) throw err;
      raw.hrvDetail[day] = { error: true };
    }
  }
  return true;
}

// ---------- main ----------

export async function runSync({ deadline, full = false }) {
  let state = await readStore(DATA_PATH);
  if (!state || state.version !== VERSION) state = emptyState(full || state?.full);
  if (full && !state.full) {
    // Widen to full history: re-walk activities, then refill older days.
    state.full = true;
    state.rangeStart = '2000-01-01';
    state.act = { backfillDone: false, offset: 0 };
    state.cursors = {};
  }

  state.raw.bb ||= {}; // added after the first v2 states were written
  let done = await syncActivities(state, deadline);

  // Daily data starts at the first activity in full mode, so we don't scan empty years.
  const firstAct = Object.values(state.raw.activities).map((a) => a.startTimeLocal?.slice(0, 10)).filter(Boolean).sort()[0];
  const start = state.full ? (firstAct && firstAct > '2010-01-01' ? firstAct : '2010-01-01') : state.rangeStart;
  const raw = state.raw;

  const steps = [
    ['daily', 60, (a, b) => `/usersummary-service/v2/dailysummaries?startDate=${a}&endDate=${b}`, storeByDate(raw.daily, 'data', 'dailySummaries')],
    ['sleep', 28, (a, b) => `/sleep-service/sleep/dailySleepSummariesByDate?startDate=${a}&endDate=${b}`, storeByDate(raw.sleep, 'data', 'dailySleepSummaries', 'sleepSummaries', 'dailySleepDTOList')],
    ['hrv', 360, (a, b) => `/hrv-service/hrv/daily/${a}/${b}`, storeByDate(raw.hrv, 'hrvSummaries')],
    ['weight', 360, (a, b) => `/weight-service/weight/range/${a}/${b}`, storeByDate(raw.weight, 'dailyWeightSummaries')],
    ['bb', 30, (a, b) => `/wellness-service/wellness/bodyBattery/reports/daily?startDate=${a}&endDate=${b}`, storeByDate(raw.bb, 'data', 'bodyBatteryReports')],
  ];
  const errors = {};
  for (const [key, chunk, urlFor, store] of steps) {
    if (!done) break;
    try {
      done = await syncRanges(state, key, { start, chunk, urlFor, store }, deadline);
    } catch (err) {
      if (err instanceof GarminKeyError) throw err;
      console.error(`sync ${key} failed:`, err.message); // one missing data type shouldn't stop the rest
      errors[key] = err.message;
    }
  }

  if (done) {
    for (const [field, path] of [
      ['zones', '/biometric-service/heartRateZones/v2'],
      ['fitnessAge', `/fitnessage-service/fitnessage/v2/${todayStr()}`],
    ]) {
      try {
        const res = await garminGet(path);
        noteShape(state, field, res);
        if (res) state[field] = res;
      } catch (err) {
        errors[field] = err.message;
      }
    }
    if (!state.probe || state.probe.v !== PROBE_V || Date.now() - Date.parse(state.probe.at) > PROBE_EVERY_MS) done = await runProbe(state, deadline);
    if (done) done = await syncHrvDetail(state, deadline);
  }
  if (done) {
    state.lastSync = new Date().toISOString();
    console.log('shapes:', JSON.stringify(Object.fromEntries(['activities', 'daily', 'sleep', 'hrv', 'weight', 'bb', 'zones', 'fitnessAge'].map((k) => [k, state.shapes[k]]))));
    // Field names only (no values), so the app's field mapping can be checked against the real data.
    const last = (m) => Object.values(m || {}).at(-1);
    for (const [name, obj] of [['daily', last(raw.daily)], ['sleep', last(raw.sleep)], ['hrv', last(raw.hrv)], ['bb', last(raw.bb)], ['hrvDetail', last(raw.hrvDetail)], ['fitnessAge', state.fitnessAge], ['activityKeys', last(raw.activities)]]) {
      console.log(`deep shape ${name}:`, JSON.stringify(name === 'activityKeys' ? Object.keys(obj || {}) : deepShape(obj)));
    }
    for (const [name, v] of Object.entries(state.extra || {})) console.log(`deep shape extra.${name}:`, JSON.stringify(deepShape(Array.isArray(v.data) ? v.data[0] : v.data)));
    state.shapesV = SHAPES_V;
    console.log('counts:', JSON.stringify(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Object.keys(v).length]))));
  }
  state.errors = Object.keys(errors).length ? errors : null;

  await writeStore(DATA_PATH, state);
  return { done, state };
}

export function summarize(state) {
  const raw = state.raw;
  const actDates = Object.values(raw.activities).map((a) => a.startTimeLocal?.slice(0, 10)).filter(Boolean).sort();
  const days = Object.keys(raw.daily).sort();
  const nights = Object.keys(raw.sleep).sort();
  return {
    activities: actDates.length,
    days: days.length,
    nights: nights.length,
    hrvDays: Object.keys(raw.hrv).length,
    weighIns: Object.keys(raw.weight).length,
    from: [actDates[0], days[0], nights[0]].filter(Boolean).sort()[0] || null,
    to: [actDates.at(-1), days.at(-1), nights.at(-1)].filter(Boolean).sort().at(-1) || null,
    lastSync: state.lastSync,
    full: state.full,
  };
}
