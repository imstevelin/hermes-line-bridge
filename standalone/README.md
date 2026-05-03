# Hermes LINE Bridge (Enhanced Hybrid Mode)

這個專案是 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) 的 LINE 官方帳號橋接器。它整合了**混合回覆機制**、**長效視覺回饋**與**主動推送 API**，提供目前最穩定且具備韌性的對話體驗。

## ✨ 特色
- **15 分鐘長效動畫**：克服 LINE 60 秒動畫限制，透過自動續期機制提供長達 15 分鐘的「對方正在輸入...」視覺回饋。
- **混合回覆 (Hybrid Response)**：優先使用免費的 `replyToken`，若處理超時（如複雜工具執行）則自動切換為 `pushMessage`。
- **異步補發與持久化**：若 Push API 也失敗，訊息會存入持久化佇列，在下一次互動時自動打包補發，絕不遺失任何回覆。
- **10 分鐘自動安撫**：針對極慢任務（如備援 API 緩慢），系統會在 10 分鐘時主動傳送進度提示，降低使用者焦慮。
- **對話壓縮自動對齊**：完美銜接 Hermes 的記憶壓縮機制，一旦後端重置 Session，Bridge 會自動同步歷史邊界，避免對話回溯。
- **主動推送 (Proactive Push)**：開放 API 接口，允許 Hermes Agent 主動發起對話或 Cron Job 通知。
- **macOS 自動化**：支援 `launchd` 配置，實現開機自啟與崩潰自動恢復。

## 🕹️ 可用指令
直接在 LINE 對話視窗輸入以下指令：

| 指令 | 功能說明 |
|------|---------|
| `/new` | **重置對話**。立即清空本地與後端的對話歷史，開啟全新的會話紀錄。 |
| `/help` 或 `說明` | **顯示說明**。列出目前 Bridge 支援的所有功能與指令。 |

## 🛠️ 安裝與更新

1. **取得代碼與安裝依賴**
   ```bash
   git clone https://github.com/imstevelin/hermes-line-bridge
   cd hermes-line-bridge/standalone
   npm install
   ```

2. **核心修復補丁 (重要)**
   Hermes Agent 原始碼在處理多模態訊息（圖片）與大型請求時存在數個關鍵 Bug。**必須執行此腳本**以修復後端，否則 AI 將無法記憶圖片或傳送大檔案：
   ```bash
   python3 ../patch_hermes.py
   ```

3. **配置環境變數**
   編輯 `.env` 填入您的 `CHANNEL_ACCESS_TOKEN`、`CHANNEL_SECRET` 與 `HERMES_API_KEY`。

4. **啟動橋接器**
   ```bash
   node index.js
   ```

## 📡 接口說明
- `POST /webhook`：供 LINE Developers Console 綁定的端點。
- `POST /push`：供 Hermes Agent 或 Cron Job 調用的主動推送接口。

---
Powered by [Hermes Agent](https://github.com/NousResearch/hermes-agent)
