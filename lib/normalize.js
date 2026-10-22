// Turns the raw Garmin responses we store into the compact shape the app draws from.
// Raw data stays untouched in storage; this is only a view of it.

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v != null) out[k] = v;
  return Object.keys(out).length ? out : null;
}

export function trimActivity(a) {
  return compact({
    id: a.activityId,
    start: a.startTimeLocal,
    type: a.activityType?.typeKey || 'other',
    name: a.activityName || '',
    dist: num(a.distance),
    dur: num(a.duration),
    moving: num(a.movingDuration),
    elapsed: num(a.elapsedDuration),
    elev: num(a.elevationGain),
    elevLoss: num(a.elevationLoss),
    avgHR: num(a.averageHR),
    maxHR: num(a.maxHR),
    cal: num(a.calories),
    load: num(a.activityTrainingLoad),
    aero: num(a.aerobicTrainingEffect),
    anaer: num(a.anaerobicTrainingEffect),
    zones: [1, 2, 3, 4, 5].map((i) => num(a[`hrTimeInZone_${i}`])),
    vo2: num(a.vO2MaxValue),
    f1k: num(a.fastestSplit_1000),
    f1mi: num(a.fastestSplit_1609),
    f5k: num(a.fastestSplit_5000),
    f10k: num(a.fastestSplit_10000),
    cadence: num(a.averageRunningCadenceInStepsPerMinute),
    maxCadence: num(a.maxRunningCadenceInStepsPerMinute),
    stride: num(a.avgStrideLength),
    avgSpeed: num(a.averageSpeed),
    maxSpeed: num(a.maxSpeed),
    power: num(a.avgPower),
    gct: num(a.avgGroundContactTime),
    vo: num(a.avgVerticalOscillation),
    vr: num(a.avgVerticalRatio),
    steps: num(a.steps),
    minTemp: num(a.minTemperature),
    maxTemp: num(a.maxTemperature),
    pr: a.pr === true || null,
    location: a.locationName || null,
  });
}

export function dailyRow(d) {
  return compact({
    steps: num(d.movement?.steps?.value ?? d.totalSteps),
    stepGoal: num(d.movement?.steps?.goal ?? d.dailyStepGoal),
    rhr: num(d.heartRate?.restingValue ?? d.restingHeartRate),
    minHR: num(d.heartRate?.minValue ?? d.minHeartRate),
    maxHR: num(d.heartRate?.maxValue ?? d.maxHeartRate),
    stress: num(d.stress?.avgLevel ?? d.averageStressLevel),
    maxStress: num(d.stress?.maxLevel ?? d.maxStressLevel),
    bbMax: num(d.bodyBattery?.maxValue),
    bbMin: num(d.bodyBattery?.minValue),
    bbCharged: num(d.bodyBattery?.chargedValue),
    bbDrained: num(d.bodyBattery?.drainedValue),
    imMod: num(d.intensityMinutes?.moderate),
    imVig: num(d.intensityMinutes?.vigorous),
    resp: num(d.respiration?.avgValue),
    spo2: num(d.pulseOx?.avgValue ?? d.spo2?.avgValue ?? d.averageSpo2),
    calTotal: num(d.calories?.totalValue ?? d.calories?.total ?? d.totalKilocalories),
    calActive: num(d.calories?.activeValue ?? d.calories?.active ?? d.activeKilocalories),
    distance: num(d.movement?.distance?.value ?? d.totalDistanceMeters),
    floors: num(d.movement?.floorsAscended?.value ?? d.floorsAscended),
  });
}

export function sleepRow(s) {
  const row = compact({
    total: num(s.sleepTimeSeconds),
    deep: num(s.deepSleepSeconds),
    light: num(s.lightSleepSeconds),
    rem: num(s.remSleepSeconds),
    awake: num(s.awakeSleepSeconds),
    score: num(s.sleepScores?.overall?.value),
    start: num(s.sleepStartTimestampLocal ?? s.sleepStartTimestampGMT),
    end: num(s.sleepEndTimestampLocal ?? s.sleepEndTimestampGMT),
    spo2: num(s.averageSpO2Value),
    resp: num(s.averageRespirationValue),
    stress: num(s.avgSleepStress),
    restless: num(s.awakeCount ?? s.restlessMomentsCount),
  });
  return row && row.total ? row : null;
}

export function hrvRow(h) {
  const b = h.baseline || {};
  const row = compact({
    last: num(h.lastNightAvg),
    high5: num(h.lastNight5MinHigh),
    week: num(h.weeklyAvg),
    status: h.status || null,
    low: num(b.balancedLow),
    high: num(b.balancedUpper),
  });
  return row && (row.last || row.week) ? row : null;
}

export function weightKg(w) {
  const grams = num(w.latestWeight?.weight ?? w.weight);
  return grams ? Math.round(grams / 10) / 100 : null;
}

// Body Battery daily report: charged/drained totals plus the day's high and low.
export function bbRow(it) {
  const levels = bbValues(it).map((p) => p[1]);
  return compact({
    charged: num(it.charged ?? it.bodyBatteryCharged),
    drained: num(it.drained ?? it.bodyBatteryDrained),
    high: levels.length ? Math.max(...levels) : null,
    low: levels.length ? Math.min(...levels) : null,
    last: levels.length ? levels[levels.length - 1] : null,
  });
}

// [[timestamp, level], ...] from Garmin's values array, using its column descriptors when present.
export function bbValues(it) {
  const rows = it?.bodyBatteryValuesArray || it?.bodyBatteryValues || [];
  if (!Array.isArray(rows) || !rows.length) return [];
  const desc = it.bodyBatteryValueDescriptorDTOList || it.bodyBatteryValueDescriptorsDTOList || [];
  const find = (re) => desc.find((d) => re.test(String(d.bodyBatteryValueDescriptorKey ?? d.key ?? '')));
  const ti = find(/timestamp/i)?.bodyBatteryValueDescriptorIndex ?? 0;
  let li = find(/level/i)?.bodyBatteryValueDescriptorIndex;
  if (li == null && Array.isArray(rows[0])) li = rows[0].length > 2 ? 2 : 1;
  return rows
    .map((r) => (Array.isArray(r) ? [r[ti], r[li]] : [r.timestamp ?? r.time, r.level ?? r.value]))
    .filter((p) => typeof p[0] === 'number' && typeof p[1] === 'number');
}

export function normalize(state) {
  const raw = state.raw;
  const pick = (map, fn) => {
    const out = {};
    for (const [k, v] of Object.entries(map || {})) {
      const r = fn(v);
      if (r != null) out[k] = r;
    }
    return out;
  };
  return {
    activities: Object.values(raw.activities).map(trimActivity).sort((a, b) => (a.start < b.start ? -1 : 1)),
    daily: pick(raw.daily, dailyRow),
    sleep: pick(raw.sleep, sleepRow),
    hrv: pick(raw.hrv, hrvRow),
    weight: pick(raw.weight, weightKg),
    bb: pick(raw.bb || {}, bbRow),
  };
}
