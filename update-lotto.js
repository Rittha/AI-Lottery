// update-lotto.js
// อัปเดต lotto.json ด้วย “งวดล่าสุด” จาก Worker ของคุณ
// - กันข้อมูลปลอม 000000 / 000 / 00
// - กันข้อมูลซ้ำ (date + prize_1)
// - รองรับหลายรูปแบบ JSON (ทั้งแบบ simplified ของ Worker และแบบ raw)
// ใช้กับ Node.js v18+ (มี fetch ในตัว)

const fs = require('fs');

// ✅ ชี้ไปที่ Worker โดเมนเดิม (root "/" ที่คุณให้คืน simplified JSON)
// ถ้าคุณเปลี่ยนให้ root ไม่คืนข้อมูลแล้ว ให้ระบุเป็น "/glo/latest" และแก้ mapping ด้านล่าง
const API_URL = 'https://ai-lottery.ritp157.workers.dev/';
const RAW_DATA_PATHS = {
  date: [
    'raw.response.displayDate',
    'raw.response.data.displayDate',
    'raw.response.data.date',
    'raw.response.date',
    'response.data.displayDate',
    'response.data.date',
    'data.displayDate',
    'data.date',
    'date'
  ],
  prize_1: [
    'raw.response.data.first.number.0.value',
    'raw.response.data.first.number[0].value',
    'raw.response.first.number.0.value',
    'raw.response.first.number[0].value',
    'response.data.first.number.0.value',
    'response.data.first.number[0].value',
    'data.first.number.0.value',
    'data.first.number[0].value',
    'first',
    'prize_1'
  ],
  front_3_1: [
    'raw.response.data.last3f.number.0.value',
    'raw.response.data.last3f.number[0].value',
    'raw.response.last3f.number.0.value',
    'raw.response.last3f.number[0].value',
    'response.data.front3_1',
    'data.front3_1',
    'front3_1',
    'front_3_1'
  ],
  front_3_2: [
    'raw.response.data.last3f.number.1.value',
    'raw.response.data.last3f.number[1].value',
    'raw.response.last3f.number.1.value',
    'raw.response.last3f.number[1].value',
    'response.data.front3_2',
    'data.front3_2',
    'front3_2',
    'front_3_2'
  ],
  back_3_1: [
    'raw.response.data.last3b.number.0.value',
    'raw.response.data.last3b.number[0].value',
    'raw.response.last3b.number.0.value',
    'raw.response.last3b.number[0].value',
    'response.data.back3_1',
    'data.back3_1',
    'back3_1',
    'back_3_1'
  ],
  back_3_2: [
    'raw.response.data.last3b.number.1.value',
    'raw.response.data.last3b.number[1].value',
    'raw.response.last3b.number.1.value',
    'raw.response.last3b.number[1].value',
    'response.data.back3_2',
    'data.back3_2',
    'back3_2',
    'back_3_2'
  ],
  back_2: [
    'raw.response.data.last2.number.0.value',
    'raw.response.data.last2.number[0].value',
    'raw.response.last2.number.0.value',
    'raw.response.last2.number[0].value',
    'response.data.last2',
    'data.last2',
    'data.back_2',
    'last2',
    'back_2'
  ]
};

const DIG6 = /^\d{6}$/;
const DIG3 = /^\d{3}$/;
const DIG2 = /^\d{2}$/;

function pick(obj, paths) {
  for (const p of paths) {
    const parts = p.split('.');
    let cur = obj;
    let ok = true;
    for (const k of parts) {
      // รองรับ index array เช่น front3f.0
      if (cur && Array.isArray(cur) && /^\d+$/.test(k)) {
        cur = cur[Number(k)];
        continue;
      }
      if (cur && Object.prototype.hasOwnProperty.call(cur, k)) {
        cur = cur[k];
      } else {
        ok = false;
        break;
      }
    }
    if (ok && cur != null) return cur;
  }
  return undefined;
}

function parseDateValue(v) {
  if (!v) return undefined;
  if (typeof v === 'string') {
    const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) {
      return `${iso[3]}/${iso[2]}/${String(Number(iso[1]) + 543)}`;
    }
    return v;
  }

  if (typeof v === 'object') {
    const d = String(v.date || v.day || '').padStart(2, '0');
    const m = String(v.month || '').padStart(2, '0');
    let y = String(v.year || v.yearThai || '');
    if (!d || !m || !y) return undefined;
    if (y.length === 4 && Number(y) < 2400) y = String(Number(y) + 543);
    return `${d}/${m}/${y}`;
  }

  return undefined;
}

function norm(v, len) {
  const s = String(v ?? '').replace(/\D/g, '');
  return s.padStart(len, '0').slice(-len);
}

function isValid(draw) {
  return DIG6.test(draw.prize_1) && draw.prize_1 !== '000000'
    && DIG3.test(draw.front_3_1) && DIG3.test(draw.front_3_2)
    && DIG3.test(draw.back_3_1) && DIG3.test(draw.back_3_2)
    && DIG2.test(draw.back_2);
}

function loadJsonFile(path) {
  if (!fs.existsSync(path)) return [];
  try {
    const json = JSON.parse(fs.readFileSync(path, 'utf-8'));
    return Array.isArray(json) ? json : [];
  } catch {
    return [];
  }
}

function saveJsonFile(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

async function updateLotto() {
  try {
    const res = await fetch(API_URL, {
      headers: { 'accept': 'application/json' },
    });

    if (!res.ok) {
      console.log('⚠️ API ไม่พร้อมใช้งาน:', res.status);
      process.exit(0);
    }

    const api = await res.json();

    // รองรับทั้งแบบ Worker simplified และแบบ raw (เผื่อคุณเปลี่ยน endpoint ในอนาคต)
    // สำหรับ Worker simplified ควรมี: date, first, front3_1, front3_2, back3_1, back3_2, last2
    // สำหรับ raw อาจอยู่ใต้ raw.response หรือ raw.response.data

    const date = parseDateValue(pick(api, RAW_DATA_PATHS.date)) || new Date().toLocaleDateString('th-TH');

    const prize_1 = norm(pick(api, RAW_DATA_PATHS.prize_1), 6);
    const front_3_1 = norm(pick(api, RAW_DATA_PATHS.front_3_1), 3);
    const front_3_2 = norm(pick(api, RAW_DATA_PATHS.front_3_2), 3);
    const back_3_1 = norm(pick(api, RAW_DATA_PATHS.back_3_1), 3);
    const back_3_2 = norm(pick(api, RAW_DATA_PATHS.back_3_2), 3);
    const back_2 = norm(pick(api, RAW_DATA_PATHS.back_2), 2);

    const newDraw = { date, prize_1, front_3_1, front_3_2, back_3_1, back_3_2, back_2 };

    // ✅ กันข้อมูลไม่ครบ/ปลอม
    if (!isValid(newDraw)) {
      console.log('⚠️ ได้ข้อมูลไม่ครบ/ไม่ถูกต้อง → ไม่บันทึก (กัน 000000)');
      console.log(newDraw);
      process.exit(0);
    }

    const path = 'lotto.json';
    const data = loadJsonFile(path);

    // ✅ กันซ้ำด้วย date+prize_1 และตัด record เดิมที่ prize_1 = 000000 ออก
    const seen = new Set();
    const out = [];

    const keyNew = `${newDraw.date}__${newDraw.prize_1}`;
    seen.add(keyNew);
    out.push(newDraw);

    for (const d of data) {
      if (!d || typeof d !== 'object') continue;
      if (String(d.prize_1) === '000000') continue; // เคลียร์ของปลอมเดิม
      const k = `${d.date}__${d.prize_1}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(d);
    }

    saveJsonFile(path, out);
    console.log('✅ อัปเดต lotto.json สำเร็จ:', newDraw.date, newDraw.prize_1);

  } catch (err) {
    console.error('❌ ERROR:', err);
    // ทำให้ GitHub Actions ไม่ fail ถ้า API ล่ม
    process.exit(0);
  }
}

updateLotto();
