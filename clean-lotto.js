// clean-lotto.js
// ลบ record ที่ผิด (เช่น prize_1 = 000000) และลบซ้ำ (date+prize_1)
const fs = require('fs');

const path = 'lotto.json';
if (!fs.existsSync(path)) {
  console.log('ไม่พบ lotto.json');
  process.exit(0);
}

const data = JSON.parse(fs.readFileSync(path, 'utf-8'));
if (!Array.isArray(data)) {
  console.log('lotto.json ไม่ใช่ array');
  process.exit(0);
}

const seen = new Set();
const out = [];

for (const d of data) {
  if (!d || typeof d !== 'object') continue;
  if (String(d.prize_1) === '000000') continue;
  const key = `${d.date}__${d.prize_1}`;
  if (seen.has(key)) continue;
  seen.add(key);
  out.push(d);
}

fs.writeFileSync(path, JSON.stringify(out, null, 2));
console.log('✅ cleaned:', out.length, 'records');
