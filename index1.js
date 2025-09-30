const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const app = express();
const PORT = process.env.PORT || 3000;

// Cache lịch sử (1h)
const historicalDataCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });

// URL API gốc
const SUNWIN_API_URL = 'https://sicbosun-8d67.onrender.com/api/sunwin/sicbo';

// Quản lý lịch sử
class HistoricalDataManager {
    constructor(maxHistoryLength = 500) {
        this.history = [];
        this.maxHistoryLength = maxHistoryLength;
    }

    addSession(newData) {
        if (!newData || !newData.phien) return false;
        if (this.history.some(item => item.phien === newData.phien)) {
            return false;
        }

        this.history.push(newData);
        if (this.history.length > this.maxHistoryLength) {
            this.history = this.history.slice(this.history.length - this.maxHistoryLength);
        }
        this.history.sort((a, b) => a.phien - b.phien);
        return true;
    }

    getHistory() {
        return [...this.history];
    }

    getRecentHistory(count) {
        return this.history.slice(-count);
    }

    calculateFrequency(dataSubset) {
        let taiCount = 0, xiuCount = 0;
        if (!dataSubset || dataSubset.length === 0) {
            return { taiCount: 0, xiuCount: 0, totalCount: 0, taiRatio: 0, xiuRatio: 0 };
        }
        dataSubset.forEach(item => {
            if (item.ket_qua && item.ket_qua.toLowerCase() === 'tài') taiCount++;
            else if (item.ket_qua && item.ket_qua.toLowerCase() === 'xỉu') xiuCount++;
        });
        const totalCount = dataSubset.length;
        return {
            taiCount,
            xiuCount,
            totalCount,
            taiRatio: totalCount > 0 ? taiCount / totalCount : 0,
            xiuRatio: totalCount > 0 ? xiuCount / totalCount : 0
        };
    }

    calculateCurrentSequence(dataSubset, resultType) {
        if (!dataSubset || dataSubset.length === 0) return 0;
        let count = 0;
        const lastResultType = resultType.toLowerCase();
        for (let i = dataSubset.length - 1; i >= 0; i--) {
            if (dataSubset[i].ket_qua && dataSubset[i].ket_qua.toLowerCase() === lastResultType) count++;
            else break;
        }
        return count;
    }
}

// Engine dự đoán
class PredictionEngine {
    constructor(historyMgr) {
        this.historyMgr = historyMgr;
        this.baseWeights = {
            bet: 5.0,
            dao11: 4.5,
            dao22: 4.0,
            dao33: 3.8,
            tyLeApDao: 3.0,
            mauLapLai: 3.5,
            uuTienGanDay: 3.2,
            default: 1.0
        };
    }

    duDoanVi(tong) {
        if (!tong) return [];
        return [
            ((tong % 6) + 10),
            ((tong % 6) + 11),
            ((tong % 6) + 12)
        ];
    }

    predict() {
        const fullHistory = this.historyMgr.getHistory();
        const historyLength = fullHistory.length;

        if (historyLength === 0) {
            return this.buildResult("Chưa xác định", 10, "Không có dữ liệu");
        }

        const recentHistory = this.historyMgr.getRecentHistory(100);
        const lastResult = recentHistory[recentHistory.length - 1].ket_qua;

        if (historyLength === 1) {
            const du_doan = (lastResult.toLowerCase() === 'tài') ? "Xỉu" : "Tài";
            return this.buildResult(du_doan, 30, "địt cmm");
        }

        let predictionScores = { 'Tài': 0, 'Xỉu': 0 };
        let dynamicWeights = { ...this.baseWeights };

        const recent30 = this.historyMgr.getRecentHistory(30);
        const recent10 = this.historyMgr.getRecentHistory(10);
        const recent20 = this.historyMgr.getRecentHistory(20);

        const taiSeq = this.historyMgr.calculateCurrentSequence(recent10, 'Tài');
        const xiuSeq = this.historyMgr.calculateCurrentSequence(recent10, 'Xỉu');
        if (taiSeq >= 4) {
            predictionScores['Xỉu'] += taiSeq * dynamicWeights.bet;
        } else if (xiuSeq >= 4) {
            predictionScores['Tài'] += xiuSeq * dynamicWeights.bet;
        }

        if (this.isAlternating(recent10, 1) && recent10.length >= 6) {
            const nextPred = (lastResult.toLowerCase() === 'tài') ? "Xỉu" : "Tài";
            predictionScores[nextPred] += dynamicWeights.dao11;
        }

        if (this.isAlternating(recent10, 2) && recent10.length >= 8) {
            const nextPred = (lastResult.toLowerCase() === 'tài') ? "Xỉu" : "Tài";
            predictionScores[nextPred] += dynamicWeights.dao22;
        }

        if (this.isAlternating(recent20, 3) && recent20.length >= 12) {
            const nextPred = (lastResult.toLowerCase() === 'tài') ? "Xỉu" : "Tài";
            predictionScores[nextPred] += dynamicWeights.dao33;
        }

        if (recent20.length >= 10) {
            const last5 = recent20.slice(-5).map(r => r.ket_qua).join("");
            const prev5 = recent20.slice(-10, -5).map(r => r.ket_qua).join("");
            if (last5.toLowerCase() === prev5.toLowerCase()) {
                const nextPred = last5.toLowerCase()[0] === 't' ? "Tài" : "Xỉu";
                predictionScores[nextPred] += dynamicWeights.mauLapLai;
            }
        }

        if (recent10.length >= 7) {
            const taiCount = recent10.filter(r => r.ket_qua && r.ket_qua.toLowerCase() === 'tài').length;
            const xiuCount = recent10.filter(r => r.ket_qua && r.ket_qua.toLowerCase() === 'xỉu').length;
            if (taiCount >= 5) {
                predictionScores['Tài'] += dynamicWeights.uuTienGanDay;
            } else if (xiuCount >= 5) {
                predictionScores['Xỉu'] += dynamicWeights.uuTienGanDay;
            }
        }

        if (recent30.length >= 10) {
            const { taiRatio, xiuRatio } = this.historyMgr.calculateFrequency(recent30);
            if (Math.abs(taiRatio - xiuRatio) > 0.3) {
                const nextPred = (taiRatio > xiuRatio) ? "Xỉu" : "Tài";
                predictionScores[nextPred] += (Math.abs(taiRatio - xiuRatio) * 10) * dynamicWeights.tyLeApDao;
            }
        }

        const defaultPrediction = (lastResult.toLowerCase() === 'tài') ? "Xỉu" : "Tài";
        predictionScores[defaultPrediction] += dynamicWeights.default;

        let finalPrediction = predictionScores['Tài'] > predictionScores['Xỉu'] ? 'Tài' : 'Xỉu';
        let finalScore = predictionScores[finalPrediction];
        const totalScore = predictionScores['Tài'] + predictionScores['Xỉu'];
        let confidence = (finalScore / totalScore) * 100;

        confidence = confidence * Math.min(1, historyLength / 100);
        confidence = Math.min(99.99, Math.max(10, confidence));

        return this.buildResult(
            finalPrediction,
            confidence,
            "địt con mẹ mày"
        );
    }

    isAlternating(history, groupSize) {
        if (history.length < groupSize * 2) return false;
        const recent = history.slice(-groupSize * 2);
        return recent.slice(0, groupSize).every(r => r.ket_qua && recent[groupSize].ket_qua && r.ket_qua.toLowerCase() !== recent[groupSize].ket_qua.toLowerCase());
    }

    buildResult(du_doan, do_tin_cay, giai_thich) {
        return { du_doan, do_tin_cay: do_tin_cay.toFixed(2), giai_thich };
    }
}

const historyManager = new HistoricalDataManager(500);
const predictionEngine = new PredictionEngine(historyManager);

// Hàm hỗ trợ gọi API với cơ chế thử lại mạnh mẽ hơn
async function fetchDataWithRetry(url, retries = 5, delay = 2000) {
    try {
        const response = await axios.get(url, { timeout: 10000 });
        return response.data;
    } catch (error) {
        if (error.response && error.response.status === 429 && retries > 0) {
            console.warn(`Đã nhận lỗi 429, đang thử lại sau ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return fetchDataWithRetry(url, retries - 1, delay * 2);
        }
        throw error;
    }
}

// API chính
app.get('/concac/ditme/trdong', async (req, res) => {
    let currentData = null;
    let cachedHistoricalData = historicalDataCache.get("full_history");
    if (cachedHistoricalData) {
        historyManager.history = cachedHistoricalData;
    }

    try {
        const data = await fetchDataWithRetry(SUNWIN_API_URL);
        currentData = data;

        if (currentData && currentData.phien && currentData.ket_qua) {
    const normalizedData = {
        phien: currentData.phien,
        ket_qua: currentData.ket_qua,
        tong: currentData.tong_diem,
        xuc_xac_1: currentData.xuc_xac[0] || 0,
        xuc_xac_2: currentData.xuc_xac[1] || 0,
        xuc_xac_3: currentData.xuc_xac[2] || 0
    };
    historyManager.addSession(normalizedData);
    historicalDataCache.set("full_history", historyManager.getHistory());
        }

        const lastSession = historyManager.getHistory().slice(-1)[0];
        if (!lastSession) {
            return res.json({
                id: "@truongdong1920",
                phien_truoc: null,
                ket_qua: null,
                xuc_xac: [],
                tong: null,
                phien_sau: null,
                du_doan: "Chua xac dinh",
                do_tin_cay: "10.00",
                giai_thich: "Khong co du lieu de du doan."
            });
        }

        const { du_doan, do_tin_cay, giai_thich } = predictionEngine.predict();

        const result = {
            id: "@truongdong1920",
            phien_truoc: lastSession.phien,
            ket_qua: lastSession.ket_qua,
            xuc_xac: [lastSession.xuc_xac_1, lastSession.xuc_xac_2, lastSession.xuc_xac_3],
            tong: lastSession.tong,
            phien_sau: lastSession.phien ? parseInt(lastSession.phien.replace('#', '')) + 1 : null,
            du_doan: du_doan,
            do_tin_cay: do_tin_cay,
            du_doan_vi: predictionEngine.duDoanVi(lastSession.tong),
            giai_thich: giai_thich
        };

        res.json(result);
    } catch (error) {
        console.error("Lỗi API:", error.message);
        res.status(500).json({ error: "API lỗi", chi_tiet: error.message });
    }
});

app.get('/', (req, res) => {
    res.send('CÓ CÁI ĐẦU BUỒI');
});

app.listen(PORT, () => {
    console.log(`Server đang chạy trên cổng ${PORT}`);
});
        
