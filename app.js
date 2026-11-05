(() => {
  "use strict";

  const CONFIG = Object.freeze({
    historyKey: "prediction_history",
    historyLimit: 20,
    topFrequency: 10,
    topDue: 10,
    topSuggestions: 6,
    recentHalfLife: 10,
    smoothing: 1
  });

  const $ = (id) => document.getElementById(id);
  const pad = (value, length) => String(value ?? "").padStart(length, "0");
  const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);

  let draws = [];
  let latestStats = null;
  let latestRanking = [];

  function parseLotteryDate(value) {
    const match = String(value ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!match) return null;
    const day = Number(match[1]);
    const month = Number(match[2]);
    let year = Number(match[3]);
    if (year >= 2400) year -= 543;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return date;
  }

  function normalizeDraw(row) {
    if (!row || typeof row !== "object") return null;
    const normalized = {
      date: String(row.date ?? "").trim(),
      prize_1: pad(row.prize_1, 6),
      front_3_1: pad(row.front_3_1, 3),
      front_3_2: pad(row.front_3_2, 3),
      back_3_1: pad(row.back_3_1, 3),
      back_3_2: pad(row.back_3_2, 3),
      back_2: pad(row.back_2, 2)
    };

    const validDate = parseLotteryDate(normalized.date);
    const validNumbers =
      /^\d{6}$/.test(normalized.prize_1) &&
      ["front_3_1", "front_3_2", "back_3_1", "back_3_2"].every((key) => /^\d{3}$/.test(normalized[key])) &&
      /^\d{2}$/.test(normalized.back_2);

    return validDate && validNumbers ? { ...normalized, timestamp: validDate.getTime() } : null;
  }

  async function loadDraws() {
    const response = await fetch(`lotto.json?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`โหลด lotto.json ไม่สำเร็จ (${response.status})`);
    const raw = await response.json();
    if (!Array.isArray(raw)) throw new Error("รูปแบบ lotto.json ต้องเป็น Array");

    const unique = new Map();
    raw.forEach((row) => {
      const item = normalizeDraw(row);
      if (item) unique.set(`${item.date}|${item.prize_1}|${item.back_2}`, item);
    });

    return [...unique.values()].sort((a, b) => b.timestamp - a.timestamp);
  }

  function minMax(values) {
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) return values.map(() => 0.5);
    return values.map((value) => (value - min) / (max - min));
  }

  function buildStats(source) {
    const frequency = Array(100).fill(0);
    const lastSeen = Array(100).fill(-1);
    const recentWeight = Array(100).fill(0);
    const tens = Array(10).fill(0);
    const units = Array(10).fill(0);
    const threeDigitFrequency = new Map();

    source.forEach((draw, index) => {
      const number = Number(draw.back_2);
      frequency[number] += 1;
      if (lastSeen[number] === -1) lastSeen[number] = index;
      const weight = Math.pow(0.5, index / CONFIG.recentHalfLife);
      recentWeight[number] += weight;
      tens[Number(draw.back_2[0])] += 1;
      units[Number(draw.back_2[1])] += 1;

      [draw.front_3_1, draw.front_3_2, draw.back_3_1, draw.back_3_2].forEach((value) => {
        threeDigitFrequency.set(value, (threeDigitFrequency.get(value) || 0) + 1);
      });
    });

    return { frequency, lastSeen, recentWeight, tens, units, threeDigitFrequency, total: source.length };
  }

  function getWeights(mode) {
    if (mode === "hot") return { frequency: 0.45, recent: 0.35, position: 0.15, gap: 0.05 };
    if (mode === "due") return { frequency: 0.15, recent: 0.10, position: 0.20, gap: 0.55 };
    return { frequency: 0.35, recent: 0.30, position: 0.20, gap: 0.15 };
  }

  function scoreNumbers(stats, mode, seed = 0) {
    const frequencyScale = minMax(stats.frequency);
    const recentScale = minMax(stats.recentWeight);
    const tensScale = minMax(stats.tens);
    const unitsScale = minMax(stats.units);
    const gaps = stats.lastSeen.map((index) => index < 0 ? stats.total : index);
    const gapScale = minMax(gaps);
    const weights = getWeights(mode);

    return Array.from({ length: 100 }, (_, number) => {
      const tensDigit = Math.floor(number / 10);
      const unitsDigit = number % 10;
      const position = (tensScale[tensDigit] + unitsScale[unitsDigit]) / 2;
      const aligned = seed > 0 && (tensDigit === seed || unitsDigit === seed) ? 1 : 0;
      const raw =
        frequencyScale[number] * weights.frequency +
        recentScale[number] * weights.recent +
        position * weights.position +
        gapScale[number] * weights.gap;
      // Numerology is a small tie-break style adjustment, never the statistical core.
      const score = Math.min(100, Math.max(0, (raw + aligned * 0.025) * 100));
      return {
        number: pad(number, 2),
        count: stats.frequency[number],
        gap: gaps[number],
        neverSeen: stats.lastSeen[number] < 0,
        frequencyPart: frequencyScale[number],
        recentPart: recentScale[number],
        positionPart: position,
        gapPart: gapScale[number],
        score
      };
    }).sort((a, b) => b.score - a.score || b.count - a.count || a.number.localeCompare(b.number));
  }

  function getNumerologySeed(name, dob, tob) {
    const digits = `${dob}${tob}`.replace(/\D/g, "");
    const dateSum = [...digits].reduce((sum, digit) => sum + Number(digit), 0);
    const nameSum = [...String(name || "")].reduce((sum, char) => sum + char.codePointAt(0), 0);
    let value = dateSum + nameSum;
    while (value > 9) value = [...String(value)].reduce((sum, digit) => sum + Number(digit), 0);
    return value;
  }

  function safeReadHistory() {
    try {
      const value = JSON.parse(localStorage.getItem(CONFIG.historyKey) || "[]");
      return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
    } catch {
      return [];
    }
  }

  function saveHistory(record) {
    try {
      const previous = safeReadHistory();
      previous.unshift(record);
      localStorage.setItem(CONFIG.historyKey, JSON.stringify(previous.slice(0, CONFIG.historyLimit)));
    } catch (error) {
      console.warn("ไม่สามารถบันทึกประวัติในอุปกรณ์นี้ได้", error);
    }
  }

  function renderHistory() {
    const host = $("history");
    if (!host) return;
    const records = safeReadHistory().slice(0, 8);
    if (!records.length) {
      host.innerHTML = '<div class="empty-state">ยังไม่มีประวัติการวิเคราะห์</div>';
      return;
    }
    host.innerHTML = records.map((item) => {
      const picks = Array.isArray(item.picks) ? item.picks : [];
      return `<article class="history-item">
        <div><strong>${escapeHTML(item.time || "—")}</strong><small>โหมด ${escapeHTML(item.modeLabel || item.mode || "สมดุล")}${item.seed ? ` · เลขศาสตร์ ${escapeHTML(item.seed)}` : ""}</small></div>
        <div class="history-picks">${picks.map((number) => `<span>${escapeHTML(number)}</span>`).join("")}</div>
      </article>`;
    }).join("");
  }

  function renderLuckyNumbers(ranking, stats) {
    const host = $("luckyCircles");
    if (host) {
      host.innerHTML = ranking.slice(0, 3).map((item, index) =>
        `<span class="circle ${index === 0 ? "circle-primary" : ""}">${item.number}</span>`
      ).join("");
    }
    const three = $("threeDigitPicks");
    if (three) {
      const top3 = [...stats.threeDigitFrequency.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 3);
      three.innerHTML = top3.length
        ? top3.map(([number]) => `<span class="three-pill">${escapeHTML(number)}</span>`).join("")
        : "—";
    }
  }

  function renderTables(stats, ranking) {
    const total = Math.max(1, stats.total);
    const topHost = $("tblTop2");
    if (topHost) {
      topHost.innerHTML = stats.frequency
        .map((count, number) => ({ number: pad(number, 2), count }))
        .sort((a, b) => b.count - a.count || a.number.localeCompare(b.number))
        .slice(0, CONFIG.topFrequency)
        .map((item, index) => `<tr><td>${index + 1}</td><td><span class="number-tag">${item.number}</span></td><td>${item.count}</td><td>${(item.count / total * 100).toFixed(1)}%</td></tr>`)
        .join("");
    }

    const posHost = $("tblPos");
    if (posHost) {
      const rows = [
        { label: "หลักสิบ", values: stats.tens },
        { label: "หลักหน่วย", values: stats.units }
      ];
      posHost.innerHTML = rows.map((row) => {
        const best = Math.max(...row.values);
        const digits = row.values.map((count, digit) => ({ digit, count })).filter((item) => item.count === best);
        return digits.map((item) => `<tr><td>${row.label}</td><td><span class="number-tag">${item.digit}</span></td><td>${item.count}</td><td>${(item.count / total * 100).toFixed(1)}%</td></tr>`).join("");
      }).join("");
    }

    const dueHost = $("tblDue");
    if (dueHost) {
      const due = ranking.slice().sort((a, b) => b.gap - a.gap || a.number.localeCompare(b.number)).slice(0, CONFIG.topDue);
      dueHost.innerHTML = due.map((item, index) => `<tr><td>${index + 1}</td><td><span class="number-tag">${item.number}</span></td><td>${item.neverSeen ? "ไม่พบในข้อมูล" : "เคยปรากฏ"}</td><td>${item.neverSeen ? "—" : `${item.gap} งวด`}</td></tr>`).join("");
    }
  }

  function renderSummary(stats, ranking) {
    const hot = stats.frequency.map((count, number) => ({ count, number: pad(number, 2) }))
      .sort((a, b) => b.count - a.count || a.number.localeCompare(b.number))[0];
    const missing = stats.frequency.filter((count) => count === 0).length;
    if ($("statHot")) $("statHot").textContent = hot && hot.count ? hot.number : "—";
    if ($("statHotCount")) $("statHotCount").textContent = hot && hot.count ? `พบ ${hot.count} ครั้ง` : "ยังไม่มีข้อมูล";
    if ($("statMissing")) $("statMissing").textContent = String(missing);
    if ($("statDraws")) $("statDraws").textContent = String(stats.total);
    if ($("rankDetails")) {
      $("rankDetails").innerHTML = ranking.slice(0, 5).map((item, index) =>
        `<div class="rank-row"><span class="rank-index">${index + 1}</span><strong>${item.number}</strong><div class="score-track"><i style="width:${item.score.toFixed(1)}%"></i></div><span class="score-value">${item.score.toFixed(1)}</span></div>`
      ).join("");
    }
  }

  function renderSuggestions(ranking, mode, seed) {
    const host = $("suggestGrid");
    if (!host) return;
    host.innerHTML = ranking.slice(0, CONFIG.topSuggestions).map((item, index) =>
      `<div class="suggest-item"><span class="suggest-rank">อันดับ ${index + 1}</span><strong>${item.number}</strong><span>คะแนน ${item.score.toFixed(1)}/100</span></div>`
    ).join("");

    const modeNames = { balanced: "สมดุล", hot: "แนวโน้มและความถี่", due: "ระยะห่าง" };
    const note = $("suggestWhy");
    if (note) {
      note.textContent = `โหมด${modeNames[mode] || "สมดุล"} ใช้ความถี่ แนวโน้มย้อนหลัง ${CONFIG.recentHalfLife} งวด ตำแหน่งหลักสิบ/หน่วย และระยะห่างจากการปรากฏล่าสุด${seed ? ` พร้อมตัวเลขศาสตร์ส่วนบุคคล (ค่า ${seed}) เป็นตัวเสริม` : ""} คะแนนเป็นเพียงอันดับเปรียบเทียบ ไม่ใช่โอกาสถูกรางวัล`;
    }
  }

  function updateMeta() {
    if ($("totalDraws")) $("totalDraws").textContent = String(draws.length);
    if ($("latestDate")) $("latestDate").textContent = draws[0]?.date || "—";
    if ($("drawDateLabel")) $("drawDateLabel").textContent = draws[0]?.date || "—";
    if ($("yearNow")) $("yearNow").textContent = String(new Date().getFullYear());
  }

  function calculate({ personal = false, save = false } = {}) {
    if (!draws.length) return;
    const mode = $("modeInput")?.value || "balanced";
    const name = $("nameInput")?.value.trim() || "";
    const dob = $("dobInput")?.value || "";
    const tob = $("tobInput")?.value || "";
    if (personal && !dob) {
      if ($("personalFeedback")) $("personalFeedback").textContent = "กรุณาระบุวันเกิดก่อนวิเคราะห์";
      $("dobInput")?.focus();
      return;
    }

    const seed = personal ? getNumerologySeed(name, dob, tob) : 0;
    const stats = buildStats(draws);
    const ranking = scoreNumbers(stats, mode, seed);
    latestStats = stats;
    latestRanking = ranking;

    renderLuckyNumbers(ranking, stats);
    renderTables(stats, ranking);
    renderSummary(stats, ranking);
    renderSuggestions(ranking, mode, seed);
    if ($("modelNote")) $("modelNote").textContent = `พร้อมวิเคราะห์ · ${draws.length} งวด`;

    if (save) {
      const modeLabel = { balanced: "สมดุล", hot: "แนวโน้มและความถี่", due: "ระยะห่าง" }[mode] || "สมดุล";
      saveHistory({
        time: new Date().toLocaleString("th-TH"),
        mode,
        modeLabel,
        seed,
        baseDate: draws[0]?.date || "",
        picks: ranking.slice(0, CONFIG.topSuggestions).map((item) => item.number)
      });
      renderHistory();
    }
    if ($("personalFeedback")) {
      $("personalFeedback").textContent = personal
        ? "คำนวณเสร็จแล้ว · ผลลัพธ์ถูกบันทึกในประวัติบนอุปกรณ์นี้"
        : "";
    }
  }

  async function initialize() {
    if ($("yearNow")) $("yearNow").textContent = String(new Date().getFullYear());
    $("btnRefresh")?.addEventListener("click", () => calculate({ save: true }));
    $("btnPersonal")?.addEventListener("click", () => calculate({ personal: true, save: true }));
    $("modeInput")?.addEventListener("change", () => calculate({ save: false }));
    renderHistory();

    try {
      draws = await loadDraws();
      updateMeta();
      if (!draws.length) throw new Error("ไม่พบข้อมูลที่ถูกต้องใน lotto.json");
      calculate({ save: false });
    } catch (error) {
      console.error(error);
      if ($("modelNote")) $("modelNote").textContent = "โหลดข้อมูลไม่สำเร็จ";
      if ($("luckyCircles")) $("luckyCircles").innerHTML = `<span class="empty-state">${escapeHTML(error.message)}</span>`;
    }
  }

  document.addEventListener("DOMContentLoaded", initialize);
})();
