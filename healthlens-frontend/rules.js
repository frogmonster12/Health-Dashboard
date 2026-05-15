// rules.js — Deterministic flagging, trend, and chart logic. No DOM, no AI, no side effects.

const LOWER_IS_BETTER = new Set([
  'ldl', 'ldl-c', 'ldl cholesterol', 'ldl-cholesterol', 'calculated ldl',
  'creatinine', 'serum creatinine',
  'triglycerides', 'triglyceride',
  'total cholesterol', 'cholesterol',
  'non-hdl', 'non-hdl cholesterol',
  'glucose', 'fasting glucose', 'hba1c', 'hemoglobin a1c', 'a1c',
  'uric acid',
  'bun', 'blood urea nitrogen',
  'ast', 'sgot', 'alt', 'sgpt',
  'alkaline phosphatase', 'alk phos', 'alp',
  'bilirubin', 'total bilirubin', 'direct bilirubin',
  'ggt', 'gamma-gt',
  'psa', 'total psa',
  'crp', 'c-reactive protein', 'hs-crp', 'high-sensitivity crp',
  'insulin',
  'body fat %', 'fat %', 'fat mass', 'body fat percentage',
  'cac score', 'calcium score', 'coronary artery calcium',
  'cortisol',
  'homocysteine',
  'fibrinogen',
]);

const HIGHER_IS_BETTER = new Set([
  'hdl', 'hdl-c', 'hdl cholesterol', 'hdl-cholesterol',
  'egfr', 'estimated gfr', 'gfr',
  'vitamin d', '25-oh vitamin d', '25(oh)d', '25-hydroxyvitamin d',
  'testosterone', 'total testosterone', 'free testosterone',
  'ferritin',
  'hemoglobin', 'hgb', 'hematocrit', 'hct',
  'rbc', 'red blood cells',
  'platelets', 'platelet count',
  't-score', 'bone mineral density', 'bone density',
  'lean mass', 'lean body mass',
  'albumin',
  'vitamin b12', 'b12', 'folate',
  'dhea', 'dhea-s', 'dhea sulfate',
]);

function normName(name) {
  return String(name ?? '').toLowerCase().trim();
}

// ── flagValue ──────────────────────────────────────────────────────────────────
// Returns { status: 'HIGH' | 'LOW' | 'NORMAL', delta: number }
// delta: % outside the reference range (0 when normal).
function flagValue(value, refLow, refHigh) {
  if (value == null || (refLow == null && refHigh == null)) {
    return { status: 'NORMAL', delta: 0 };
  }
  if (refHigh != null && value > refHigh) {
    const span = refHigh - (refLow ?? 0);
    const delta = span > 0 ? ((value - refHigh) / span) * 100 : 100;
    return { status: 'HIGH', delta: Math.min(delta, 999) };
  }
  if (refLow != null && value < refLow) {
    const span = (refHigh ?? refLow * 2) - refLow;
    const delta = span > 0 ? ((refLow - value) / span) * 100 : 100;
    return { status: 'LOW', delta: Math.min(delta, 999) };
  }
  return { status: 'NORMAL', delta: 0 };
}

// ── Marker-specific severity config ───────────────────────────────────────────
// Markers listed here use absolute value thresholds instead of the generic
// percentage-delta approach, which breaks when there is no meaningful reference
// range to compute a delta against (e.g. CAC Score: refHigh = 0).
const MARKER_THRESHOLDS = {
  'cac score':                 { higherIsBad: true, thresholds: { mild: 1,   moderate: 100, critical: 400 } },
  'coronary artery calcium':   { higherIsBad: true, thresholds: { mild: 1,   moderate: 100, critical: 400 } },
  'calcium score':             { higherIsBad: true, thresholds: { mild: 1,   moderate: 100, critical: 400 } },
};

// ── getSeverity ────────────────────────────────────────────────────────────────
// markerName and value are optional — when supplied, marker-specific config
// takes precedence over the generic percentage-delta calculation.
function getSeverity(delta, markerName, value) {
  if (markerName != null && value != null) {
    const cfg = MARKER_THRESHOLDS[String(markerName).toLowerCase().trim()];
    if (cfg) {
      const v = Number(value);
      if (!isNaN(v)) {
        const { thresholds: t } = cfg;
        if (v >= t.critical) return 'critical';
        if (v >= t.moderate) return 'moderate';
        if (v >= t.mild)     return 'mild';
        return 'normal';
      }
    }
  }
  // Generic percentage-delta fallback for all other markers
  if (delta >= 50) return 'critical';
  if (delta >= 10) return 'moderate';
  if (delta >  0)  return 'mild';
  return 'normal';
}

// ── getTrend ───────────────────────────────────────────────────────────────────
// valuesArray: ordered oldest → newest. Comparison is last two readings only.
function getTrend(valuesArray, markerName) {
  if (!Array.isArray(valuesArray) || valuesArray.length < 2) return 'stable';
  const last = valuesArray.at(-1);
  const prev = valuesArray.at(-2);
  if (last == null || prev == null || last === prev) return 'stable';
  const rising = last > prev;
  const n = normName(markerName);
  if (LOWER_IS_BETTER.has(n))  return rising ? 'worsening' : 'improving';
  if (HIGHER_IS_BETTER.has(n)) return rising ? 'improving' : 'worsening';
  return 'stable'; // no directional preference known
}

// ── buildSummaryCards ──────────────────────────────────────────────────────────
// allPanels: array of normalized panel objects from the Worker.
// Returns: all markers as card objects, sorted flagged-first then severity desc.
function buildSummaryCards(allPanels) {
  const markerMap = new Map(); // normalized name → accumulator

  for (const panel of (allPanels ?? [])) {
    if (!panel?.markers) continue;
    for (const m of panel.markers) {
      if (m.value == null) continue;
      const key = normName(m.name);
      if (!markerMap.has(key)) {
        markerMap.set(key, {
          name: m.name, unit: m.unit ?? '',
          refLow: null, refHigh: null, readings: [],
        });
      }
      const acc = markerMap.get(key);
      acc.readings.push({ date: panel.drawDate ?? null, value: m.value });
      if (m.refLow  != null) acc.refLow  = m.refLow;
      if (m.refHigh != null) acc.refHigh = m.refHigh;
    }
  }

  for (const acc of markerMap.values()) {
    acc.readings.sort((a, b) =>
      !a.date ? 1 : !b.date ? -1 : a.date.localeCompare(b.date)
    );
  }

  const SORD = { critical: 0, moderate: 1, mild: 2, normal: 3 };
  const cards = [];

  for (const acc of markerMap.values()) {
    const latest          = acc.readings.at(-1);
    const { status, delta } = flagValue(latest.value, acc.refLow, acc.refHigh);
    const severity        = getSeverity(delta, acc.name, latest.value);
    const trend           = getTrend(acc.readings.map(r => r.value), acc.name);
    cards.push({
      name: acc.name, value: latest.value, unit: acc.unit,
      status, severity, trend, delta,
      refLow: acc.refLow, refHigh: acc.refHigh,
      readings: acc.readings,
    });
  }

  return cards.sort((a, b) => {
    const aF = a.status !== 'NORMAL', bF = b.status !== 'NORMAL';
    if (aF !== bF) return aF ? -1 : 1;
    return (SORD[a.severity] ?? 3) - (SORD[b.severity] ?? 3);
  });
}

// ── getChartConfig ─────────────────────────────────────────────────────────────
// Returns a Chart.js v4 config for a single-marker line chart.
// options: { refLow, refHigh, unit, color, goal }
function getChartConfig(markerName, dataPoints, options = {}) {
  const { refLow = null, refHigh = null, unit = '', color = '#14b8a6', goal = null } = options;
  const labels = dataPoints.map(p => p.date ?? '—');
  const values = dataPoints.map(p => p.value);

  const pointColors = values.map(v => {
    const { status } = flagValue(v, refLow, refHigh);
    return status === 'HIGH' ? '#ef4444' : status === 'LOW' ? '#3b82f6' : '#22c55e';
  });

  const datasets = [{
    label: markerName,
    data: values,
    borderColor: color,
    backgroundColor: color + '14',
    borderWidth: 2,
    pointBackgroundColor: pointColors,
    pointBorderColor:     pointColors,
    pointRadius: 5,
    pointHoverRadius: 7,
    tension: 0.3,
    fill: false,
    yAxisID: 'y',
  }];

  if (refHigh != null) {
    datasets.push({
      label: `Ref High (${refHigh}${unit ? ' ' + unit : ''})`,
      data: values.map(() => refHigh),
      borderColor: 'rgba(239,68,68,.4)',
      borderDash: [6, 5],
      borderWidth: 1.5,
      pointRadius: 0, pointHoverRadius: 0,
      fill: false, yAxisID: 'y',
    });
  }
  if (refLow != null) {
    datasets.push({
      label: `Ref Low (${refLow}${unit ? ' ' + unit : ''})`,
      data: values.map(() => refLow),
      borderColor: 'rgba(59,130,246,.4)',
      borderDash: [6, 5],
      borderWidth: 1.5,
      pointRadius: 0, pointHoverRadius: 0,
      fill: false, yAxisID: 'y',
    });
  }
  if (goal != null) {
    datasets.push({
      label: `Goal: ${goal}${unit ? ' ' + unit : ''}`,
      data: values.map(() => goal),
      borderColor: 'rgba(34,197,94,.85)',
      borderDash: [8, 5],
      borderWidth: 2,
      pointRadius: 0, pointHoverRadius: 0,
      fill: false, yAxisID: 'y',
    });
  }

  return {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11 }, color: '#64748b', boxWidth: 14 } },
        tooltip: { filter: (item) => !item.dataset.borderDash },
      },
      scales: {
        x: { grid: { color: 'rgba(0,0,0,.05)' }, ticks: { color: '#64748b', font: { size: 11 } } },
        y: {
          grid: { color: 'rgba(0,0,0,.06)' },
          ticks: {
            color: '#64748b', font: { size: 11 },
            callback: (v) => `${v}${unit ? ' ' + unit : ''}`,
          },
        },
      },
    },
  };
}
