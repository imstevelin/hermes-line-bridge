# Hermes LINE Bridge (Reply Mode)

這個專案是 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) 的 LINE 官方帳號橋接器。它能讓您透過 LINE 與強大的 Hermes 助手進行連貫且穩定的對話。

## ✨ 特色
- **10 分鐘長連線**：支援長時間運算的任務（如複雜工具執行、行事曆查詢）。
- **對話連貫性 (Sequential Mode)**：自動處理 LINE 的重複請求，確保對話不跳躍。
- **載入動畫 (Loading Indicator)**：在Hermes思考時，LINE 對話視窗會顯示正在輸入的動畫。
- **自動備援 (Model Fallback)**：建議配合 Hermes 設定，在主要模型過載時自動切換至備用模型。
- **系統級服務**：提供 macOS `launchd` 設定檔，支援開機自動啟動與崩潰自動恢復。

## 🛠️ 安裝步驟

1. **取得代碼與安裝依賴**
   ```bash
   git clone https://github.com/imstevelin/hermes-line-bridge
   cd hermes-line-bridge
   npm install
   ```

2. **配置環境變數**
   複製 `.env.example` 並重新命名為 `.env`，填入您的 LINE 與 Hermes 資訊：
   - `CHANNEL_ACCESS_TOKEN` / `CHANNEL_SECRET` (來自 LINE Developers Console)
   - `HERMES_API_KEY` (與 Hermes Gateway 的 `API_SERVER_KEY` 保持一致)

3. **關鍵：配置 Hermes Gateway (.hermes/.env)**
   為了確保對話不跳躍，您的 Hermes Gateway 必須開啟 Session 持續性：
   ```bash
   # 在 ~/.hermes/.env 中加入：
   API_SERVER_KEY=your_secret_key
   GATEWAY_ALLOW_ALL_USERS=true
   ```

4. **啟動橋接器**
   ```bash
   node index.js
   ```

## 🚀 macOS 自動啟動服務 (LaunchAgents)
如果您希望開機自動執行：
1. 修改 `ai.hermes.bridge.plist` 中的路徑為您的實際路徑。
2. 將檔案複製到 `~/Library/LaunchAgents/`：
   ```bash
   cp ai.hermes.bridge.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/ai.hermes.bridge.plist
   ```

## ⚠️ 注意事項
LINE 的 `replyToken` 在高負載下可能因回覆時間過長而失效。本專案透過 `10 分鐘逾時` 與 `Loading API` 盡可能維持連線。如果連線頻繁中斷，請檢查 MiniMax 伺服器的負載狀況。