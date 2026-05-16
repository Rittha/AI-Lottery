const fs = require("fs");

// ✅ Node v18+ ใช้ fetch ได้เลย (ไม่ต้อง node-fetch)
const API_URL = "https://ai-lottery.ritp157.workers.dev/";

async function updateLotto() {
    try {
        const response = await fetch(API_URL);
        const api = await response.json();

        const newDraw = {
            date: api.date || new Date().toLocaleDateString(),
            prize_1: api.first || "000000",
            front_3_1: api.front3_1 || "000",
            front_3_2: api.front3_2 || "000",
            back_3_1: api.back3_1 || "000",
            back_3_2: api.back3_2 || "000",
            back_2: api.last2 || "00"
        };

        let data = [];

        // ✅ โหลดไฟล์เดิม
        if (fs.existsSync("lotto.json")) {
            data = JSON.parse(fs.readFileSync("lotto.json", "utf-8"));
        }

        // ✅ เช็คซ้ำ
        let exists = data.find(d => d.prize_1 === newDraw.prize_1);

        if (!exists) {
            data.unshift(newDraw);
            console.log("✅ เพิ่มงวดใหม่แล้ว");
        } else {
            console.log("⚠️ งวดนี้มีแล้ว");
        }

        fs.writeFileSync("lotto.json", JSON.stringify(data, null, 2));

    } catch (err) {
        console.error("❌ ERROR:", err);
    }
}

updateLotto();