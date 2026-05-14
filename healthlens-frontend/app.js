// ── Config ──────────────────────────────────────────────────────────────────
// Update this URL after deploying your Cloudflare Worker.
// Example: 'https://healthlens-worker.your-subdomain.workers.dev'
const WORKER_URL = 'https://healthlens-worker.jhs-amarillo.workers.dev';

const PDFJS_WORKER_SRC =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
}

// ── Constants ────────────────────────────────────────────────────────────────
const DOC_TYPES = [
  { value: '',            label: 'Select document type…' },
  { value: 'blood_work',  label: 'Blood Work / CMP' },
  { value: 'lipid_panel', label: 'Lipid Panel' },
  { value: 'testosterone', label: 'Testosterone' },
  { value: 'estradiol',   label: 'Estradiol (E2)' },
  { value: 'thyroid',     label: 'Thyroid Panel' },
  { value: 'cbc',         label: 'CBC (Blood Count)' },
  { value: 'dexa',        label: 'DEXA Scan' },
  { value: 'scale',       label: 'Scale / Weight Log' },
  { value: 'ctca',        label: 'CTCA / Imaging' },
  { value: 'other',       label: 'Other' },
];

const ACCEPTED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/tiff',
]);

// ── SVG assets ───────────────────────────────────────────────────────────────
const SVG = {
  eyeOpen: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15"
      viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>`,

  eyeClosed: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15"
      viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8
             a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0
             1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19
             m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
    <line x1="1" y1="1" x2="23" y2="23"/>
  </svg>`,

  uploadLg: `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44"
      viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
      class="upload-icon">
    <polyline points="16 16 12 12 8 16"/>
    <line x1="12" y1="12" x2="12" y2="21"/>
    <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
  </svg>`,

  uploadSm: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15"
      viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      style="color:var(--text-muted)">
    <polyline points="16 16 12 12 8 16"/>
    <line x1="12" y1="12" x2="12" y2="21"/>
    <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
  </svg>`,
};

// ── State ────────────────────────────────────────────────────────────────────
// ALL state lives here. No localStorage, sessionStorage, cookies, or IndexedDB.
const state = {
  files: new Map(),   // id → FileEntry
  privacyMode: false,
  exporting: false,   // true while PDF export is running — blocks privacy toggle
  goals: {},          // normName(markerName) → goal value (number); persists across file uploads
};

// FileEntry shape:
// {
//   id:          string,
//   file:        File | {name,size,type,lastModified},
//   docType:     string,
//   phase:       'extracting' | 'ready' | 'analyzing' | 'done' | 'error',
//   errorMsg:    string | null,
//   errorPhase:  'extract' | 'analyze' | null,
//   text:        string | null,
//   base64:      string | null,
//   result:      object | null,
//   showManual:  boolean,         — true when manual-entry form is open
// }

// ── Sample data ───────────────────────────────────────────────────────────────
// Pre-built panel objects that bypass the Worker entirely, used for the demo.
const SAMPLE_PANELS = [
  { _fileName:'Demo — CMP 2023-09-12.pdf', documentType:'blood_work', drawDate:'2023-09-12',
    patientName:'Alex Reynolds', dob:'1978-04-22', address:'123 Demo Lane, Springfield',
    physicianName:'Dr. M. Sample', facilityName:'Sample Medical Group',
    extractionConfidence:'high', parseWarnings:[],
    markers:[
      {name:'Glucose',              value:112, unit:'mg/dL',  refLow:70,   refHigh:99,   flag:'H'},
      {name:'BUN',                  value:18,  unit:'mg/dL',  refLow:7,    refHigh:25,   flag:null},
      {name:'Creatinine',           value:1.0, unit:'mg/dL',  refLow:0.7,  refHigh:1.3,  flag:null},
      {name:'eGFR',                 value:82,  unit:'mL/min', refLow:60,   refHigh:null, flag:null},
      {name:'Sodium',               value:139, unit:'mEq/L',  refLow:136,  refHigh:145,  flag:null},
      {name:'Potassium',            value:4.1, unit:'mEq/L',  refLow:3.5,  refHigh:5.1,  flag:null},
      {name:'AST',                  value:45,  unit:'U/L',    refLow:null, refHigh:40,   flag:'H'},
      {name:'ALT',                  value:52,  unit:'U/L',    refLow:null, refHigh:56,   flag:null},
      {name:'Alkaline Phosphatase', value:78,  unit:'U/L',    refLow:null, refHigh:120,  flag:null},
      {name:'Total Bilirubin',      value:0.8, unit:'mg/dL',  refLow:null, refHigh:1.2,  flag:null},
      {name:'Albumin',              value:4.2, unit:'g/dL',   refLow:3.5,  refHigh:5.0,  flag:null},
    ]},
  { _fileName:'Demo — CMP 2024-09-05.pdf', documentType:'blood_work', drawDate:'2024-09-05',
    patientName:'Alex Reynolds', dob:'1978-04-22', address:'123 Demo Lane, Springfield',
    physicianName:'Dr. M. Sample', facilityName:'Sample Medical Group',
    extractionConfidence:'high', parseWarnings:[],
    markers:[
      {name:'Glucose',              value:105, unit:'mg/dL',  refLow:70,   refHigh:99,   flag:'H'},
      {name:'BUN',                  value:16,  unit:'mg/dL',  refLow:7,    refHigh:25,   flag:null},
      {name:'Creatinine',           value:0.9, unit:'mg/dL',  refLow:0.7,  refHigh:1.3,  flag:null},
      {name:'eGFR',                 value:88,  unit:'mL/min', refLow:60,   refHigh:null, flag:null},
      {name:'Sodium',               value:140, unit:'mEq/L',  refLow:136,  refHigh:145,  flag:null},
      {name:'Potassium',            value:4.0, unit:'mEq/L',  refLow:3.5,  refHigh:5.1,  flag:null},
      {name:'AST',                  value:38,  unit:'U/L',    refLow:null, refHigh:40,   flag:null},
      {name:'ALT',                  value:44,  unit:'U/L',    refLow:null, refHigh:56,   flag:null},
      {name:'Alkaline Phosphatase', value:72,  unit:'U/L',    refLow:null, refHigh:120,  flag:null},
      {name:'Total Bilirubin',      value:0.7, unit:'mg/dL',  refLow:null, refHigh:1.2,  flag:null},
      {name:'Albumin',              value:4.4, unit:'g/dL',   refLow:3.5,  refHigh:5.0,  flag:null},
    ]},
  { _fileName:'Demo — CMP 2025-10-22.pdf', documentType:'blood_work', drawDate:'2025-10-22',
    patientName:'Alex Reynolds', dob:'1978-04-22', address:'123 Demo Lane, Springfield',
    physicianName:'Dr. M. Sample', facilityName:'Sample Medical Group',
    extractionConfidence:'high', parseWarnings:[],
    markers:[
      {name:'Glucose',              value:98,  unit:'mg/dL',  refLow:70,   refHigh:99,   flag:null},
      {name:'BUN',                  value:15,  unit:'mg/dL',  refLow:7,    refHigh:25,   flag:null},
      {name:'Creatinine',           value:0.9, unit:'mg/dL',  refLow:0.7,  refHigh:1.3,  flag:null},
      {name:'eGFR',                 value:90,  unit:'mL/min', refLow:60,   refHigh:null, flag:null},
      {name:'Sodium',               value:141, unit:'mEq/L',  refLow:136,  refHigh:145,  flag:null},
      {name:'Potassium',            value:4.2, unit:'mEq/L',  refLow:3.5,  refHigh:5.1,  flag:null},
      {name:'AST',                  value:32,  unit:'U/L',    refLow:null, refHigh:40,   flag:null},
      {name:'ALT',                  value:38,  unit:'U/L',    refLow:null, refHigh:56,   flag:null},
      {name:'Alkaline Phosphatase', value:68,  unit:'U/L',    refLow:null, refHigh:120,  flag:null},
      {name:'Total Bilirubin',      value:0.6, unit:'mg/dL',  refLow:null, refHigh:1.2,  flag:null},
      {name:'Albumin',              value:4.5, unit:'g/dL',   refLow:3.5,  refHigh:5.0,  flag:null},
    ]},
  { _fileName:'Demo — Lipid Panel 2023-09-12.pdf', documentType:'lipid_panel', drawDate:'2023-09-12',
    patientName:'Alex Reynolds', dob:'1978-04-22', address:'123 Demo Lane, Springfield',
    physicianName:'Dr. M. Sample', facilityName:'Sample Medical Group',
    extractionConfidence:'high', parseWarnings:[],
    markers:[
      {name:'Total Cholesterol', value:245, unit:'mg/dL',  refLow:null, refHigh:200, flag:'H'},
      {name:'LDL Cholesterol',   value:168, unit:'mg/dL',  refLow:null, refHigh:100, flag:'H'},
      {name:'HDL Cholesterol',   value:38,  unit:'mg/dL',  refLow:40,   refHigh:null,flag:'L'},
      {name:'Triglycerides',     value:195, unit:'mg/dL',  refLow:null, refHigh:150, flag:'H'},
      {name:'Non-HDL',           value:207, unit:'mg/dL',  refLow:null, refHigh:130, flag:'H'},
      {name:'Lp(a)',             value:78,  unit:'nmol/L', refLow:null, refHigh:75,  flag:'H'},
      {name:'ApoB',              value:142, unit:'mg/dL',  refLow:null, refHigh:90,  flag:'H'},
    ]},
  { _fileName:'Demo — Lipid Panel 2024-09-05.pdf', documentType:'lipid_panel', drawDate:'2024-09-05',
    patientName:'Alex Reynolds', dob:'1978-04-22', address:'123 Demo Lane, Springfield',
    physicianName:'Dr. M. Sample', facilityName:'Sample Medical Group',
    extractionConfidence:'high', parseWarnings:[],
    markers:[
      {name:'Total Cholesterol', value:198, unit:'mg/dL',  refLow:null, refHigh:200, flag:null},
      {name:'LDL Cholesterol',   value:122, unit:'mg/dL',  refLow:null, refHigh:100, flag:'H'},
      {name:'HDL Cholesterol',   value:44,  unit:'mg/dL',  refLow:40,   refHigh:null,flag:null},
      {name:'Triglycerides',     value:152, unit:'mg/dL',  refLow:null, refHigh:150, flag:'H'},
      {name:'Non-HDL',           value:154, unit:'mg/dL',  refLow:null, refHigh:130, flag:'H'},
      {name:'Lp(a)',             value:78,  unit:'nmol/L', refLow:null, refHigh:75,  flag:'H'},
      {name:'ApoB',              value:108, unit:'mg/dL',  refLow:null, refHigh:90,  flag:'H'},
    ]},
  { _fileName:'Demo — Lipid Panel 2025-10-22.pdf', documentType:'lipid_panel', drawDate:'2025-10-22',
    patientName:'Alex Reynolds', dob:'1978-04-22', address:'123 Demo Lane, Springfield',
    physicianName:'Dr. M. Sample', facilityName:'Sample Medical Group',
    extractionConfidence:'high', parseWarnings:[],
    markers:[
      {name:'Total Cholesterol', value:182, unit:'mg/dL',  refLow:null, refHigh:200, flag:null},
      {name:'LDL Cholesterol',   value:95,  unit:'mg/dL',  refLow:null, refHigh:100, flag:null},
      {name:'HDL Cholesterol',   value:52,  unit:'mg/dL',  refLow:40,   refHigh:null,flag:null},
      {name:'Triglycerides',     value:128, unit:'mg/dL',  refLow:null, refHigh:150, flag:null},
      {name:'Non-HDL',           value:130, unit:'mg/dL',  refLow:null, refHigh:130, flag:null},
      {name:'Lp(a)',             value:76,  unit:'nmol/L', refLow:null, refHigh:75,  flag:'H'},
      {name:'ApoB',              value:88,  unit:'mg/dL',  refLow:null, refHigh:90,  flag:null},
    ]},
  { _fileName:'Demo — CTCA 2025-11-10.pdf', documentType:'ctca', drawDate:'2025-11-10',
    patientName:'Alex Reynolds', dob:'1978-04-22', address:'123 Demo Lane, Springfield',
    physicianName:'Dr. M. Sample', facilityName:'Sample Medical Group',
    extractionConfidence:'high', parseWarnings:[],
    markers:[
      {name:'CAC Score',    value:142, unit:'',  refLow:null, refHigh:0,   flag:'H'},
      {name:'LVEF',         value:62,  unit:'%', refLow:55,   refHigh:null,flag:null},
      {name:'LAD Stenosis', value:30,  unit:'%', refLow:null, refHigh:50,  flag:null},
      {name:'LCx Stenosis', value:10,  unit:'%', refLow:null, refHigh:50,  flag:null},
      {name:'RCA Stenosis', value:15,  unit:'%', refLow:null, refHigh:50,  flag:null},
    ]},
];

// ── Manual-entry field templates (shown when AI extraction fails) ──────────────
const MANUAL_FIELDS = {
  blood_work: [
    {name:'Glucose',     unit:'mg/dL',  refLow:70,   refHigh:99 },
    {name:'BUN',         unit:'mg/dL',  refLow:7,    refHigh:25 },
    {name:'Creatinine',  unit:'mg/dL',  refLow:0.7,  refHigh:1.3},
    {name:'eGFR',        unit:'mL/min', refLow:60,   refHigh:null},
    {name:'AST',         unit:'U/L',    refLow:null, refHigh:40 },
    {name:'ALT',         unit:'U/L',    refLow:null, refHigh:56 },
  ],
  lipid_panel: [
    {name:'Total Cholesterol', unit:'mg/dL', refLow:null, refHigh:200},
    {name:'LDL Cholesterol',   unit:'mg/dL', refLow:null, refHigh:100},
    {name:'HDL Cholesterol',   unit:'mg/dL', refLow:40,   refHigh:null},
    {name:'Triglycerides',     unit:'mg/dL', refLow:null, refHigh:150},
    {name:'Non-HDL',           unit:'mg/dL', refLow:null, refHigh:130},
  ],
  dexa: [
    {name:'Body Fat %',             unit:'%',  refLow:null, refHigh:25 },
    {name:'Lean Mass',              unit:'kg', refLow:null, refHigh:null},
    {name:'Bone Density T-score',   unit:'SD', refLow:-1.0, refHigh:null},
  ],
  scale: [
    {name:'Weight', unit:'lbs', refLow:null, refHigh:null},
    {name:'BMI',    unit:'',    refLow:18.5, refHigh:24.9},
  ],
  ctca: [
    {name:'CAC Score', unit:'',  refLow:null, refHigh:0  },
    {name:'LVEF',      unit:'%', refLow:55,   refHigh:null},
  ],
  testosterone: [
    {name:'Total Testosterone', unit:'ng/dL',  refLow:300, refHigh:1000},
    {name:'Free Testosterone',  unit:'pg/mL',  refLow:5,   refHigh:30  },
    {name:'SHBG',               unit:'nmol/L', refLow:10,  refHigh:57  },
    {name:'LH',                 unit:'mIU/mL', refLow:1.7, refHigh:8.6 },
    {name:'FSH',                unit:'mIU/mL', refLow:1.5, refHigh:12.4},
  ],
  estradiol: [
    {name:'Estradiol (E2)', unit:'pg/mL', refLow:10, refHigh:40},
    {name:'SHBG',           unit:'nmol/L',refLow:10, refHigh:57},
  ],
  thyroid: [
    {name:'TSH',           unit:'mIU/L', refLow:0.4,  refHigh:4.0 },
    {name:'Free T4',       unit:'ng/dL', refLow:0.8,  refHigh:1.8 },
    {name:'Free T3',       unit:'pg/mL', refLow:2.3,  refHigh:4.2 },
    {name:'Reverse T3',    unit:'ng/dL', refLow:9.2,  refHigh:24.1},
    {name:'TPO Antibodies',unit:'IU/mL', refLow:null, refHigh:34  },
  ],
  cbc: [
    {name:'WBC',           unit:'K/uL',  refLow:4.5,  refHigh:11.0},
    {name:'RBC',           unit:'M/uL',  refLow:4.5,  refHigh:5.9 },
    {name:'Hemoglobin',    unit:'g/dL',  refLow:13.5, refHigh:17.5},
    {name:'Hematocrit',    unit:'%',     refLow:41,   refHigh:53  },
    {name:'Platelets',     unit:'K/uL',  refLow:150,  refHigh:400 },
    {name:'Neutrophils',   unit:'%',     refLow:40,   refHigh:70  },
    {name:'Lymphocytes',   unit:'%',     refLow:20,   refHigh:40  },
  ],
  // legacy key — kept so old in-session entries still get a form
  hormones: [
    {name:'Total Testosterone', unit:'ng/dL',  refLow:300, refHigh:1000},
    {name:'Estradiol (E2)',     unit:'pg/mL',  refLow:10,  refHigh:40  },
  ],
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function isPDF(file) {
  return file.type === 'application/pdf'
    || file.name.toLowerCase().endsWith('.pdf');
}

function isAccepted(file) {
  return ACCEPTED_MIME.has(file.type)
    || file.name.toLowerCase().endsWith('.pdf');
}

function fileBadge(file) {
  if (isPDF(file)) return { label: 'PDF', cls: 'badge-pdf' };
  if (file.type.startsWith('image/')) {
    const ext = (file.type.split('/')[1] || 'IMG')
      .replace('jpeg', 'jpg').toUpperCase();
    return { label: ext, cls: 'badge-img' };
  }
  return { label: 'FILE', cls: 'badge-file' };
}

function dedupKey(file) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

// ── PDF extraction ────────────────────────────────────────────────────────────
async function extractPDFText(file) {
  if (typeof pdfjsLib === 'undefined') {
    throw new Error('PDF.js did not load. Check your internet connection.');
  }
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => item.str).join(' ')
      .replace(/\s{2,}/g, ' ').trim();
    if (pageText) fullText += pageText + '\n';
  }
  if (!fullText.trim()) {
    throw new Error(
      'No text found in this PDF. It may be a scanned image — try a text-layer version.'
    );
  }
  return fullText.trim();
}

async function imageToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('Failed to read image file.'));
    reader.readAsDataURL(file);
  });
}

// ── Worker API call ───────────────────────────────────────────────────────────
async function callWorker(entry) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);

  let response;
  try {
    response = await fetch(`${WORKER_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        documentType: entry.docType,
        // Images: send a descriptor rather than raw base64 to avoid huge payloads;
        // full multimodal support can be added to the Worker later.
        textContent: entry.text
          ?? `[Image file: ${entry.file.type}, ${entry.file.name}]`,
        fileName: entry.file.name,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Request timed out after 45 s. Try again.');
    }
    throw new Error('Could not reach the analysis server. Is the Worker deployed?');
  } finally {
    clearTimeout(timer);
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error ?? `Server error ${response.status}`);
  }
  if (!body?.ok) {
    throw new Error(body?.error ?? 'Extraction failed with unknown error.');
  }
  return body.data;
}

// ── State mutations ───────────────────────────────────────────────────────────
function setPhase(id, phase, extras = {}) {
  const e = state.files.get(id);
  if (e) Object.assign(e, { phase }, extras);
}

// ── Extraction orchestration ──────────────────────────────────────────────────
async function extractFile(id) {
  const entry = state.files.get(id);
  if (!entry) return;

  setPhase(id, 'extracting', { errorMsg: null, errorPhase: null });
  updateCard(id);

  try {
    if (isPDF(entry.file)) {
      entry.text = await extractPDFText(entry.file);
    } else {
      entry.base64 = await imageToBase64(entry.file);
      entry.text   = null;
    }

    if (!state.files.has(id)) return; // removed during async op
    setPhase(id, 'ready');
  } catch (err) {
    if (!state.files.has(id)) return;
    setPhase(id, 'error', { errorMsg: err.message, errorPhase: 'extract' });
  }

  updateCard(id);
  updateAnalyzeBtn();
}

// ── Analysis orchestration ────────────────────────────────────────────────────
async function analyzeFile(id) {
  const entry = state.files.get(id);
  if (!entry || entry.phase !== 'ready' || !entry.docType) return;

  setPhase(id, 'analyzing', { errorMsg: null, errorPhase: null });
  updateCard(id);
  updateAnalyzeBtn();

  try {
    const result = await callWorker(entry);
    if (!state.files.has(id)) return;
    setPhase(id, 'done', { result });
  } catch (err) {
    if (!state.files.has(id)) return;
    setPhase(id, 'error', { errorMsg: err.message, errorPhase: 'analyze' });
  }

  updateCard(id);
  updateAnalyzeBtn();
  checkAllDone();
}

// After every analysis settles, handle transition to dashboard.
function checkAllDone() {
  const entries = [...state.files.values()];
  if (!entries.length) return;
  if (!entries.every(e => e.phase === 'done' || e.phase === 'error')) return;
  const anyDone = entries.some(e => e.phase === 'done');
  if (!anyDone) return;

  // Re-render cards so date inputs appear for panels with missing dates
  renderFileList();
  updateAnalyzeBtn(); // morphs to "View Dashboard →"

  const missingDates = entries.filter(e => e.phase === 'done' && !e.result?.drawDate);
  if (missingDates.length === 0) {
    // Everything has dates — go straight to dashboard
    switchView(renderDashboard);
  }
  // If dates are missing, stay here so the user can fill them in,
  // then click "View Dashboard →" when ready.
}

// ── Add files ─────────────────────────────────────────────────────────────────
function addFiles(fileList) {
  const existing = new Set([...state.files.values()].map(e => dedupKey(e.file)));
  let added = 0;

  for (const file of fileList) {
    if (!isAccepted(file)) {
      showDropError(`"${file.name}" — only PDF and image files are supported.`);
      continue;
    }
    if (existing.has(dedupKey(file))) {
      if (!window.confirm(`"${file.name}" is already in the list.\nAdd it again?`)) continue;
    }
    const id = uid();
    state.files.set(id, {
      id, file, docType: '', phase: 'extracting',
      errorMsg: null, errorPhase: null,
      text: null, base64: null, result: null, showManual: false,
      testDose: '', aiDose: '',
    });
    existing.add(dedupKey(file));
    added++;
  }

  if (added === 0) return;

  renderFileList();
  updateDropZone();
  updateAnalyzeBtn();

  // Kick off extraction for all newly added files
  for (const [id, entry] of state.files) {
    if (entry.phase === 'extracting') extractFile(id);
  }
}

// ── Retry ─────────────────────────────────────────────────────────────────────
async function retryFile(id) {
  const entry = state.files.get(id);
  if (!entry || entry.phase !== 'error') return;

  if (entry.errorPhase === 'extract') {
    await extractFile(id);
  } else {
    // Analysis failed: text is already available, re-run Worker call
    setPhase(id, 'ready');
    updateCard(id);
    updateAnalyzeBtn();
    if (entry.docType) await analyzeFile(id);
  }
}

// ── Rendering: card HTML ──────────────────────────────────────────────────────
function statusHTML(phase) {
  switch (phase) {
    case 'extracting': return `<span class="card-status status-extracting"><span class="spinner"></span> Extracting…</span>`;
    case 'ready':      return `<span class="card-status status-ready">✓ Ready</span>`;
    case 'analyzing':  return `<span class="card-status status-analyzing"><span class="spinner"></span> Analyzing…</span>`;
    case 'done':       return `<span class="card-status status-done">Done ✓</span>`;
    case 'error':      return `<span class="card-status status-error">✗ Failed</span>`;
    default:           return '';
  }
}

function cardHTML(entry) {
  const badge     = fileBadge(entry.file);
  const busy      = entry.phase === 'analyzing';
  const removable = !busy;
  const selectOff = entry.phase === 'extracting' || busy;

  const options = DOC_TYPES.map(t =>
    `<option value="${esc(t.value)}"${entry.docType === t.value ? ' selected' : ''}>${esc(t.label)}</option>`
  ).join('');

  let bottomContent;
  if (entry.showManual) {
    bottomContent = manualFormHTML(entry);
  } else if (entry.phase === 'done') {
    const count = entry.result?.markers?.length ?? 0;
    const dateStr = entry.result?.drawDate;
    if (!dateStr) {
      bottomContent = `
        <div class="done-date-row">
          <span class="done-summary">${count} marker${count !== 1 ? 's' : ''} extracted &nbsp;·&nbsp; <span class="date-missing-label">date not found — enter to plot on charts</span></span>
          <input type="date" class="date-missing-input" data-action="setdate" data-id="${esc(entry.id)}" />
        </div>`;
    } else {
      bottomContent = `<span class="done-summary">✓ ${count} marker${count !== 1 ? 's' : ''} extracted &nbsp;·&nbsp; ${esc(dateStr)}</span>`;
    }
  } else if (entry.phase === 'error') {
    const canManual = entry.errorPhase === 'analyze';
    bottomContent = `
      <span class="card-error-msg">${esc(entry.errorMsg ?? 'Unknown error.')}</span>
      <button class="retry-btn" data-action="retry" data-id="${esc(entry.id)}">Retry</button>
      ${canManual ? `<button class="manual-btn" data-action="manual" data-id="${esc(entry.id)}">Enter manually</button>` : ''}`;
  } else {
    const sel = `<select class="doc-type-select" data-action="doctype" data-id="${esc(entry.id)}"${selectOff ? ' disabled' : ''}>${options}</select>`;
    // Dosage fields only on Testosterone — not on Estradiol
    bottomContent = entry.docType === 'testosterone'
      ? sel + doseFieldsHTML(entry)
      : sel;
  }

  return `
<div class="file-card" data-id="${esc(entry.id)}">
  <div class="card-top">
    <span class="file-badge ${badge.cls}">${badge.label}</span>
    <span class="file-name" title="${esc(entry.file.name)}">${esc(entry.file.name)}</span>
    ${entry.phase === 'done' && !entry.result?.drawDate
      ? `<span class="card-status status-warn">⚠ Date missing</span>`
      : statusHTML(entry.phase)}
    ${removable
      ? `<button class="remove-btn" data-action="remove" data-id="${esc(entry.id)}"
           aria-label="Remove ${esc(entry.file.name)}" title="Remove">×</button>`
      : ''}
  </div>
  <div class="card-bottom${entry.docType === 'testosterone' && !entry.showManual && entry.phase !== 'error' ? ' card-bottom--col' : ''}">
    ${bottomContent}
  </div>
</div>`;
}

// ── Rendering: file list ──────────────────────────────────────────────────────
function renderFileList() {
  const el = document.getElementById('fileList');
  if (!el) return;
  el.innerHTML = [...state.files.values()].map(cardHTML).join('');
}

// Targeted single-card update — avoids destroying the entire list on each async tick
function updateCard(id) {
  const entry    = state.files.get(id);
  const existing = document.querySelector(`.file-card[data-id="${id}"]`);
  if (!existing) {
    // Card not in DOM yet (or was removed) — full list render
    if (state.files.size > 0) renderFileList();
    return;
  }
  if (!entry) {
    existing.remove();
    return;
  }
  const tmp = document.createElement('div');
  tmp.innerHTML = cardHTML(entry);
  existing.replaceWith(tmp.firstElementChild);
}

// ── Rendering: drop zone ──────────────────────────────────────────────────────
function dropFullHTML() {
  return `
<div class="drop-full">
  ${SVG.uploadLg}
  <span class="drop-label">Drop PDFs or images here</span>
  <span class="drop-or">or</span>
  <button class="browse-btn" type="button">Browse files</button>
</div>`;
}

function dropCompactHTML() {
  return `
<div class="drop-compact">
  ${SVG.uploadSm}
  <span class="drop-label-sm">Drop more files, or</span>
  <button class="browse-btn-sm" type="button">Browse</button>
</div>`;
}

function updateDropZone() {
  const zone = document.getElementById('dropZone');
  if (!zone) return;
  zone.innerHTML = state.files.size > 0 ? dropCompactHTML() : dropFullHTML();
  wireDropZoneBrowse(zone);
}

function wireDropZoneBrowse(zone) {
  const btn = zone.querySelector('.browse-btn, .browse-btn-sm');
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // don't trigger zone's own click handler
      document.getElementById('fileInput').click();
    });
  }
}

// ── Rendering: analyze button ─────────────────────────────────────────────────
function updateAnalyzeBtn() {
  const btn = document.getElementById('analyzeBtn');
  if (!btn) return;
  const entries    = [...state.files.values()];
  const allSettled = entries.length > 0 && entries.every(e => e.phase === 'done' || e.phase === 'error');
  const anyDone    = entries.some(e => e.phase === 'done');

  if (allSettled && anyDone) {
    // All done — morph into dashboard navigation button
    btn.disabled = false;
    btn.textContent = 'View Dashboard →';
    btn.dataset.mode = 'view';
    return;
  }
  btn.dataset.mode = 'analyze';
  btn.textContent  = 'Analyze Documents';
  btn.disabled = !entries.some(e => e.phase === 'ready' && e.docType !== '');
}

// ── Drop error flash ──────────────────────────────────────────────────────────
let _dropErrTimer = null;
function showDropError(msg) {
  document.getElementById('dropError')?.remove();
  clearTimeout(_dropErrTimer);
  const el = document.createElement('p');
  el.className = 'drop-error'; el.id = 'dropError'; el.textContent = msg;
  document.getElementById('dropZone')?.insertAdjacentElement('afterend', el);
  _dropErrTimer = setTimeout(() => document.getElementById('dropError')?.remove(), 4000);
}

// ── Render upload view (called once on init) ──────────────────────────────────
// ── Hormone dosage fields ─────────────────────────────────────────────────────
function doseFieldsHTML(entry) {
  return `
<div class="dose-row">
  <div class="dose-field">
    <span class="dose-label">Test dosage</span>
    <input class="dose-input" type="text" data-action="testdose" data-id="${esc(entry.id)}"
           value="${esc(entry.testDose ?? '')}" placeholder="e.g. 200mg Test Cyp / week" />
  </div>
  <div class="dose-field">
    <span class="dose-label">AI (aromatase inhibitor) dosage</span>
    <input class="dose-input" type="text" data-action="aidose" data-id="${esc(entry.id)}"
           value="${esc(entry.aiDose ?? '')}" placeholder="e.g. 0.5mg Anastrozole / week" />
  </div>
</div>`;
}

// ── Manual entry form ─────────────────────────────────────────────────────────
function manualFormHTML(entry) {
  const fields = MANUAL_FIELDS[entry.docType] ?? MANUAL_FIELDS.blood_work;
  const rows = fields.map((f, i) => `
    <tr>
      <td><input class="mf-name" value="${esc(f.name)}" placeholder="Marker name" /></td>
      <td><input class="mf-val" type="number" step="any" placeholder="Value" /></td>
      <td><input class="mf-unit" value="${esc(f.unit)}" placeholder="Unit" /></td>
      <td><input class="mf-reflow" type="number" step="any" value="${f.refLow ?? ''}" placeholder="—" /></td>
      <td><input class="mf-refhi" type="number" step="any" value="${f.refHigh ?? ''}" placeholder="—" /></td>
    </tr>`).join('');
  return `
    <form class="manual-form" data-action="manual-submit" data-id="${esc(entry.id)}">
      <div class="mf-date-row">
        <label class="mf-label">Lab date</label>
        <input class="mf-date" type="date" required />
      </div>
      <div class="mf-table-wrap">
        <table class="mf-table">
          <thead><tr><th>Marker</th><th>Value</th><th>Unit</th><th>Ref Low</th><th>Ref High</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="mf-actions">
        <button type="button" class="mf-cancel" data-action="manual-cancel" data-id="${esc(entry.id)}">Cancel</button>
        <button type="submit" class="mf-submit">Save results</button>
      </div>
    </form>`;
}

function buildManualResult(form, docType, fileName) {
  const dateVal = form.querySelector('.mf-date')?.value ?? null;
  const rows = [...form.querySelectorAll('tbody tr')];
  const markers = rows.map(row => {
    const name  = row.querySelector('.mf-name')?.value.trim();
    const val   = parseFloat(row.querySelector('.mf-val')?.value);
    const unit  = row.querySelector('.mf-unit')?.value.trim() || null;
    const rl    = parseFloat(row.querySelector('.mf-reflow')?.value);
    const rh    = parseFloat(row.querySelector('.mf-refhi')?.value);
    if (!name || isNaN(val)) return null;
    return { name, value: val, unit, refLow: isNaN(rl) ? null : rl, refHigh: isNaN(rh) ? null : rh, flag: null };
  }).filter(Boolean);
  return {
    documentType: docType, drawDate: dateVal,
    patientName: null, dob: null, address: null, physicianName: null, facilityName: null,
    markers, extractionConfidence: 'medium',
    parseWarnings: ['Values entered manually — not extracted by AI.'],
    sourceFile: fileName,
  };
}

// ── View transition ───────────────────────────────────────────────────────────
function switchView(renderFn) {
  const view = document.getElementById('view');
  view.classList.add('view-exiting');
  setTimeout(() => {
    renderFn();
    view.classList.remove('view-exiting');
    void view.offsetWidth; // force reflow to restart animation
    view.classList.add('view-entering');
    view.addEventListener('animationend', () => view.classList.remove('view-entering'), { once: true });
  }, 180);
}

// ── Sample data loader ────────────────────────────────────────────────────────
function loadSampleData() {
  state.files.clear();
  for (const panel of SAMPLE_PANELS) {
    const id = uid();
    const fakeFile = { name: panel._fileName, size: 0, type: 'application/pdf', lastModified: Date.now() };
    state.files.set(id, {
      id, file: fakeFile, docType: panel.documentType, phase: 'done',
      errorMsg: null, errorPhase: null, text: null, base64: null,
      result: panel, showManual: false,
    });
  }
  switchView(renderDashboard);
}

// ── Privacy confirmation modal ────────────────────────────────────────────────
function showPrivacyConfirmModal() {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box" role="alertdialog" aria-modal="true" aria-labelledby="modal-title">
        <h3 class="modal-title" id="modal-title">Display personal information?</h3>
        <p class="modal-body">Names, dates of birth, addresses, and physician names will become visible in the dashboard and any PDF exports.</p>
        <div class="modal-actions">
          <button class="modal-btn modal-cancel-btn" type="button">Cancel</button>
          <button class="modal-btn modal-confirm-btn" type="button">Show info</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const done = ok => { overlay.remove(); resolve(ok); };
    overlay.querySelector('.modal-cancel-btn').addEventListener('click', () => done(false));
    overlay.querySelector('.modal-confirm-btn').addEventListener('click', () => done(true));
    overlay.addEventListener('click', e => { if (e.target === overlay) done(false); });
    const onKey = e => { if (e.key === 'Escape') { done(false); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
    overlay.querySelector('.modal-confirm-btn').focus();
  });
}

function renderUploadView() {
  document.getElementById('view').innerHTML = `
<section class="upload-view">

  <div class="upload-hero">
    <h1 class="upload-title">Analyze Your Health Documents</h1>
    <p class="upload-subtitle">
      Upload lab reports, DEXA scans, imaging results, and weight logs.<br>
      Analysis runs privately in your browser. Nothing is ever stored.
    </p>
    <button class="sample-btn" id="sampleBtn" type="button">Try with sample data →</button>
  </div>

  <div class="drop-zone" id="dropZone"
       role="button" tabindex="0"
       aria-label="Drop files here or click to browse">
    ${dropFullHTML()}
  </div>

  <div class="file-list" id="fileList"></div>

  <div class="action-row">
    <button class="analyze-btn" id="analyzeBtn" type="button" disabled>
      Analyze Documents
    </button>
  </div>

</section>`;

  wireUploadView();
}

// ── Wire upload view events (called once after render) ────────────────────────
function wireUploadView() {
  const zone      = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const fileList  = document.getElementById('fileList');
  const analyzeBtn= document.getElementById('analyzeBtn');

  // Drop zone: click opens file dialog
  zone.addEventListener('click', () => fileInput.click());
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });

  // Drag and drop
  zone.addEventListener('dragover', (e) => {
    e.preventDefault(); e.stopPropagation();
    zone.classList.add('is-over');
  });
  zone.addEventListener('dragleave', (e) => {
    e.stopPropagation();
    if (!zone.contains(e.relatedTarget)) zone.classList.remove('is-over');
  });
  zone.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    zone.classList.remove('is-over');
    addFiles(Array.from(e.dataTransfer.files));
  });

  // File list: delegated events (remove, retry, doc-type change)
  fileList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;
    if (action === 'remove') {
      state.files.delete(id);
      document.querySelector(`.file-card[data-id="${id}"]`)?.remove();
      updateDropZone();
      updateAnalyzeBtn();
    } else if (action === 'retry') {
      retryFile(id);
    }
  });
  fileList.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-action="doctype"]');
    if (sel) {
      const entry = state.files.get(sel.dataset.id);
      if (entry) entry.docType = sel.value;
      updateAnalyzeBtn();
      updateCard(sel.dataset.id); // re-render to show/hide dose fields
      return;
    }
    const testInput = e.target.closest('[data-action="testdose"]');
    if (testInput) {
      const entry = state.files.get(testInput.dataset.id);
      if (entry) entry.testDose = testInput.value;
      return;
    }
    const aiInput = e.target.closest('[data-action="aidose"]');
    if (aiInput) {
      const entry = state.files.get(aiInput.dataset.id);
      if (entry) entry.aiDose = aiInput.value;
      return;
    }
    const dateInput = e.target.closest('[data-action="setdate"]');
    if (dateInput) {
      const entry = state.files.get(dateInput.dataset.id);
      if (entry?.result) {
        entry.result.drawDate = dateInput.value || null;
        updateCard(dateInput.dataset.id);
        updateAnalyzeBtn();
      }
    }
  });

  // Analyze / View Dashboard button
  analyzeBtn.addEventListener('click', () => {
    if (analyzeBtn.dataset.mode === 'view') {
      switchView(renderDashboard);
      return;
    }
    const toAnalyze = [...state.files.values()].filter(
      e => e.phase === 'ready' && e.docType !== ''
    );
    Promise.all(toAnalyze.map(e => analyzeFile(e.id)));
  });

  // Sample data button
  document.getElementById('sampleBtn')?.addEventListener('click', loadSampleData);

  // Manual form: open, cancel, submit — delegated to fileList
  fileList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="manual"]');
    if (btn) {
      const entry = state.files.get(btn.dataset.id);
      if (entry) { entry.showManual = true; updateCard(btn.dataset.id); }
      return;
    }
    const cancel = e.target.closest('[data-action="manual-cancel"]');
    if (cancel) {
      const entry = state.files.get(cancel.dataset.id);
      if (entry) { entry.showManual = false; updateCard(cancel.dataset.id); }
    }
  });
  fileList.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-action="manual-submit"]');
    if (!form) return;
    e.preventDefault();
    const id    = form.dataset.id;
    const entry = state.files.get(id);
    if (!entry) return;
    const result = buildManualResult(form, entry.docType, entry.file.name);
    Object.assign(entry, { phase: 'done', result, showManual: false, errorMsg: null, errorPhase: null });
    updateCard(id);
    updateAnalyzeBtn();
    checkAllDone();
  });

  // Wire browse button in the initial drop-full state
  wireDropZoneBrowse(zone);
}

// ── Privacy toggle ────────────────────────────────────────────────────────────
function initPrivacyToggle() {
  const btn   = document.getElementById('privacyToggle');
  const icon  = document.getElementById('privacyIcon');
  const label = document.getElementById('privacyLabel');

  icon.innerHTML = SVG.eyeOpen;

  btn.addEventListener('click', async () => {
    if (state.exporting) return; // privacy locked during PDF export
    if (state.privacyMode) {
      // Going from hidden → shown: require explicit confirmation
      const ok = await showPrivacyConfirmModal();
      if (!ok) return;
    }
    state.privacyMode = !state.privacyMode;
    btn.setAttribute('aria-pressed', String(state.privacyMode));
    icon.innerHTML    = state.privacyMode ? SVG.eyeClosed : SVG.eyeOpen;
    label.textContent = state.privacyMode ? 'Info Hidden' : 'Showing Personal Info';
    if (document.querySelector('.dashboard-view')) refreshDashboardPrivacy();
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  // Hidden file input lives on <body> so it survives view re-renders
  const fileInput   = document.createElement('input');
  fileInput.type    = 'file';
  fileInput.id      = 'fileInput';
  fileInput.multiple = true;
  fileInput.accept  = '.pdf,image/*';
  fileInput.style.display = 'none';
  document.body.appendChild(fileInput);

  // Wire fileInput ONCE here — wireUploadView() re-runs on every back/forward
  // transition, so putting this listener there would stack duplicates and cause
  // the "already in list" false-positive on re-upload.
  fileInput.addEventListener('change', () => {
    addFiles(Array.from(fileInput.files));
    fileInput.value = '';
  });

  // Block accidental browser navigation when dropping outside the zone
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop',     (e) => e.preventDefault());

  // ── Global error reporting ────────────────────────────────────────────────
  // Unhandled JS errors are sent to the Worker /log endpoint and streamed
  // in real-time via: cd healthlens-worker && npx wrangler tail
  function sendErrorLog(data) {
    try {
      navigator.sendBeacon(
        `${WORKER_URL}/log`,
        new Blob([JSON.stringify({ ...data, ts: new Date().toISOString() })],
                 { type: 'application/json' })
      );
    } catch (_) { /* never throw from an error handler */ }
  }

  window.onerror = (message, source, line, col, error) => {
    sendErrorLog({ type: 'unhandled-error', message: String(message).slice(0, 500),
      source: String(source ?? '').slice(0, 200), line, col,
      stack: String(error?.stack ?? '').slice(0, 600) });
  };

  window.onunhandledrejection = (e) => {
    sendErrorLog({ type: 'unhandled-rejection',
      message: String(e.reason?.message ?? e.reason ?? '').slice(0, 500),
      stack:   String(e.reason?.stack   ?? '').slice(0, 600) });
  };

  // ── Feedback button + modal ───────────────────────────────────────────────
  function openFeedbackModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="fb-title">
        <h3 class="modal-title" id="fb-title">Send feedback</h3>
        <div class="fb-type-row">
          <label class="fb-type-label"><input type="radio" name="fbType" value="bug" checked> Bug report</label>
          <label class="fb-type-label"><input type="radio" name="fbType" value="suggestion"> Suggestion</label>
        </div>
        <textarea class="fb-text" placeholder="Describe the bug or suggestion in as much detail as you can…" rows="5"></textarea>
        <div class="modal-actions">
          <button class="modal-btn modal-cancel-btn" id="fbCancel" type="button">Cancel</button>
          <button class="modal-btn modal-confirm-btn" id="fbSubmit" type="button">Open in email →</button>
        </div>
        <p class="fb-note">Tapping Send will open your email client. Nothing is sent automatically.</p>
      </div>`;
    document.body.appendChild(overlay);

    const ta = overlay.querySelector('.fb-text');
    ta.focus();

    overlay.querySelector('#fbCancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelector('#fbSubmit').addEventListener('click', () => {
      const type = overlay.querySelector('[name="fbType"]:checked')?.value ?? 'bug';
      const msg  = ta.value.trim();
      if (!msg) { ta.focus(); return; }
      const subject = encodeURIComponent(`HealthLens – ${type === 'bug' ? 'Bug Report' : 'Suggestion'}`);
      const body    = encodeURIComponent(`Type: ${type === 'bug' ? 'Bug' : 'Suggestion'}\n\n${msg}\n\n---\nSent from HealthLens`);
      window.open(`mailto:bugs.healthlens@gmail.com?subject=${subject}&body=${body}`);
      overlay.remove();
    });
  }

  const fab = document.createElement('button');
  fab.className = 'feedback-fab no-print';
  fab.setAttribute('aria-label', 'Send feedback');
  fab.textContent = 'Feedback';
  fab.addEventListener('click', openFeedbackModal);
  document.body.appendChild(fab);

  // ── Keyboard shortcuts: P = privacy, E = export
  document.addEventListener('keydown', (e) => {
    if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
    if (e.key === 'p' || e.key === 'P') document.getElementById('privacyToggle')?.click();
    if ((e.key === 'e' || e.key === 'E') && document.getElementById('exportBtn')) {
      const btn = document.getElementById('exportBtn');
      if (!btn.disabled) btn.click();
    }
  });

  initPrivacyToggle();
  renderUploadView();
}

init();
