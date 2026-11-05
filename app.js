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
    refreshMs: 60000,
    realtimeMinMs: 5000,
    realtimeMaxMs: 30000,
    realtimeBackoffMs: 4000
  };

  let draws = [];
  let timer = null;
  let realtimeTimer = null;
  let pollDelayMs = CONFIG.realtimeMinMs;
  let lastSnapshotKey = '';
  let hasConnectedOnce = false;

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

  function setRealtimeState(text, state) {
    const el = $('realtimeStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('is-live', 'is-reconnecting');
    el.classList.add(state === 'reconnecting' ? 'is-reconnecting' : 'is-live');
  }

  function makeSnapshotKey(nextDraws) {
    return nextDraws.slice(0, 8).map(d => `${d.date}|${d.prize_1}|${d.back_2}`).join('||');
  }

  function flashUpdateGlow() {
    const host = $('luckyCircles');
    if (host) {
      host.classList.remove('update-glow');
      void host.offsetWidth;
      host.classList.add('update-glow');
      window.setTimeout(() => host.classList.remove('update-glow'), 1600);
    }
    const dateLabel = $('drawDateLabel');
    if (dateLabel) {
      dateLabel.classList.remove('update-glow');
      void dateLabel.offsetWidth;
      dateLabel.classList.add('update-glow');
      window.setTimeout(() => dateLabel.classList.remove('update-glow'), 1600);
    }
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

  function renderSuggest(payload) {
    // payload: { s2, s3Front, s3Back, hotNums, dueNums, mixed, why }
    const whyEl = $('suggestWhy');
    if (!payload) return;

    const { s2 = [], s3Front = [], s3Back = [], hotNums = [], dueNums = [], mixed = [], why = '' } = payload;

    // fill the 3-digit panels
    const elF1 = $('recFront3_1'); if (elF1) elF1.textContent = s3Front[0] || '---';
    const elF2 = $('recFront3_2'); if (elF2) elF2.textContent = s3Front[1] || '---';
    const elB1 = $('recBack3_1');  if (elB1) elB1.textContent = s3Back[0] || '---';
    const elB2 = $('recBack3_2');  if (elB2) elB2.textContent = s3Back[1] || '---';

    // fill big suggest table
    const tbl = $('suggestTableBody');
    if (tbl) {
      const rows = [];
      rows.push(`<tr><td>เลขร้อน</td><td>${hotNums.join(', ') || '-'}</td><td>ออกบ่อยที่สุด</td></tr>`);
      rows.push(`<tr><td>เลขเย็น</td><td>${dueNums.join(', ') || '-'}</td><td>ยังไม่เคยออก / ค้างนาน</td></tr>`);
      rows.push(`<tr><td>เลขผสมดี</td><td>${mixed.join(', ') || '-'}</td><td>หลักเด่นผสาน</td></tr>`);
      tbl.innerHTML = rows.join('');
    }

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
    const s3Front = front3.slice(0, CONFIG.suggest3).map(x => x.n);
    const s3Back = back3.slice(0, CONFIG.suggest3).map(x => x.n);
    const s3 = [s3Front[0] || '---', s3Back[0] || '---'];

    renderLuckyCircles(s2, s3);

    const why = `
      <b>เหตุผล (โปร่งใส):</b>
      <ul>
        <li>ใช้ความถี่เลขท้าย 2 ตัวจากข้อมูลย้อนหลัง (<code>back_2</code>) และทำ smoothing เพื่อลดอคติตัวอย่างน้อย</li>
        <li>โหมด <b>${mode}</b> ปรับน้ำหนักระหว่าง Hot (ถี่) และ Due (ค้างนาน)</li>
        <li>ปรับผลเฉพาะบุคคลด้วย Numerology seed = <b>${seed}</b> (เมื่อกดทำนายรายบุคคล)</li>
      </ul>`;

    // build helper lists for UI
    // ✅ HOT = เลขท้าย 2 ตัวความถี่สูง (ตัดเลข freq=0 ออก = ยังไม่เคยออก)
    const hotNums = topEntries(stats.last2Freq, 100)
      .filter(([n, f]) => f > 0)
      .slice(0, 3)
      .map(x => x[0]);

    // ✅ COLD/DUE = เลขท้าย 2 ตัวยังไม่เคยออก + ค้างนาน (ต่างจาก hotNums)
    const dueNums = dueList(stats.last2LastSeen, CONFIG.dueTop)
      .filter(x => x.status !== 'เคยออก' && !hotNums.includes(x.n))
      .slice(0, 3)
      .map(x => x.n);

    // mixed from tens/units position (หลักสิบ=pos 4, หน่วย=pos5)
    const tens = stats.posFreq[4].map((c, d) => ({d, c})).sort((a,b)=>b.c-a.c).slice(0,2).map(x=>x.d);
    const units = stats.posFreq[5].map((c, d) => ({d, c})).sort((a,b)=>b.c-a.c).slice(0,2).map(x=>x.d);
    const mixed = [];
    for (const t of tens) for (const u of units) mixed.push(String(t)+String(u));
    const mixedUnique = Array.from(new Set(mixed)).slice(0,4).map(s=>s.padStart(2,'0'));

    renderSuggest({ s2, s3Front, s3Back, hotNums, dueNums, mixed: mixedUnique, why });

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
    if (!res.ok) throw new Error('Failed to fetch lotto.json');

    const json = await res.json();
    if (!Array.isArray(json)) throw new Error('lotto.json must be an array');

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

    return cleaned;
  }

  async function pollForUpdates() {
    if (realtimeTimer) clearTimeout(realtimeTimer);

    try {
      const latest = await loadLocalData();
      const snapshotKey = makeSnapshotKey(latest);
      const changed = snapshotKey !== lastSnapshotKey;

      if (changed) {
        const previousCount = draws.length;
        draws = latest;
        lastSnapshotKey = snapshotKey;
        pollDelayMs = CONFIG.realtimeMinMs;
        updateMeta();
        fillYearAndPeriods(draws);
        renderHistory();
        flashUpdateGlow();
        setRealtimeState('Live • อัปเดตข้อมูลใหม่แล้ว', 'live');
        const mode = $('modeInput')?.value || 'balanced';
        computeAndRender({ mode, personalize: false, save: false });
        if (previousCount !== latest.length) {
          console.info('Realtime sync: detected new draw data', latest[0]);
        }
      } else {
        pollDelayMs = Math.min(CONFIG.realtimeMaxMs, pollDelayMs + 1000);
        setRealtimeState('Live • รอข้อมูลใหม่', 'live');
      }

      hasConnectedOnce = true;
    } catch (err) {
      console.warn('Realtime sync unavailable, retrying...', err);
      pollDelayMs = Math.min(CONFIG.realtimeMaxMs, pollDelayMs + CONFIG.realtimeBackoffMs);
      setRealtimeState('Reconnecting… กำลังเชื่อมต่อใหม่', 'reconnecting');
    }

    realtimeTimer = window.setTimeout(() => {
      pollForUpdates();
    }, pollDelayMs);
  }

  function initParallax() {
    let raf = null;

    function updateParallax(x, y) {
      const moveX = (x - window.innerWidth / 2) * 0.02;
      const moveY = (y - window.innerHeight / 2) * 0.015;
      document.documentElement.style.setProperty('--parallax-x', `${moveX}px`);
      document.documentElement.style.setProperty('--parallax-y', `${moveY}px`);
    }

    const onMove = (event) => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = null;
        updateParallax(event.clientX, event.clientY);
      });
    };

    const onScroll = () => {
      const scrollY = window.scrollY || window.pageYOffset || 0;
      document.documentElement.style.setProperty('--parallax-y', `${Math.max(-8, Math.min(8, scrollY * 0.02))}px`);
    };

    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
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
      draws = await loadLocalData();
      lastSnapshotKey = makeSnapshotKey(draws);
      updateMeta();
      fillYearAndPeriods(draws);
      renderHistory();
      const mode = $('modeInput')?.value || 'balanced';
      computeAndRender({ mode, personalize: false, save: false });
      setRealtimeState('Live • พร้อมรับอัปเดตแบบเรียลไทม์', 'live');
    } catch (err) {
      console.error(err);
      const note = $('modelNote');
      if (note) note.textContent = 'โหลดข้อมูลไม่สำเร็จ: ตรวจสอบไฟล์ lotto.json';
      setRealtimeState('Reconnecting… กำลังเชื่อมต่อใหม่', 'reconnecting');
    }
  }

  window.addEventListener('load', async () => {
    initParallax();
    bindUI();
    initTicketCheckUI();
    await updateGlobalViewerOncePerSession();
    await refresh();

    if (timer) clearInterval(timer);
    timer = setInterval(refresh, CONFIG.refreshMs);
    if (realtimeTimer) clearTimeout(realtimeTimer);
    pollForUpdates();
  });
})();

const WORKER_BASE = "https://ai-lottery.ritp157.workers.dev";
let checkInputCount = 1;

function parseToISO(dateStr) {
  const s = String(dateStr || "").trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return "";

  let a = parseInt(m[1], 10);
  let b = parseInt(m[2], 10);
  let y = parseInt(m[3], 10);

  if (y >= 2400) y -= 543;

  let day, month;
  if (a > 12) { day = a; month = b; }
  else if (b > 12) { day = b; month = a; }
  else { day = a; month = b; }

  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function buildCheckInputs() {
  const host = document.getElementById("checkInputs");
  if (!host) return;

  const items = [];
  const MAX = 10;
  for (let i = 1; i <= MAX; i++) {
    const visible = i <= checkInputCount;
    items.push(`
      <div class="check-input-wrapper" style="display:${visible ? 'block' : 'none'}">
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

  const periods = (Array.isArray(draws) ? draws : []).map(d => d?.date).filter(Boolean);
  const years = new Set();
  periods.forEach(ds => {
    const m = String(ds).match(/\/(\d{4})$/);
    if (m) years.add(m[1]);
  });

  const yearList = Array.from(years).sort((a, b) => Number(b) - Number(a));
  yearSel.innerHTML = yearList.map(y => `<option value="${y}">${y}</option>`).join("");

  function refreshPeriods() {
    const y = yearSel.value;
    const filtered = periods.filter(ds => String(ds).endsWith("/" + y));
    periodSel.innerHTML = filtered.map(ds => `<option value="${ds}">${ds}</option>`).join("");
  }

  yearSel.onchange = refreshPeriods;
  refreshPeriods();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
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

  if (!nums.length) {
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

  const payload = { number: nums.map(n => ({ lottery_num: n })), period_date: periodISO };
  resultEl.textContent = "⏳ กำลังตรวจผลรางวัล…";

  try {
    const res = await fetch(`${WORKER_BASE}/glo/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { body = null; }

    let html = `<b>✅ ผลการตรวจงวด ${escapeHtml(periodDateStr)} (${escapeHtml(periodISO)})</b>`;

    if (body?.response?.result && Array.isArray(body.response.result)) {
      const statusLabels = { 1: 'ถูกรางวัล', 2: 'ไม่ถูกรางวัล', 3: 'รอตรวจผล', 4: 'รอตรวจผล' };
      const itemsHtml = body.response.result.map(item => {
        const status = item.statusType != null ? statusLabels[item.statusType] || `สถานะ ${item.statusType}` : 'สถานะไม่ระบุ';
        const details = [];
        if (item.date) details.push(`งวด: ${escapeHtml(item.date)}`);
        if (item.number) details.push(`เลขสลาก: ${escapeHtml(item.number)}`);
        details.push(`ผล: ${escapeHtml(status)}`);

        if (Array.isArray(item.status_data) && item.status_data.length > 0) {
          const detailLines = item.status_data.map(data => {
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
  fillYearAndPeriods(draws);

  document.getElementById("btnAddInput")?.addEventListener("click", () => {
    if (checkInputCount >= 10) return;
    checkInputCount += 1;
    buildCheckInputs();
    setTimeout(() => {
      const wrappers = document.querySelectorAll('.check-input-wrapper');
      const idx = checkInputCount - 1;
      const input = wrappers[idx]?.querySelector('.checkNum');
      if (input) input.focus();
    }, 10);
  });

  document.getElementById("btnResetInputs")?.addEventListener("click", () => {
    checkInputCount = 1;
    buildCheckInputs();
    const el = document.getElementById("checkResult");
    if (el) el.textContent = "กรอกเลขสลาก 1-10 หมายเลข (เริ่มแสดง 1 ช่อง) แล้วกด “ตรวจผลรางวัล”";
  });

  document.getElementById("btnCheck")?.addEventListener("click", () => {
    checkTickets(draws);
  });
}
