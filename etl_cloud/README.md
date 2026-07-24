# etl_cloud

雲端（GCP）執行的 Facebook 匯入腳本放這裡。目前為空 —— 待「Cloud Run Service（方案 A）vs Cloud Run Job（方案 B）」決定後才會填入。

## 與 `etl_local/` 的差異

`etl_local/` 是既有的、在開發者本機跑的檔案導向管線：`BATCH=<folder> node etl_local/**/script.js`，讀寫本機磁碟的 `raw/` 與各階段 `output/`，由後台 `/admin/import`（`src/fb-import/`）以 `child_process.spawn` 串起來。這套維持不動，繼續作為本機工具。

`etl_cloud/` 針對 Cloud Run 的無狀態、磁碟即記憶體、隨時縮到零的執行環境重寫，預期差異：

- **輸入來源**：zip 由前端以 presigned URL 直傳 R2（繞過 Cloud Run 32 MiB 請求上限），腳本從 R2 **串流**讀取，不整包進記憶體。
- **中間產物**：階段之間的 `classified.json` / `merged.json` / media 檔存 R2（例如 `pending-imports/<batch>/`），而非本機磁碟 —— prepare 與 confirm 可能落在不同實例。
- **狀態接力**：續傳 / 取消所需的 `import-state.json` 也存 R2，取代 `etl_local` 目前掃本機 `output/` 的做法。

## 尚未決定

- 執行模型：Cloud Run **Service**（沿用兩請求 + 串流 log）或 Cloud Run **Job**（批次型、適合大檔案與長時間）。
- 見 backend 的匯入設計討論與費用比較。
