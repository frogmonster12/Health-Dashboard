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

const CBC_SET = new Set([
  'wbc', 'white blood cells', 'white blood count', 'leukocytes',
  'rbc', 'red blood cells', 'red blood count', 'erythrocytes',
  'hemoglobin', 'hgb', 'hb',
  'hematocrit', 'hct',
  'mcv', 'mch', 'mchc', 'rdw',
  'platelets', 'platelet count', 'thrombocytes', 'plt',
  'neutrophils', 'neutrophil', 'absolute neutrophils',
  'lymphocytes', 'lymphocyte', 'absolute lymphocytes',
  'monocytes', 'monocyte', 'absolute monocytes',
  'eosinophils', 'eosinophil', 'absolute eosinophils',
  'basophils', 'basophil',
  'immature granulocytes', 'nrbc',
]);
const THYROID_SET = new Set([
  'tsh', 'thyroid stimulating hormone', 'thyrotropin',
  'free t4', 'ft4', 'free thyroxine', 't4 free',
  'free t3', 'ft3', 'free triiodothyronine', 't3 free',
  'total t4', 't4', 'thyroxine',
  'total t3', 't3', 'triiodothyronine',
  'reverse t3', 'rt3',
  'tpo', 'tpo antibodies', 'thyroid peroxidase antibodies', 'anti-tpo',
  'thyroglobulin antibodies', 'tgab',
  'thyroglobulin',
]);
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
  if ([...allMarkers.keys()].some(n => matchesSet(n, CBC_SET)))     tabs.push({ id: 'cbc',      label: 'CBC'       });
  if ([...allMarkers.keys()].some(n => matchesSet(n, THYROID_SET))) tabs.push({ id: 'thyroid',  label: 'Thyroid'   });
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
    if ((entry.docType === 'testosterone' || entry.docType === 'hormones') && (entry.testDose || entry.aiDose)) {
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
  <div class="sc-goal-row">
    <span class="sc-goal-label">Goal</span>
    <input type="number" step="any" class="sc-goal-input"
           data-marker-goal="${normName(card.name)}"
           value="${userGoals?.[normName(card.name)] ?? ''}"
           placeholder="—" />
    ${card.unit ? `<span class="sc-goal-unit">${esc(card.unit)}</span>` : ''}
  </div>
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
      const annKey = `${normName(acc.name)}::${r.date ?? ''}`;
      rows.push({ date: r.date, name: acc.name, value: r.value, unit: acc.unit, refText, status, annKey });
    }
  }
  rows.sort((a, b) => !a.date ? 1 : !b.date ? -1 : b.date.localeCompare(a.date));
  if (!rows.length) return '<p class="dash-empty">No data available.</p>';
  return `
<div class="table-wrap">
  <table class="data-table">
    <thead><tr><th>Date</th><th>Marker</th><th>Value</th><th>Unit</th><th>Ref Range</th><th>Flag</th><th class="th-note"></th></tr></thead>
    <tbody>
      ${rows.map(r => {
        const note = state.annotations?.[r.annKey] ?? '';
        return `
      <tr class="row-${r.status.toLowerCase()}">
        <td>${esc(r.date ?? '—')}</td>
        <td class="td-marker">
          ${esc(r.name)}
          ${note ? `<span class="ann-text">${esc(note)}</span>` : ''}
        </td>
        <td class="cell-val">${r.value}</td>
        <td>${esc(r.unit || (normName(r.name) === 'cac score' ? 'Agatston' : '—'))}</td>
        <td>${esc(r.refText)}</td>
        <td>${flagBadgeHTML(r.status)}</td>
        <td><button class="ann-btn" data-ann-key="${esc(r.annKey)}" title="${note ? 'Edit note' : 'Add note'}">${note ? '💬' : '✎'}</button></td>
      </tr>`;
      }).join('')}
    </tbody>
  </table>
</div>`;
}

// ── Annotation modal ───────────────────────────────────────────────────────────
function openAnnotationModal(key) {
  if (!key) return;
  const current = state.annotations?.[key] ?? '';
  const [markerRaw, dateRaw] = key.split('::');
  const title = [markerRaw, dateRaw].filter(Boolean).join(' · ');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box" role="dialog" aria-modal="true">
      <h3 class="modal-title">Note — ${esc(title)}</h3>
      <p class="modal-body">Add context: medication changes, events, symptoms, or anything relevant to this reading.</p>
      <textarea class="ann-textarea" placeholder="e.g. Started statin 20mg / day" rows="3">${esc(current)}</textarea>
      <div class="modal-actions">
        <button class="modal-btn modal-cancel-btn" id="annCancel" type="button">Cancel</button>
        ${current ? '<button class="modal-btn ann-clear-btn" id="annClear" type="button">Remove note</button>' : ''}
        <button class="modal-btn modal-confirm-btn" id="annSave" type="button">Save note</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const ta = overlay.querySelector('.ann-textarea');
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  const close = () => overlay.remove();
  overlay.querySelector('#annCancel').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  const onKey = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);

  overlay.querySelector('#annClear')?.addEventListener('click', () => {
    delete state.annotations[key];
    _patchAnnRow(key, '');
    close();
  });

  overlay.querySelector('#annSave').addEventListener('click', () => {
    const val = ta.value.trim();
    if (val) { state.annotations[key] = val; } else { delete state.annotations[key]; }
    _patchAnnRow(key, val);
    close();
  });
}

// Surgically update a single table row's note display without re-rendering the tab
function _patchAnnRow(key, note) {
  const escaped = key.replace(/"/g, '\\"');
  const btn = document.querySelector(`.ann-btn[data-ann-key="${escaped}"]`);
  if (!btn) return;
  btn.textContent = note ? '💬' : '✎';
  btn.title = note ? 'Edit note' : 'Add note';
  const td = btn.closest('tr')?.querySelector('.td-marker');
  if (!td) return;
  let span = td.querySelector('.ann-text');
  if (note) {
    if (!span) { span = document.createElement('span'); span.className = 'ann-text'; td.appendChild(span); }
    span.textContent = note;
  } else {
    span?.remove();
  }
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
    const valueMap  = new Map(s.readings.map(r => [r.date, r.value]));
    const values    = labels.map(d => valueMap.get(d) ?? null);
    // Color each point by flag status — red=HIGH, blue=LOW, series color=normal
    const pointColors = values.map(v => {
      if (v == null) return colorBase;
      const { status } = flagValue(v, s.refLow, s.refHigh);
      return status === 'HIGH' ? '#ef4444' : status === 'LOW' ? '#3b82f6' : colorBase;
    });
    return {
      label: `${s.name}${s.unit ? ' (' + s.unit + ')' : ''}`,
      data: values,
      borderColor: colorBase,
      backgroundColor: colorBase + '14',
      borderWidth: 2,
      pointBackgroundColor: pointColors,
      pointBorderColor:     pointColors,
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
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const s = seriesArr[ctx.datasetIndex];
              if (!s) return ctx.dataset.label;
              const val = ctx.parsed.y;
              if (val == null) return null;
              const { status } = flagValue(val, s.refLow, s.refHigh);
              const ref = s.refLow != null && s.refHigh != null ? ` [ref: ${s.refLow}–${s.refHigh}]`
                : s.refHigh != null ? ` [ref: <${s.refHigh}]`
                : s.refLow  != null ? ` [ref: >${s.refLow}]` : '';
              const goalVal = userGoals?.[normName(s.name)];
              const goalStr = goalVal != null ? ` [goal: ${goalVal}]` : '';
              const flag = status !== 'NORMAL' ? ` ⚑ ${status}` : '';
              return `${ctx.dataset.label}: ${val}${ref}${goalStr}${flag}`;
            },
          },
        },
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

// Appends a green dashed goal line to any chart config that has a matching goal in state
function addGoalLine(cfg, markerName, unit, yAxisID = 'y') {
  const goal = userGoals?.[normName(markerName)];
  if (goal == null || !cfg?.data?.datasets) return;
  cfg.data.datasets.push({
    label: `${markerName} Goal: ${goal}${unit ? ' ' + unit : ''}`,
    data: cfg.data.labels.map(() => goal),
    borderColor: 'rgba(34,197,94,.85)',
    borderDash: [8, 5],
    borderWidth: 2,
    pointRadius: 0, pointHoverRadius: 0,
    fill: false, yAxisID,
  });
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
  if (creat && egfr) {
    const cfg = dualAxisConfig(creat, egfr);
    addGoalLine(cfg, creat.name, creat.unit, 'y');
    addGoalLine(cfg, egfr.name,  egfr.unit,  'y2');
    initChart('chart-renal-dual', cfg);
  } else if (creat || egfr) {
    const s = creat ?? egfr;
    initChart('chart-renal-dual', getChartConfig(s.name, s.readings, {
      refLow: s.refLow, refHigh: s.refHigh, unit: s.unit,
      goal: userGoals?.[normName(s.name)],
    }));
  }
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
    trig.name, trig.readings, { refLow: trig.refLow, refHigh: trig.refHigh, unit: trig.unit,
      goal: userGoals?.[normName(trig.name)] }
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
    weight.name, weight.readings, { refLow: weight.refLow, refHigh: weight.refHigh, unit: weight.unit,
      goal: userGoals?.[normName(weight.name)] }
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

  const statCard = (label, s) => {
    if (!s) return '';
    const latest = s.readings.at(-1);
    const { status, delta } = flagValue(latest?.value, s.refLow, s.refHigh);
    // getSeverity from rules.js — uses MARKER_THRESHOLDS for CAC Score etc.
    const severity = getSeverity(delta, s.name, latest?.value);
    return `
<div class="stat-card">
  <div class="stat-label">${esc(label)}</div>
  <div class="stat-value">${latest?.value ?? '—'} <span class="stat-unit">${esc(s.unit)}</span></div>
  ${s.refHigh != null ? `<div class="stat-ref">Ref: < ${s.refHigh}</div>` : ''}
  <div class="stat-badges">
    ${flagBadgeHTML(status)}
    ${severity !== 'normal' ? `<span class="sev-badge sev-${severity}">${severity}</span>` : ''}
  </div>
</div>`;
  };

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
      getChartConfig(s.name, s.readings, { refLow: s.refLow, refHigh: s.refHigh, unit: s.unit,
        goal: userGoals?.[normName(s.name)] })
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

// ── CBC tab ───────────────────────────────────────────────────────────────────
function renderCBCTab(panels) {
  const readings   = getMarkerReadings(panels, CBC_SET);
  const hasHgbHct  = !!(findSeries(readings, 'hemoglobin', 'hgb') || findSeries(readings, 'hematocrit', 'hct'));
  const hasWBC     = !!(findSeries(readings, 'wbc', 'white blood'));
  const hasPlt     = !!(findSeries(readings, 'platelet', 'plt'));
  const hasCharts  = hasHgbHct || hasWBC || hasPlt;
  return `
<div class="tab-pane">
  ${_partialNotice(panels, CBC_SET)}
  ${hasHgbHct ? chartSection('Hemoglobin & Hematocrit', 'chart-cbc-hgb') : ''}
  ${hasWBC    ? chartSection('White Blood Cells (WBC)',  'chart-cbc-wbc') : ''}
  ${hasPlt    ? chartSection('Platelets',                'chart-cbc-plt') : ''}
  <h2 class="pane-title" style="margin-top:${hasCharts ? 36 : 0}px">CBC Markers — All Data</h2>
  ${dataTableHTML(readings)}
</div>`;
}

function initCBCCharts(panels) {
  const readings = getMarkerReadings(panels, CBC_SET);
  const hgb = findSeries(readings, 'hemoglobin', 'hgb');
  const hct = findSeries(readings, 'hematocrit', 'hct');
  const wbc = findSeries(readings, 'wbc', 'white blood');
  const plt = findSeries(readings, 'platelet', 'plt');

  if (hgb && hct) {
    const cfg = dualAxisConfig(hgb, hct);
    addGoalLine(cfg, hgb.name, hgb.unit, 'y');
    addGoalLine(cfg, hct.name, hct.unit, 'y2');
    initChart('chart-cbc-hgb', cfg);
  } else if (hgb || hct) {
    const s = hgb ?? hct;
    initChart('chart-cbc-hgb', getChartConfig(s.name, s.readings, {
      refLow: s.refLow, refHigh: s.refHigh, unit: s.unit,
      goal: userGoals?.[normName(s.name)], color: '#ef4444',
    }));
  }
  if (wbc) initChart('chart-cbc-wbc', getChartConfig(wbc.name, wbc.readings, {
    refLow: wbc.refLow, refHigh: wbc.refHigh, unit: wbc.unit,
    goal: userGoals?.[normName(wbc.name)], color: '#3b82f6',
  }));
  if (plt) initChart('chart-cbc-plt', getChartConfig(plt.name, plt.readings, {
    refLow: plt.refLow, refHigh: plt.refHigh, unit: plt.unit,
    goal: userGoals?.[normName(plt.name)], color: '#a855f7',
  }));
}

// ── Thyroid tab ───────────────────────────────────────────────────────────────
function renderThyroidTab(panels) {
  const readings = getMarkerReadings(panels, THYROID_SET);
  const hasTSH   = !!(findSeries(readings, 'tsh'));
  const hasT4T3  = !!(findSeries(readings, 'free t4', 'ft4') || findSeries(readings, 'free t3', 'ft3'));
  const hasCharts = hasTSH || hasT4T3;
  return `
<div class="tab-pane">
  ${_partialNotice(panels, THYROID_SET)}
  ${hasTSH  ? chartSection('TSH (Thyroid Stimulating Hormone)', 'chart-thyroid-tsh')  : ''}
  ${hasT4T3 ? chartSection('Free T4 & Free T3',                 'chart-thyroid-t4t3') : ''}
  <h2 class="pane-title" style="margin-top:${hasCharts ? 36 : 0}px">Thyroid Markers — All Data</h2>
  ${dataTableHTML(readings)}
</div>`;
}

function initThyroidCharts(panels) {
  const readings = getMarkerReadings(panels, THYROID_SET);
  const tsh = findSeries(readings, 'tsh');
  const ft4 = findSeries(readings, 'free t4', 'ft4');
  const ft3 = findSeries(readings, 'free t3', 'ft3');
  if (tsh) initChart('chart-thyroid-tsh', getChartConfig(tsh.name, tsh.readings, {
    refLow: tsh.refLow, refHigh: tsh.refHigh, unit: tsh.unit,
    goal: userGoals?.[normName(tsh.name)], color: '#f59e0b',
  }));
  const t4t3 = [ft4, ft3].filter(Boolean);
  if (t4t3.length) initChart('chart-thyroid-t4t3', multiLineConfig(t4t3));
}

// ── Reinit only the charts for the current tab (used after goal changes) ──────
function reinitActiveCharts() {
  destroyAllCharts();
  const { panels, activeTab } = _dash;
  switch (activeTab) {
    case 'renal':     initRenalCharts(panels);    break;
    case 'lipid':     initLipidCharts(panels);    break;
    case 'hepatic':   initHepaticCharts(panels);  break;
    case 'hormones':  initHormonesCharts(panels); break;
    case 'cbc':       initCBCCharts(panels);      break;
    case 'thyroid':   initThyroidCharts(panels);  break;
    case 'bodycomp':  initBodyCompCharts(panels); break;
  }
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
    case 'hormones':  content.innerHTML = renderHormonesTab(panels);  initHormonesCharts(panels); break;
    case 'cbc':       content.innerHTML = renderCBCTab(panels);       initCBCCharts(panels);      break;
    case 'thyroid':   content.innerHTML = renderThyroidTab(panels);   initThyroidCharts(panels);  break;
    case 'bodycomp':  content.innerHTML = renderBodyCompTab(panels);  initBodyCompCharts(panels); break;
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

  // Annotation buttons — open note modal on any data table row
  document.getElementById('dashContent').addEventListener('click', (e) => {
    const btn = e.target.closest('.ann-btn');
    if (btn) openAnnotationModal(btn.dataset.annKey);
  });

  // Goal input — one source of truth: userGoals.
  // Sync every input for the same marker on the page so Flagged and
  // All Markers cards never diverge.
  document.getElementById('dashContent').addEventListener('change', (e) => {
    const input = e.target.closest('.sc-goal-input');
    if (!input) return;
    const marker = input.dataset.markerGoal;
    if (!marker) return;

    const val = parseFloat(input.value);
    if (isNaN(val) || input.value.trim() === '') {
      delete userGoals[marker];
    } else {
      userGoals[marker] = val;
    }

    // Push the new value to every other input sharing the same marker key
    document.querySelectorAll(`.sc-goal-input[data-marker-goal="${marker}"]`).forEach(inp => {
      if (inp !== input) inp.value = input.value;
    });

    reinitActiveCharts();
  });

  // Back button — clears state and returns to upload screen with transition
  document.getElementById('backBtn').addEventListener('click', () => {
    destroyAllCharts();
    state.files.clear();
    switchView(renderUploadView);
  });
}
