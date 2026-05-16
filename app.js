// Premium Lottery + Astrology (offline-first)
// Data source: local lotto.json (array of draw objects)
// This is a statistical + numerology scoring model for entertainment.

const CONFIG = {
  topN2: 10,
  dueTop: 12,
  suggest2: 4,
  suggest3: 2,
  recencyWindow: 12, // draws
  smoothing: 1.0
};

let draws = [];

// ---------- Utilities ----------
const pad = (s, n) => String(s).padStart(n, '0');
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function safeText(el, txt) {
  if (el) el.textContent = txt;
}

function sumDigits(str) {
  return String(str).replace(/\D/g, '').split('').reduce((a, c) => a + Number(c), 0);
}

function digitalRoot(n) {
  let x = Math.abs(Number(n) || 0);
  while (x > 9) x = String(x).split('').reduce((a, c) => a + Number(c), 0);
  return x;
}

function numerologySeed({ name, dob, tob }) {
  // Keep deterministic and transparent
  const nameSum = digitalRoot(sumDigits(Array.from(name || '').map(ch => ch.charCodeAt(0)).join('')));
  const dobSum = digitalRoot(sumDigits(dob || ''));
  const tobSum = digitalRoot(sumDigits(tob || ''));
  // Seed 0-9
  return digitalRoot(nameSum + dobSum + tobSum);
}

function localViewerIncrement() {
  const key = 'viewer_count';
  const v = Number(localStorage.getItem(key) || '0') + 1;
  localStorage.setItem(key, String(v));
  const el = document.getElementById('viewer');
  if (el) el.textContent = String(v);
}

function saveHistory(payload) {
  const key = 'prediction_history';
  const prev = JSON.parse(localStorage.getItem(key) || '[]');
  prev.unshift(payload);
  localStorage.setItem(key, JSON.stringify(prev.slice(0, 10)));
}

function renderHistory() {
  const key = 'prediction_history';
  const prev = JSON.parse(localStorage.getItem(key) || '[]');
  const host = document.getElementById('history');
  if (!host) return;

  if (prev.length === 0) {
    host.innerHTML = '<div class="history-item"><div class="history-meta">ยังไม่มีประวัติ</div></div>';
    return;
  }

  host.innerHTML = prev.map(item => {
    const nums = (item.suggest2 || []).concat(item.suggest3 || []);
    const pills = nums.map(n => `<span class="smallpill">${n}</span>`).join('');
    const meta = `
      <div class="history-meta">
        <div>📅 ${item.time}</div>
        <div>โหมด: <b>${item.mode}</b> • seed: <b>${item.seed}</b></div>
      </div>`;
    return `<div class="history-item">${meta}<div class="history-nums">${pills}</div></div>`;
  }).join('');
}

// ---------- Data extraction ----------
function extractNumbers(draw) {
  // Normalize into strings
  const prize1 = pad(draw.prize_1, 6);
  const f31 = pad(draw.front_3_1, 3);
  const f32 = pad(draw.front_3_2, 3);
  const b31 = pad(draw.back_3_1, 3);
  const b32 = pad(draw.back_3_2, 3);
  const b2 = pad(draw.back_2, 2);
  return { prize1, f31, f32, b31, b32, b2 };
}

// ---------- Core statistics ----------
function buildStats() {
  const last2Freq = new Map();
  const last2LastSeen = new Map();

  // position digit freq for prize1 only
  const posFreq = Array.from({ length: 6 }, () => Array(10).fill(0));

  // For 3-digit pools (front/back)
  const front3Freq = new Map();
  const back3Freq = new Map();

  draws.forEach((d, idx) => {
    const { prize1, f31, f32, b31, b32, b2 } = extractNumbers(d);

    // last-2 from official back_2
    last2Freq.set(b2, (last2Freq.get(b2) || 0) + 1);
    last2LastSeen.set(b2, idx);

    // position analysis from prize1 (6 digits)
    for (let p = 0; p < 6; p++) {
      const dig = Number(prize1[p]);
      posFreq[p][dig] += 1;
    }

    // front/back 3-digit
    front3Freq.set(f31, (front3Freq.get(f31) || 0) + 1);
    front3Freq.set(f32, (front3Freq.get(f32) || 0) + 1);
    back3Freq.set(b31, (back3Freq.get(b31) || 0) + 1);
    back3Freq.set(b32, (back3Freq.get(b32) || 0) + 1);
  });

  return { last2Freq, last2LastSeen, posFreq, front3Freq, back3Freq };
}

function topEntries(map, limit) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function dueList(lastSeenMap, totalDraws, limit) {
  // Numbers not present in lastSeenMap are 'never'
  const list = [];
  for (let i = 0; i < 100; i++) {
    const n = String(i).padStart(2, '0');
    if (!lastSeenMap.has(n)) {
      list.push({ n, status: 'ไม่เคยออก', ago: '—' });
    } else {
      const lastIdx = lastSeenMap.get(n);
      const ago = lastIdx; // idx=0 is latest draw in our ordering assumption
      list.push({ n, status: ago >= CONFIG.recencyWindow ? 'ค้างนาน' : 'เคยออก', ago: String(ago) + ' งวดก่อน' });
    }
  }

  // prioritize never, then most overdue
  const score = (x) => (x.status === 'ไม่เคยออก' ? 1e9 : Number(x.ago.split(' ')[0] || 0));
  return list
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit);
}

// ---------- Scoring model ("AI") ----------
function score2Digit({ last2Freq, last2LastSeen }, seed, mode) {
  const total = draws.length;
  const out = [];

  for (let i = 0; i < 100; i++) {
    const n = String(i).padStart(2, '0');
    const f = last2Freq.get(n) || 0;
    const p = (f + CONFIG.smoothing) / (total + 100 * CONFIG.smoothing); // smoothed probability

    const lastIdx = last2LastSeen.has(n) ? last2LastSeen.get(n) : 9999;
    const overdue = clamp((lastIdx - CONFIG.recencyWindow) / CONFIG.recencyWindow, 0, 1);

    // numerology alignment: if digit matches seed
    const align = (Number(n[0]) === seed || Number(n[1]) === seed) ? 1 : 0;

    // mode weights
    const wHot = mode === 'hot' ? 1.15 : 1.0;
    const wDue = mode === 'due' ? 1.15 : 1.0;
    const hotPart = p * wHot;
    const duePart = (mode === 'due' ? overdue : overdue * 0.6) * wDue;

    const score = (hotPart * 100) + (duePart * 8) + (align * 2.5);

    out.push({ n, f, p, lastIdx, overdue, align, score });
  }

  return out.sort((a, b) => b.score - a.score);
}

function score3Digit(freqMap, seed, mode) {
  const total = draws.length * 2; // approx count for 3-digit pool
  const entries = [];
  for (const [n, f] of freqMap.entries()) {
    const p = (f + CONFIG.smoothing) / (total + 1000 * CONFIG.smoothing);
    const align = (n.includes(String(seed))) ? 1 : 0;
    const score = (p * (mode === 'hot' ? 120 : 100)) + (align * 1.8);
    entries.push({ n, f, p, align, score });
  }
  return entries.sort((a, b) => b.score - a.score);
}

// ---------- Rendering ----------
function renderLuckyCircles(suggest2, suggest3) {
  const host = document.getElementById('luckyCircles');
  if (!host) return;

  const items = [
    { v: suggest2[0] || '--', kind: '2d' },
    { v: suggest2[1] || '--', kind: '2d' },
    { v: suggest3[0] || '---', kind: '3d' },
    { v: suggest3[1] || '---', kind: '3d' }
  ];

  host.innerHTML = items.map(x => `<div class="circle" data-kind="${x.kind}">${x.v}</div>`).join('');
}

function renderTop2Table(top2, total) {
  const host = document.getElementById('tblTop2');
  if (!host) return;

  host.innerHTML = top2.map(([n, f], i) => {
    const prob = ((f / total) * 100).toFixed(1) + '%';
    return `<tr><td>${i + 1}</td><td><span class="badge">${n}</span></td><td>${f}</td><td>${prob}</td></tr>`;
  }).join('');
}

function renderPosTable(posFreq) {
  const host = document.getElementById('tblPos');
  if (!host) return;

  const total = draws.length;
  const rows = [];
  const labels = ['แสน', 'หมื่น', 'พัน', 'ร้อย', 'สิบ', 'หน่วย'];

  for (let p = 0; p < 6; p++) {
    const arr = posFreq[p];
    let bestDigit = 0, bestCount = arr[0];
    for (let d = 1; d < 10; d++) {
      if (arr[d] > bestCount) { bestCount = arr[d]; bestDigit = d; }
    }
    const prob = ((bestCount / total) * 100).toFixed(1) + '%';
    rows.push(`<tr><td>${labels[p]}</td><td><span class="badge">${bestDigit}</span></td><td>${bestCount}</td><td>${prob}</td></tr>`);
  }

  host.innerHTML = rows.join('');
}

function renderDueTable(due) {
  const host = document.getElementById('tblDue');
  if (!host) return;

  host.innerHTML = due.map((x, i) => {
    const last = x.status === 'ไม่เคยออก' ? '—' : x.ago;
    return `<tr><td>${i + 1}</td><td><span class="badge">${x.n}</span></td><td>${x.status}</td><td>${last}</td></tr>`;
  }).join('');
}

function renderSuggest(suggest2, suggest3, why) {
  const host = document.getElementById('suggestGrid');
  const whyEl = document.getElementById('suggestWhy');
  if (!host) return;

  const boxes = [
    { n: suggest2[0] || '--', tag: '2 ตัว • แนะนำ 1' },
    { n: suggest2[1] || '--', tag: '2 ตัว • แนะนำ 2' },
    { n: suggest3[0] || '---', tag: '3 ตัว • แนะนำ 1' },
    { n: suggest3[1] || '---', tag: '3 ตัว • แนะนำ 2' },
  ];

  host.innerHTML = boxes.map(b => `
    <div class="suggest-box">
      <div class="suggest-num">${b.n}</div>
      <div class="suggest-tag">${b.tag}</div>
    </div>
  `).join('');

  if (whyEl) whyEl.innerHTML = why;
}

// ---------- Orchestration ----------
function updateMeta() {
  const totalEl = document.getElementById('totalDraws');
  const latestEl = document.getElementById('latestDate');
  const y = document.getElementById('yearNow');
  if (y) y.textContent = String(new Date().getFullYear());

  if (draws.length > 0) {
    safeText(totalEl, String(draws.length));
    safeText(latestEl, draws[0].date || '-');
  }
}

function computeAndRender({ mode = 'balanced', personalize = false } = {}) {
  if (!draws.length) return;

  const name = document.getElementById('nameInput')?.value || '';
  const dob = document.getElementById('dobInput')?.value || '';
  const tob = document.getElementById('tobInput')?.value || '';

  const seed = personalize ? numerologySeed({ name, dob, tob }) : numerologySeed({ name: '', dob: '', tob: '' });

  const stats = buildStats();

  // Top tables
  const top2 = topEntries(stats.last2Freq, CONFIG.topN2);
  renderTop2Table(top2, draws.length);
  renderPosTable(stats.posFreq);

  const due = dueList(stats.last2LastSeen, draws.length, CONFIG.dueTop);
  renderDueTable(due);

  // Suggestions
  const s2 = score2Digit(stats, seed, mode);
  const suggest2 = s2.slice(0, CONFIG.suggest2).map(x => x.n);

  const s3Front = score3Digit(stats.front3Freq, seed, mode);
  const s3Back = score3Digit(stats.back3Freq, seed, mode);
  const suggest3 = [
    (s3Front[0]?.n || '---'),
    (s3Back[0]?.n || '---')
  ].slice(0, CONFIG.suggest3);

  renderLuckyCircles(suggest2, suggest3);

  const why = `
    <b>เหตุผล (โปร่งใส):</b>
    <ul>
      <li>คำนวณจากความถี่เลขท้าย 2 ตัวในอดีต พร้อมปรับค่าแบบ <i>smoothing</i> เพื่อไม่ให้ผล偏ไปที่ตัวอย่างน้อย</li>
      <li>พิจารณา “เลขค้าง” จากจำนวนงวดที่ไม่ปรากฏ และเลือกโหมด <b>${mode}</b> เพื่อปรับน้ำหนัก Hot/Due</li>
      <li>เพิ่มตัวปรับตาม “ตัวเลขศาสตร์” (seed = <b>${seed}</b>) เพื่อทำให้คำแนะนำมีความเป็นส่วนตัว</li>
    </ul>`;

  renderSuggest([suggest2[0], suggest2[1]], suggest3, why);

  // Save history
  const time = new Date().toLocaleString();
  saveHistory({ time, mode, seed, suggest2: [suggest2[0], suggest2[1]], suggest3 });
  renderHistory();

 
}

async function loadLocalData() {
  const res = await fetch('lotto.json', { cache: 'no-store' });
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error('lotto.json must be an array');
  // ensure newest first: assume file already sorted newest -> oldest; if not, keep as is
  draws = json;
}

function bindUI() {
  document.getElementById('btnRefresh')?.addEventListener('click', () => {
    const mode = document.getElementById('modeInput')?.value || 'balanced';
    computeAndRender({ mode, personalize: false });
  });

  document.getElementById('btnPersonal')?.addEventListener('click', () => {
    const mode = document.getElementById('modeInput')?.value || 'balanced';
    computeAndRender({ mode, personalize: true });
  });
}

// ---------- Boot ----------
window.addEventListener('load', async () => {
  try {
    localViewerIncrement();
    bindUI();
    await loadLocalData();
    updateMeta();
    renderHistory();
    computeAndRender({ mode: 'balanced', personalize: false });
  } catch (err) {
    console.error(err);
    const note = document.getElementById('modelNote');
    if (note) note.textContent = 'โหลดข้อมูลไม่สำเร็จ: ตรวจสอบไฟล์ lotto.json';
  }
});
