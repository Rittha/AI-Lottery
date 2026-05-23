(() => {
  // Prevent double-init
  if (window.__AI_LOTTERY_APP_LOADED__) return;
  window.__AI_LOTTERY_APP_LOADED__ = true;

  const CONFIG = {
    topN2: 10,
    dueTop: 12,
    suggest2: 2,
    suggest3: 2,
    recencyWindow: 12,
    smoothing: 1.0,
    refreshMs: 60000
  };

  let draws = [];
  let timer = null;

  const $ = (id) => document.getElementById(id);
  const pad = (v, n) => String(v ?? '').padStart(n, '0');

  const DIG6 = /^\d{6}$/;
  const DIG3 = /^\d{3}$/;
  const DIG2 = /^\d{2}$/;

  function setText(id, txt) {
    const el = $(id);
    if (el) el.textContent = txt;
  }

  // ---------------- Global viewer (all users) ----------------
  async function updateGlobalViewerOncePerSession() {
    const VIEW_KEY = 'counted_view_session';
    const viewerEl = $('viewer');

    try {
      if (sessionStorage.getItem(VIEW_KEY) === '1') {
        const res = await fetch('https://ai-lottery.ritp157.workers.dev/stats/get');
        const data = await res.json();
        if (viewerEl && data?.ok) viewerEl.textContent = String(data.total_views);
        return;
      }

      sessionStorage.setItem(VIEW_KEY, '1');
      const res = await fetch('https://ai-lottery.ritp157.workers.dev/stats/view', {
        method: 'POST',
        keepalive: true,
      });
      const data = await res.json();
      if (viewerEl && data?.ok) viewerEl.textContent = String(data.total_views);

    } catch (e) {
      // หาก API นับวิวล้มเหลว ไม่ทำให้หน้าเว็บพัง
      console.log('viewer api error', e);
    }
  }

  // ---------------- Numerology ----------------
  function sumDigits(str) {
    return String(str).replace(/\D/g, '').split('').reduce((a, c) => a + Number(c), 0);
  }

  function digitalRoot(n) {
    let x = Math.abs(Number(n) || 0);
    while (x > 9) x = String(x).split('').reduce((a, c) => a + Number(c), 0);
    return x;
  }

  function numerologySeed({ name, dob, tob }) {
    const nameSum = digitalRoot(sumDigits(Array.from(name || '').map(ch => ch.charCodeAt(0)).join('')));
    const dobSum = digitalRoot(sumDigits(dob || ''));
    const tobSum = digitalRoot(sumDigits(tob || ''));
    return digitalRoot(nameSum + dobSum + tobSum);
  }

  // ---------------- History ----------------
  function saveHistory(payload) {
    const key = 'prediction_history';
    const prev = JSON.parse(localStorage.getItem(key) || '[]');
    prev.unshift(payload);
    localStorage.setItem(key, JSON.stringify(prev.slice(0, 50)));
  }

  function renderHistory() {
    const key = 'prediction_history';
    const prev = JSON.parse(localStorage.getItem(key) || '[]');
    const host = $('history');
    if (!host) return;

    if (!prev.length) {
      host.innerHTML = '<div class="history-item"><div class="history-meta">ยังไม่มีประวัติ</div></div>';
      return;
    }

    host.innerHTML = prev.slice(0, 10).map(item => {
      const nums = (item.luckySet && item.luckySet.length) ? item.luckySet : (item.suggest2 || []).concat(item.suggest3 || []);
      const pills = nums.map(n => `<span class="smallpill">${n}</span>`).join('');
      return `
        <div class="history-item">
          <div class="history-meta">
            <div>📅 ${item.time}</div>
            <div>โหมด: <b>${item.mode}</b> • seed: <b>${item.seed}</b></div>
          </div>
          <div class="history-nums">${pills}</div>
        </div>`;
    }).join('');
  }

  // ---------------- Data normalization ----------------
  function normalizeDraw(d) {
    const out = {
      date: d.date,
      prize_1: pad(d.prize_1, 6),
      front_3_1: pad(d.front_3_1, 3),
      front_3_2: pad(d.front_3_2, 3),
      back_3_1: pad(d.back_3_1, 3),
      back_3_2: pad(d.back_3_2, 3),
      back_2: pad(d.back_2, 2)
    };

    const ok = DIG6.test(out.prize_1) && out.prize_1 !== '000000'
      && DIG3.test(out.front_3_1) && DIG3.test(out.front_3_2)
      && DIG3.test(out.back_3_1) && DIG3.test(out.back_3_2)
      && DIG2.test(out.back_2);

    return ok ? out : null;
  }

  // ---------------- Statistics ----------------
  function buildStats() {
    const last2Freq = new Map();
    const last2LastSeen = new Map();
    const posFreq = Array.from({ length: 6 }, () => Array(10).fill(0));
    const front3Freq = new Map();
    const back3Freq = new Map();

    draws.forEach((d, idx) => {
      last2Freq.set(d.back_2, (last2Freq.get(d.back_2) || 0) + 1);
      last2LastSeen.set(d.back_2, idx);

      for (let p = 0; p < 6; p++) {
        posFreq[p][Number(d.prize_1[p])] += 1;
      }

      front3Freq.set(d.front_3_1, (front3Freq.get(d.front_3_1) || 0) + 1);
      front3Freq.set(d.front_3_2, (front3Freq.get(d.front_3_2) || 0) + 1);
      back3Freq.set(d.back_3_1, (back3Freq.get(d.back_3_1) || 0) + 1);
      back3Freq.set(d.back_3_2, (back3Freq.get(d.back_3_2) || 0) + 1);
    });

    return { last2Freq, last2LastSeen, posFreq, front3Freq, back3Freq };
  }

  function topEntries(map, limit) {
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, limit);
  }

  function dueList(lastSeenMap, limit) {
    const list = [];
    for (let i = 0; i < 100; i++) {
      const n = String(i).padStart(2, '0');
      if (!lastSeenMap.has(n)) list.push({ n, status: 'ไม่เคยออก', ago: Infinity });
      else {
        const lastIdx = lastSeenMap.get(n);
        list.push({ n, status: lastIdx >= CONFIG.recencyWindow ? 'ค้างนาน' : 'เคยออก', ago: lastIdx });
      }
    }
    return list.sort((a, b) => b.ago - a.ago).slice(0, limit);
  }

  // ---------------- Scoring (AI-like) ----------------
  function score2Digit(stats, seed, mode) {
    const { last2Freq, last2LastSeen } = stats;
    const total = draws.length;
    const out = [];

    for (let i = 0; i < 100; i++) {
      const n = String(i).padStart(2, '0');
      const f = last2Freq.get(n) || 0;
      const p = (f + CONFIG.smoothing) / (total + 100 * CONFIG.smoothing);

      const lastIdx = last2LastSeen.has(n) ? last2LastSeen.get(n) : 9999;
      const overdue = Math.max(0, (lastIdx - CONFIG.recencyWindow) / CONFIG.recencyWindow);

      const align = (Number(n[0]) === seed || Number(n[1]) === seed) ? 1 : 0;
      const wHot = mode === 'hot' ? 1.15 : 1.0;
      const wDue = mode === 'due' ? 1.15 : 1.0;

      const score = (p * 100 * wHot) + (overdue * 8 * wDue) + (align * 2.5);
      out.push({ n, f, p, overdue, align, score });
    }

    return out.sort((a, b) => b.score - a.score);
  }

  function score3Digit(freqMap, seed, mode) {
    const total = draws.length * 2;
    const out = [];

    for (const [n, f] of freqMap.entries()) {
      const p = (f + CONFIG.smoothing) / (total + 1000 * CONFIG.smoothing);
      const align = n.includes(String(seed)) ? 1 : 0;
      const score = (p * (mode === 'hot' ? 120 : 100)) + (align * 1.8);
      out.push({ n, f, p, score });
    }

    return out.sort((a, b) => b.score - a.score);
  }

  // ---------------- Render ----------------
  function renderLuckyCircles(s2, s3) {
    const host = $('luckyCircles');
    if (!host) return;
    const items = [
      { v: s2[0] || '--', kind: '2d' },
      { v: s2[1] || '--', kind: '2d' },
      { v: s3[0] || '---', kind: '3d' },
      { v: s3[1] || '---', kind: '3d' },
    ];
    host.innerHTML = items.map(x => `<div class="circle" data-kind="${x.kind}">${x.v}</div>`).join('');
  }

  function renderTop2Table(rows) {
    const host = $('tblTop2');
    if (!host) return;
    host.innerHTML = rows.map(([n, f], i) => {
      const prob = ((f / draws.length) * 100).toFixed(1) + '%';
      return `<tr><td>${i + 1}</td><td><span class="badge">${n}</span></td><td>${f}</td><td>${prob}</td></tr>`;
    }).join('');
  }

  function renderPosTable(posFreq) {
    const host = $('tblPos');
    if (!host) return;
    const labels = ['แสน', 'หมื่น', 'พัน', 'ร้อย', 'สิบ', 'หน่วย'];
    const total = draws.length;

    host.innerHTML = posFreq.map((arr, p) => {
      let bestDigit = 0, bestCount = arr[0];
      for (let d = 1; d < 10; d++) {
        if (arr[d] > bestCount) { bestCount = arr[d]; bestDigit = d; }
      }
      const prob = ((bestCount / total) * 100).toFixed(1) + '%';
      return `<tr><td>${labels[p]}</td><td><span class="badge">${bestDigit}</span></td><td>${bestCount}</td><td>${prob}</td></tr>`;
    }).join('');
  }

  function renderDueTable(due) {
    const host = $('tblDue');
    if (!host) return;
    host.innerHTML = due.map((x, i) => {
      const last = x.ago === Infinity ? '—' : `${x.ago} งวดก่อน`;
      return `<tr><td>${i + 1}</td><td><span class="badge">${x.n}</span></td><td>${x.status}</td><td>${last}</td></tr>`;
    }).join('');
  }

  function renderSuggest(s2, s3, why) {
    const host = $('suggestGrid');
    const whyEl = $('suggestWhy');
    if (!host) return;

    const boxes = [
      { n: s2[0] || '--', tag: '2 ตัว • แนะนำ 1' },
      { n: s2[1] || '--', tag: '2 ตัว • แนะนำ 2' },
      { n: s3[0] || '---', tag: '3 ตัว • แนะนำ 1' },
      { n: s3[1] || '---', tag: '3 ตัว • แนะนำ 2' },
    ];

    host.innerHTML = boxes.map(b => `
      <div class="suggest-box">
        <div class="suggest-num">${b.n}</div>
        <div class="suggest-tag">${b.tag}</div>
      </div>
    `).join('');

    if (whyEl) whyEl.innerHTML = why;
  }

  function updateMeta() {
    setText('totalDraws', String(draws.length));
    setText('latestDate', draws[0]?.date || '-');
    setText('yearNow', String(new Date().getFullYear()));
    setText('drawDateLabel', draws[0]?.date ? `อัพเดทงวดล่าสุด ${draws[0].date}` : 'งวดถัดไป');
  }

  // ---------------- Accuracy (ใช้ ✨ชุดเลขมงคล) ----------------
  function evaluateAccuracy() {
    const key = 'prediction_history';
    const prev = JSON.parse(localStorage.getItem(key) || '[]');

    const indexByDate = new Map();
    draws.forEach((d, idx) => {
      if (d && d.date) indexByDate.set(d.date, idx);
    });

    let evaluable = 0;
    let hitCount = 0;
    const rows = [];

    for (const item of prev) {
      const baseDate = item.baseDate;
      if (!baseDate || !indexByDate.has(baseDate)) continue;

      const baseIdx = indexByDate.get(baseDate);
      if (baseIdx <= 0) continue; // ยังไม่มีงวดใหม่ถัดจาก baseDate

      const actual = draws[baseIdx - 1];
      if (!actual) continue;

      evaluable += 1;

      const actual2 = actual.back_2;
      const actual3 = [actual.front_3_1, actual.front_3_2, actual.back_3_1, actual.back_3_2].filter(Boolean);

      // ✅ ใช้ ✨ชุดเลขมงคลประจำวัน เป็นชุดหลักในการชี้วัด
      const luckySet = Array.isArray(item.luckySet) && item.luckySet.length
        ? item.luckySet
        : (item.suggest2 || []).concat(item.suggest3 || []);

      const hit2 = luckySet.includes(actual2) ? [actual2] : [];
      const hit3 = luckySet.filter(x => actual3.includes(x));

      const hit = hit2.length > 0 || hit3.length > 0;
      if (hit) hitCount += 1;

      rows.push({
        date: actual.date || '—',
        pred: luckySet.join(', ') || '—',
        hit: [...hit2, ...hit3].join(', ') || '—',
        isHit: hit
      });
    }

    const rate = evaluable > 0 ? ((hitCount / evaluable) * 100).toFixed(1) + '%' : '-';
    setText('accuracyRate', rate);
    setText('accuracyCount', String(evaluable));

    const detail = $('accuracyDetails');
    if (detail) {
      const explain = evaluable > 0
        ? `ทายถูก <b>${hitCount}</b> จาก <b>${evaluable}</b> ครั้ง (คิดเป็น <b>${rate}</b>)`
        : 'ยังไม่มีงวดที่ประเมินได้ (ต้องทายก่อน และต้องมีการอัปเดตงวดใหม่เข้ามาใน lotto.json)';
      detail.innerHTML = `${explain}<div style="margin-top:6px; opacity:.9">ชี้วัดจาก ✨ชุดเลขมงคลประจำวัน ที่บันทึกไว้ ณ ตอนทาย (บนอุปกรณ์นี้)</div>`;
    }

    const host = $('tblHits');
    if (host) {
      if (!rows.length) {
        host.innerHTML = '<tr><td colspan="3">ยังไม่มีงวดที่ประเมินได้</td></tr>';
      } else {
        host.innerHTML = rows.slice(0, 12).map(r => {
          const badge = r.isHit ? '✅' : '—';
          return `<tr><td>${badge} ${r.date}</td><td>${r.pred}</td><td>${r.hit}</td></tr>`;
        }).join('');
      }
    }
  }

  // ---------------- Main compute (กดปุ่มเท่านั้นถึงจะบันทึก history) ----------------
  function computeAndRender({ mode = 'balanced', personalize = false, save = false } = {}) {
    const note = $('modelNote');

    if (!draws.length) {
      if (note) note.textContent = 'ไม่พบข้อมูลที่ใช้งานได้ใน lotto.json (ตรวจสอบรูปแบบข้อมูล)';
      return;
    }

    const name = $('nameInput')?.value || '';
    const dob = $('dobInput')?.value || '';
    const tob = $('tobInput')?.value || '';
    const seed = personalize ? numerologySeed({ name, dob, tob }) : 0;

    const stats = buildStats();

    renderTop2Table(topEntries(stats.last2Freq, CONFIG.topN2));
    renderPosTable(stats.posFreq);
    renderDueTable(dueList(stats.last2LastSeen, CONFIG.dueTop));

    const ranked2 = score2Digit(stats, seed, mode);
    const s2 = ranked2.slice(0, CONFIG.suggest2).map(x => x.n);

    const front3 = score3Digit(stats.front3Freq, seed, mode);
    const back3 = score3Digit(stats.back3Freq, seed, mode);
    const s3 = [front3[0]?.n || '---', back3[0]?.n || '---'].slice(0, CONFIG.suggest3);

    renderLuckyCircles(s2, s3);

    const why = `
      <b>เหตุผล (โปร่งใส):</b>
      <ul>
        <li>ใช้ความถี่เลขท้าย 2 ตัวจากข้อมูลย้อนหลัง (<code>back_2</code>) และทำ smoothing เพื่อลดอคติตัวอย่างน้อย</li>
        <li>โหมด <b>${mode}</b> ปรับน้ำหนักระหว่าง Hot (ถี่) และ Due (ค้างนาน)</li>
        <li>ปรับผลเฉพาะบุคคลด้วย Numerology seed = <b>${seed}</b> (เมื่อกดทำนายรายบุคคล)</li>
      </ul>`;

    renderSuggest(s2, s3, why);

    if (save) {
      const time = new Date().toLocaleString();
      const luckySet = [...s2, ...s3]; // ✅ ✨ชุดเลขมงคลประจำวัน
      saveHistory({ time, mode, seed, baseDate: draws[0]?.date || '', suggest2: s2, suggest3: s3, luckySet });
      renderHistory();
    }

    evaluateAccuracy();

    if (note) note.textContent = 'โมเดลสถิติ + ตัวเลขศาสตร์ (เพื่อความบันเทิง)';
  }

  // ---------------- Loading + auto refresh ----------------
  async function loadLocalData() {
    const res = await fetch('lotto.json?ts=' + Date.now(), { cache: 'no-store' });
    const json = await res.json();
    if (!Array.isArray(json)) throw new Error('lotto.json must be an array');

    // normalize & dedupe
    const cleaned = [];
    const seen = new Set();

    for (const row of json) {
      const n = normalizeDraw(row);
      if (!n) continue;
      const key = `${n.date}__${n.prize_1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push(n);
    }

    cleaned.sort((a, b) => {
      const da = new Date(parseToISO(a.date) || '1970-01-01');
      const db = new Date(parseToISO(b.date) || '1970-01-01');
      return db - da;
    });

    draws = cleaned;
  }

  function bindUI() {
    $('btnRefresh')?.addEventListener('click', () => {
      const mode = $('modeInput')?.value || 'balanced';
      computeAndRender({ mode, personalize: false, save: true });
    });

    $('btnPersonal')?.addEventListener('click', () => {
      const mode = $('modeInput')?.value || 'balanced';
      computeAndRender({ mode, personalize: true, save: true });
    });
  }

  async function refresh() {
    try {
      await loadLocalData();
      updateMeta();
      fillYearAndPeriods(draws);
      renderHistory();
      // render current view (ไม่บันทึก history)
      const mode = $('modeInput')?.value || 'balanced';
      computeAndRender({ mode, personalize: false, save: false });
    } catch (err) {
      console.error(err);
      const note = $('modelNote');
      if (note) note.textContent = 'โหลดข้อมูลไม่สำเร็จ: ตรวจสอบไฟล์ lotto.json';
    }
  }

  window.addEventListener('load', async () => {
    bindUI();
    initTicketCheckUI();
    await updateGlobalViewerOncePerSession();
    await refresh();

    if (timer) clearInterval(timer);
    timer = setInterval(refresh, CONFIG.refreshMs);
  });
// ===============================
// ตรวจสลาก (GLO checking) via Worker proxy
// ===============================
// const WORKER_BASE = "https://ai-lottery.ritp157.workers.dev"; // duplicate definition removed

// let checkInputCount = 10; // duplicate definition removed

function parseToISO(dateStr) {
  // รองรับ: "16/05/2569" (พ.ศ.) หรือ "5/16/2026" (ค.ศ.)
  const s = String(dateStr || "").trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return ""; // ถ้า format อื่นให้ค่าว่าง

  let a = parseInt(m[1], 10);
  let b = parseInt(m[2], 10);
  let y = parseInt(m[3], 10);

  // ถ้าปีเป็น พ.ศ. (>=2400) แปลงเป็น ค.ศ.
  if (y >= 2400) y = y - 543;

  // เดาว่าเป็น dd/mm/yyyy แบบไทย ถ้าตัวแรก > 12
  let day, month;
  if (a > 12) { day = a; month = b; }
  else if (b > 12) { day = b; month = a; }  // เผื่อเป็น mm/dd
  else {
    // ถ้าทั้งคู่ <= 12 ให้ถือแบบ dd/mm (ไทย) เป็นหลัก
    day = a; month = b;
  }

  const dd = String(day).padStart(2, "0");
  const mm = String(month).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

function buildCheckInputs() {
  const host = document.getElementById("checkInputs");
  if (!host) return;

  const items = [];
  for (let i = 1; i <= checkInputCount; i++) {
    items.push(`
      <div>
        <label>เลขสลาก ${i}</label>
        <input class="input checkNum" inputmode="numeric" maxlength="6"
               placeholder="กรอกเลขสลาก 6 หลัก" />
      </div>
    `);
  }
  host.innerHTML = items.join("");
}

function fillYearAndPeriods(draws) {
  const yearSel = document.getElementById("checkYear");
  const periodSel = document.getElementById("checkPeriod");
  if (!yearSel || !periodSel) return;

  // สร้าง list งวดจาก lotto.json ของคุณ (ถ้ามี)
  // ใช้ date string ตามในไฟล์ แต่ปีจะดึงจาก string
  const periods = (Array.isArray(draws) ? draws : [])
    .map(d => d?.date)
    .filter(Boolean);

  // สกัด year (พ.ศ.หรือค.ศ.) จากท้าย dd/mm/yyyy
  const years = new Set();
  periods.forEach(ds => {
    const m = String(ds).match(/\/(\d{4})$/);
    if (m) years.add(m[1]);
  });

  const yearList = Array.from(years).sort((a,b)=>Number(b)-Number(a));
  yearSel.innerHTML = yearList.map(y => `<option value="${y}">${y}</option>`).join("");

  // เติม period list ตามปีที่เลือก
  function refreshPeriods() {
    const y = yearSel.value;
    const filtered = periods.filter(ds => String(ds).endsWith("/"+y) || String(ds).includes("/"+y));
    periodSel.innerHTML = filtered.map(ds => `<option value="${ds}">${ds}</option>`).join("");
  }

  yearSel.onchange = refreshPeriods;
  refreshPeriods();
}

async function checkTickets(draws) {
  const resultEl = document.getElementById("checkResult");
  const periodSel = document.getElementById("checkPeriod");
  if (!resultEl || !periodSel) return;

  const periodDateStr = periodSel.value;
  const periodISO = parseToISO(periodDateStr);

  if (!periodISO) {
    resultEl.textContent = "❌ ไม่สามารถแปลงวันที่งวดเป็นรูปแบบ YYYY-MM-DD ได้";
    return;
  }

  // ดึงเลขที่กรอก (สูงสุด 10)
  const inputs = Array.from(document.querySelectorAll(".checkNum"));
  const nums = inputs.map(i => (i.value || "").trim()).filter(v => v.length > 0);

  if (nums.length === 0) {
    resultEl.textContent = "❌ กรุณากรอกเลขสลากอย่างน้อย 1 หมายเลข";
    return;
  }
  if (nums.length > 10) {
    resultEl.textContent = "❌ ใส่ได้สูงสุด 10 หมายเลข";
    return;
  }

  // validate 6 digits
  for (const n of nums) {
    if (!/^\d{6}$/.test(n)) {
      resultEl.textContent = `❌ เลข "${n}" ต้องเป็นตัวเลข 6 หลักเท่านั้น`;
      return;
    }
  }

  // เตรียม payload ตาม API GLO [1](https://ntcth-my.sharepoint.com/personal/rittha_ntcth_onmicrosoft_com/Documents/%E0%B9%84%E0%B8%9F%E0%B8%A5%E0%B9%8C%E0%B8%81%E0%B8%B2%E0%B8%A3%E0%B9%81%E0%B8%8A%E0%B8%97%20Microsoft%20Copilot/app.js)
  const payload = {
    number: nums.map(n => ({ lottery_num: n })),
    period_date: periodISO
  };

  resultEl.textContent = "⏳ กำลังตรวจผลรางวัล…";

  try {
    const res = await fetch(`${WORKER_BASE}/glo/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const text = await res.text();

    // แสดงผลแบบปลอดภัยก่อน (JSON ดิบ) แล้วค่อยปรับ render รายรางวัลทีหลังได้
    resultEl.innerHTML = `
      <b>✅ ผลการตรวจงวด ${periodDateStr} (${periodISO})</b>
      <pre style="white-space:pre-wrap; margin-top:8px">${escapeHtml(text)}</pre>
    `;
  } catch (e) {
    resultEl.textContent = "❌ ตรวจผลไม่ได้ (เช็ค Worker /glo/check และ KV bindings)";
    console.log(e);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function initTicketCheckUI(draws) {
  buildCheckInputs();
  fillYearAndPeriods(draws);

  document.getElementById("btnAddInput")?.addEventListener("click", () => {
    if (checkInputCount >= 10) return;
    checkInputCount += 1;
    buildCheckInputs();
  });

  document.getElementById("btnResetInputs")?.addEventListener("click", () => {
    checkInputCount = 10;
    buildCheckInputs();
    document.getElementById("checkResult").textContent =
      "กรอกเลขสลาก 6 หลักได้สูงสุด 10 หมายเลข แล้วกด “ตรวจผลรางวัล”";
  });

  document.getElementById("btnCheck")?.addEventListener("click", () => {
    checkTickets(draws);
  });
}

// ===============================
// ตรวจสลาก (GLO checking) via Worker proxy
// dropdown ปี/งวด ดึงจาก lotto.json (draws)
// ===============================
const WORKER_BASE = "https://ai-lottery.ritp157.workers.dev";

let checkInputCount = 10;

// แปลง dd/mm/yyyy (พ.ศ./ค.ศ.) หรือ m/d/yyyy -> YYYY-MM-DD
function parseToISO(dateStr) {
  const s = String(dateStr || "").trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return "";

  let a = parseInt(m[1], 10);
  let b = parseInt(m[2], 10);
  let y = parseInt(m[3], 10);

  // ถ้าเป็น พ.ศ. แปลงเป็น ค.ศ.
  if (y >= 2400) y -= 543;

  // เดาว่าเป็น dd/mm ถ้า a>12, หรือถ้า b>12 ให้ถือว่าเป็น mm/dd
  let day, month;
  if (a > 12) { day = a; month = b; }
  else if (b > 12) { day = b; month = a; }
  else { day = a; month = b; }

  return `${y}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}

function buildCheckInputs() {
  const host = document.getElementById("checkInputs");
  if (!host) return;

  const items = [];
  for (let i = 1; i <= checkInputCount; i++) {
    items.push(`
      <div>
        <label>เลขสลาก ${i}</label>
        <input class="input checkNum" inputmode="numeric" maxlength="6"
               placeholder="กรอกเลขสลาก 6 หลัก" />
      </div>
    `);
  }
  host.innerHTML = items.join("");
}

// ดึงปี/งวดจาก draws (มาจาก lotto.json)
function fillYearAndPeriodsFromLotto(draws) {
  const yearSel = document.getElementById("checkYear");
  const periodSel = document.getElementById("checkPeriod");
  if (!yearSel || !periodSel) return;

  const dates = (Array.isArray(draws) ? draws : [])
    .map(d => d?.date)
    .filter(Boolean);

  // สกัดปีจาก pattern dd/mm/yyyy หรือ m/d/yyyy
  const years = new Set();
  dates.forEach(ds => {
    const m = String(ds).match(/\/(\d{4})$/);
    if (m) years.add(m[1]);
  });

  const yearList = Array.from(years).sort((a,b)=>Number(b)-Number(a));
  yearSel.innerHTML = yearList.map(y => `<option value="${y}">${y}</option>`).join("");

  function refreshPeriods() {
    const y = yearSel.value;
    const filtered = dates.filter(ds => String(ds).endsWith("/" + y));
    periodSel.innerHTML = filtered.map(ds => `<option value="${ds}">${ds}</option>`).join("");
  }

  yearSel.onchange = refreshPeriods;
  refreshPeriods();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function checkTickets(draws) {
  const resultEl = document.getElementById("checkResult");
  const periodSel = document.getElementById("checkPeriod");
  if (!resultEl || !periodSel) return;

  const periodDateStr = periodSel.value;
  const periodISO = parseToISO(periodDateStr);

  if (!periodISO) {
    resultEl.textContent = "❌ ไม่สามารถแปลงวันที่งวดเป็น YYYY-MM-DD ได้";
    return;
  }

  const inputs = Array.from(document.querySelectorAll(".checkNum"));
  const nums = inputs.map(i => (i.value || "").trim()).filter(v => v.length > 0);

  if (nums.length === 0) {
    resultEl.textContent = "❌ กรุณากรอกเลขสลากอย่างน้อย 1 หมายเลข";
    return;
  }
  if (nums.length > 10) {
    resultEl.textContent = "❌ ใส่ได้สูงสุด 10 หมายเลข";
    return;
  }

  for (const n of nums) {
    if (!/^\d{6}$/.test(n)) {
      resultEl.textContent = `❌ เลข "${n}" ต้องเป็นตัวเลข 6 หลักเท่านั้น`;
      return;
    }
  }

  // Payload ตาม API GLO [1](https://ntcth-my.sharepoint.com/personal/rittha_ntcth_onmicrosoft_com/Documents/%E0%B9%84%E0%B8%9F%E0%B8%A5%E0%B9%8C%E0%B8%81%E0%B8%B2%E0%B8%A3%E0%B9%81%E0%B8%8A%E0%B8%97%20Microsoft%20Copilot/app.js)
  const payload = {
    number: nums.map(n => ({ lottery_num: n })),
    period_date: periodISO
  };

  resultEl.textContent = "⏳ กำลังตรวจผลรางวัล…";

  try {
    const res = await fetch(`${WORKER_BASE}/glo/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }

    let html = `<b>✅ ผลการตรวจงวด ${escapeHtml(periodDateStr)} (${escapeHtml(periodISO)})</b>`;

    if (body?.response?.result && Array.isArray(body.response.result)) {
      const statusLabels = {
        1: 'ถูกรางวัล',
        2: 'ไม่ถูกรางวัล',
        3: 'รอตรวจผล',
        4: 'รอตรวจผล',
      };

      const itemsHtml = body.response.result.map(item => {
        const status = item.statusType != null
          ? statusLabels[item.statusType] || `สถานะ ${item.statusType}`
          : 'สถานะไม่ระบุ';

        const details = [];
        if (item.date) details.push(`งวด: ${escapeHtml(item.date)}`);
        if (item.number) details.push(`เลขสลาก: ${escapeHtml(item.number)}`);
        details.push(`ผล: ${escapeHtml(status)}`);

        if (Array.isArray(item.status_data) && item.status_data.length > 0) {
          const detailLines = item.status_data.map((data, idx) => {
            const fields = [];
            if (data.prizeName) fields.push(`รางวัล: ${escapeHtml(data.prizeName)}`);
            if (data.rank) fields.push(`อันดับ: ${escapeHtml(String(data.rank))}`);
            if (data.prize) fields.push(`จำนวนเงิน: ${escapeHtml(String(data.prize))}`);
            if (data.status) fields.push(`สถานะ: ${escapeHtml(data.status)}`);
            if (data.detail) fields.push(`รายละเอียด: ${escapeHtml(data.detail)}`);
            return `<div style="margin-left:12px;">${fields.length ? fields.join(' • ') : escapeHtml(JSON.stringify(data))}</div>`;
          }).join('');
          details.push(`ข้อมูลรางวัล:${detailLines}`);
        }

        return `<div class="check-item" style="margin-top:10px;padding:10px;border:1px solid #ddd;border-radius:8px;background:#fff;">${details.join('<br>')}</div>`;
      }).join('');

      html += `<div style="margin-top:10px">${itemsHtml}</div>`;
    } else {
      html += `<pre style="white-space:pre-wrap; margin-top:8px">${escapeHtml(text)}</pre>`;
    }

    resultEl.innerHTML = html;
  } catch (e) {
    resultEl.textContent = "❌ ตรวจผลไม่ได้ (เช็ค Worker /glo/check)";
    console.log(e);
  }
}

function initTicketCheckUI(draws) {
  buildCheckInputs();
  fillYearAndPeriodsFromLotto(draws);

  document.getElementById("btnAddInput")?.addEventListener("click", () => {
    if (checkInputCount >= 10) return;
    checkInputCount += 1;
    buildCheckInputs();
  });

  document.getElementById("btnResetInputs")?.addEventListener("click", () => {
    checkInputCount = 10;
    buildCheckInputs();
    const el = document.getElementById("checkResult");
    if (el) el.textContent = "กรอกเลขสลาก 6 หลักได้สูงสุด 10 หมายเลข แล้วกด “ตรวจผลรางวัล”";
  });

  document.getElementById("btnCheck")?.addEventListener("click", () => {
    checkTickets(draws);
  });
}

})();
