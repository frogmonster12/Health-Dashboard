// dashboard.js — Dashboard view rendering and chart management.
// Globals required: state (app.js), normName/flagValue/getSeverity/getTrend/
//                   buildSummaryCards/getChartConfig (rules.js), Chart (Chart.js)

// ── Marker category sets ──────────────────────────────────────────────────────
const RENAL_SET = new Set([
  'creatinine', 'serum creatinine', 'egfr', 'estimated gfr', 'gfr',
  'bun', 'blood urea nitrogen', 'bun/creatinine ratio',
  'cystatin c', 'uric acid', 'microalbumin', 'albumin creatinine ratio',
]);
const LIPID_SET = new Set([
  'ldl', 'ldl-c', 'ldl cholesterol', 'ldl-cholesterol', 'calculated ldl',
  'hdl', 'hdl-c', 'hdl cholesterol', 'hdl-cholesterol',
  'total cholesterol', 'cholesterol',
  'triglycerides', 'triglyceride',
  'non-hdl', 'non-hdl cholesterol',
  'vldl', 'apolipoprotein b', 'apob', 'lp(a)', 'lipoprotein(a)',
]);
const HEPATIC_SET = new Set([
  'ast', 'sgot', 'alt', 'sgpt',
  'alkaline phosphatase', 'alk phos', 'alp',
  'bilirubin', 'total bilirubin', 'direct bilirubin', 'indirect bilirubin',
  'ggt', 'gamma-gt', 'albumin', 'total protein', 'globulin',
]);
const HORMONE_SET = new Set([
  'testosterone', 'total testosterone', 'free testosterone', 'serum testosterone',
  'estradiol', 'estradiol (e2)', 'e2', 'estrogen',
  'shbg', 'sex hormone binding globulin',
  'lh', 'luteinizing hormone',
  'fsh', 'follicle stimulating hormone',
  'dhea', 'dhea-s', 'dhea sulfate',
  'progesterone',
]);
// Inline Chart.js plugin: draws teal dashed vertical lines + dosage label boxes above them
const DOSAGE_LINES_PLUGIN = {
  id: 'dosageLines',
  afterDraw(chart, _, opts) {
    const doses = opts?.doses;
    if (!doses?.length) return;
    const { ctx, data, chartArea, scales } = chart;
    if (!chartArea || !scales.x) return;

    ctx.save();
    ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (const { date, testDose, aiDose } of doses) {
      const idx = data.labels.indexOf(date);
      if (idx < 0) continue;
      const x = scales.x.getPixelForValue(idx);

      // Build label lines (Test first, AI second)
      const lines = [];
      if (testDose) lines.push({ text: `Test: ${testDose}`, color: 'rgba(255,255,255,.92)' });
      if (aiDose)   lines.push({ text: `AI: ${aiDose}`,     color: 'rgba(148,163,184,.95)' });

      if (lines.length) {
        const lineH  = 14;
        const padX   = 6, padY = 4;
        const maxW   = Math.max(...lines.map(l => ctx.measureText(l.text).width));
        const boxW   = maxW + padX * 2;
        const boxH   = lines.length * lineH + padY * 2;
        // Position the label box in the padding zone, just above chartArea.top
        const boxTop = chartArea.top - boxH - 3;

        // Dark background pill for readability
        ctx.fillStyle = 'rgba(11,26,46,.85)';
        ctx.fillRect(x - boxW / 2, boxTop, boxW, boxH);

        // Teal left accent on the box
        ctx.fillStyle = 'rgba(20,184,166,.7)';
        ctx.fillRect(x - boxW / 2, boxTop, 2, boxH);

        // Text lines
        lines.forEach((line, i) => {
          ctx.fillStyle = line.color;
          ctx.fillText(line.text, x, boxTop + padY + i * lineH);
        });
      }

      // Dashed vertical line from chartArea.top to bottom
      ctx.strokeStyle = 'rgba(20,184,166,.45)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();
  }
};

const BODY_COMP_TYPES  = new Set(['dexa', 'scale']);
const IMAGING_TYPES    = new Set(['ctca']);
const PALETTE          = ['#14b8a6', '#3b82f6', '#f59e0b', '#a855f7', '#ef4444', '#22c55e', '#f97316'];

// ── Module state ──────────────────────────────────────────────────────────────
let _dash = { panels: [], cards: [], tabs: [], activeTab: 'overview' };
const _charts = new Map();

function destroyAllCharts() {
  for (const c of _charts.values()) c.destroy();
  _charts.clear();
}

// ── Data helpers ──────────────────────────────────────────────────────────────
function getPanels() {
  return [...state.files.values()]
    .filter(e => e.phase === 'done' && e.result)
    .map(e => e.result)
    .sort((a, b) => !a.drawDate ? 1 : !b.drawDate ? -1 : a.drawDate.localeCompare(b.drawDate));
}

// Partial name matching: "serum creatinine" matches set entry "creatinine"
function matchesSet(normalizedName, nameSet) {
  if (nameSet.has(normalizedName)) return true;
  for (const s of nameSet) {
    if (normalizedName.includes(s) || s.includes(normalizedName)) return true;
  }
  return false;
}

// Returns Map<normalized-name, { name, unit, refLow, refHigh, readings:[{date,value}] }>
function getMarkerReadings(panels, nameSet) {
  const map = new Map();
  for (const panel of panels) {
    if (!panel?.markers) continue;
    for (const m of panel.markers) {
      if (m.value == null) continue;
      const n = normName(m.name);
      if (nameSet && !matchesSet(n, nameSet)) continue;
      if (!map.has(n)) {
        map.set(n, { name: m.name, unit: m.unit ?? '', refLow: null, refHigh: null, readings: [] });
      }
      const acc = map.get(n);
      // Deduplicate: skip if this exact (date, value) already recorded from this panel
      if (!acc.readings.some(r => r.date === (panel.drawDate ?? null) && r.value === m.value)) {
        acc.readings.push({ date: panel.drawDate ?? null, value: m.value });
      }
      if (m.refLow  != null) acc.refLow  = m.refLow;
      if (m.refHigh != null) acc.refHigh = m.refHigh;
    }
  }
  for (const acc of map.values()) {
    acc.readings.sort((a, b) => !a.date ? 1 : !b.date ? -1 : a.date.localeCompare(b.date));
  }
  return map;
}

// Find first marker series that partially matches any of the given names
function findSeries(markerMap, ...names) {
  for (const [key, val] of markerMap) {
    if (names.some(n => key.includes(n) || n.includes(key))) return val;
  }
  return null;
}

function detectTabs(panels) {
  const allMarkers = getMarkerReadings(panels, null);
  const tabs = [{ id: 'overview', label: 'Overview' }];
  if ([...allMarkers.keys()].some(n => matchesSet(n, RENAL_SET)))   tabs.push({ id: 'renal',    label: 'Renal'     });
  if ([...allMarkers.keys()].some(n => matchesSet(n, LIPID_SET)))   tabs.push({ id: 'lipid',    label: 'Lipid'     });
  if ([...allMarkers.keys()].some(n => matchesSet(n, HEPATIC_SET))) tabs.push({ id: 'hepatic',  label: 'Hepatic'   });
  if ([...allMarkers.keys()].some(n => matchesSet(n, HORMONE_SET))) tabs.push({ id: 'hormones', label: 'Hormones'  });
  if (panels.some(p => BODY_COMP_TYPES.has(p.documentType)))        tabs.push({ id: 'bodycomp', label: 'Body Comp' });
  if (panels.some(p => IMAGING_TYPES.has(p.documentType)))          tabs.push({ id: 'imaging',  label: 'Imaging'   });
  return tabs;
}

// Collect user-entered dosage info — deduped by (date + testDose + aiDose)
function getDosageInfo() {
  if (typeof state === 'undefined') return [];
  const seen  = new Set();
  const doses = [];
  for (const entry of state.files.values()) {
    if (entry.docType === 'hormones' && (entry.testDose || entry.aiDose)) {
      const date = entry.result?.drawDate ?? null;
      const key  = `${date}|${entry.testDose ?? ''}|${entry.aiDose ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      doses.push({ date, testDose: entry.testDose ?? '', aiDose: entry.aiDose ?? '' });
    }
  }
  return doses.sort((a, b) => !a.date ? 1 : !b.date ? -1 : a.date.localeCompare(b.date));
}

function getDateRange(panels) {
  const dates = panels.map(p => p.drawDate).filter(Boolean).sort();
  if (!dates.length) return '';
  return dates.length === 1 ? dates[0] : `${dates[0]} – ${dates.at(-1)}`;
}

// ── Privacy helpers ───────────────────────────────────────────────────────────
function pText(val) {
  return state.privacyMode ? '[REDACTED]' : (val ?? '—');
}

function privacySpan(val) {
  if (!val) return '';
  return `<span data-privacy data-original="${esc(val)}">${pText(val)}</span>`;
}

function refreshDashboardPrivacy() {
  document.querySelectorAll('[data-privacy]').forEach(el => {
    el.textContent = state.privacyMode ? '[REDACTED]' : (el.dataset.original ?? '');
  });
}

// ── HTML fragments ────────────────────────────────────────────────────────────
function esc(s) { // local copy — dashboard.js loads after app.js which also defines it
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function flagBadgeHTML(status) {
  const cls = status === 'HIGH' ? 'flag-h' : status === 'LOW' ? 'flag-l' : 'flag-n';
  return `<span class="flag-badge ${cls}">${status}</span>`;
}

function summaryCardHTML(card) {
  const trendArrow = card.trend === 'improving' ? '↗' : card.trend === 'worsening' ? '↘' : '→';
  const trendCls   = card.trend === 'improving' ? 'trend-up' : card.trend === 'worsening' ? 'trend-dn' : 'trend-flat';
  const refText = card.refLow != null && card.refHigh != null ? `${card.refLow}–${card.refHigh}`
    : card.refHigh != null ? `< ${card.refHigh}`
    : card.refLow  != null ? `> ${card.refLow}` : '—';
  return `
<div class="sc sc-${card.status.toLowerCase()} sc-sev-${card.severity}" role="article">
  <div class="sc-name">${esc(card.name)}</div>
  <div class="sc-value">${card.value} <span class="sc-unit">${esc(card.unit)}</span></div>
  <div class="sc-ref">Ref: ${esc(refText)}</div>
  <div class="sc-footer">
    <span class="sev-badge sev-${card.severity}">${card.severity}</span>
    <span class="trend-label ${trendCls}" title="${card.trend}">${trendArrow}</span>
  </div>
</div>`;
}

function summaryGridHTML(cards, onlyFlagged) {
  const filtered = onlyFlagged ? cards.filter(c => c.status !== 'NORMAL') : cards;
  if (!filtered.length) return '<p class="dash-empty">No flagged markers.</p>';
  return `<div class="sc-grid">${filtered.map(summaryCardHTML).join('')}</div>`;
}

function dataTableHTML(markerMap) {
  const rows = [];
  for (const acc of markerMap.values()) {
    for (const r of acc.readings) {
      const { status } = flagValue(r.value, acc.refLow, acc.refHigh);
      const refText = acc.refLow != null && acc.refHigh != null ? `${acc.refLow}–${acc.refHigh}`
        : acc.refHigh != null ? `<${acc.refHigh}` : acc.refLow != null ? `>${acc.refLow}` : '—';
      rows.push({ date: r.date, name: acc.name, value: r.value, unit: acc.unit, refText, status });
    }
  }
  rows.sort((a, b) => !a.date ? 1 : !b.date ? -1 : b.date.localeCompare(a.date));
  if (!rows.length) return '<p class="dash-empty">No data available.</p>';
  return `
<div class="table-wrap">
  <table class="data-table">
    <thead><tr><th>Date</th><th>Marker</th><th>Value</th><th>Unit</th><th>Ref Range</th><th>Flag</th></tr></thead>
    <tbody>
      ${rows.map(r => `
      <tr class="row-${r.status.toLowerCase()}">
        <td>${esc(r.date ?? '—')}</td>
        <td>${esc(r.name)}</td>
        <td class="cell-val">${r.value}</td>
        <td>${esc(r.unit || '—')}</td>
        <td>${esc(r.refText)}</td>
        <td>${flagBadgeHTML(r.status)}</td>
      </tr>`).join('')}
    </tbody>
  </table>
</div>`;
}

function chartSection(title, canvasId) {
  return `
<div class="chart-section">
  <h3 class="section-title">${esc(title)}</h3>
  <div class="chart-scroll"><div class="chart-container"><canvas id="${canvasId}"></canvas></div></div>
</div>`;
}

// ── Chart helpers ─────────────────────────────────────────────────────────────
function initChart(canvasId, config) {
  if (typeof Chart === 'undefined') return;
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const chart = new Chart(canvas, config);
  _charts.set(canvasId, chart);
  return chart;
}

// Multi-line config: seriesArr = [{ name, unit, refLow, refHigh, readings }]
function multiLineConfig(seriesArr, yLabel) {
  // Build unified date labels from all series
  const dateSet = new Set();
  seriesArr.forEach(s => s.readings.forEach(r => r.date && dateSet.add(r.date)));
  const labels = [...dateSet].sort();

  const datasets = seriesArr.map((s, i) => {
    const colorBase = PALETTE[i % PALETTE.length];
    const valueMap = new Map(s.readings.map(r => [r.date, r.value]));
    return {
      label: `${s.name}${s.unit ? ' (' + s.unit + ')' : ''}`,
      data: labels.map(d => valueMap.get(d) ?? null),
      borderColor: colorBase,
      backgroundColor: colorBase + '14',
      borderWidth: 2,
      pointRadius: 4, pointHoverRadius: 7,
      tension: 0.3, fill: false,
      spanGaps: true,
    };
  });

  return {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11 }, color: '#64748b', boxWidth: 14 } },
      },
      scales: {
        x: { grid: { color: 'rgba(0,0,0,.05)' }, ticks: { color: '#64748b', font: { size: 11 } } },
        y: {
          grid: { color: 'rgba(0,0,0,.06)' },
          ticks: { color: '#64748b', font: { size: 11 } },
          title: yLabel ? { display: true, text: yLabel, color: '#94a3b8', font: { size: 11 } } : undefined,
        },
      },
    },
  };
}

// Dual-axis config for renal chart (creatinine left, eGFR right)
function dualAxisConfig(series1, series2) {
  const dateSet = new Set();
  [...series1.readings, ...series2.readings].forEach(r => r.date && dateSet.add(r.date));
  const labels = [...dateSet].sort();

  const makeMap = (readings) => new Map(readings.map(r => [r.date, r.value]));
  const m1 = makeMap(series1.readings);
  const m2 = makeMap(series2.readings);

  return {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: `${series1.name}${series1.unit ? ' (' + series1.unit + ')' : ''}`,
          data: labels.map(d => m1.get(d) ?? null),
          borderColor: '#ef4444', backgroundColor: '#ef444414',
          borderWidth: 2, pointRadius: 4, pointHoverRadius: 7,
          tension: 0.3, fill: false, yAxisID: 'y', spanGaps: true,
        },
        {
          label: `${series2.name}${series2.unit ? ' (' + series2.unit + ')' : ''}`,
          data: labels.map(d => m2.get(d) ?? null),
          borderColor: '#3b82f6', backgroundColor: '#3b82f614',
          borderWidth: 2, pointRadius: 4, pointHoverRadius: 7,
          tension: 0.3, fill: false, yAxisID: 'y2', spanGaps: true,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11 }, color: '#64748b', boxWidth: 14 } },
      },
      scales: {
        x: { grid: { color: 'rgba(0,0,0,.05)' }, ticks: { color: '#64748b', font: { size: 11 } } },
        y: {
          type: 'linear', position: 'left',
          grid: { color: 'rgba(0,0,0,.06)' },
          ticks: { color: '#ef4444', font: { size: 11 } },
          title: { display: true, text: series1.unit || series1.name, color: '#ef4444', font: { size: 11 } },
        },
        y2: {
          type: 'linear', position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { color: '#3b82f6', font: { size: 11 } },
          title: { display: true, text: series2.unit || series2.name, color: '#3b82f6', font: { size: 11 } },
        },
      },
    },
  };
}

// ── Partial extraction notice ─────────────────────────────────────────────────
function _partialNotice(panels, nameSet) {
  const relevant = nameSet
    ? panels.filter(p => getMarkerReadings([p], nameSet).size > 0)
    : panels;
  if (!relevant.length) return '';
  // Only warn for genuinely low confidence — ignore routine truncation notices
  const hasIssues = relevant.some(p => p.extractionConfidence === 'low');
  return hasIssues
    ? '<div class="partial-notice">⚠ Partial extraction detected on one or more documents — some values may be missing. Verify against original reports.</div>'
    : '';
}

// ── Tab renderers ─────────────────────────────────────────────────────────────
function renderOverviewTab(cards) {
  const flagged = cards.filter(c => c.status !== 'NORMAL');
  return `
<div class="tab-pane">
  <h2 class="pane-title">Flagged Markers</h2>
  ${flagged.length ? summaryGridHTML(flagged, false) : '<p class="dash-empty">All markers within reference ranges.</p>'}
  <h2 class="pane-title" style="margin-top:36px">All Markers</h2>
  ${summaryGridHTML(cards, false)}
</div>`;
}

function renderRenalTab(panels) {
  const readings = getMarkerReadings(panels, RENAL_SET);
  const hasDual  = findSeries(readings, 'creatinine') && findSeries(readings, 'egfr', 'gfr');
  return `
<div class="tab-pane">
  ${_partialNotice(panels, RENAL_SET)}
  ${hasDual ? chartSection('Creatinine & eGFR (dual axis)', 'chart-renal-dual') : ''}
  <h2 class="pane-title" style="margin-top:${hasDual ? 36 : 0}px">Renal Markers — All Data</h2>
  ${dataTableHTML(readings)}
</div>`;
}

function initRenalCharts(panels) {
  const readings = getMarkerReadings(panels, RENAL_SET);
  const creat = findSeries(readings, 'creatinine');
  const egfr  = findSeries(readings, 'egfr', 'gfr');
  if (creat && egfr) initChart('chart-renal-dual', dualAxisConfig(creat, egfr));
}

function renderLipidTab(panels) {
  const readings = getMarkerReadings(panels, LIPID_SET);
  const notice   = _partialNotice(panels, LIPID_SET);
  const hasPrimary = ['ldl', 'hdl', 'cholesterol', 'non-hdl'].some(
    n => [...readings.keys()].some(k => k.includes(n))
  );
  const hasTrig = [...readings.keys()].some(k => k.includes('triglyceride'));
  return `
<div class="tab-pane">
  ${notice}
  ${hasPrimary ? chartSection('LDL · HDL · Total Cholesterol · Non-HDL', 'chart-lipid-main') : ''}
  ${hasTrig    ? chartSection('Triglycerides', 'chart-lipid-trig') : ''}
  <h2 class="pane-title" style="margin-top:${hasPrimary || hasTrig ? 36 : 0}px">Lipid Markers — All Data</h2>
  ${dataTableHTML(readings)}
</div>`;
}

function initLipidCharts(panels) {
  const readings = getMarkerReadings(panels, LIPID_SET);
  const PRIMARY_KEYS = ['ldl', 'hdl', 'total cholesterol', 'cholesterol', 'non-hdl'];
  const primary = [...readings.values()].filter(s =>
    PRIMARY_KEYS.some(n => normName(s.name).includes(n))
  ).slice(0, 4);
  const trig = findSeries(readings, 'triglyceride');
  if (primary.length) initChart('chart-lipid-main', multiLineConfig(primary, 'mg/dL'));
  if (trig) initChart('chart-lipid-trig', getChartConfig(
    trig.name, trig.readings, { refLow: trig.refLow, refHigh: trig.refHigh, unit: trig.unit }
  ));
}

function renderHepaticTab(panels) {
  const readings = getMarkerReadings(panels, HEPATIC_SET);
  const hasEnzymes = ['ast', 'alt', 'alkaline phosphatase', 'alp'].some(
    n => [...readings.keys()].some(k => k.includes(n))
  );
  return `
<div class="tab-pane">
  ${_partialNotice(panels, HEPATIC_SET)}
  ${hasEnzymes ? chartSection('AST · ALT · Alkaline Phosphatase', 'chart-hepatic-enz') : ''}
  <h2 class="pane-title" style="margin-top:${hasEnzymes ? 36 : 0}px">Hepatic Markers — All Data</h2>
  ${dataTableHTML(readings)}
</div>`;
}

function initHepaticCharts(panels) {
  const readings = getMarkerReadings(panels, HEPATIC_SET);
  const ENZYME_KEYS = ['ast', 'alt', 'alkaline phosphatase', 'alp', 'sgot', 'sgpt', 'alk phos'];
  const enzymes = [...readings.values()].filter(s =>
    ENZYME_KEYS.some(n => normName(s.name).includes(n))
  ).slice(0, 3);
  if (enzymes.length) initChart('chart-hepatic-enz', multiLineConfig(enzymes, 'U/L'));
}

function renderBodyCompTab(panels) {
  const dexaPanels  = panels.filter(p => p.documentType === 'dexa');
  const scalePanels = panels.filter(p => p.documentType === 'scale');
  const dexaAll  = getMarkerReadings(dexaPanels, null);
  const scaleAll = getMarkerReadings(scalePanels, null);

  const hasDexa  = dexaAll.size  > 0;
  const hasScale = scaleAll.size > 0;

  return `
<div class="tab-pane">
  ${_partialNotice(panels, null)}
  ${hasDexa  ? chartSection('Body Composition (DEXA)',   'chart-dexa-comp')   : ''}
  ${hasScale ? chartSection('Weight Trend',              'chart-scale-weight') : ''}
  ${hasDexa  ? `<h2 class="pane-title" style="margin-top:36px">DEXA Data</h2>${dataTableHTML(dexaAll)}`  : ''}
  ${hasScale ? `<h2 class="pane-title" style="margin-top:36px">Scale Data</h2>${dataTableHTML(scaleAll)}` : ''}
  ${!hasDexa && !hasScale ? '<p class="dash-empty">No body composition data found.</p>' : ''}
</div>`;
}

function initBodyCompCharts(panels) {
  const dexaPanels  = panels.filter(p => p.documentType === 'dexa');
  const scalePanels = panels.filter(p => p.documentType === 'scale');
  const dexaAll  = getMarkerReadings(dexaPanels,  null);
  const scaleAll = getMarkerReadings(scalePanels, null);

  const COMP_KEYS = ['fat', 'lean', 'mass', 'body fat', 'bone'];
  const compSeries = [...dexaAll.values()].filter(s =>
    COMP_KEYS.some(n => normName(s.name).includes(n))
  ).slice(0, 5);
  if (compSeries.length) initChart('chart-dexa-comp', multiLineConfig(compSeries));

  const weight = findSeries(scaleAll, 'weight', 'bmi');
  if (weight) initChart('chart-scale-weight', getChartConfig(
    weight.name, weight.readings, { refLow: weight.refLow, refHigh: weight.refHigh, unit: weight.unit }
  ));
}

function renderImagingTab(panels) {
  const imgPanels = panels.filter(p => IMAGING_TYPES.has(p.documentType));
  const allMarkers = getMarkerReadings(imgPanels, null);

  const cac  = findSeries(allMarkers, 'cac', 'calcium score');
  const lvef = findSeries(allMarkers, 'lvef', 'ejection fraction');
  const stenosis = [...allMarkers.values()].filter(s =>
    normName(s.name).includes('stenosis') || normName(s.name).includes('artery')
  );

  const statCard = (label, s) => s ? `
<div class="stat-card">
  <div class="stat-label">${esc(label)}</div>
  <div class="stat-value">${s.readings.at(-1)?.value ?? '—'} <span class="stat-unit">${esc(s.unit)}</span></div>
  ${s.refHigh != null ? `<div class="stat-ref">Ref: < ${s.refHigh}</div>` : ''}
  ${flagBadgeHTML(flagValue(s.readings.at(-1)?.value, s.refLow, s.refHigh).status)}
</div>` : '';

  return `
<div class="tab-pane">
  <div class="stat-row">
    ${statCard('CAC Score',  cac)}
    ${statCard('LVEF',       lvef)}
  </div>
  ${stenosis.length ? `
  <h2 class="pane-title" style="margin-top:28px">Coronary Artery Findings</h2>
  ${dataTableHTML(new Map(stenosis.map(s => [normName(s.name), s])))}` : ''}
  <h2 class="pane-title" style="margin-top:28px">All Imaging Markers</h2>
  ${dataTableHTML(allMarkers)}
  <p class="dash-note">Narrative radiologist impressions are not extracted — refer to the original report for full findings.</p>
</div>`;
}

function renderHormonesTab(panels) {
  const readings  = getMarkerReadings(panels, HORMONE_SET);
  const hasTest   = !!findSeries(readings, 'total testosterone', 'testosterone');
  const hasE2     = !!findSeries(readings, 'estradiol', 'e2');
  const hasMain   = hasTest || hasE2;
  const chartTitle = hasTest && hasE2 ? 'Testosterone & Estradiol (E2)' : hasTest ? 'Testosterone' : 'Estradiol (E2)';

  const MAIN_KEYS  = ['testosterone', 'estradiol', 'e2'];
  const hasOther   = [...readings.values()].some(s => !MAIN_KEYS.some(k => normName(s.name).includes(k)));

  const doses = getDosageInfo();
  const doseSummary = doses.length ? `
<div class="dose-summary">
  <span class="dose-summary-label">Protocol on file:</span>
  ${doses.map(d => `<span class="dose-entry">
    ${d.date ? `<b>${esc(d.date)}</b>` : ''}
    ${d.testDose ? `Test: <b>${esc(d.testDose)}</b>` : ''}
    ${d.testDose && d.aiDose ? ' · ' : ''}
    ${d.aiDose ? `AI: <b>${esc(d.aiDose)}</b>` : ''}
  </span>`).join('')}
</div>` : '';

  return `
<div class="tab-pane">
  ${_partialNotice(panels, HORMONE_SET)}
  ${doseSummary}
  ${hasMain  ? chartSection(chartTitle, 'chart-hormone-main') : ''}
  ${hasOther ? chartSection('Other Hormones', 'chart-hormone-other') : ''}
  <h2 class="pane-title" style="margin-top:${hasMain || hasOther ? 36 : 0}px">Hormone Markers — All Data</h2>
  ${dataTableHTML(readings)}
</div>`;
}

function initHormonesCharts(panels) {
  const readings = getMarkerReadings(panels, HORMONE_SET);
  const test = findSeries(readings, 'total testosterone', 'testosterone');
  const e2   = findSeries(readings, 'estradiol', 'e2');
  const doses = getDosageInfo();

  // Add vertical dosage lines + top padding to make room for the labels
  function withDosageLines(cfg) {
    if (!doses.length) return cfg;
    cfg.options.layout = cfg.options.layout ?? {};
    cfg.options.layout.padding = { ...(cfg.options.layout.padding ?? {}), top: 36 };
    cfg.options.plugins = cfg.options.plugins ?? {};
    cfg.options.plugins.dosageLines = { doses };
    return cfg;
  }

  if (test && e2) {
    const cfg = withDosageLines(dualAxisConfig(test, e2));
    cfg.plugins = [DOSAGE_LINES_PLUGIN];
    initChart('chart-hormone-main', cfg);
  } else if (test || e2) {
    const s = test ?? e2;
    const cfg = withDosageLines(
      getChartConfig(s.name, s.readings, { refLow: s.refLow, refHigh: s.refHigh, unit: s.unit })
    );
    cfg.plugins = [DOSAGE_LINES_PLUGIN];
    initChart('chart-hormone-main', cfg);
  }

  const MAIN_KEYS = ['testosterone', 'estradiol', 'e2'];
  const others = [...readings.values()]
    .filter(s => !MAIN_KEYS.some(k => normName(s.name).includes(k)))
    .slice(0, 4);
  if (others.length) initChart('chart-hormone-other', multiLineConfig(others));
}

// ── Active tab render + init ───────────────────────────────────────────────────
function renderActiveTab() {
  destroyAllCharts();
  const content = document.getElementById('dashContent');
  if (!content) return;
  const { panels, cards, activeTab } = _dash;

  switch (activeTab) {
    case 'overview':  content.innerHTML = renderOverviewTab(cards); break;
    case 'renal':     content.innerHTML = renderRenalTab(panels);     initRenalCharts(panels);    break;
    case 'lipid':     content.innerHTML = renderLipidTab(panels);     initLipidCharts(panels);    break;
    case 'hepatic':   content.innerHTML = renderHepaticTab(panels);   initHepaticCharts(panels);   break;
    case 'hormones':  content.innerHTML = renderHormonesTab(panels);  initHormonesCharts(panels);  break;
    case 'bodycomp':  content.innerHTML = renderBodyCompTab(panels);  initBodyCompCharts(panels);  break;
    case 'imaging':   content.innerHTML = renderImagingTab(panels);   break;
  }
}

function switchTab(tabId) {
  _dash.activeTab = tabId;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tabId);
  });
  renderActiveTab();
}

// ── Main entry ────────────────────────────────────────────────────────────────
function renderDashboard() {
  destroyAllCharts();
  const panels = getPanels();
  if (!panels.length) return;

  const cards = buildSummaryCards(panels);
  const tabs  = detectTabs(panels);
  _dash = { panels, cards, tabs, activeTab: tabs[0]?.id ?? 'overview' };

  // Collect patient info from the richest panel
  const infoPanel = panels.slice().reverse().find(p => p.patientName || p.facilityName) ?? panels[0];

  document.getElementById('view').innerHTML = `
<div class="dashboard-view">

  <div class="dash-header">
    <button class="back-btn" id="backBtn" type="button">← Back to Upload</button>
    <div class="patient-meta" style="flex:1">
      ${infoPanel.patientName  ? `<span class="pm-item" data-privacy data-original="${esc(infoPanel.patientName)}">${pText(infoPanel.patientName)}</span>` : ''}
      ${infoPanel.facilityName ? `<span class="pm-item pm-fac" data-privacy data-original="${esc(infoPanel.facilityName)}">${pText(infoPanel.facilityName)}</span>` : ''}
      ${getDateRange(panels)   ? `<span class="pm-item pm-dates">${esc(getDateRange(panels))}</span>` : ''}
    </div>
    <button class="export-btn" id="exportBtn" type="button" data-tip="Export PDF (E)">Export PDF</button>
  </div>

  <nav class="tab-bar" id="tabBar" role="tablist">
    ${tabs.map((t, i) =>
      `<button class="tab-btn${i === 0 ? ' active' : ''}" data-tab="${t.id}" role="tab"
         aria-selected="${i === 0}">${t.label}</button>`
    ).join('')}
  </nav>

  <div class="dash-content" id="dashContent"></div>

</div>`;

  renderActiveTab();

  // Tab switching
  document.getElementById('tabBar').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (btn) switchTab(btn.dataset.tab);
  });

  // Export button — exportPDF() is defined in exporter.js
  document.getElementById('exportBtn').addEventListener('click', () => exportPDF());

  // Back button — clears state and returns to upload screen with transition
  document.getElementById('backBtn').addEventListener('click', () => {
    destroyAllCharts();
    state.files.clear();
    switchView(renderUploadView);
  });
}
