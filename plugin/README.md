# Hermes LINE Plugin (Native Adapter)

這是一個專為 Hermes Agent 設計的原生 Python 插件。使用此插件，您可以讓 Hermes Agent 原生支援 LINE 通訊，無需額外執行獨立的 Node.js 服務。

## ✨ 特色
- **零外部依賴**：完全作為 Hermes 的內建平台運行。
- **原生效能**：直接調用 Hermes 的原生記憶體、工具排程 (Cronjob) 及主動推送 API。
- **多模態完美支援**：直接接收並處理 LINE 使用者的圖片及位置資訊。
- **混合回覆**：優先使用免費的 `replyToken`，必要時自動 fallback 為 `pushMessage`。
- **長效動畫**：內建非同步背景任務，支援無縫的「對方正在輸入...」視覺回饋。

## 🛠️ 安裝與啟動

### 1. 安裝插件
將本目錄下的所有檔案（`adapter.py` 與 `plugin.yaml`）拷貝至 Hermes 的插件目錄中：
```bash
mkdir -p ~/.hermes/plugins/line
cp plugin.yaml adapter.py ~/.hermes/plugins/line/
```

### 2. 配置環境變數
使用 Hermes 內建的交互式設定指令來配置您的 LINE 帳號：
```bash
hermes gateway setup
```
在選單中選擇 **LINE**，並依照提示輸入您的 `LINE_CHANNEL_ACCESS_TOKEN` 與 `LINE_CHANNEL_SECRET`。
*(或者您也可以直接修改 `~/.hermes/.env` 加入 `LINE_WEBHOOK_PORT=5003` 等相關參數)*

### 3. 重啟 Gateway
完成設定後，重新啟動 Gateway 服務讓插件生效：
```bash
hermes gateway restart
```

## 📡 Webhook 綁定
啟動後，插件會預設在 `http://0.0.0.0:5003/webhook` 監聽請求。
請將您的對外網域或 ngrok 轉發網址加上 `/webhook`，綁定至 LINE Developers Console 的 Webhook URL 欄位中。
