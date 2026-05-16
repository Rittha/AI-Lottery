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

  // ---------------- Helpers ----------------
  const $ = (id) => document.getElementById(id);
  const pad = (v, n) => String(v ?? '').padStart(n, '0');

  const DIG6 = /^\d{6}$/;
  const DIG3 = /^\d{3}$/;
  const DIG2 = /^\d{2}$/;

  function setText(id, txt) {
    const el = $(id);
    if (el) el.textContent = txt;
  }

  function localViewerIncrement() {
    const key = 'viewer_count';
    const v = Number(localStorage.getItem(key) || '0') + 1;
    localStorage.setItem(key, String(v));
    setText('viewer', String(v));
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
    localStorage.setItem(key, JSON.stringify(prev.slice(0, 50))); // keep more for accuracy stats
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
      const nums = (item.suggest2 || []).concat(item.suggest3 || []);
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
    setText('drawDateLabel', draws[0]?.date ? `งวดล่าสุด ${draws[0].date}` : 'งวดถัดไป');
  }

  // ---------------- Accuracy evaluation ----------------
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
      if (baseIdx <= 0) continue; // no newer draw yet

      const actual = draws[baseIdx - 1];
      if (!actual) continue;

      evaluable += 1;

      const actual2 = actual.back_2;
      const actual3 = [actual.front_3_1, actual.front_3_2, actual.back_3_1, actual.back_3_2].filter(Boolean);

      const pred2 = Array.isArray(item.suggest2) ? item.suggest2 : [];
      const pred3 = Array.isArray(item.suggest3) ? item.suggest3 : [];

      const hit2 = pred2.includes(actual2) ? [actual2] : [];
      const hit3 = pred3.filter(x => actual3.includes(x));

      const hit = hit2.length > 0 || hit3.length > 0;
      if (hit) hitCount += 1;

      rows.push({
        date: actual.date || '—',
        pred: [...pred2, ...pred3].join(', ') || '—',
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
      detail.innerHTML = `${explain}<div style="margin-top:6px; opacity:.9">ประเมินจากประวัติที่บันทึกบนอุปกรณ์นี้เท่านั้น</div>`;
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

  // ---------------- Main compute ----------------
  function computeAndRender({ mode = 'balanced', personalize = false } = {}) {
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

    // Save prediction (for future accuracy evaluation)
    const time = new Date().toLocaleString();
    saveHistory({ time, mode, seed, baseDate: draws[0]?.date || '', suggest2: s2, suggest3: s3 });
    renderHistory();

    evaluateAccuracy();

    if (note) note.textContent = 'โมเดลสถิติ + ตัวเลขศาสตร์ (เพื่อความบันเทิง)';
  }

  // ---------------- Loading + auto refresh ----------------
  async function loadLocalData() {
    const res = await fetch('lotto.json?ts=' + Date.now(), { cache: 'no-store' });
    const json = await res.json();
    if (!Array.isArray(json)) throw new Error('lotto.json must be an array');

    // normalize & filter invalid rows
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

    draws = cleaned;
  }

  function bindUI() {
    $('btnRefresh')?.addEventListener('click', () => {
      const mode = $('modeInput')?.value || 'balanced';
      computeAndRender({ mode, personalize: false });
    });

    $('btnPersonal')?.addEventListener('click', () => {
      const mode = $('modeInput')?.value || 'balanced';
      computeAndRender({ mode, personalize: true });
    });
  }

  async function refresh() {
    try {
      await loadLocalData();
      updateMeta();
      evaluateAccuracy(); // refresh UI stats even without new prediction
      // Keep last mode for display (no new save)
      const mode = $('modeInput')?.value || 'balanced';
      // Render without saving history
      // Temporarily call computeAndRender with a flag by reusing code without saving
      // We'll duplicate minimal rendering here:
      const stats = buildStats();
      renderTop2Table(topEntries(stats.last2Freq, CONFIG.topN2));
      renderPosTable(stats.posFreq);
      renderDueTable(dueList(stats.last2LastSeen, CONFIG.dueTop));

      const note = $('modelNote');
      if (note) note.textContent = 'โมเดลสถิติ + ตัวเลขศาสตร์ (เพื่อความบันเทิง)';

      // Also render current suggestions (without saving)
      const seed = 0;
      const ranked2 = score2Digit(stats, seed, mode);
      const s2 = ranked2.slice(0, CONFIG.suggest2).map(x => x.n);
      const front3 = score3Digit(stats.front3Freq, seed, mode);
      const back3 = score3Digit(stats.back3Freq, seed, mode);
      const s3 = [front3[0]?.n || '---', back3[0]?.n || '---'].slice(0, CONFIG.suggest3);
      renderLuckyCircles(s2, s3);
      renderSuggest(s2, s3, $('suggestWhy')?.innerHTML || '');

      renderHistory();

    } catch (err) {
      console.error(err);
      const note = $('modelNote');
      if (note) note.textContent = 'โหลดข้อมูลไม่สำเร็จ: ตรวจสอบไฟล์ lotto.json';
    }
  }

  window.addEventListener('load', async () => {
    localViewerIncrement();
    bindUI();
    renderHistory();

    await refresh();

    if (timer) clearInterval(timer);
    timer = setInterval(refresh, CONFIG.refreshMs);
  });
})();
