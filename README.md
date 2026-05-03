# Hermes LINE Bridge & Plugin

本專案提供讓 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) 支援 LINE 官方帳號的兩種解決方案。

請根據您的使用情境，選擇其中一種方案來部署：

## 📁 目錄結構

- `standalone/`：原先獨立運行的 Node.js 版本橋接器。適合不希望更動 Hermes 原生架構，或者希望將 LINE 橋接器與 Hermes 分開部署在不同機器的使用者。
- `plugin/`：全新開發的 Python 原生插件版本。直接掛載於 Hermes Agent 內部，效能最好，無需維護雙服務，完美支援跨平台主動推送與原生的 `/reset` 系統指令。

## ⚠️ 必要核心修復 (Core Patches)

Hermes Agent 原始碼在處理多模態訊息（圖片）與大型請求時存在數個關鍵 Bug。在部署任何方案前，**強烈建議先執行此腳本**以修復後端：

```bash
python3 patch_hermes.py
```

## 🚀 開始使用

請進入您想使用的方案目錄，查看對應的安裝說明：
- [👉 前往獨立 Node.js 橋接器安裝說明](./standalone/README.md)
- [👉 前往原生 Python 插件版安裝說明](./plugin/README.md)
