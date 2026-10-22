// Pulls Garmin history into encrypted storage. Resumable: each run works until its
// deadline, saves progress, and the next run carries on. Re-runs only fetch what is new.
import { DATA_PATH, readStore, writeStore, garminGet, GarminKeyError, GarminTooBigError } from './common.js';

const DAY = 86400e3;
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => iso(new Date(Date.parse(`${s}T00:00:00Z`) + n * DAY));
const minDate = (a, b) => (a < b ? a : b);
const todayStr = () => iso(new Date(Date.now() + 3 * 3600e3)); // Garmin day boundaries are local; lean ahead a little.

function emptyState(full) {
  return {
    version: 1,
    full: Boolean(full),
    rangeStart: full ? '2000-01-01' : addDays(todayStr(), -365),
    activities: {},
    daily: {},
    sleep: {},
    hrv: {},
    weight: {},
    zones: null,
    fitnessAge: null,
    cursors: {},
    act: { backfillDone: false, offset: 0 },
    shapes: {},
    lastSync: null,
  };
}

// Records just the field names Garmin returned, to help debug odd responses.
function noteShape(state, name, res) {
  if (state.shapes[name] || res == null) return;
  const top = Array.isArray(res) ? '[array]' : Object.keys(res).slice(0, 25);
  const list = Array.isArray(res) ? res : Object.values(res).find(Array.isArray);
  state.shapes[name] = { top, item: list && list[0] ? Object.keys(list[0]).slice(0, 60) : null };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function trimActivity(a) {
  return {
    id: a.activityId,
    start: a.startTimeLocal,
    type: a.activityType?.typeKey || 'other',
    name: a.activityName || '',
    dist: num(a.distance),
    dur: num(a.duration),
    moving: num(a.movingDuration),
    elev: num(a.elevationGain),
    avgHR: num(a.averageHR),
    maxHR: num(a.maxHR),
    cal: num(a.calories),
    load: num(a.activityTrainingLoad),
    aero: num(a.aerobicTrainingEffect),
    anaer: num(a.anaerobicTrainingEffect),
    zones: [1, 2, 3, 4, 5].map((i) => num(a[`hrTimeInZone_${i}`])),
    vo2: num(a.vO2MaxValue),
    f1k: num(a.fastestSplit_1000),
    f5k: num(a.fastestSplit_5000),
    f10k: num(a.fastestSplit_10000),
    cadence: num(a.averageRunningCadenceInStepsPerMinute),
  };
}

// ---------- activities ----------

async function syncActivities(state, deadline) {
  const known = state.activities;
  if (!state.act.backfillDone) {
    let start = state.act.offset || 0;
    while (Date.now() < deadline) {
      const page = (await garminGet(`/activitylist-service/activities/search/activities?start=${start}&limit=20`)) || [];
      noteShape(state, 'activities', page);
      for (const a of page) known[a.activityId] = trimActivity(a);
      const oldest = page.length ? page[page.length - 1].startTimeLocal?.slice(0, 10) : null;
      if (page.length < 20 || (oldest && oldest < state.rangeStart)) {
        state.act.backfillDone = true;
        state.act.offset = 0;
        return true;
      }
      start += 20;
      state.act.offset = start;
    }
    return false;
  }
  // Already have history: page from newest until we reach activities we know.
  for (let start = 0; Date.now() < deadline; start += 20) {
    const page = (await garminGet(`/activitylist-service/activities/search/activities?start=${start}&limit=20`)) || [];
    let sawKnown = false;
    for (const a of page) {
      if (known[a.activityId]) sawKnown = true;
      known[a.activityId] = trimActivity(a);
    }
    if (sawKnown || page.length < 20) return true;
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

const dateOf = (x) => (x?.calendarDate || x?.summaryDate || x?.date || '').slice(0, 10) || null;
const listIn = (res, ...keys) => {
  if (Array.isArray(res)) return res;
  for (const k of keys) if (Array.isArray(res?.[k])) return res[k];
  return [];
};

function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v != null) out[k] = v;
  return Object.keys(out).length ? out : null;
}

function storeDaily(state) {
  return (res) => {
    for (const d of listIn(res, 'data', 'dailySummaries')) {
      const day = dateOf(d);
      const row = day && compact({
        steps: num(d.movement?.steps?.value ?? d.totalSteps),
        rhr: num(d.heartRate?.restingValue ?? d.restingHeartRate),
        stress: num(d.stress?.avgLevel ?? d.averageStressLevel),
        bbMax: num(d.bodyBattery?.maxValue),
        bbMin: num(d.bodyBattery?.minValue),
        imMod: num(d.intensityMinutes?.moderate),
        imVig: num(d.intensityMinutes?.vigorous),
        resp: num(d.respiration?.avgValue),
      });
      if (row) state.daily[day] = row;
    }
  };
}

function storeSleep(state) {
  return (res) => {
    for (const s of listIn(res, 'data', 'dailySleepSummaries', 'sleepSummaries', 'dailySleepDTOList')) {
      const day = dateOf(s);
      const row = day && compact({
        total: num(s.sleepTimeSeconds),
        deep: num(s.deepSleepSeconds),
        light: num(s.lightSleepSeconds),
        rem: num(s.remSleepSeconds),
        awake: num(s.awakeSleepSeconds),
        score: num(s.sleepScores?.overall?.value),
      });
      if (row && row.total) state.sleep[day] = row;
    }
  };
}

function storeHrv(state) {
  return (res) => {
    for (const h of listIn(res, 'hrvSummaries')) {
      const day = dateOf(h);
      const b = h.baseline || {};
      const row = day && compact({
        last: num(h.lastNightAvg),
        week: num(h.weeklyAvg),
        status: h.status || null,
        low: num(b.balancedLow),
        high: num(b.balancedUpper),
      });
      if (row && (row.last || row.week)) state.hrv[day] = row;
    }
  };
}

function storeWeight(state) {
  return (res) => {
    for (const w of listIn(res, 'dailyWeightSummaries')) {
      const day = dateOf(w);
      const grams = num(w.latestWeight?.weight);
      if (day && grams) state.weight[day] = Math.round(grams / 10) / 100;
    }
  };
}

// ---------- main ----------

export async function runSync({ deadline, full = false }) {
  let state = await readStore(DATA_PATH);
  if (!state) state = emptyState(full);
  if (full && !state.full) {
    // Widen to full history: re-walk activities, then refill older days.
    state.full = true;
    state.rangeStart = '2000-01-01';
    state.act = { backfillDone: false, offset: 0 };
    state.cursors = {};
  }

  let done = await syncActivities(state, deadline);

  // Daily data starts at the first activity in full mode, so we don't scan empty years.
  const firstAct = Object.values(state.activities).map((a) => a.start?.slice(0, 10)).filter(Boolean).sort()[0];
  const start = state.full ? (firstAct && firstAct > '2010-01-01' ? firstAct : '2010-01-01') : state.rangeStart;

  const steps = [
    ['daily', 60, (a, b) => `/usersummary-service/v2/dailysummaries?startDate=${a}&endDate=${b}`, storeDaily(state)],
    ['sleep', 28, (a, b) => `/sleep-service/sleep/dailySleepSummariesByDate?startDate=${a}&endDate=${b}`, storeSleep(state)],
    ['hrv', 360, (a, b) => `/hrv-service/hrv/daily/${a}/${b}`, storeHrv(state)],
    ['weight', 360, (a, b) => `/weight-service/weight/range/${a}/${b}`, storeWeight(state)],
  ];
  for (const [key, chunk, urlFor, store] of steps) {
    if (!done) break;
    try {
      done = await syncRanges(state, key, { start, chunk, urlFor, store }, deadline);
    } catch (err) {
      if (err instanceof GarminKeyError) throw err;
      console.error(`sync ${key} failed:`, err.message); // one missing data type shouldn't stop the rest
      state.errors = { ...(state.errors || {}), [key]: err.message };
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
        console.error(`sync ${field} failed:`, err.message);
      }
    }
    state.lastSync = new Date().toISOString();
  }

  await writeStore(DATA_PATH, state);
  return { done, state };
}

export function summarize(state) {
  const acts = Object.values(state.activities);
  const days = Object.keys(state.daily).sort();
  const nights = Object.keys(state.sleep).sort();
  const actDates = acts.map((a) => a.start?.slice(0, 10)).filter(Boolean).sort();
  return {
    activities: acts.length,
    days: days.length,
    nights: nights.length,
    hrvDays: Object.keys(state.hrv).length,
    weighIns: Object.keys(state.weight).length,
    from: [actDates[0], days[0], nights[0]].filter(Boolean).sort()[0] || null,
    to: [actDates.at(-1), days.at(-1), nights.at(-1)].filter(Boolean).sort().at(-1) || null,
    lastSync: state.lastSync,
    full: state.full,
  };
}
