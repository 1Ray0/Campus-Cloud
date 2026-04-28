# 研究發現記錄

> 建立時間：2026-04-23

## 架構分析

### Backend 分層現狀
- `api/` → `services/` → `repositories/` → `infrastructure/` 邊界已初步建立
- `domain/` 層存在 pve_* 舊版與新版並存問題
- `features/ai/` 目前只有 config.py，屬輕量 feature flag 結構

### 測試現狀
- Backend 有測試的 routes：users, login, ai_api, ai_pve_advisor, vm_request_availability
- Backend 完全無測試：firewall, nat, reverse_proxy, gateway, tunnel, groups, deletion_requests, batch_provision
- Frontend unit test：5 個檔案（groups/api, ai-judge/api, queryClient, resourcePayloads, openApiAuth）
- Frontend E2E：login, signup, settings, items（無業務核心頁面測試）

### 安全現況
- JWT 認證：`/api/v1/login/access-token`（password）+ `/api/v1/login/google`（Google OAuth）
- Rate limit：只在 AI API proxy 有（Redis sliding window）
- Health check：只回 `true`，無依賴檢查
- 無 MFA/2FA
- 無 JWT revocation（無 logout blacklist）

### 網路功能現況
- 防火牆：Proxmox API 為 source of truth，DB 只存 layout
- NAT：HAProxy on Gateway VM，DB 為 source of truth
- Reverse Proxy：Traefik on Gateway VM，DB 為 source of truth
- Tunnel：FRP (frp/frpc)
- Snapshot service 已實作但前端 UI 缺失

### i18n 現況
- 命名空間：auth, common, messages, navigation, resources, resourceDetail, settings, validation, applications, approvals
- **完全缺少**：admin, firewall, groups, aiManagement, reverseProxy, network
- Admin 頁面大量硬寫中文字串（ai-management, gateway, domains 等）

### Frontend SDK 技術債
- 使用 compat.ts + legacy-services.ts 橋接新舊 SDK 格式
- 每次 generate-client 後需手動還原 core/ shim 檔案
- 已記錄於 repo memory

### Async 現況
- WebSocket handlers 已 async
- AI 服務已 async（`async def`）
- DB 全面 sync（SQLModel Session），靠 `asyncio.to_thread()` 過渡
- Redis client 已 async
- Scheduler 仍使用 ThreadPoolExecutor

### Worker 現況
- In-process background worker（`infrastructure/worker/background_tasks.py`）
- 不持久化，重啟遺失任務
- 非 Celery/ARQ 等外部 queue

## 關鍵檔案位置

| 功能 | 關鍵檔案 |
|------|---------|
| 排程協調 | `services/scheduling/coordinator.py` |
| Placement | `services/vm/placement_service.py` |
| 防火牆 | `services/network/firewall_service.py` |
| 快照 | `services/network/snapshot_service.py` |
| 認證 | `services/user/auth_service.py` |
| Rate Limit | `infrastructure/redis/rate_limiter.py` |
| Health Check | `api/routes/utils.py` |
| WebSocket Jobs | `api/websocket/jobs.py` |
| Frontend SDK 橋接 | `frontend/src/client/compat.ts` |
| i18n 設定 | `frontend/src/lib/i18n.ts` |
