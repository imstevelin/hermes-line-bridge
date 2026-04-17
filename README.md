# Hermes LINE Bridge (Hybrid Mode)

這個專案是 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) 的 LINE 官方帳號橋接器。它整合了**混合回覆機制**與**主動推送 API**，提供目前最穩定的對話體驗。

## ✨ 特色
- **混合回覆 (Hybrid Response)**：優先使用 `replyToken`，若超時則自動切換為 `pushMessage`，確保 100% 訊息送達。
- **主動推送 (Proactive Push)**：開放 API 接口，允許 Hermes Agent 主動發起對話。
- **對話連貫性 (Sequential Mode)**：自動處理 LINE 重複請求，精確隔離不同使用者的對話脈絡。
- **載入動畫 (Loading Indicator)**：思考時自動顯示 LINE 正在輸入的動畫。
- **macOS 自動化**：支援 `launchd` 開機自啟與崩潰恢復。

## 🧠 讓 Hermes Agent 學習 LINE 技能（重要！）
為了讓 Hermes 知道如何與此橋接器深度互動（例如主動推送通知），**您必須執行以下操作：**

1. 找到資料夾中的 `hermes-need-read.md`。
2. 將該文件的內容複製並貼給您的 Hermes Agent（或作為 Session Context 餵入）。
3. Hermes 學習後，將具備在執行 Cron Job 或耗時任務後，主動發送 LINE 訊息給您的能力。

## 🛠️ 安裝步驟

1. **取得代碼與安裝依賴**
   ```bash
   git clone https://github.com/imstevelin/hermes-line-bridge
   cd hermes-line-bridge
   npm install
   ```

2. **配置環境變數**
   複製 `.env.example` 為 `.env`，填入：
   - `CHANNEL_ACCESS_TOKEN` / `CHANNEL_SECRET`
   - `HERMES_API_KEY` (需與大腦端的 `API_SERVER_KEY` 一致)

3. **配置 Hermes Gateway**
   在 `~/.hermes/.env` 中確保包含：
   ```bash
   API_SERVER_KEY=your_secret_key
   GATEWAY_ALLOW_ALL_USERS=true
   ```

4. **啟動橋接器**
   ```bash
   node index.js
   ```

## 📡 API 接口
- `POST /webhook`：供 LINE Developers Console 綁定的 Webhook。
- `POST /push`：供 Hermes Agent 調用的主動推送接口。

---
Powered by [Hermes Agent](https://github.com/NousResearch/hermes-agent)
