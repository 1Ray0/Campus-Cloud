# PVE Resource Simulator Allocation Logic

## 目的

這份文件說明目前 `pve_ resource_simulator` 的實際放置與計算方式，內容以現在程式行為為準，不是早期設計稿。

目前這版 simulator 的核心目標是：

- 以目前叢集狀態為起點做 placement 模擬
- 用同規格 VM 的歷史資料估算「有效需求」
- 用 weighted dominant share 挑選最不容易失衡的 node
- 在必要時嘗試小範圍 rebalance，而不是直接宣告放不下

## 資料來源

模擬器有兩種常見輸入來源：

1. 使用者直接輸入 servers 與 VM templates
2. 由 monthly analytics 轉成 live scenario

live scenario 目前只會使用：

- `status == "online"` 的 node
- 有完整 CPU / RAM / Disk 容量資訊的 node

並把 Proxmox 即時使用量轉成 simulator 的初始已用量：

- `cpu_used`
- `memory_used_gb`
- `disk_used_gb`

## 歷史分析資料的語意

monthly analytics 現在會輸出三組不同語意的指標：

- `average_*`: weighted mean
- `trend_*`: 依時間順序計算的 EWMA
- `peak_*`: weighted P95

其中 simulator 目前的 placement 還沒有直接使用 `trend_*`，它主要保留給 UI 或後續 admission policy。

### hourly 欄位的語意

每個 `hourly[*]` 目前代表：

- `cpu_ratio / memory_ratio / disk_ratio`: 同時段 weighted mean
- `peak_cpu_ratio / peak_memory_ratio / peak_disk_ratio`: 同時段 weighted P95

所以現在的資料語意是：

- `average_*` = 全月平均負載
- `trend_*` = 最近趨勢
- `peak_*` = 全月高分位負載
- `hourly[*].*_ratio` = 同時段平均
- `hourly[*].peak_*` = 同時段高分位

## 模擬時怎麼決定一台 VM 的有效需求

目前 simulator 會先找同規格歷史 profile：

- 規格鍵值是 `configured_cpu_cores + configured_memory_gb`
- 例如 `2 vCPU / 4 GiB`

如果找到同規格 profile，會優先拿「當前 hour 的 hourly baseline」；如果該小時沒有資料，再退回 profile 的 `average_*`。

### CPU baseline

```text
effective_cpu = min(requested_cpu, max(requested_cpu * cpu_ratio * 1.4, requested_cpu * 0.35))
```

目前常數：

- `CPU_MARGIN = 1.4`
- `CPU_FLOOR_RATIO = 0.35`

語意是：

- 先用歷史 CPU ratio 估算常態需求
- 再乘上安全 margin
- 但至少保留原始申請 CPU 的 35%
- 最後不超過原始申請值

### RAM baseline

```text
effective_ram = min(requested_ram, max(requested_ram * memory_ratio * 1.15, requested_ram * 0.5))
```

目前常數：

- `RAM_MARGIN = 1.15`
- `RAM_FLOOR_RATIO = 0.5`

語意和 CPU 相同，但 RAM floor 更高，避免過度樂觀。

### Peak guard

peak 不是直接拿最大值，而是：

- 先看 `hourly[*].peak_*`
- 沒有 hourly peak 時，退回 profile `peak_*`
- 如果連 profile peak 都沒有，就退回 baseline

peak demand 的估算方式：

```text
peak_cpu = min(requested_cpu, max(requested_cpu * peak_cpu_ratio * 1.1, effective_cpu))
peak_ram = min(requested_ram, max(requested_ram * peak_memory_ratio * 1.05, effective_ram))
```

目前常數：

- `CPU_PEAK_MARGIN = 1.1`
- `RAM_PEAK_MARGIN = 1.05`

### Disk 與 GPU

目前不使用歷史 profile 縮小：

- Disk 直接用 requested value
- GPU 直接用 requested value

## 可放置判斷

一台 VM 能不能放進某台 server，先看 hard fit：

- CPU 以 overcommit 後的 schedulable capacity 判斷
- RAM 以 safety buffer 後的 schedulable capacity 判斷
- Disk 必須真的有空間
- GPU 必須真的有空間

目前常數：

- `CPU_OVERCOMMIT_RATIO = 4.0`
- `RAM_USABLE_RATIO = 0.9`

也就是：

- CPU 排程容量 = `total_cpu * 4.0`
- RAM 排程容量 = `total_memory * 0.9`

這代表 CPU 是 soft limit，RAM 比較接近 hard reservation。

## Server 選擇規則

如果多台 server 都放得下，模擬器會比較「放進去之後哪一台最穩」。

### 1. 先算 projected weighted share

每台 server 都會計算放入後的 share：

- CPU share = `(used_cpu + vm_cpu) / cpu_schedulable_capacity`
- RAM share = `(used_memory + vm_memory) / memory_schedulable_capacity`
- Disk share = `(used_disk + vm_disk) / total_disk`
- GPU share = `(used_gpu + vm_gpu) / total_gpu`

再乘上權重：

- `CPU_SHARE_WEIGHT = 1.0`
- `MEMORY_SHARE_WEIGHT = 1.2`
- `DISK_SHARE_WEIGHT = 1.5`
- `GPU_SHARE_WEIGHT = 3.0`

weighted dominant share 定義為：

```text
max(weighted_cpu_share, weighted_memory_share, weighted_disk_share, weighted_gpu_share)
```

這表示：

- RAM 比 CPU 更敏感
- Disk 比 RAM 更敏感
- GPU 最敏感

### 2. 再加 contention penalty

除了 weighted share，本版還會對過高 share 額外加 penalty。

#### CPU penalty

- `CPU_SAFE_SHARE = 0.7`
- `CPU_MAX_SHARE = 1.2`

當 projected physical CPU share：

- 小於等於 `0.7` 時，penalty = `0`
- 大於等於 `1.2` 時，penalty = `1`
- 中間線性增加

再乘上：

- `CPU_CONTENTION_WEIGHT = 2.0`

#### RAM penalty

RAM policy share 如果大於 `1.0`，直接加 hard overflow penalty：

- `MEMORY_OVERFLOW_WEIGHT = 5.0`

因為 RAM 不希望靠 overcommit 撐過去。

#### Disk penalty

- `DISK_SAFE_SHARE = 0.75`
- `DISK_MAX_SHARE = 0.95`
- `DISK_CONTENTION_WEIGHT = 1.5`

share 越接近滿盤，分數越差。

### 3. 最終排序鍵

目前放置排序鍵是：

1. `projected_dominant_share + resource_penalty + migration_cost`
2. projected average weighted share
3. projected physical CPU share
4. 目前已放置 VM 數量
5. server name

所以它不只是「dominant share 最低」，而是：

`weighted dominant share + contention penalty 最低`

## Local rebalance

如果一台新 VM 沒有任何 server 可以直接放入，而且 `allow_rebalance = true`，模擬器會嘗試 local rebalance。

目前規則：

- 最多遞迴搜尋 `LOCAL_REBALANCE_MAX_MOVES = 2`
- 先從最緊的 server 開始找移動來源
- 優先移動較重的 VM
- 移動目標仍然用同一套 placement score
- move target 會額外加上 `MIGRATION_COST = 0.15`

這代表 rebalance 是：

- 小範圍
- 有成本
- 只在直接放不下時才觸發

不是全域最佳化，也不是大規模重排。

## Peak risk 判斷

placement 完成後，每筆 calculation row 還會做 peak risk 評估。

它會把該 VM 的 baseline demand 換成 peak demand，再看放上去後的 CPU / RAM share。

目前門檻：

- CPU warning/high: `0.7 / 1.2`
- RAM warning/high: `0.8 / 0.85`

輸出結果：

- `safe`
- `guarded`
- `high`

這個欄位目前主要是風險提示，不是 admission hard reject。

## 目前版本最重要的設計選擇

### 已經做到的

- CPU 可 overcommit，但會有 contention penalty
- RAM 保留 safety buffer，不靠大量 overcommit
- baseline、trend、peak 三種語意已分開
- average 與 peak 都保留 `0`，不再把 idle VM 當缺值
- hourly peak 已可用於 same-hour risk / sizing
- direct fit 失敗後，會先做小範圍 rebalance

### 還沒有做到的

- 用 `trend_*` 直接驅動 placement
- weighted percentile interpolation
- host loadavg 直接參與 fit gate
- NUMA / affinity / anti-affinity
- HA reserve
- IOPS / latency-aware storage policy
- ballooning / memory reclaim
- global optimal rebalance

## 一句話總結

目前這版的實際策略是：

`先用同規格 VM 的同時段 weighted mean 估 baseline，用 P95 當 peak guard，再把新 VM 放到 weighted dominant share 與 contention score 最低的 node；若直接放不下，就只做最多 2 步的 local rebalance。`
