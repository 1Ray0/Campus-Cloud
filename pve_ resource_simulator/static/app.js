const HOURS_IN_DAY = 24;

const state = {
  servers: [],
  vmList: [],
  historicalProfiles: [],
  historicalPeakHours: [],
  historicalHourlyPeaks: {},
  scenarioSource: "default",
  scenarioNote: "",
  result: null,
  currentHour: 9,
  currentStep: 0,
  selectedRange: { start: 9, end: 12 },
  strategy: "dominant_share_min",
  cpuOvercommitRatio: 2.0,
  diskOvercommitRatio: 1.0,
  // storageConfig: { [poolName]: { is_shared, speed_tier, user_priority } }
  storageConfig: {},
};

const elements = {
  form: document.querySelector("#vm-form"),
  name: document.querySelector("#vm-name"),
  resourceType: document.querySelector("#vm-resource-type"),
  cpu: document.querySelector("#vm-cpu"),
  ram: document.querySelector("#vm-ram"),
  disk: document.querySelector("#vm-disk"),
  quantity: document.querySelector("#vm-quantity"),
  startHour: document.querySelector("#vm-start-hour"),
  endHour: document.querySelector("#vm-end-hour"),
  slotSummary: document.querySelector("#slot-summary"),
  reset: document.querySelector("#reset-all"),
  vmList: document.querySelector("#vm-list"),
  vmCount: document.querySelector("#vm-count"),
  errorBanner: document.querySelector("#error-banner"),
  dayCalendar: document.querySelector("#day-calendar"),
  calculationTableBody: document.querySelector("#calculation-table-body"),
  hourSummary: document.querySelector("#hour-summary"),
  slider: document.querySelector("#step-slider"),
  stepLabel: document.querySelector("#step-label"),
  stepCaption: document.querySelector("#step-caption"),
  serverBoard: document.querySelector("#server-board"),
  scenarioNote: document.querySelector("#scenario-note"),
  strategySelect: document.querySelector("#strategy-select"),
  nodePriorityList: document.querySelector("#node-priority-list"),
  storageConfigPanel: document.querySelector("#storage-config-panel"),
  reliefActions: document.querySelector("#relief-actions"),
  storageScope: document.querySelector("#vm-storage-scope"),
  preferredStorage: document.querySelector("#vm-preferred-storage"),
  cpuOvercommitRatio: document.querySelector("#cpu-overcommit-ratio"),
  diskOvercommitRatio: document.querySelector("#disk-overcommit-ratio"),
};

elements.form?.addEventListener("submit", (event) => {
  event.preventDefault();
  void addVmFromForm();
});
elements.reset?.addEventListener("click", resetAll);
elements.startHour?.addEventListener("change", handleRangeChange);
elements.endHour?.addEventListener("change", handleRangeChange);
elements.slider?.addEventListener("input", (event) => {
  state.currentStep = Number(event.target.value || 0);
  renderCalculationTable();
  renderHourPanel();
  renderServerBoard();
});
elements.strategySelect?.addEventListener("change", () => {
  state.strategy = elements.strategySelect.value;
  if (state.vmList.length > 0) void runSimulation();
});
elements.cpuOvercommitRatio?.addEventListener("change", () => {
  const parsed = parseFloat(elements.cpuOvercommitRatio.value);
  state.cpuOvercommitRatio = isNaN(parsed) ? 2.0 : Math.max(1.0, Math.min(8.0, parsed));
  if (state.vmList.length > 0) void runSimulation();
});
elements.diskOvercommitRatio?.addEventListener("change", () => {
  const parsed = parseFloat(elements.diskOvercommitRatio.value);
  state.diskOvercommitRatio = isNaN(parsed) ? 1.0 : Math.max(1.0, Math.min(5.0, parsed));
  if (state.vmList.length > 0) void runSimulation();
});

void init();

async function init() {
  await loadScenario();
  renderScenarioNote();
  renderRangeControls();
  renderNodePriorityList();
  renderStorageConfigPanel();
  renderVmList();
  renderDayCalendar();
  renderCalculationTable();
  renderHourPanel();
  renderServerBoard();
}

async function loadScenario() {
  clearError();

  try {
    const liveResponse = await fetch("/api/v1/scenario/live");
    const livePayload = await liveResponse.json();
    if (!liveResponse.ok) {
      throw new Error(livePayload.detail || "Failed to load live scenario.");
    }
    applyScenario(livePayload);
    return;
  } catch (error) {
    console.warn("Live scenario unavailable, fallback to default scenario.", error);
  }

  const response = await fetch("/api/v1/scenario/default");
  const payload = await response.json();
  applyScenario(payload);
}

function applyScenario(payload) {
  state.servers = payload.servers || [];
  state.historicalProfiles = payload.historical_profiles || [];
  state.historicalPeakHours = payload.historical_peak_hours || [];
  state.historicalHourlyPeaks = payload.historical_hourly_peaks || {};
  state.scenarioSource = payload.source || "default";
  state.scenarioNote = payload.note || "";
  state.vmList = [];
  state.result = null;
  initStorageConfig();
  renderNodePriorityList();
  renderStorageConfigPanel();
}

function initStorageConfig() {
  // Collect all unique pool names from all nodes.
  // Only add entries that don't already exist (preserve user edits on reload).
  for (const server of state.servers) {
    for (const pool of server.storages || []) {
      if (!state.storageConfig[pool.storage]) {
        state.storageConfig[pool.storage] = {
          is_shared: pool.is_shared ?? false,
          speed_tier: pool.speed_tier ?? "unknown",
          user_priority: pool.user_priority ?? 5,
          enabled: pool.enabled ?? true,
          // read-only capability flags (from server, not user-editable)
          _can_vm: pool.can_vm ?? false,
          _can_lxc: pool.can_lxc ?? false,
          _can_iso: pool.can_iso ?? false,
          _can_backup: pool.can_backup ?? false,
        };
      }
    }
  }
}

function applyStorageConfigToServers(servers) {
  // Deep-copy servers and apply storageConfig overrides before sending to API.
  return servers.map((server) => ({
    ...server,
    storages: (server.storages || []).map((pool) => {
      const cfg = state.storageConfig[pool.storage];
      if (!cfg) return pool;
      return {
        ...pool,
        is_shared: cfg.is_shared,
        speed_tier: cfg.speed_tier,
        user_priority: cfg.user_priority,
        enabled: cfg.enabled,
      };
    }),
  }));
}

function storageRoleLabel(cfg) {
  const roles = [];
  if (cfg._can_vm) roles.push("VM");
  if (cfg._can_lxc) roles.push("LXC");
  if (cfg._can_iso) roles.push("ISO");
  if (cfg._can_backup) roles.push("Backup");
  if (!roles.length) roles.push("Other");
  return roles;
}

function renderScenarioNote() {
  if (!elements.scenarioNote) return;
  const prefix = state.scenarioSource === "live"
    ? "目前使用真實 PVE node 狀態與同類型歷史平均進行模擬。"
    : "目前使用靜態示範資料，未接上真實 PVE。";
  elements.scenarioNote.textContent = `${prefix} ${state.scenarioNote}`.trim();
}

function handleRangeChange() {
  const start = Number(elements.startHour?.value || 0);
  const end = Number(elements.endHour?.value || 0);
  state.selectedRange = { start, end };
  renderRangeControls();
}

function renderRangeControls() {
  renderRangeSelects();

  if (!elements.slotSummary) return;

  if (!isValidRange(state.selectedRange.start, state.selectedRange.end)) {
    elements.slotSummary.textContent = "結束時段必須大於開始時段。";
    return;
  }

  elements.slotSummary.textContent = `${formatRange(state.selectedRange.start, state.selectedRange.end)} · ${state.selectedRange.end - state.selectedRange.start} hr`;
}

function renderRangeSelects() {
  if (elements.startHour) {
    elements.startHour.innerHTML = Array.from({ length: HOURS_IN_DAY }, (_, hour) => {
      const selected = state.selectedRange.start === hour ? "selected" : "";
      return `<option value="${hour}" ${selected}>${formatHour(hour)}</option>`;
    }).join("");
  }

  if (elements.endHour) {
    elements.endHour.innerHTML = Array.from({ length: HOURS_IN_DAY }, (_, index) => {
      const hour = index + 1;
      const selected = state.selectedRange.end === hour ? "selected" : "";
      return `<option value="${hour}" ${selected}>${formatHour(hour % HOURS_IN_DAY, hour === HOURS_IN_DAY)}</option>`;
    }).join("");
  }
}

async function addVmFromForm() {
  clearError();

  const resourceType = String(elements.resourceType?.value || "qemu");
  const cpu = Number(elements.cpu?.value || 0);
  const ram = Number(elements.ram?.value || 0);
  const disk = Number(elements.disk?.value || 0);
  const quantity = Number(elements.quantity?.value || 0);
  const { start, end } = state.selectedRange;
  const activeHours = expandRange(start, end);
  const defaultName = `vm-${String(state.vmList.length + 1).padStart(3, "0")}`;
  const name = (elements.name?.value || "").trim() || defaultName;

  if (cpu <= 0 || ram <= 0 || disk <= 0) {
    showError("CPU、RAM、Disk 都必須大於 0。");
    return;
  }

  if (!isValidRange(start, end)) {
    showError("啟用時段無效，請重新選擇。");
    return;
  }

  if (!Number.isInteger(quantity) || quantity <= 0) {
    showError("Quantity must be a positive integer.");
    return;
  }

  const storageScope = String(elements.storageScope?.value || "any");
  const preferredStorage = (elements.preferredStorage?.value || "").trim() || null;

  state.vmList.push({
    id: `vm-${Date.now()}-${state.vmList.length + 1}`,
    name,
    resource_type: resourceType,
    cpu_cores: cpu,
    memory_gb: ram,
    disk_gb: disk,
    gpu_count: 0,
    count: quantity,
    active_hours: activeHours,
    enabled: true,
    storage_scope_preference: storageScope,
    preferred_storage_name: preferredStorage,
  });

  if (elements.name) elements.name.value = "";
  if (elements.resourceType) elements.resourceType.value = "qemu";
  if (elements.cpu) elements.cpu.value = "2";
  if (elements.ram) elements.ram.value = "4";
  if (elements.disk) elements.disk.value = "40";
  if (elements.quantity) elements.quantity.value = "1";
  if (elements.storageScope) elements.storageScope.value = "any";
  if (elements.preferredStorage) elements.preferredStorage.value = "";

  state.result = null;
  state.currentStep = 0;
  renderVmList();
  renderDayCalendar();
  await runSimulation();
}

async function removeVm(index) {
  state.vmList.splice(index, 1);
  state.result = null;
  state.currentStep = 0;
  renderVmList();
  renderDayCalendar();
  renderCalculationTable();

  if (state.vmList.length) {
    await runSimulation();
    return;
  }

  renderHourPanel();
  renderServerBoard();
}

function resetAll() {
  state.vmList = [];
  state.result = null;
  state.currentHour = 9;
  state.currentStep = 0;
  state.selectedRange = { start: 9, end: 12 };
  clearError();
  renderRangeControls();
  renderVmList();
  renderDayCalendar();
  renderCalculationTable();
  renderHourPanel();
  renderServerBoard();
}

function renderVmList() {
  if (elements.vmCount) {
    const totalVmCount = state.vmList.reduce((sum, vm) => sum + Number(vm.count || 1), 0);
    elements.vmCount.textContent = `${totalVmCount} 台`;
  }

  if (!elements.vmList) return;

  if (!state.vmList.length) {
    elements.vmList.innerHTML = `
      <div class="vm-item empty-state">
        <div class="vm-main">
          <p class="vm-spec">新增待申請 VM 後，系統會優先使用真實 PVE 的同類型歷史平均換算有效 CPU / RAM，沒有歷史就退回保守申請值。</p>
        </div>
      </div>
    `;
    return;
  }

  elements.vmList.innerHTML = state.vmList
    .map((vm, index) => {
      const historyHint = findProfileHint(vm);
      return `
        <article class="vm-item">
          <div class="vm-main">
            <p class="vm-name">${escapeHtml(vm.name)}</p>
            <p class="vm-spec">${formatResourceType(vm.resource_type)} · CPU ${formatCompact(vm.cpu_cores)} · RAM ${formatCompact(vm.memory_gb)} GB · Disk ${formatCompact(vm.disk_gb)} GB</p>
            <p class="vm-slot-line">${escapeHtml(formatHoursAsSingleRange(vm.active_hours || []))}</p>
            <p class="vm-slot-line">${escapeHtml(historyHint)}</p>
          </div>
          <button class="link-button" type="button" data-remove-index="${index}">移除</button>
        </article>
      `;
    })
    .join("");

  elements.vmList.querySelectorAll("[data-remove-index]").forEach((button) => {
    button.addEventListener("click", async () => {
      await removeVm(Number(button.getAttribute("data-remove-index")));
    });
  });
}

function findProfileHint(vm) {
  const match = state.historicalProfiles.find((profile) =>
    profile.resource_type === (vm.resource_type || "qemu")
    && Number(profile.configured_cpu_cores) === Number(vm.cpu_cores)
    && Number(profile.configured_memory_gb) === Number(vm.memory_gb),
  );
  if (!match) {
    if ((vm.resource_type || "qemu") === "lxc") {
      return "No matching LXC history: use LXC baseline fallback.";
    }
    return "No matching history: use conservative requested CPU / RAM.";
  }
  return `Historical type match: ${match.type_label} from ${match.guest_count} real guest(s).`;
}

async function runSimulation() {
  clearError();

  try {
    const response = await fetch("/api/v1/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        servers: applyStorageConfigToServers(state.servers),
        vm_templates: state.vmList,
        historical_profiles: state.historicalProfiles,
        strategy: state.strategy,
        cpu_overcommit_ratio: state.cpuOvercommitRatio,
        disk_overcommit_ratio: state.diskOvercommitRatio,
      }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.detail || "Simulation failed.");
    }

    state.result = payload;
    const firstActiveHour = payload.summary?.active_hours?.[0];
    const currentHourLoad = Number(payload.summary?.reservations_by_hour?.[String(state.currentHour)] || 0);
    if (typeof firstActiveHour === "number" && currentHourLoad === 0) {
      state.currentHour = firstActiveHour;
    }
    syncSliderToHourEnd();
    renderDayCalendar();
    renderCalculationTable();
    renderHourPanel();
    renderServerBoard();
  } catch (error) {
    showError(error.message || "Simulation failed.");
  }
}

function renderDayCalendar() {
  if (!elements.dayCalendar) return;

  const reservations = state.result?.summary?.reservations_by_hour || buildHourCountsFromVmList();
  const counts = Array.from({ length: HOURS_IN_DAY }, (_, hour) => Number(reservations[String(hour)] || 0));
  const peakCount = Math.max(...counts, 0);
  const useHistoricalPeak = peakCount === 0 && state.historicalPeakHours.length > 0;
  const historicalPeakAnalysis = useHistoricalPeak
    ? buildHistoricalPeakAnalysis({
        valuesByHour: state.historicalHourlyPeaks,
        primaryPeakHours: state.historicalPeakHours,
      })
    : null;

  elements.dayCalendar.innerHTML = Array.from({ length: HOURS_IN_DAY }, (_, hour) => {
    const count = counts[hour];
    const selected = state.currentHour === hour;
    const busy = count > 0;
    const historicalPeakValue = state.historicalHourlyPeaks[String(hour)];
    const historicalPeakTier = useHistoricalPeak
      ? historicalPeakAnalysis?.tiers?.[hour] || "none"
      : "none";
    const isPeak = useHistoricalPeak
      ? historicalPeakTier === "peak"
      : peakCount > 0 && count === peakCount;
    const historicalPeakClass = useHistoricalPeak
      ? historicalPeakTierClass(historicalPeakTier)
      : "";
    const peakTitle = useHistoricalPeak
      ? historicalPeakTitle(historicalPeakTier, historicalPeakValue)
      : `Peak hour with ${count} active VM reservation(s).`;
    const peakPill = useHistoricalPeak
      ? historicalPeakPill(historicalPeakTier)
      : (isPeak ? { label: "PEAK", className: "" } : null);

    return `
      <button
        class="calendar-hour ${selected ? "selected" : ""} ${busy ? "busy" : ""} ${isPeak ? "peak" : ""} ${historicalPeakClass}"
        type="button"
        data-hour-select="${hour}"
        title="${peakPill ? peakTitle : `${count} active VM reservation(s).`}"
      >
        <span class="calendar-label-row">
          <span class="calendar-label">${formatHour(hour)}</span>
          ${peakPill ? `<span class="calendar-peak-pill ${peakPill.className}">${peakPill.label}</span>` : ""}
        </span>
        <span class="calendar-value-row">
          <span class="calendar-count">${count}</span>
          <span class="calendar-peak-value">${formatCalendarPeakValue(historicalPeakValue)}</span>
        </span>
      </button>
    `;
  }).join("");

  elements.dayCalendar.querySelectorAll("[data-hour-select]").forEach((button) => {
    button.addEventListener("click", () => {
      state.currentHour = Number(button.getAttribute("data-hour-select"));
      syncSliderToHourEnd();
      renderDayCalendar();
      renderCalculationTable();
      renderHourPanel();
      renderServerBoard();
    });
  });
}

function renderCalculationTable() {
  if (!elements.calculationTableBody) return;

  const calculations = getCurrentHourResult()?.calculations || [];
  if (!calculations.length) {
    elements.calculationTableBody.innerHTML = `
      <tr>
        <td colspan="11" class="guest-empty">This hour has no active VM reservation.</td>
      </tr>
    `;
    return;
  }

  elements.calculationTableBody.innerHTML = calculations
    .map(
      (row) => `
        <tr class="${row.placement_status === 'no_fit' ? 'row-no-fit' : ''}">
          <td>${escapeHtml(row.vm_name)}</td>
          <td>${formatCompact(row.requested_cpu_cores)}C / ${formatCompact(row.requested_memory_gb)}G / ${formatCompact(row.requested_disk_gb)}D</td>
          <td>${escapeHtml(row.profile_label || "Fallback")}</td>
          <td>${formatRatioSource(row.cpu_ratio, row.source)}</td>
          <td>${formatRatioSource(row.memory_ratio, row.source)}</td>
          <td>${formatCompact(row.effective_cpu_cores)}C / ${formatCompact(row.effective_memory_gb)}G</td>
          <td>${formatCompact(row.peak_cpu_cores)}C / ${formatCompact(row.peak_memory_gb)}G</td>
          <td><span class="risk-pill ${peakRiskClass(row.peak_risk)}">${escapeHtml(formatPeakRisk(row.peak_risk))}</span></td>
          <td>${escapeHtml(formatPlacementStatus(row.placement_status))}</td>
          <td>
            ${escapeHtml(row.placed_server_name || "-")}
            ${row.is_cpu_overcommit ? '<span class="role-pill role-oc" title="CPU 超額配置：此 VM 的 CPU 分配超過節點實體核心數">CPU OC</span>' : ""}
          </td>
          <td class="storage-cell">
            ${escapeHtml(row.placed_storage_pool || "-")}
            ${row.is_disk_overcommit ? '<span class="role-pill role-oc" title="磁碟超額配置：此 VM 使用的磁碟空間超過 storage pool 實際剩餘容量">OC</span>' : ""}
          </td>
        </tr>
      `,
    )
    .join("");
}

function renderHourPanel() {
  const currentHourResult = getCurrentHourResult();

  if (!currentHourResult) {
    if (elements.hourSummary) {
      elements.hourSummary.textContent = `${formatRange(state.currentHour, state.currentHour + 1)} · 沒有待放置 VM`;
    }
    if (elements.stepLabel) {
      elements.stepLabel.textContent = "逐步放置 VM";
    }
    if (elements.stepCaption) {
      elements.stepCaption.textContent = "新增 VM 後，系統會依照真實 PVE node 現況與同類型歷史平均重新計算放置結果。";
    }
    if (elements.reliefActions) elements.reliefActions.innerHTML = "";
    syncSlider();
    return;
  }

  const placed = currentHourResult.summary?.total_placements || 0;
  const requested = currentHourResult.summary?.requested_vm_count || 0;
  const failed = currentHourResult.summary?.failed_vm_names || [];

  if (elements.hourSummary) {
    const calculations = currentHourResult.calculations || [];
    const cpuOcCount = calculations.filter(r => r.is_cpu_overcommit).length;
    const diskOcCount = calculations.filter(r => r.is_disk_overcommit).length;
    const ocParts = [];
    if (cpuOcCount > 0) ocParts.push(`${cpuOcCount} CPU OC`);
    if (diskOcCount > 0) ocParts.push(`${diskOcCount} Disk OC`);
    const ocText = ocParts.length > 0 ? ` · ${ocParts.join(", ")}` : "";
    elements.hourSummary.textContent = `${currentHourResult.label} · ${requested} 台待放置 · ${placed} 台成功${failed.length ? ` · ${failed.length} 台未放入` : ""}${ocText}`;
  }

  const currentState = currentHourResult.states[state.currentStep] || currentHourResult.states[0];
  const lastStep = Math.max((currentHourResult.states?.length || 1) - 1, 0);

  if (elements.stepLabel) {
    elements.stepLabel.textContent = lastStep === 0
      ? `${currentHourResult.label} · 初始狀態`
      : `${currentState?.title || currentHourResult.label} · Step ${state.currentStep}/${lastStep}`;
  }

  if (elements.stepCaption) {
    elements.stepCaption.textContent = currentState?.latest_placement?.reason
      || currentHourResult.summary?.stop_reason
      || "目前沒有可顯示的放置說明。";
  }

  if (elements.reliefActions) {
    const summary = currentHourResult.summary;
    const parts = [];
    if (summary?.bottleneck_server && summary?.bottleneck_resource) {
      parts.push(`<span class="relief-bottleneck">瓶頸：${escapeHtml(summary.bottleneck_server)} (${escapeHtml(summary.bottleneck_resource)})</span>`);
    }
    const relief = summary?.relief_actions || [];
    for (const action of relief) {
      parts.push(`<div class="relief-item"><strong>${escapeHtml(action.title)}</strong> — ${escapeHtml(action.detail)}</div>`);
    }
    elements.reliefActions.innerHTML = parts.length > 0 ? parts.join("") : "";
  }

  syncSlider();
}

function renderServerBoard() {
  if (!elements.serverBoard) return;

  const currentHourResult = getCurrentHourResult();
  const servers = currentHourResult?.states?.length
    ? currentHourResult.states[state.currentStep]?.servers
    : state.servers.map((server) => ({
        name: server.name,
        total: {
          cpu_cores: Number(server.cpu_cores || 0),
          memory_gb: Number(server.memory_gb || 0),
          disk_gb: Number(server.disk_gb || 0),
        },
        used: {
          cpu_cores: Number(server.cpu_used || 0),
          memory_gb: Number(server.memory_used_gb || 0),
          disk_gb: Number(server.disk_used_gb || 0),
        },
        remaining: {
          cpu_cores: Number(server.cpu_cores) - Number(server.cpu_used || 0),
          memory_gb: Number(server.memory_gb) - Number(server.memory_used_gb || 0),
          disk_gb: Number(server.disk_gb) - Number(server.disk_used_gb || 0),
        },
        vm_stack: [],
      }));

  elements.serverBoard.innerHTML = (servers || [])
    .map(
      (server) => {
        const priority = server.priority ?? getServerPriority(server.name);
        const priorityBadge = priority != null
          ? `<span class="priority-badge" title="PVE Node Priority">P${priority}</span>`
          : "";
        const storageHtml = renderStoragePools(server.storages);
        return `
        <article class="server-column">
          <div class="stack-frame">
            <div class="stack-cap">
              ${escapeHtml(server.name)}
              ${priorityBadge}
            </div>
            <div class="stack-body">
              ${renderVmStack(server.vm_stack)}
            </div>
          </div>
          <div class="server-footer">
            <h3>${escapeHtml(server.name)}</h3>
            <p class="server-meta">${escapeHtml(formatServerMeta(server))}</p>
            ${storageHtml}
          </div>
        </article>
      `;
      },
    )
    .join("");
}

function getServerPriority(name) {
  const server = state.servers.find((s) => s.name === name);
  return server?.priority ?? null;
}

function renderStoragePools(storages) {
  if (!storages || storages.length === 0) return "";

  const makeRow = (pool) => {
    const pct = pool.total_gb > 0 ? Math.round((pool.avail_gb / pool.total_gb) * 100) : 0;
    const roles = [
      pool.can_vm ? "VM" : null,
      pool.can_lxc ? "LXC" : null,
      pool.can_iso ? "ISO" : null,
      pool.can_backup ? "Bak" : null,
    ].filter(Boolean).join("/") || "—";
    const scopeLabel = pool.is_shared ? "shared" : "local";
    const scopeClass = pool.is_shared ? "scope-shared" : "scope-local";
    const isDisabled = !pool.active || pool.enabled === false;
    const disabledClass = isDisabled ? " storage-inactive" : "";
    const disabledLabel = !pool.active ? " [offline]" : pool.enabled === false ? " [停用]" : "";
    return `<div class="storage-pool${disabledClass}">
      <span class="storage-name">${escapeHtml(pool.storage)}${escapeHtml(disabledLabel)}</span>
      <span class="storage-flags">${escapeHtml(roles)}</span>
      <span class="storage-scope ${scopeClass}">${scopeLabel}</span>
      <span class="storage-avail">${formatCompact(pool.avail_gb)} GB free (${pct}%)</span>
    </div>`;
  };

  // Split: VM/LXC pools (primary) vs ISO/Backup-only pools (secondary)
  const primary = storages.filter((p) => p.can_vm || p.can_lxc);
  const secondary = storages.filter((p) => !p.can_vm && !p.can_lxc);

  const primaryRows = primary.map(makeRow).join("");
  const secondaryHtml = secondary.length
    ? `<details class="storage-secondary">
        <summary class="storage-pools-toggle">${secondary.length} 個 ISO/Backup pool</summary>
        ${secondary.map(makeRow).join("")}
       </details>`
    : "";

  return `<div class="storage-pools">${primaryRows}</div>${secondaryHtml}`;
}

function renderNodePriorityList() {
  if (!elements.nodePriorityList) return;
  if (!state.servers.length) {
    elements.nodePriorityList.innerHTML = "<p class='helper-text'>No nodes loaded.</p>";
    return;
  }
  elements.nodePriorityList.innerHTML = state.servers
    .map(
      (server, index) => `
      <div class="node-priority-row">
        <span class="node-priority-name">${escapeHtml(server.name)}</span>
        <input
          class="node-priority-input"
          type="number"
          min="1"
          max="10"
          step="1"
          value="${Number(server.priority ?? 5)}"
          data-server-index="${index}"
          aria-label="Priority for ${escapeHtml(server.name)}"
        />
      </div>
    `,
    )
    .join("");

  elements.nodePriorityList.querySelectorAll(".node-priority-input").forEach((input) => {
    input.addEventListener("change", (event) => {
      const index = Number(event.target.dataset.serverIndex);
      const value = Math.min(10, Math.max(1, Number(event.target.value) || 5));
      event.target.value = value;
      if (state.servers[index]) {
        state.servers[index].priority = value;
        if (state.vmList.length > 0) void runSimulation();
      }
    });
  });
}

function renderStorageConfigPanel() {
  if (!elements.storageConfigPanel) return;

  const poolNames = Object.keys(state.storageConfig);
  if (!poolNames.length) {
    elements.storageConfigPanel.innerHTML = "<p class='helper-text'>No storage pools detected.</p>";
    return;
  }

  elements.storageConfigPanel.innerHTML = poolNames
    .sort()
    .map((poolName) => {
      const cfg = state.storageConfig[poolName];
      const roles = storageRoleLabel(cfg);
      const isPlaceable = cfg._can_vm || cfg._can_lxc;
      const disabledClass = cfg.enabled ? "" : " storage-cfg-disabled";
      const rolePills = roles
        .map((r) => {
          const cls = r === "VM" ? "role-vm" : r === "LXC" ? "role-lxc" : r === "ISO" ? "role-iso" : r === "Backup" ? "role-backup" : "role-other";
          return `<span class="role-pill ${cls}">${r}</span>`;
        })
        .join("");

      return `
      <div class="storage-cfg-row${disabledClass}" data-pool="${escapeHtml(poolName)}">
        <div class="storage-cfg-header">
          <span class="storage-cfg-name">${escapeHtml(poolName)}</span>
          <div class="storage-cfg-roles">${rolePills}</div>
        </div>
        <div class="storage-cfg-controls">
          <label class="storage-cfg-toggle" title="停用此 Storage，不參與 VM/LXC 放置">
            <input type="checkbox" class="scfg-enabled" ${cfg.enabled ? "checked" : ""} />
            <span>啟用</span>
          </label>
          ${isPlaceable ? `
          <label class="storage-cfg-toggle" title="Shared storage — 容量只計一次（NFS/Ceph/RBD）">
            <input type="checkbox" class="scfg-shared" ${cfg.is_shared ? "checked" : ""} ${!cfg.enabled ? "disabled" : ""} />
            <span>共享</span>
          </label>
          <select class="scfg-speed" title="Storage 速度等級" ${!cfg.enabled ? "disabled" : ""}>
            ${["nvme", "ssd", "hdd", "unknown"].map((t) =>
              `<option value="${t}" ${cfg.speed_tier === t ? "selected" : ""}>${t.toUpperCase()}</option>`
            ).join("")}
          </select>
          <label class="storage-cfg-priority-label" title="用途優先級 1=最優先">
            <span>Pri</span>
            <input type="number" class="scfg-priority" min="1" max="10" step="1" value="${cfg.user_priority}" ${!cfg.enabled ? "disabled" : ""} />
          </label>
          ` : `<span class="storage-cfg-note">不參與 VM/LXC 放置</span>`}
        </div>
      </div>`;
    })
    .join("");

  elements.storageConfigPanel.querySelectorAll(".storage-cfg-row").forEach((row) => {
    const poolName = row.dataset.pool;
    const enabledInput = row.querySelector(".scfg-enabled");
    const sharedInput = row.querySelector(".scfg-shared");
    const speedSelect = row.querySelector(".scfg-speed");
    const priorityInput = row.querySelector(".scfg-priority");

    const save = () => {
      const prev = state.storageConfig[poolName];
      state.storageConfig[poolName] = {
        ...prev,
        enabled: enabledInput ? enabledInput.checked : prev.enabled,
        is_shared: sharedInput ? sharedInput.checked : prev.is_shared,
        speed_tier: speedSelect ? speedSelect.value : prev.speed_tier,
        user_priority: priorityInput
          ? Math.min(10, Math.max(1, Number(priorityInput.value) || 5))
          : prev.user_priority,
      };
      if (priorityInput) priorityInput.value = state.storageConfig[poolName].user_priority;
      // Re-render to toggle disabled state visually
      renderStorageConfigPanel();
      if (state.vmList.length > 0) void runSimulation();
    };

    enabledInput?.addEventListener("change", save);
    sharedInput?.addEventListener("change", save);
    speedSelect?.addEventListener("change", save);
    priorityInput?.addEventListener("change", save);
  });
}

function buildHistoricalPeakAnalysis({ valuesByHour, primaryPeakHours }) {
  const entries = Array.from({ length: HOURS_IN_DAY }, (_, hour) => ({
    hour,
    value: Number(valuesByHour?.[String(hour)] || 0),
  }));
  const positiveEntries = entries.filter((entry) => Number.isFinite(entry.value) && entry.value > 0);
  if (!positiveEntries.length) {
    return { tiers: {} };
  }

  const maxValue = Math.max(...positiveEntries.map((entry) => entry.value));
  const closeToPeakCutoff = maxValue * 0.985;
  const broadPeakCutoff = maxValue * 0.9;
  const topFewPeakHours = positiveEntries
    .slice()
    .sort((left, right) => right.value - left.value || left.hour - right.hour)
    .slice(0, 4)
    .filter((entry) => entry.value >= broadPeakCutoff)
    .map((entry) => entry.hour);

  const peakHours = new Set([
    ...primaryPeakHours,
    ...positiveEntries
      .filter((entry) => entry.value >= closeToPeakCutoff)
      .map((entry) => entry.hour),
    ...topFewPeakHours,
  ]);
  const tiers = {};

  for (const entry of entries) {
    if (peakHours.has(entry.hour)) {
      tiers[entry.hour] = "peak";
      continue;
    }

    if (entry.value >= maxValue * 0.6) {
      tiers[entry.hour] = "high";
      continue;
    }

    if (entry.value >= maxValue * 0.25) {
      tiers[entry.hour] = "elevated";
    }
  }

  return { tiers };
}

function historicalPeakTierClass(tier) {
  if (tier === "high") return "historical-high";
  if (tier === "elevated") return "historical-elevated";
  return "";
}

function historicalPeakPill(tier) {
  if (tier === "peak") {
    return { label: "PVE PEAK", className: "is-peak" };
  }
  if (tier === "high") {
    return { label: "PVE HIGH", className: "is-high" };
  }
  if (tier === "elevated") {
    return { label: "PVE ELEV", className: "is-elevated" };
  }
  return null;
}

function historicalPeakTitle(tier, value) {
  const formattedValue = formatCalendarPeakValue(value);
  if (tier === "peak") {
    return `Historical peak hour after nearby-hour smoothing. ${formattedValue}.`;
  }
  if (tier === "high") {
    return `Historical near-peak hour after nearby-hour smoothing. ${formattedValue}.`;
  }
  if (tier === "elevated") {
    return `Historical elevated hour after nearby-hour smoothing. ${formattedValue}.`;
  }
  return `Historical hour. ${formattedValue}.`;
}

function formatServerMeta(server) {
  const cpuPhysicalFree = Math.max(
    Number(server.total?.cpu_cores || 0) - Number(server.used?.cpu_cores || 0),
    0,
  );
  const memoryPhysicalFree = Math.max(
    Number(server.total?.memory_gb || 0) - Number(server.used?.memory_gb || 0),
    0,
  );
  const cpuPolicyFree = Math.max(Number(server.remaining?.cpu_cores || 0), 0);
  const memoryPolicyFree = Math.max(Number(server.remaining?.memory_gb || 0), 0);
  const diskFree = Math.max(Number(server.remaining?.disk_gb || 0), 0);

  const lines = [
    `CPU ${formatCompact(cpuPhysicalFree)} physical free / ${formatCompact(cpuPolicyFree)} policy`,
    `RAM ${formatCompact(memoryPhysicalFree)} physical free / ${formatCompact(memoryPolicyFree)} safe`,
    `Disk ${formatCompact(diskFree)} free`,
  ];
  if (server.dominant_share != null) {
    lines.push(`DS ${(server.dominant_share * 100).toFixed(1)}%`);
  }
  if (server.current_loadavg_1 != null) {
    lines.push(`Load ${server.current_loadavg_1.toFixed(2)}`);
  }
  return lines.join(" | ");
}

function syncSlider() {
  if (!elements.slider) return;

  const currentHourResult = getCurrentHourResult();
  if (!currentHourResult?.states?.length) {
    elements.slider.min = "0";
    elements.slider.max = "0";
    elements.slider.value = "0";
    elements.slider.disabled = true;
    return;
  }

  const max = currentHourResult.states.length - 1;
  state.currentStep = Math.min(state.currentStep, max);
  elements.slider.min = "0";
  elements.slider.max = String(max);
  elements.slider.value = String(state.currentStep);
  elements.slider.disabled = false;
}

function syncSliderToHourEnd() {
  const currentHourResult = getCurrentHourResult();
  state.currentStep = Math.max((currentHourResult?.states?.length || 1) - 1, 0);
  syncSlider();
}

function renderVmStack(vmStack) {
  if (!Array.isArray(vmStack) || vmStack.length === 0) {
    return `<div class="stack-empty">empty</div>`;
  }

  return vmStack
    .map(
      (item) => `
        <div class="stack-row">
          <span class="stack-name">${escapeHtml(item.name)}</span>
          <span class="stack-count">×${item.count}</span>
        </div>
      `,
    )
    .join("");
}

function getCurrentHourResult() {
  return state.result?.hours?.[state.currentHour] || null;
}

function buildHourCountsFromVmList() {
  const counts = {};
  for (let hour = 0; hour < HOURS_IN_DAY; hour += 1) {
    counts[String(hour)] = state.vmList.reduce((sum, vm) => (
      (vm.active_hours || []).includes(hour) ? sum + Number(vm.count || 1) : sum
    ), 0);
  }
  return counts;
}

function expandRange(start, end) {
  if (!isValidRange(start, end)) {
    return [];
  }
  return Array.from({ length: end - start }, (_, index) => start + index);
}

function isValidRange(start, end) {
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= HOURS_IN_DAY && end > start;
}

function formatHour(hour, isEndOfDay = false) {
  if (hour === 0 && isEndOfDay) {
    return "24:00";
  }
  return `${String(hour).padStart(2, "0")}:00`;
}

function formatRange(start, end) {
  return `${formatHour(start)}-${formatHour(end % HOURS_IN_DAY, end === HOURS_IN_DAY)}`;
}

function formatHoursAsSingleRange(hours) {
  if (!Array.isArray(hours) || !hours.length) {
    return "No schedule";
  }
  const sorted = [...new Set(hours)].sort((left, right) => left - right);
  return formatRange(sorted[0], sorted[sorted.length - 1] + 1);
}

function formatCompact(value) {
  const numeric = Number(value || 0);
  return numeric % 1 === 0 ? String(numeric) : numeric.toFixed(1);
}

function formatResourceType(resourceType) {
  return resourceType === "lxc" ? "LXC" : "VM";
}

function formatRatioSource(value, source) {
  if (value == null) {
    return source === "requested" ? "fallback" : "n/a";
  }
  const percentage = Number(value) * 100;
  if (percentage > 0 && percentage < 1) {
    return "<1%";
  }
  if (percentage < 10) {
    return `${percentage.toFixed(1)}%`;
  }
  return `${Math.round(percentage)}%`;
}

function formatPlacementStatus(status) {
  if (status === "placed") return "Placed";
  if (status === "no_fit") return "No fit";
  return "Pending";
}

function formatCalendarPeakValue(value) {
  if (value == null) {
    return "Peak --";
  }
  const percentage = Number(value) * 100;
  if (percentage > 0 && percentage < 1) {
    return "Peak <1%";
  }
  if (percentage < 10) {
    return `Peak ${percentage.toFixed(1)}%`;
  }
  return `Peak ${Math.round(percentage)}%`;
}

function formatPeakRisk(risk) {
  if (risk === "safe") return "Safe";
  if (risk === "guarded") return "Guarded";
  if (risk === "high") return "High";
  if (risk === "n/a") return "n/a";
  return "Pending";
}

function peakRiskClass(risk) {
  if (risk === "safe") return "is-safe";
  if (risk === "guarded") return "is-guarded";
  if (risk === "high") return "is-high";
  return "is-neutral";
}

function showError(message) {
  if (!elements.errorBanner) return;
  elements.errorBanner.hidden = false;
  elements.errorBanner.textContent = message;
}

function clearError() {
  if (!elements.errorBanner) return;
  elements.errorBanner.hidden = true;
  elements.errorBanner.textContent = "";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
