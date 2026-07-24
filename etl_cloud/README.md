# etl_cloud — 雲端匯入（方案 A：Cloud Run Service + R2 串流）

後台 `/admin/import` 的 Facebook 匯入已全面走雲端路徑（本機開發與 Cloud Run 行為一致）。
管線邏輯整合在 NestJS 應用內（`src/fb-import/`），本資料夾放獨立的維運腳本。

## 流程

```
瀏覽器 ──presigned PUT──▶ R2: pending-imports/<batch>/upload.zip   （上限 ~5 GiB）
   │
   ├─ POST /admin/fb-import/:batch/prepare      （NDJSON 串流 log）
   │    unzip（僅抽 *.json，ranged GET，不下載整包）
   │    → 01_ingest → media_stage（zip 內媒體串流→ media-staging/）
   │    → 02_classify → workspace JSON 存 R2 → state=review
   │
   ├─ 管理員審核分類（關頁可續，GET /pending、GET /:batch/review）
   │
   └─ POST /admin/fb-import/:batch/confirm
        hydrate workspace ← R2 → 03_analyze×3 → 04_format → 05_merge
        → 06_import → publish_media（staging → 正式 key server-side copy
        + DB URI 改寫，取代 utils/upload-to-r2.js）→ 07_trips → 08_geocode
        → state=done → 刪 zip 與 media-staging
```

- 階段腳本（02–08）直接 spawn `etl_local/` 的原始腳本 —— 它們只讀寫幾 MB 的
  JSON（Cloud Run 的 in-memory 檔案系統足夠），媒體從不落地。
- 跨請求狀態全在 R2 `pending-imports/<batch>/`（`state.json`、`workspace/*.json`），
  prepare 與 confirm 落在不同 instance 也沒問題。
- 媒體正式 key = zip 內部路徑（`your_facebook_activity/posts/media/...`），
  與 `utils/upload-to-r2.js` 的既有慣例一致。
- 取消批次 = 刪整個 prefix；每週一 04:00 cron 清 30 天前的完成批次與
  7 天前的孤兒上傳（`FbImportService.sweepStaleBatches`）。

## 首次部署需要做的事

1. **R2 CORS**（一次性 — ✅ 已於 2026-07-24 設定完成，含 localhost 與正式網域）：
   presigned 直傳需要允許前端 origin 的 PUT：
   ```bash
   node --env-file=.env etl_cloud/setup-r2-cors.js https://maramap.vizino.ai
   ```
   （`http://localhost:3000` 會自動包含。）

   ⚠️ 後端 `.env` 的 R2 token 是物件層級權限，跑這支腳本會 Access Denied。
   兩個選擇：改用 Admin Read & Write 的 API token 執行，或直接在
   Cloudflare 儀表板設定：R2 → maramap-assets → Settings → CORS Policy，貼上：
   ```json
   [
     {
       "AllowedOrigins": ["http://localhost:3000", "https://maramap.vizino.ai"],
       "AllowedMethods": ["PUT"],
       "AllowedHeaders": ["content-type"],
       "ExposeHeaders": ["etag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
2. **Cloud Run**：deploy workflow 已加 `--timeout=3600 --memory=1Gi`；
   Dockerfile 已 COPY `etl_local/`（`.dockerignore` 擋掉 raw/output 資料）。
3. Secrets 不變（GEMINI、SUPABASE、USER_ID、R2_* 原本就在 deploy workflow）。

## 與 `etl_local/` 的分工

`etl_local/` 維持原樣，仍可在本機手動執行（`BATCH=<folder> node etl_local/...`），
同時作為雲端管線 spawn 的階段腳本來源。本資料夾只放不進 NestJS 的維運工具：

- `setup-r2-cors.js` — R2 bucket CORS 一次性設定
