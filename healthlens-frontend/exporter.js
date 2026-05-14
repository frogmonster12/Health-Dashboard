// exporter.js — PDF export via jsPDF 2.x and html2canvas 1.4.x.
// Globals required: jspdf (jsPDF), html2canvas, Chart, state (app.js),
//   buildSummaryCards/flagValue/getChartConfig (rules.js),
//   summaryGridHTML/getMarkerReadings/matchesSet/findSeries/
//   multiLineConfig/dualAxisConfig/RENAL_SET/LIPID_SET/HEPATIC_SET/
//   BODY_COMP_TYPES/IMAGING_TYPES/normName (dashboard.js),
//   WORKER_URL (app.js)

// ── Page geometry ─────────────────────────────────────────────────────────────
const PM   = 15;           // page margin (mm)
const PW   = 210;          // A4 width
const PH   = 297;          // A4 height
const PCW  = PW - PM * 2;  // content width: 180mm
const PFH  = 14;           // footer zone height
const PMY  = PH - PM - PFH;// max content Y before footer
const CHART_H = 72;        // chart image height in PDF (mm)
const CARD_H  = 30;        // summary card height (mm)
const ROW_H   = 7;         // table data row height (mm)
const HDR_H   = 8;         // table header row height (mm)
const CELL_P  = 2;         // horizontal cell padding (mm)

// ── Color palette (r, g, b) ───────────────────────────────────────────────────
const KC = {
  teal:   [20,  184, 166],
  dark:   [15,  23,  42 ],
  mid:    [71,  85,  105],
  muted:  [148, 163, 184],
  border: [226, 232, 240],
  surf:   [248, 250, 252],
  white:  [255, 255, 255],
  red:    [185, 28,  28 ],
  blue:   [29,  78,  216],
  green:  [21,  128, 61 ],
};

// ── Table column layout (total: 180mm) ────────────────────────────────────────
const COLS = [
  { h: 'Date',      k: 'date',   w: 25, a: 'left'   },
  { h: 'Marker',    k: 'name',   w: 63, a: 'left'   },
  { h: 'Value',     k: 'value',  w: 18, a: 'right'  },
  { h: 'Unit',      k: 'unit',   w: 20, a: 'left'   },
  { h: 'Ref Range', k: 'ref',    w: 34, a: 'left'   },
  { h: 'Flag',      k: 'status', w: 20, a: 'center' },
];

// ── Module state ──────────────────────────────────────────────────────────────
let _pdf = null;
let _cy  = PM;

// ── Page helpers ──────────────────────────────────────────────────────────────
function _newPage() { _pdf.addPage(); _cy = PM; }

function _need(mm) {
  if (_cy + mm > PMY) { _newPage(); return true; }
  return false;
}

function _f(size, weight, color) {
  _pdf.setFontSize(size);
  _pdf.setFont('helvetica', weight ?? 'normal');
  _pdf.setTextColor(...(color ?? KC.mid));
}

function _trunc(text, maxW) {
  let s = String(text ?? '—');
  if (_pdf.getTextWidth(s) <= maxW) return s;
  while (s.length > 1 && _pdf.getTextWidth(s + '…') > maxW) s = s.slice(0, -1);
  return s + '…';
}

// ── Drawing primitives ────────────────────────────────────────────────────────
function _sectionHead(title) {
  _need(16);
  _f(10, 'bold', KC.dark);
  _pdf.text(title, PM, _cy + 7);
  _pdf.setDrawColor(...KC.border);
  _pdf.setLineWidth(0.3);
  _pdf.line(PM, _cy + 10, PM + PCW, _cy + 10);
  _cy += 15;
}

function _reportHeader(patientLabel, dateRange, panelCount) {
  // Teal header band
  _pdf.setFillColor(...KC.teal);
  _pdf.rect(0, 0, PW, 28, 'F');

  _f(18, 'bold', KC.white);
  _pdf.text('HealthLens Health Report', PM, 16);

  _f(8, 'normal', [204, 240, 235]);
  const dateStr = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
  _pdf.text(`Generated ${dateStr}`, PM, 23);

  _cy = 35;

  // Info block
  _pdf.setFillColor(...KC.surf);
  _pdf.setDrawColor(...KC.border);
  _pdf.setLineWidth(0.3);
  _pdf.roundedRect(PM, _cy, PCW, 20, 2, 2, 'FD');

  const col2x = PM + 75, col3x = PM + 140;

  _f(7, 'bold', KC.muted);
  _pdf.text('PATIENT',    PM + 4, _cy + 6);
  _pdf.text('DATE RANGE', col2x,  _cy + 6);
  _pdf.text('DOCUMENTS',  col3x,  _cy + 6);

  _f(10, 'normal', KC.dark);
  _pdf.text(_trunc(patientLabel || '—', 68), PM + 4, _cy + 14);
  _pdf.text(_trunc(dateRange    || '—', 62), col2x,  _cy + 14);
  _pdf.text(String(panelCount),                   col3x,  _cy + 14);

  _cy += 26;
}

// ── Summary cards (programmatic — 3 per row) ──────────────────────────────────
function _drawSummaryCards(cards) {
  if (!cards.length) return;
  const GAP    = 4;
  const CARD_W = (PCW - GAP * 2) / 3;

  let col = 0;
  let rowY = _cy;

  for (const card of cards) {
    if (col === 0) { _need(CARD_H + GAP); rowY = _cy; }

    const cx = PM + col * (CARD_W + GAP);
    const cy = rowY;

    // Card background + border
    _pdf.setFillColor(...KC.white);
    _pdf.setDrawColor(...KC.border);
    _pdf.setLineWidth(0.25);
    _pdf.roundedRect(cx, cy, CARD_W, CARD_H, 1.5, 1.5, 'FD');

    // Coloured left strip
    const sc = card.status === 'HIGH' ? KC.red : card.status === 'LOW' ? KC.blue : KC.green;
    _pdf.setFillColor(...sc);
    _pdf.roundedRect(cx, cy, 2.5, CARD_H, 1.5, 1.5, 'F');
    _pdf.rect(cx + 1.25, cy, 1.25, CARD_H, 'F');  // square off right edge of strip

    const tx = cx + 5;

    // Marker name
    _f(6.5, 'bold', KC.muted);
    _pdf.text(_trunc(card.name, CARD_W - 8), tx, cy + 6.5);

    // Value + unit
    const valStr = String(card.value);
    _f(13, 'bold', KC.dark);
    _pdf.text(valStr, tx, cy + 14);
    _f(7, 'normal', KC.muted);
    _pdf.text(card.unit ?? '', tx + _pdf.getTextWidth(valStr) + 0.5, cy + 14);

    // Ref range
    const refText = card.refLow != null && card.refHigh != null
      ? `Ref: ${card.refLow}–${card.refHigh}`
      : card.refHigh != null ? `Ref: < ${card.refHigh}`
      : card.refLow  != null ? `Ref: > ${card.refLow}` : '';
    _f(7, 'normal', KC.muted);
    if (refText) _pdf.text(refText, tx, cy + 20);

    // Severity + trend
    _f(6.5, 'bold', sc);
    _pdf.text(card.severity.toUpperCase(), tx, cy + 26.5);
    const trendText = card.trend === 'improving' ? 'IMPR' : card.trend === 'worsening' ? 'DECL' : 'STBL';
    _f(6.5, 'normal', KC.muted);
    _pdf.text(trendText, cx + CARD_W - 3, cy + 26.5, { align: 'right' });

    col++;
    if (col >= 3) { col = 0; _cy = rowY + CARD_H + GAP; }
  }
  if (col > 0) _cy = rowY + CARD_H + GAP;
  _cy += 4;
}

// ── Table drawing ─────────────────────────────────────────────────────────────
function _tableHeader() {
  _pdf.setFillColor(...KC.surf);
  _pdf.setDrawColor(...KC.border);
  _pdf.setLineWidth(0.2);
  _pdf.rect(PM, _cy, PCW, HDR_H, 'FD');
  let x = PM;
  _f(7, 'bold', KC.mid);
  for (const col of COLS) {
    const tx = col.a === 'right' ? x + col.w - CELL_P : col.a === 'center' ? x + col.w / 2 : x + CELL_P;
    _pdf.text(col.h, tx, _cy + 5.5, { align: col.a });
    x += col.w;
  }
  _cy += HDR_H;
}

function _tableRow(row, alt) {
  _pdf.setFillColor(alt ? 248 : 255, alt ? 250 : 255, alt ? 252 : 255);
  _pdf.setDrawColor(241, 245, 249);
  _pdf.setLineWidth(0.15);
  _pdf.rect(PM, _cy, PCW, ROW_H, 'FD');
  let x = PM;
  for (const col of COLS) {
    const tx  = col.a === 'right' ? x + col.w - CELL_P : col.a === 'center' ? x + col.w / 2 : x + CELL_P;
    const maxW = col.w - CELL_P * 2;
    const cell = _trunc(row[col.k], maxW);

    let cc = KC.mid, bold = false;
    if (col.k === 'value') {
      cc = row.status === 'HIGH' ? KC.red : row.status === 'LOW' ? KC.blue : KC.dark;
      bold = true;
    } else if (col.k === 'status') {
      cc = row.status === 'HIGH' ? KC.red : row.status === 'LOW' ? KC.blue : KC.green;
    }
    _f(7.5, bold ? 'bold' : 'normal', cc);
    _pdf.text(cell, tx, _cy + 5, { align: col.a });
    x += col.w;
  }
  _cy += ROW_H;
}

function _buildRows(markerMap) {
  const rows = [];
  for (const acc of markerMap.values()) {
    const ref = acc.refLow != null && acc.refHigh != null ? `${acc.refLow}–${acc.refHigh}`
      : acc.refHigh != null ? `<${acc.refHigh}` : acc.refLow != null ? `>${acc.refLow}` : '—';
    for (const r of acc.readings) {
      const { status } = flagValue(r.value, acc.refLow, acc.refHigh);
      rows.push({ date: r.date ?? '—', name: acc.name, value: String(r.value), unit: acc.unit || '—', ref, status });
    }
  }
  return rows.sort((a, b) => a.date === '—' ? 1 : b.date === '—' ? -1 : b.date.localeCompare(a.date));
}

function _renderTable(markerMap) {
  const rows = _buildRows(markerMap);
  if (!rows.length) { _f(8, 'normal', KC.muted); _pdf.text('No data.', PM, _cy + 6); _cy += 10; return; }
  _tableHeader();
  rows.forEach((row, i) => {
    if (_cy + ROW_H > PMY) { _newPage(); _tableHeader(); }
    _tableRow(row, i % 2 === 0);
  });
  _cy += 6;
}

// ── Footers (called last — needs final page count) ─────────────────────────────
function _addAllFooters() {
  const total = _pdf.internal.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    _pdf.setPage(i);
    _pdf.setDrawColor(...KC.border);
    _pdf.setLineWidth(0.3);
    _pdf.line(PM, PH - PFH + 1, PM + PCW, PH - PFH + 1);
    _f(7.5, 'normal', KC.muted);
    _pdf.text('HealthLens · No data is stored. Ever.', PM, PH - PFH + 6.5);
    _pdf.text(`Page ${i} of ${total}`, PM + PCW, PH - PFH + 6.5, { align: 'right' });
  }
}

// ── Off-screen html2canvas capture (summary cards grid) ───────────────────────
async function _captureCards(html) {
  const div = document.createElement('div');
  div.style.cssText = 'position:absolute;top:-9999px;left:0;width:780px;background:#f8fafc;padding:16px;box-sizing:border-box;';
  div.innerHTML = html;
  document.body.appendChild(div);
  try {
    const canvas = await html2canvas(div, {
      scale: 2, backgroundColor: '#f8fafc', logging: false, useCORS: false,
    });
    return { dataUrl: canvas.toDataURL('image/png'), pw: canvas.width, ph: canvas.height };
  } finally {
    document.body.removeChild(div);
  }
}

// ── Off-screen Chart.js render → toBase64Image ────────────────────────────────
function _noAnim(cfg) {
  cfg.options = cfg.options ?? {};
  cfg.options.animation = false;
  return cfg;
}

async function _captureChart(config, w = 900, h = 320) {
  _noAnim(config);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h; canvas.style.display = 'none';
  document.body.appendChild(canvas);
  try {
    const chart = new Chart(canvas, config);
    // Two rAF calls ensure Chart.js has completed its synchronous render pass
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const img = chart.toBase64Image('image/png', 1.0);
    chart.destroy();
    return img;
  } finally {
    document.body.removeChild(canvas);
  }
}

// ── Per-category chart generation ────────────────────────────────────────────
async function _renalImgs(panels) {
  const m    = getMarkerReadings(panels, RENAL_SET);
  const creat = findSeries(m, 'creatinine');
  const egfr  = findSeries(m, 'egfr', 'gfr');
  if (!creat && !egfr) return [];
  const config = (creat && egfr)
    ? dualAxisConfig(creat, egfr)
    : getChartConfig((creat ?? egfr).name, (creat ?? egfr).readings,
        { refLow: (creat ?? egfr).refLow, refHigh: (creat ?? egfr).refHigh, unit: (creat ?? egfr).unit });
  return [{ title: 'Creatinine & eGFR', img: await _captureChart(config) }];
}

async function _lipidImgs(panels) {
  const m      = getMarkerReadings(panels, LIPID_SET);
  const result = [];
  const PK     = ['ldl', 'hdl', 'total cholesterol', 'cholesterol', 'non-hdl'];
  const primary = [...m.values()].filter(s => PK.some(k => normName(s.name).includes(k))).slice(0, 4);
  if (primary.length) {
    result.push({ title: 'LDL · HDL · Total Cholesterol · Non-HDL',
      img: await _captureChart(multiLineConfig(primary, 'mg/dL')) });
  }
  const trig = findSeries(m, 'triglyceride');
  if (trig) {
    result.push({ title: 'Triglycerides', img: await _captureChart(
      getChartConfig(trig.name, trig.readings, { refLow: trig.refLow, refHigh: trig.refHigh, unit: trig.unit })) });
  }
  return result;
}

async function _hepaticImgs(panels) {
  const m    = getMarkerReadings(panels, HEPATIC_SET);
  const EK   = ['ast', 'alt', 'alkaline phosphatase', 'alp', 'sgot', 'sgpt', 'alk phos'];
  const enzymes = [...m.values()].filter(s => EK.some(k => normName(s.name).includes(k))).slice(0, 3);
  if (!enzymes.length) return [];
  return [{ title: 'AST · ALT · Alkaline Phosphatase',
    img: await _captureChart(multiLineConfig(enzymes, 'U/L')) }];
}

async function _hormoneImgs(panels) {
  const readings = getMarkerReadings(panels, HORMONE_SET);
  const test = findSeries(readings, 'total testosterone', 'testosterone');
  const e2   = findSeries(readings, 'estradiol', 'e2');
  if (!test && !e2) return [];

  const doses = getDosageInfo();
  function applyDosage(cfg) {
    if (!doses.length) return cfg;
    cfg.options.layout = cfg.options.layout ?? {};
    cfg.options.layout.padding = { ...(cfg.options.layout.padding ?? {}), top: 36 };
    cfg.options.plugins = cfg.options.plugins ?? {};
    cfg.options.plugins.dosageLines = { doses };
    cfg.plugins = [DOSAGE_LINES_PLUGIN];
    return cfg;
  }

  const config = (test && e2)
    ? applyDosage(dualAxisConfig(test, e2))
    : applyDosage((() => {
        const s = test ?? e2;
        return getChartConfig(s.name, s.readings, { refLow: s.refLow, refHigh: s.refHigh, unit: s.unit });
      })());

  return [{ title: 'Testosterone & Estradiol (E2)', img: await _captureChart(config) }];
}

async function _cbcImgs(panels) {
  const readings = getMarkerReadings(panels, CBC_SET);
  const hgb = findSeries(readings, 'hemoglobin', 'hgb');
  const hct = findSeries(readings, 'hematocrit', 'hct');
  if (!hgb && !hct) return [];
  const config = (hgb && hct)
    ? dualAxisConfig(hgb, hct)
    : getChartConfig((hgb ?? hct).name, (hgb ?? hct).readings, {
        refLow: (hgb ?? hct).refLow, refHigh: (hgb ?? hct).refHigh, unit: (hgb ?? hct).unit, color: '#ef4444',
      });
  return [{ title: 'Hemoglobin & Hematocrit', img: await _captureChart(config) }];
}

async function _thyroidImgs(panels) {
  const readings = getMarkerReadings(panels, THYROID_SET);
  const tsh = findSeries(readings, 'tsh');
  if (!tsh) return [];
  return [{ title: 'TSH (Thyroid Stimulating Hormone)', img: await _captureChart(
    getChartConfig(tsh.name, tsh.readings, { refLow: tsh.refLow, refHigh: tsh.refHigh, unit: tsh.unit, color: '#f59e0b' })
  )}];
}

async function _bodyCompImgs(panels) {
  const result = [];
  const dexaM  = getMarkerReadings(panels.filter(p => p.documentType === 'dexa'), null);
  const scaleM = getMarkerReadings(panels.filter(p => p.documentType === 'scale'), null);
  const CK = ['fat', 'lean', 'mass', 'body fat', 'bone'];
  const comp = [...dexaM.values()].filter(s => CK.some(k => normName(s.name).includes(k))).slice(0, 5);
  if (comp.length) {
    result.push({ title: 'Body Composition (DEXA)', img: await _captureChart(multiLineConfig(comp)) });
  }
  const wt = findSeries(scaleM, 'weight', 'bmi');
  if (wt) {
    result.push({ title: 'Weight Trend', img: await _captureChart(
      getChartConfig(wt.name, wt.readings, { refLow: wt.refLow, refHigh: wt.refHigh, unit: wt.unit })) });
  }
  return result;
}

// ── Combined sections: each category gets its own page with chart then table ───
async function _addSections(panels) {
  const SECTIONS = [
    {
      title: 'Renal Function',
      chartFn: _renalImgs,
      getMap: (p) => getMarkerReadings(p, RENAL_SET),
    },
    {
      title: 'Lipid Panel',
      chartFn: _lipidImgs,
      getMap: (p) => getMarkerReadings(p, LIPID_SET),
    },
    {
      title: 'Hepatic Markers',
      chartFn: _hepaticImgs,
      getMap: (p) => getMarkerReadings(p, HEPATIC_SET),
    },
    {
      title: 'Hormones',
      chartFn: _hormoneImgs,
      getMap: (p) => getMarkerReadings(p, HORMONE_SET),
    },
    {
      title: 'CBC (Blood Count)',
      chartFn: _cbcImgs,
      getMap: (p) => getMarkerReadings(p, CBC_SET),
    },
    {
      title: 'Thyroid',
      chartFn: _thyroidImgs,
      getMap: (p) => getMarkerReadings(p, THYROID_SET),
    },
    {
      title: 'Body Composition',
      chartFn: _bodyCompImgs,
      getMap: (p) => {
        const d = getMarkerReadings(p.filter(x => x.documentType === 'dexa'),  null);
        const s = getMarkerReadings(p.filter(x => x.documentType === 'scale'), null);
        return new Map([...d, ...s]);
      },
    },
  ];

  const shownKeys = new Set();

  for (const sec of SECTIONS) {
    const markerMap = sec.getMap(panels);
    const imgs      = await sec.chartFn(panels);
    if (!markerMap.size && !imgs.length) continue;

    // Each section starts on a fresh page
    _newPage();
    _sectionHead(sec.title);

    // Chart(s) — multiple for lipid (primary + triglycerides)
    for (const { title: chartTitle, img } of imgs) {
      if (imgs.length > 1 && chartTitle) {
        _f(8, 'normal', KC.mid);
        _pdf.text(chartTitle, PM, _cy);
        _cy += 5;
      }
      // Start new page if chart won't fit (e.g. multi-chart sections)
      _need(CHART_H + 4);
      _pdf.addImage(img, 'PNG', PM, _cy, PCW, CHART_H);
      _cy += CHART_H + 10;
    }

    // Data table immediately after chart(s)
    if (markerMap.size) {
      _renderTable(markerMap);
      for (const k of markerMap.keys()) shownKeys.add(k);
    }
  }

  // Imaging — its own page (stat cards + table, no chart)
  const imgPanels = panels.filter(p => IMAGING_TYPES.has(p.documentType));
  if (imgPanels.length) {
    _newPage();
    _addImagingSection(panels);
  }

  // Catch-all: anything not shown above
  const allRest = getMarkerReadings(
    panels.filter(p => !IMAGING_TYPES.has(p.documentType)), null
  );
  const remaining = new Map([...allRest].filter(([k]) => !shownKeys.has(k)));
  if (remaining.size) {
    _newPage();
    _sectionHead('Other Markers');
    _renderTable(remaining);
  }
}

function _addImagingSection(panels) {
  const imgPanels = panels.filter(p => IMAGING_TYPES.has(p.documentType));
  if (!imgPanels.length) return;
  _sectionHead('Imaging / CTCA');

  const all  = getMarkerReadings(imgPanels, null);
  const cac  = findSeries(all, 'cac', 'calcium score');
  const lvef = findSeries(all, 'lvef', 'ejection fraction');
  const stats = [cac, lvef].filter(Boolean);

  if (stats.length) {
    _need(28);
    const BW = (PCW - (stats.length - 1) * 6) / stats.length;
    stats.forEach((s, i) => {
      const bx = PM + i * (BW + 6), by = _cy;
      const latest = s.readings.at(-1);
      const { status } = flagValue(latest?.value, s.refLow, s.refHigh);
      const sc = status === 'HIGH' ? KC.red : status === 'LOW' ? KC.blue : KC.green;
      _pdf.setFillColor(...KC.white); _pdf.setDrawColor(...KC.border); _pdf.setLineWidth(0.25);
      _pdf.roundedRect(bx, by, BW, 22, 2, 2, 'FD');
      _pdf.setFillColor(...sc); _pdf.roundedRect(bx, by, 2.5, 22, 2, 2, 'F');
      _pdf.rect(bx + 1.25, by, 1.25, 22, 'F');
      _f(6.5, 'bold', KC.muted); _pdf.text(s.name.toUpperCase().slice(0, 22), bx + 5, by + 7);
      _f(14, 'bold', KC.dark);   _pdf.text(String(latest?.value ?? '—'), bx + 5, by + 16);
      _f(7,  'normal', KC.muted);_pdf.text(s.unit ?? '', bx + 5 + _pdf.getTextWidth(String(latest?.value ?? '')) + 0.5, by + 16);
    });
    _cy += 28;
  }

  _renderTable(all);
  _need(8); _f(7.5, 'normal', KC.muted);
  _pdf.text('Narrative radiologist impressions are not included. Refer to the original report.', PM, _cy);
  _cy += 8;
}

// ── Data accessors ────────────────────────────────────────────────────────────
function _plainPanels() {
  return [...state.files.values()]
    .filter(e => e.phase === 'done' && e.result)
    .map(e => e.result)
    .sort((a, b) => !a.drawDate ? 1 : !b.drawDate ? -1 : a.drawDate.localeCompare(b.drawDate));
}

async function _redactedPanels() {
  return Promise.all(_plainPanels().map(async p => {
    try {
      const r = await fetch(`${WORKER_URL}/redact`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p),
      });
      const body = await r.json();
      return body.ok && body.data ? body.data : p;
    } catch { return p; }
  }));
}

function _dateRange(panels) {
  const dates = panels.map(p => p.drawDate).filter(Boolean).sort();
  if (!dates.length) return '';
  return dates.length === 1 ? dates[0] : `${dates[0]} – ${dates.at(-1)}`;
}

// ── Main export ───────────────────────────────────────────────────────────────
async function exportPDF() {
  const btn        = document.getElementById('exportBtn');
  const toggleBtn  = document.getElementById('privacyToggle');

  // Snapshot privacy state exactly once — must not change mid-export
  const exportPrivate = state.privacyMode;
  state.exporting     = true;

  if (btn)       { btn.disabled = true;       btn.textContent = 'Exporting…'; }
  if (toggleBtn) { toggleBtn.disabled = true; }   // block toggle during export

  try {
    // 1. Get panels — call /redact if privacy was ON at trigger time
    const panels = exportPrivate ? await _redactedPanels() : _plainPanels();
    if (!panels.length) { alert('No analyzed documents to export.'); return; }

    const cards   = buildSummaryCards(panels);
    const flagged = cards.filter(c => c.status !== 'NORMAL');
    const patient = panels.find(p => p.patientName)?.patientName
      ?? (exportPrivate ? '[REDACTED]' : null);

    // 2. Init jsPDF
    _pdf = new jspdf.jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    _cy  = PM;

    // 3. Report header (cover block)
    _reportHeader(patient, _dateRange(panels), panels.length);

    // 4. Flagged markers
    //    - If privacy ON: data is already redacted (came from /redact)
    //    - If privacy OFF: use live state data
    //    Cards are rendered off-screen via html2canvas so the visual output
    //    exactly matches what the user would see on the dashboard.
    if (flagged.length) {
      _sectionHead(`Flagged Markers (${flagged.length})`);
      try {
        const captured = await _captureCards(summaryGridHTML(flagged, false));
        const imgH = (captured.ph / captured.pw) * PCW;
        _need(imgH + 4);
        _pdf.addImage(captured.dataUrl, 'PNG', PM, _cy, PCW, imgH);
        _cy += imgH + 8;
      } catch {
        // html2canvas fallback: draw cards programmatically
        _drawSummaryCards(flagged);
      }
    }

    // 5. One page per category: chart then data table, imaging handled inside
    await _addSections(panels);

    // 8. Footers on every page (must run last — needs final page count)
    _addAllFooters();

    // 9. Save
    const stamp = new Date().toISOString().slice(0, 10);
    _pdf.save(`HealthLens-Report-${stamp}.pdf`);

  } catch (err) {
    console.error('HealthLens export error:', err);
    alert(`PDF export failed: ${err.message}`);
  } finally {
    state.exporting = false;
    if (btn)       { btn.disabled = false;        btn.textContent = 'Export PDF'; }
    if (toggleBtn) { toggleBtn.disabled = false; }
  }
}
