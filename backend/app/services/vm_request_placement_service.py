from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
import uuid

from sqlmodel import Session

from app.ai.pve_advisor import recommendation_service as advisor_service
from app.ai.pve_advisor.schemas import (
    NodeCapacity,
    PlacementDecision,
    PlacementPlan,
    PlacementRequest,
    ResourceType,
)
from app.models import VMRequest
from app.repositories import proxmox_config as proxmox_config_repo
from app.repositories import proxmox_node as proxmox_node_repo
from app.repositories import proxmox_storage as proxmox_storage_repo
from app.repositories import vm_request as vm_request_repo

GIB = 1024**3
_STORAGE_SPEED_RANK = {"nvme": 0, "ssd": 1, "hdd": 2, "unknown": 3}
_CPU_PEAK_WARN_SHARE = 0.7
_CPU_PEAK_HIGH_SHARE = 1.2
_RAM_PEAK_WARN_SHARE = 0.8
_RAM_PEAK_HIGH_SHARE = 0.85


@dataclass
class CurrentPlacementSelection:
    node: str | None
    strategy: str
    plan: PlacementPlan


@dataclass
class _WorkingStoragePool:
    storage: str
    total_gb: float
    avail_gb: float
    active: bool
    enabled: bool
    can_vm: bool
    can_lxc: bool
    is_shared: bool
    speed_tier: str
    user_priority: int
    placed_count: int = 0
    overcommit_placed_count: int = 0


@dataclass
class _StorageSelection:
    pool: _WorkingStoragePool
    projected_share: float
    speed_rank: int
    user_priority: int
    contention_penalty: float


@dataclass(frozen=True)
class _PlacementTuning:
    migration_cost: float
    peak_cpu_margin: float
    peak_memory_margin: float
    loadavg_warn_per_core: float
    loadavg_max_per_core: float
    loadavg_penalty_weight: float
    disk_contention_warn_share: float
    disk_contention_high_share: float
    disk_penalty_weight: float
    search_max_relocations: int
    search_depth: int


@dataclass(frozen=True)
class _AssignmentEvaluation:
    feasible: bool
    objective: tuple[float, float, float, int]
    max_node_score: float = float("inf")
    total_score: float = float("inf")
    priority_total: float = float("inf")
    movement_count: int = 10**9
    node_scores: dict[str, float] | None = None
    storage_penalties: dict[str, float] | None = None


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _normalize_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value


def _request_window(db_request: VMRequest) -> tuple[datetime | None, datetime | None]:
    return _normalize_datetime(db_request.start_at), _normalize_datetime(db_request.end_at)


def _request_capacity_tuple(db_request: VMRequest) -> tuple[float, int, int]:
    cpu_cores = float(db_request.cores or 1)
    memory_bytes = int(db_request.memory or 512) * 1024 * 1024
    disk_gb = (
        int(db_request.disk_size or 0)
        if db_request.resource_type == "vm"
        else int(db_request.rootfs_size or 0)
    )
    if disk_gb <= 0:
        disk_gb = 20 if db_request.resource_type == "vm" else 8
    return cpu_cores, memory_bytes, disk_gb * GIB


def _get_placement_tuning(*, session: Session) -> _PlacementTuning:
    config = proxmox_config_repo.get_proxmox_config(session)
    if config is None:
        return _PlacementTuning(
            migration_cost=0.15,
            peak_cpu_margin=1.1,
            peak_memory_margin=1.05,
            loadavg_warn_per_core=0.8,
            loadavg_max_per_core=1.5,
            loadavg_penalty_weight=0.9,
            disk_contention_warn_share=0.7,
            disk_contention_high_share=0.9,
            disk_penalty_weight=0.75,
            search_max_relocations=2,
            search_depth=3,
        )
    return _PlacementTuning(
        migration_cost=max(float(config.rebalance_migration_cost or 0.15), 0.0),
        peak_cpu_margin=max(float(config.rebalance_peak_cpu_margin or 1.1), 1.0),
        peak_memory_margin=max(float(config.rebalance_peak_memory_margin or 1.05), 1.0),
        loadavg_warn_per_core=max(float(config.rebalance_loadavg_warn_per_core or 0.8), 0.0),
        loadavg_max_per_core=max(float(config.rebalance_loadavg_max_per_core or 1.5), 0.01),
        loadavg_penalty_weight=max(float(config.rebalance_loadavg_penalty_weight or 0.9), 0.0),
        disk_contention_warn_share=max(
            float(config.rebalance_disk_contention_warn_share or 0.7),
            0.0,
        ),
        disk_contention_high_share=max(
            float(config.rebalance_disk_contention_high_share or 0.9),
            0.01,
        ),
        disk_penalty_weight=max(float(config.rebalance_disk_penalty_weight or 0.75), 0.0),
        search_max_relocations=max(int(config.rebalance_search_max_relocations or 2), 0),
        search_depth=max(int(config.rebalance_search_depth or 3), 0),
    )


def _build_storage_pool_state(
    *,
    session: Session,
    node_names: list[str],
) -> tuple[dict[str, list[_WorkingStoragePool]], bool]:
    storages = proxmox_storage_repo.get_all_storages(session)
    if not storages:
        return {node_name: [] for node_name in node_names}, False

    shared_registry: dict[str, _WorkingStoragePool] = {}
    by_node: dict[str, list[_WorkingStoragePool]] = {node_name: [] for node_name in node_names}
    node_set = set(node_names)

    for storage in storages:
        node_name = str(storage.node_name or "")
        if node_name not in node_set:
            continue

        if storage.is_shared:
            pool = shared_registry.get(storage.storage)
            if pool is None:
                pool = _WorkingStoragePool(
                    storage=storage.storage,
                    total_gb=float(storage.total_gb or 0.0),
                    avail_gb=float(storage.avail_gb or 0.0),
                    active=bool(storage.active),
                    enabled=bool(storage.enabled),
                    can_vm=bool(storage.can_vm),
                    can_lxc=bool(storage.can_lxc),
                    is_shared=bool(storage.is_shared),
                    speed_tier=str(storage.speed_tier or "unknown"),
                    user_priority=int(storage.user_priority or 5),
                )
                shared_registry[storage.storage] = pool
            by_node[node_name].append(pool)
            continue

        by_node[node_name].append(
            _WorkingStoragePool(
                storage=storage.storage,
                total_gb=float(storage.total_gb or 0.0),
                avail_gb=float(storage.avail_gb or 0.0),
                active=bool(storage.active),
                enabled=bool(storage.enabled),
                can_vm=bool(storage.can_vm),
                can_lxc=bool(storage.can_lxc),
                is_shared=bool(storage.is_shared),
                speed_tier=str(storage.speed_tier or "unknown"),
                user_priority=int(storage.user_priority or 5),
            )
        )

    has_managed_storage = any(pools for pools in by_node.values())
    return by_node, has_managed_storage


def _select_best_storage_for_request(
    *,
    storage_pools: list[_WorkingStoragePool],
    resource_type: ResourceType,
    disk_gb: int,
    disk_overcommit_ratio: float,
    tuning: _PlacementTuning | None = None,
) -> _StorageSelection | None:
    if disk_gb <= 0:
        return None
    tuning = tuning or _PlacementTuning(
        migration_cost=0.15,
        peak_cpu_margin=1.1,
        peak_memory_margin=1.05,
        loadavg_warn_per_core=0.8,
        loadavg_max_per_core=1.5,
        loadavg_penalty_weight=0.9,
        disk_contention_warn_share=0.7,
        disk_contention_high_share=0.9,
        disk_penalty_weight=0.75,
        search_max_relocations=2,
        search_depth=3,
    )

    capable = [
        pool
        for pool in storage_pools
        if pool.active
        and pool.enabled
        and ((resource_type == "lxc" and pool.can_lxc) or (resource_type == "vm" and pool.can_vm))
    ]
    if not capable:
        return None

    normal = [pool for pool in capable if pool.avail_gb + 1e-9 >= float(disk_gb)]
    if normal:
        chosen = min(
            normal,
            key=lambda pool: (
                _STORAGE_SPEED_RANK.get(pool.speed_tier, 3),
                _storage_contention_penalty(
                    projected_share=_projected_share(
                        used=max(pool.total_gb - pool.avail_gb, 0.0) + float(disk_gb),
                        total=max(pool.total_gb, 1.0),
                    ),
                    placed_count=pool.placed_count,
                    overcommit_placed_count=pool.overcommit_placed_count,
                    tuning=tuning,
                    overcommit=False,
                ),
                int(pool.user_priority or 5),
                pool.placed_count,
                -float(pool.avail_gb),
                pool.storage,
            ),
        )
        projected_share = _projected_share(
            used=max(chosen.total_gb - chosen.avail_gb, 0.0) + float(disk_gb),
            total=max(chosen.total_gb, 1.0),
        )
        return _StorageSelection(
            pool=chosen,
            projected_share=projected_share,
            speed_rank=_STORAGE_SPEED_RANK.get(chosen.speed_tier, 3),
            user_priority=int(chosen.user_priority or 5),
            contention_penalty=_storage_contention_penalty(
                projected_share=projected_share,
                placed_count=chosen.placed_count,
                overcommit_placed_count=chosen.overcommit_placed_count,
                tuning=tuning,
                overcommit=False,
            ),
        )

    overcommit = [
        pool
        for pool in capable
        if (max(float(pool.total_gb) * max(disk_overcommit_ratio, 1.0) - (pool.total_gb - pool.avail_gb), 0.0) + 1e-9)
        >= float(disk_gb)
    ]
    if not overcommit:
        return None

    chosen = min(
        overcommit,
        key=lambda pool: (
            _storage_contention_penalty(
                projected_share=_projected_share(
                    used=max(pool.total_gb - pool.avail_gb, 0.0) + float(disk_gb),
                    total=max(float(pool.total_gb) * max(disk_overcommit_ratio, 1.0), 1.0),
                ),
                placed_count=pool.placed_count,
                overcommit_placed_count=pool.overcommit_placed_count,
                tuning=tuning,
                overcommit=True,
            ),
            pool.overcommit_placed_count,
            _STORAGE_SPEED_RANK.get(pool.speed_tier, 3),
            int(pool.user_priority or 5),
            -max(
                float(pool.total_gb) * max(disk_overcommit_ratio, 1.0) - (pool.total_gb - pool.avail_gb),
                0.0,
            ),
            pool.storage,
        ),
    )
    effective_total = max(float(chosen.total_gb) * max(disk_overcommit_ratio, 1.0), 1.0)
    current_used = max(chosen.total_gb - chosen.avail_gb, 0.0)
    projected_share = _projected_share(
        used=current_used + float(disk_gb),
        total=effective_total,
    )
    return _StorageSelection(
        pool=chosen,
        projected_share=projected_share,
        speed_rank=_STORAGE_SPEED_RANK.get(chosen.speed_tier, 3),
        user_priority=int(chosen.user_priority or 5),
        contention_penalty=_storage_contention_penalty(
            projected_share=projected_share,
            placed_count=chosen.placed_count,
            overcommit_placed_count=chosen.overcommit_placed_count,
            tuning=tuning,
            overcommit=True,
        ),
    )


def _provisioned_current_node(request: VMRequest) -> str | None:
    if request.vmid is None:
        return None
    current = str(request.actual_node or "").strip()
    if current:
        return current
    assigned = str(request.assigned_node or "").strip()
    return assigned or None


def _build_rebalance_baseline_nodes(
    *,
    session: Session,
    requests: list[VMRequest],
) -> list[NodeCapacity]:
    nodes, resources = advisor_service._load_cluster_state()
    cpu_overcommit_ratio, disk_overcommit_ratio = get_overcommit_ratios(session)
    working_nodes = advisor_service._build_node_capacities(
        nodes=nodes,
        resources=resources,
        cpu_overcommit_ratio=cpu_overcommit_ratio,
        disk_overcommit_ratio=disk_overcommit_ratio,
    )
    for request in requests:
        if request.vmid is not None:
            _release_request_from_capacities(
                node_capacities=working_nodes,
                db_request=request,
                node_name=str(request.actual_node or request.assigned_node or ""),
            )
    return working_nodes


def _build_preview_vm_request(
    *,
    request: PlacementRequest,
    start_at: datetime,
    end_at: datetime,
) -> VMRequest:
    is_vm = str(request.resource_type) == "vm"
    return VMRequest(
        id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        reason="placement-preview",
        resource_type=str(request.resource_type),
        hostname="placement-preview",
        cores=int(request.cpu_cores or 1),
        memory=int(request.memory_mb or 512),
        password="preview",
        storage="preview",
        environment_type="Preview",
        start_at=start_at,
        end_at=end_at,
        ostemplate=None if is_vm else "preview",
        rootfs_size=None if is_vm else int(request.disk_gb or 0),
        unprivileged=True,
        template_id=1 if is_vm else None,
        disk_size=int(request.disk_gb or 0) if is_vm else None,
        username="preview" if is_vm else None,
        created_at=_utc_now(),
    )


def _reserve_storage_pool(
    *,
    selection: _StorageSelection,
    disk_gb: int,
    disk_overcommit_ratio: float,
) -> None:
    pool = selection.pool
    remaining_physical = max(float(pool.avail_gb), 0.0)
    requested = float(max(disk_gb, 0))
    if remaining_physical + 1e-9 >= requested:
        pool.avail_gb = max(remaining_physical - requested, 0.0)
        pool.placed_count += 1
        return

    current_used = max(pool.total_gb - remaining_physical, 0.0)
    effective_total = max(float(pool.total_gb) * max(disk_overcommit_ratio, 1.0), float(pool.total_gb))
    remaining_effective = max(effective_total - current_used, 0.0)
    if remaining_effective + 1e-9 >= requested:
        pool.avail_gb = max(remaining_physical - requested, 0.0)
        pool.overcommit_placed_count += 1
        return

    raise ValueError(f"Storage pool {pool.storage} does not have enough capacity")


def _refresh_node_candidate(node: NodeCapacity) -> None:
    node.guest_pressure_ratio = advisor_service._guest_pressure_ratio(
        int(node.running_resources),
        int(node.total_cpu_cores),
    )
    node.guest_overloaded = (
        node.guest_pressure_ratio >= advisor_service.settings.guest_pressure_threshold
    )
    node.candidate = (
        node.status == "online"
        and node.allocatable_cpu_cores > 0
        and node.allocatable_memory_bytes > 0
        and node.allocatable_disk_bytes > 0
        and not node.guest_overloaded
    )


def _release_request_from_capacities(
    *,
    node_capacities: list[NodeCapacity],
    db_request: VMRequest,
    node_name: str | None,
) -> None:
    if not node_name:
        return
    node = next((item for item in node_capacities if item.node == node_name), None)
    if node is None:
        return

    cpu_cores, memory_bytes, disk_bytes = _request_capacity_tuple(db_request)
    node.allocatable_cpu_cores = min(
        round(node.allocatable_cpu_cores + cpu_cores, 2),
        round(float(node.total_cpu_cores), 2),
    )
    node.allocatable_memory_bytes = min(
        node.allocatable_memory_bytes + memory_bytes,
        int(node.total_memory_bytes),
    )
    node.allocatable_disk_bytes = min(
        node.allocatable_disk_bytes + disk_bytes,
        int(node.total_disk_bytes),
    )
    node.running_resources = max(int(node.running_resources) - 1, 0)
    _refresh_node_candidate(node)


def _reserve_request_on_capacities(
    *,
    node_capacities: list[NodeCapacity],
    db_request: VMRequest,
    node_name: str,
) -> None:
    node = next((item for item in node_capacities if item.node == node_name), None)
    if node is None:
        raise ValueError(f"Target node {node_name} not found in capacity list")

    cpu_cores, memory_bytes, disk_bytes = _request_capacity_tuple(db_request)
    node.allocatable_cpu_cores = max(
        round(node.allocatable_cpu_cores - cpu_cores, 2),
        0.0,
    )
    node.allocatable_memory_bytes = max(node.allocatable_memory_bytes - memory_bytes, 0)
    node.allocatable_disk_bytes = max(node.allocatable_disk_bytes - disk_bytes, 0)
    node.running_resources = int(node.running_resources) + 1
    _refresh_node_candidate(node)


def _hour_window_iter(start_at: datetime, end_at: datetime) -> list[datetime]:
    if end_at <= start_at:
        return [start_at]
    cursor = start_at.replace(minute=0, second=0, microsecond=0)
    if cursor < start_at:
        cursor += timedelta(hours=1)
    checkpoints: list[datetime] = []
    while cursor < end_at:
        checkpoints.append(cursor)
        cursor += timedelta(hours=1)
    return checkpoints or [start_at]


def _apply_reserved_requests_to_capacities(
    *,
    baseline_capacities,
    reserved_requests: list[VMRequest],
    at_time: datetime,
):
    adjusted = [item.model_copy(deep=True) for item in baseline_capacities]
    by_node = {item.node: item for item in adjusted}

    for reserved in reserved_requests:
        reserved_start = _normalize_datetime(reserved.start_at)
        reserved_end = _normalize_datetime(reserved.end_at)
        assigned_node = str(reserved.assigned_node or "")
        if not reserved_start or not reserved_end or not assigned_node:
            continue
        if not (reserved_start <= at_time < reserved_end):
            continue

        node = by_node.get(assigned_node)
        if not node:
            continue

        reserved_cpu, reserved_memory, reserved_disk = _request_capacity_tuple(reserved)
        node.allocatable_cpu_cores = max(node.allocatable_cpu_cores - reserved_cpu, 0.0)
        node.allocatable_memory_bytes = max(node.allocatable_memory_bytes - reserved_memory, 0)
        node.allocatable_disk_bytes = max(node.allocatable_disk_bytes - reserved_disk, 0)
        node.candidate = (
            node.status == "online"
            and node.allocatable_cpu_cores > 0
            and node.allocatable_memory_bytes > 0
            and node.allocatable_disk_bytes > 0
        )

    return adjusted


def build_plan(
    *,
    session: Session,
    request: PlacementRequest,
    node_capacities: list[NodeCapacity],
    effective_resource_type: ResourceType,
    resource_type_reason: str,
    placement_strategy: str | None = None,
    node_priorities: dict[str, int] | None = None,
    current_node: str | None = None,
) -> PlacementPlan:
    strategy = _normalize_strategy(placement_strategy or get_placement_strategy(session))
    priorities = node_priorities or get_node_priorities(session)
    tuning = _get_placement_tuning(session=session)
    working_nodes = [item.model_copy(deep=True) for item in node_capacities]
    storage_pools_by_node, has_managed_storage = _build_storage_pool_state(
        session=session,
        node_names=[item.node for item in working_nodes],
    )
    _, disk_overcommit_ratio = get_overcommit_ratios(session)
    required_cpu = advisor_service._effective_cpu_cores(request, effective_resource_type)
    required_memory = advisor_service._effective_memory_bytes(request, effective_resource_type)
    required_disk = request.disk_gb * GIB
    placements: dict[str, int] = {item.node: 0 for item in working_nodes}
    remaining = request.instance_count

    while remaining > 0:
        candidates: list[tuple[NodeCapacity, _StorageSelection | None]] = []
        for item in working_nodes:
            if not item.candidate or not advisor_service._can_fit(
                item,
                cores=required_cpu,
                memory_bytes=required_memory,
                disk_bytes=required_disk,
                gpu_required=request.gpu_required,
            ):
                continue

            storage_selection: _StorageSelection | None = None
            if has_managed_storage:
                storage_selection = _select_best_storage_for_request(
                    storage_pools=storage_pools_by_node.get(item.node, []),
                    resource_type=str(request.resource_type),
                    disk_gb=int(request.disk_gb),
                    disk_overcommit_ratio=disk_overcommit_ratio,
                    tuning=tuning,
                )
                if storage_selection is None:
                    continue

            candidates.append((item, storage_selection))
        if not candidates:
            break

        chosen, chosen_storage = min(
            candidates,
            key=lambda candidate: _placement_sort_key(
                candidate[0],
                placements=placements,
                priorities=priorities,
                strategy=strategy,
                cores=required_cpu,
                memory_bytes=required_memory,
                disk_bytes=required_disk,
                storage_selection=candidate[1],
                tuning=tuning,
                current_node=current_node,
            ),
        )
        placements[chosen.node] += 1
        chosen.allocatable_cpu_cores = max(
            chosen.allocatable_cpu_cores - required_cpu,
            0.0,
        )
        chosen.allocatable_memory_bytes = max(
            chosen.allocatable_memory_bytes - required_memory,
            0,
        )
        chosen.allocatable_disk_bytes = max(
            chosen.allocatable_disk_bytes - required_disk,
            0,
        )
        chosen.running_resources += 1
        chosen.guest_pressure_ratio = advisor_service._guest_pressure_ratio(
            chosen.running_resources,
            int(chosen.total_cpu_cores),
        )
        chosen.guest_overloaded = (
            chosen.guest_pressure_ratio
            >= advisor_service.settings.guest_pressure_threshold
        )
        chosen.candidate = (
            chosen.status == "online"
            and chosen.allocatable_cpu_cores > 0
            and chosen.allocatable_memory_bytes > 0
            and chosen.allocatable_disk_bytes > 0
            and not chosen.guest_overloaded
        )
        if chosen_storage is not None:
            _reserve_storage_pool(
                selection=chosen_storage,
                disk_gb=int(request.disk_gb),
                disk_overcommit_ratio=disk_overcommit_ratio,
            )
        remaining -= 1

    assigned = request.instance_count - remaining
    placement_decisions = [
        PlacementDecision(
            node=item.node,
            instance_count=placements[item.node],
            cpu_cores_reserved=round(placements[item.node] * required_cpu, 2),
            memory_bytes_reserved=placements[item.node] * required_memory,
            disk_bytes_reserved=placements[item.node] * required_disk,
            remaining_cpu_cores=round(item.allocatable_cpu_cores, 2),
            remaining_memory_bytes=item.allocatable_memory_bytes,
            remaining_disk_bytes=item.allocatable_disk_bytes,
        )
        for item in working_nodes
        if placements[item.node] > 0
    ]
    placement_decisions.sort(key=lambda item: (-item.instance_count, item.node))

    return PlacementPlan(
        feasible=remaining == 0,
        requested_resource_type=request.resource_type,
        effective_resource_type=effective_resource_type,
        resource_type_reason=resource_type_reason,
        assigned_instances=assigned,
        unassigned_instances=remaining,
        recommended_node=placement_decisions[0].node if placement_decisions else None,
        summary=advisor_service._build_summary_text(
            request=request,
            placement_decisions=placement_decisions,
            effective_resource_type=effective_resource_type,
            assigned=assigned,
            remaining=remaining,
        ),
        rationale=advisor_service._build_rationale(
            request=request,
            placement_decisions=placement_decisions,
            effective_resource_type=effective_resource_type,
            node_capacities=node_capacities,
        ),
        warnings=advisor_service._build_warnings(
            node_capacities=node_capacities,
            request=request,
            effective_resource_type=effective_resource_type,
            remaining=remaining,
        ),
        placements=placement_decisions,
        candidate_nodes=node_capacities,
    )


def select_current_target_node(
    *,
    session: Session,
    db_request: VMRequest,
) -> CurrentPlacementSelection:
    request = _to_placement_request(db_request)
    nodes, resources = advisor_service._load_cluster_state()
    cpu_overcommit_ratio, disk_overcommit_ratio = get_overcommit_ratios(session)
    node_capacities = advisor_service._build_node_capacities(
        nodes=nodes,
        resources=resources,
        cpu_overcommit_ratio=cpu_overcommit_ratio,
        disk_overcommit_ratio=disk_overcommit_ratio,
    )
    effective_resource_type, resource_type_reason = advisor_service._decide_resource_type(
        request
    )
    plan = build_plan(
        session=session,
        request=request,
        node_capacities=node_capacities,
        effective_resource_type=effective_resource_type,
        resource_type_reason=resource_type_reason,
    )
    return CurrentPlacementSelection(
        node=plan.recommended_node,
        strategy=get_placement_strategy(session),
        plan=plan,
    )


def select_reserved_target_node(
    *,
    session: Session,
    db_request: VMRequest,
    reserved_requests: list[VMRequest] | None = None,
) -> CurrentPlacementSelection:
    start_at, end_at = _request_window(db_request)
    return select_reserved_target_node_for_request(
        session=session,
        request=_to_placement_request(db_request),
        start_at=start_at,
        end_at=end_at,
        reserved_requests=reserved_requests,
    )


def select_reserved_target_node_for_request(
    *,
    session: Session,
    request: PlacementRequest,
    start_at: datetime | None,
    end_at: datetime | None,
    reserved_requests: list[VMRequest] | None = None,
) -> CurrentPlacementSelection:
    if not start_at or not end_at:
        nodes, resources = advisor_service._load_cluster_state()
        cpu_overcommit_ratio, disk_overcommit_ratio = get_overcommit_ratios(session)
        node_capacities = advisor_service._build_node_capacities(
            nodes=nodes,
            resources=resources,
            cpu_overcommit_ratio=cpu_overcommit_ratio,
            disk_overcommit_ratio=disk_overcommit_ratio,
        )
        effective_resource_type, resource_type_reason = (
            advisor_service._decide_resource_type(request)
        )
        plan = build_plan(
            session=session,
            request=request,
            node_capacities=node_capacities,
            effective_resource_type=effective_resource_type,
            resource_type_reason=resource_type_reason,
        )
        return CurrentPlacementSelection(
            node=plan.recommended_node,
            strategy=get_placement_strategy(session),
            plan=plan,
        )

    nodes, resources = advisor_service._load_cluster_state()
    cpu_overcommit_ratio, disk_overcommit_ratio = get_overcommit_ratios(session)
    baseline_capacities = advisor_service._build_node_capacities(
        nodes=nodes,
        resources=resources,
        cpu_overcommit_ratio=cpu_overcommit_ratio,
        disk_overcommit_ratio=disk_overcommit_ratio,
    )
    effective_resource_type, resource_type_reason = advisor_service._decide_resource_type(
        request
    )
    if reserved_requests is None:
        reserved_requests = vm_request_repo.get_approved_vm_requests_overlapping_window(
            session=session,
            window_start=start_at,
            window_end=end_at,
        )
    checkpoints = [start_at] + [
        checkpoint
        for checkpoint in _hour_window_iter(start_at, end_at)
        if checkpoint != start_at
    ]

    feasible_nodes = {item.node for item in baseline_capacities}
    start_capacities = baseline_capacities

    for index, checkpoint in enumerate(checkpoints):
        adjusted_capacities = _apply_reserved_requests_to_capacities(
            baseline_capacities=baseline_capacities,
            reserved_requests=reserved_requests,
            at_time=checkpoint,
        )
        if index == 0:
            start_capacities = adjusted_capacities

        hour_feasible_nodes = {
            item.node
            for item in adjusted_capacities
            if advisor_service._can_fit(
                item,
                cores=advisor_service._effective_cpu_cores(
                    request, effective_resource_type
                ),
                memory_bytes=advisor_service._effective_memory_bytes(
                    request, effective_resource_type
                ),
                disk_bytes=request.disk_gb * GIB,
                gpu_required=request.gpu_required,
            )
        }
        feasible_nodes &= hour_feasible_nodes
        if not feasible_nodes:
            break

    strategy = get_placement_strategy(session)
    if not feasible_nodes:
        return CurrentPlacementSelection(
            node=None,
            strategy=strategy,
            plan=build_plan(
                session=session,
                request=request,
                node_capacities=[],
                effective_resource_type=effective_resource_type,
                resource_type_reason=resource_type_reason,
                placement_strategy=strategy,
                node_priorities=get_node_priorities(session),
            ),
        )

    filtered_start_capacities = [
        item for item in start_capacities if item.node in feasible_nodes
    ]
    plan = build_plan(
        session=session,
        request=request,
        node_capacities=filtered_start_capacities,
        effective_resource_type=effective_resource_type,
        resource_type_reason=resource_type_reason,
        placement_strategy=strategy,
        node_priorities=get_node_priorities(session),
    )
    overlapping_start_requests = [
        item
        for item in reserved_requests
        if (window := _request_window(item))[0] is not None
        and window[1] is not None
        and window[0] <= start_at < window[1]
    ]
    preview_request = _build_preview_vm_request(
        request=request,
        start_at=start_at,
        end_at=end_at,
    )
    preview_cohort = overlapping_start_requests + [preview_request]
    preview_ordered_requests = sorted(
        preview_cohort,
        key=lambda item: (
            _normalize_datetime(item.start_at) or datetime.min.replace(tzinfo=UTC),
            _normalize_datetime(item.reviewed_at) or datetime.min.replace(tzinfo=UTC),
            _normalize_datetime(item.created_at) or datetime.min.replace(tzinfo=UTC),
            str(item.id),
        ),
    )
    preview_baseline_nodes = _build_rebalance_baseline_nodes(
        session=session,
        requests=preview_ordered_requests,
    )
    preview_baseline_nodes = [
        item.model_copy(deep=True)
        for item in preview_baseline_nodes
        if item.node in feasible_nodes
    ]
    priorities = get_node_priorities(session)
    tuning = _get_placement_tuning(session=session)
    best_preview_node = plan.recommended_node
    best_preview_objective: tuple[float, float, float, int] | None = None
    candidate_evals: dict[str, _AssignmentEvaluation] = {}
    for candidate_node in sorted(feasible_nodes):
        try:
            preview_assignments = _solve_rebalance_assignments(
                session=session,
                ordered_requests=preview_ordered_requests,
                baseline_nodes=preview_baseline_nodes,
                strategy=strategy,
                priorities=priorities,
                tuning=tuning,
                fixed_assignments={preview_request.id: candidate_node},
            )
            preview_eval = _evaluate_active_assignment_map(
                session=session,
                ordered_requests=preview_ordered_requests,
                baseline_nodes=preview_baseline_nodes,
                assignments=preview_assignments,
                priorities=priorities,
                tuning=tuning,
            )
        except ValueError:
            continue
        if not preview_eval.feasible:
            continue
        candidate_evals[candidate_node] = preview_eval
        if (
            best_preview_objective is None
            or preview_eval.objective < best_preview_objective
        ):
            best_preview_objective = preview_eval.objective
            best_preview_node = candidate_node
    preview_reasons = (
        _build_preview_selection_reasons(
            selected_node=best_preview_node,
            selected_eval=candidate_evals[best_preview_node],
            candidate_evals=candidate_evals,
            priorities=priorities,
        )
        if best_preview_node and best_preview_node in candidate_evals
        else list(plan.rationale or [])
    )
    return CurrentPlacementSelection(
        node=best_preview_node,
        strategy=strategy,
        plan=plan.model_copy(
            update={
                "recommended_node": best_preview_node,
                "summary": (
                    "Reservation preview selected the best feasible node "
                    "using the same active-window rebalance objective."
                ),
                "rationale": preview_reasons,
            }
        ),
    )


def _evaluate_active_assignment_map(
    *,
    session: Session,
    ordered_requests: list[VMRequest],
    baseline_nodes: list[NodeCapacity],
    assignments: dict[uuid.UUID, str],
    priorities: dict[str, int],
    tuning: _PlacementTuning,
) -> _AssignmentEvaluation:
    working_nodes = [item.model_copy(deep=True) for item in baseline_nodes]
    by_node = {item.node: item for item in working_nodes}
    storage_pools_by_node, has_managed_storage = _build_storage_pool_state(
        session=session,
        node_names=[item.node for item in working_nodes],
    )
    _, disk_overcommit_ratio = get_overcommit_ratios(session)
    storage_penalty_total = 0.0
    priority_total = 0.0
    movement_count = 0

    for request in ordered_requests:
        target_node = assignments.get(request.id)
        if not target_node:
            return _AssignmentEvaluation(
                feasible=False,
                objective=(float("inf"), float("inf"), 10**9, float("inf")),
            )
        node = by_node.get(target_node)
        if node is None:
            return _AssignmentEvaluation(
                feasible=False,
                objective=(float("inf"), float("inf"), 10**9, float("inf")),
            )

        placement_request = _to_placement_request(request)
        effective_resource_type, _ = advisor_service._decide_resource_type(
            placement_request
        )
        required_cpu = advisor_service._effective_cpu_cores(
            placement_request,
            effective_resource_type,
        )
        required_memory = advisor_service._effective_memory_bytes(
            placement_request,
            effective_resource_type,
        )
        required_disk = placement_request.disk_gb * GIB
        if not node.candidate or not advisor_service._can_fit(
            node,
            cores=required_cpu,
            memory_bytes=required_memory,
            disk_bytes=required_disk,
            gpu_required=placement_request.gpu_required,
        ):
            return _AssignmentEvaluation(
                feasible=False,
                objective=(float("inf"), float("inf"), 10**9, float("inf")),
            )

        storage_selection: _StorageSelection | None = None
        if has_managed_storage:
            storage_selection = _select_best_storage_for_request(
                storage_pools=storage_pools_by_node.get(target_node, []),
                resource_type=str(placement_request.resource_type),
                disk_gb=int(placement_request.disk_gb),
                disk_overcommit_ratio=disk_overcommit_ratio,
                tuning=tuning,
            )
            if storage_selection is None:
                return _AssignmentEvaluation(
                    feasible=False,
                    objective=(float("inf"), float("inf"), 10**9, float("inf")),
                )

        _reserve_request_on_capacities(
            node_capacities=working_nodes,
            db_request=request,
            node_name=target_node,
        )
        if storage_selection is not None:
            _reserve_storage_pool(
                selection=storage_selection,
                disk_gb=int(placement_request.disk_gb),
                disk_overcommit_ratio=disk_overcommit_ratio,
            )
            storage_penalty_total += storage_selection.contention_penalty
        priority_total += float(priorities.get(target_node, 5))
        if _provisioned_current_node(request) not in {None, target_node}:
            movement_count += 1

    node_score_map = {
        node.node: _node_balance_score(node, tuning=tuning) for node in working_nodes
    }
    max_node_score = max(node_score_map.values(), default=0.0)
    total_score = (
        sum(node_score_map.values())
        + (storage_penalty_total * tuning.disk_penalty_weight)
        + (movement_count * tuning.migration_cost)
    )
    return _AssignmentEvaluation(
        feasible=True,
        objective=(max_node_score, total_score, priority_total, movement_count),
        max_node_score=max_node_score,
        total_score=total_score,
        priority_total=priority_total,
        movement_count=movement_count,
        node_scores=node_score_map,
        storage_penalties={
            node_name: sum(
                _storage_contention_penalty(
                    projected_share=_projected_share(
                        used=max(pool.total_gb - pool.avail_gb, 0.0),
                        total=max(pool.total_gb, 1.0),
                    ),
                    placed_count=pool.placed_count,
                    overcommit_placed_count=pool.overcommit_placed_count,
                    tuning=tuning,
                    overcommit=pool.overcommit_placed_count > 0,
                )
                for pool in storage_pools_by_node.get(node_name, [])
            )
            for node_name in by_node
        },
    )


def _initial_active_assignment_map(
    *,
    session: Session,
    ordered_requests: list[VMRequest],
    baseline_nodes: list[NodeCapacity],
    strategy: str,
    priorities: dict[str, int],
    tuning: _PlacementTuning,
    fixed_assignments: dict[uuid.UUID, str] | None = None,
) -> dict[uuid.UUID, str]:
    working_nodes = [item.model_copy(deep=True) for item in baseline_nodes]
    storage_pools_by_node, has_managed_storage = _build_storage_pool_state(
        session=session,
        node_names=[item.node for item in working_nodes],
    )
    _, disk_overcommit_ratio = get_overcommit_ratios(session)
    placements: dict[str, int] = {item.node: 0 for item in working_nodes}
    assignments: dict[uuid.UUID, str] = {}
    locked_nodes = fixed_assignments or {}

    for request in ordered_requests:
        placement_request = _to_placement_request(request)
        effective_resource_type, resource_type_reason = advisor_service._decide_resource_type(
            placement_request
        )
        required_cpu = advisor_service._effective_cpu_cores(
            placement_request,
            effective_resource_type,
        )
        required_memory = advisor_service._effective_memory_bytes(
            placement_request,
            effective_resource_type,
        )
        required_disk = placement_request.disk_gb * GIB
        candidates: list[tuple[NodeCapacity, _StorageSelection | None]] = []
        for item in working_nodes:
            forced_node = locked_nodes.get(request.id)
            if forced_node and item.node != forced_node:
                continue
            if not item.candidate or not advisor_service._can_fit(
                item,
                cores=required_cpu,
                memory_bytes=required_memory,
                disk_bytes=required_disk,
                gpu_required=placement_request.gpu_required,
            ):
                continue

            storage_selection: _StorageSelection | None = None
            if has_managed_storage:
                storage_selection = _select_best_storage_for_request(
                    storage_pools=storage_pools_by_node.get(item.node, []),
                    resource_type=str(placement_request.resource_type),
                    disk_gb=int(placement_request.disk_gb),
                    disk_overcommit_ratio=disk_overcommit_ratio,
                    tuning=tuning,
                )
                if storage_selection is None:
                    continue
            candidates.append((item, storage_selection))

        if not candidates:
            raise ValueError(f"No feasible active rebalance exists for request {request.id}")

        chosen, chosen_storage = min(
            candidates,
            key=lambda candidate: _placement_sort_key(
                candidate[0],
                placements=placements,
                priorities=priorities,
                strategy=strategy,
                cores=required_cpu,
                memory_bytes=required_memory,
                disk_bytes=required_disk,
                storage_selection=candidate[1],
                tuning=tuning,
                current_node=_provisioned_current_node(request),
            ),
        )
        assignments[request.id] = chosen.node
        placements[chosen.node] += 1
        _reserve_request_on_capacities(
            node_capacities=working_nodes,
            db_request=request,
            node_name=chosen.node,
        )
        if chosen_storage is not None:
            _reserve_storage_pool(
                selection=chosen_storage,
                disk_gb=int(placement_request.disk_gb),
                disk_overcommit_ratio=disk_overcommit_ratio,
            )

    return assignments


def _run_local_rebalance_search(
    *,
    session: Session,
    ordered_requests: list[VMRequest],
    baseline_nodes: list[NodeCapacity],
    initial_assignments: dict[uuid.UUID, str],
    priorities: dict[str, int],
    tuning: _PlacementTuning,
    locked_request_ids: set[uuid.UUID] | None = None,
) -> dict[uuid.UUID, str]:
    if tuning.search_depth <= 0 or tuning.search_max_relocations <= 0:
        return initial_assignments

    current_assignments = dict(initial_assignments)
    locked_ids = locked_request_ids or set()
    current_eval = _evaluate_active_assignment_map(
        session=session,
        ordered_requests=ordered_requests,
        baseline_nodes=baseline_nodes,
        assignments=current_assignments,
        priorities=priorities,
        tuning=tuning,
    )
    if not current_eval.feasible:
        return initial_assignments

    node_names = [item.node for item in baseline_nodes]
    used_moves = 0

    for _ in range(tuning.search_depth):
        if used_moves >= tuning.search_max_relocations:
            break

        best_assignments: dict[uuid.UUID, str] | None = None
        best_eval: _AssignmentEvaluation | None = None
        best_move_cost = 0

        for request in ordered_requests:
            if request.id in locked_ids:
                continue
            current_node = current_assignments.get(request.id)
            if not current_node:
                continue
            for candidate_node in node_names:
                if candidate_node == current_node:
                    continue
                trial_assignments = dict(current_assignments)
                trial_assignments[request.id] = candidate_node
                trial_eval = _evaluate_active_assignment_map(
                    session=session,
                    ordered_requests=ordered_requests,
                    baseline_nodes=baseline_nodes,
                    assignments=trial_assignments,
                    priorities=priorities,
                    tuning=tuning,
                )
                if not trial_eval.feasible or trial_eval.objective >= current_eval.objective:
                    continue
                if best_eval is None or trial_eval.objective < best_eval.objective:
                    best_assignments = trial_assignments
                    best_eval = trial_eval
                    best_move_cost = 1

        if used_moves + 2 <= tuning.search_max_relocations:
            for index, request_a in enumerate(ordered_requests):
                if request_a.id in locked_ids:
                    continue
                node_a = current_assignments.get(request_a.id)
                if not node_a:
                    continue
                for request_b in ordered_requests[index + 1 :]:
                    if request_b.id in locked_ids:
                        continue
                    node_b = current_assignments.get(request_b.id)
                    if not node_b or node_a == node_b:
                        continue
                    trial_assignments = dict(current_assignments)
                    trial_assignments[request_a.id] = node_b
                    trial_assignments[request_b.id] = node_a
                    trial_eval = _evaluate_active_assignment_map(
                        session=session,
                        ordered_requests=ordered_requests,
                        baseline_nodes=baseline_nodes,
                        assignments=trial_assignments,
                        priorities=priorities,
                        tuning=tuning,
                    )
                    if not trial_eval.feasible or trial_eval.objective >= current_eval.objective:
                        continue
                    if best_eval is None or trial_eval.objective < best_eval.objective:
                        best_assignments = trial_assignments
                        best_eval = trial_eval
                        best_move_cost = 2

        if best_assignments is None or best_eval is None:
            break
        current_assignments = best_assignments
        current_eval = best_eval
        used_moves += best_move_cost

    return current_assignments


def _solve_rebalance_assignments(
    *,
    session: Session,
    ordered_requests: list[VMRequest],
    baseline_nodes: list[NodeCapacity],
    strategy: str,
    priorities: dict[str, int],
    tuning: _PlacementTuning,
    fixed_assignments: dict[uuid.UUID, str] | None = None,
) -> dict[uuid.UUID, str]:
    initial_assignments = _initial_active_assignment_map(
        session=session,
        ordered_requests=ordered_requests,
        baseline_nodes=baseline_nodes,
        strategy=strategy,
        priorities=priorities,
        tuning=tuning,
        fixed_assignments=fixed_assignments,
    )
    final_assignments = _run_local_rebalance_search(
        session=session,
        ordered_requests=ordered_requests,
        baseline_nodes=baseline_nodes,
        initial_assignments=initial_assignments,
        priorities=priorities,
        tuning=tuning,
        locked_request_ids=set((fixed_assignments or {}).keys()),
    )
    final_eval = _evaluate_active_assignment_map(
        session=session,
        ordered_requests=ordered_requests,
        baseline_nodes=baseline_nodes,
        assignments=final_assignments,
        priorities=priorities,
        tuning=tuning,
    )
    if not final_eval.feasible:
        raise ValueError("No feasible active rebalance exists for the current request cohort")
    return final_assignments


def _build_preview_selection_reasons(
    *,
    selected_node: str,
    selected_eval: _AssignmentEvaluation,
    candidate_evals: dict[str, _AssignmentEvaluation],
    priorities: dict[str, int],
) -> list[str]:
    alternatives = [
        (node, evaluation)
        for node, evaluation in candidate_evals.items()
        if node != selected_node and evaluation.feasible
    ]
    if not alternatives:
        return [f"因為 {selected_node} 是目前這個時段唯一可行的節點。"]

    runner_up_node, runner_up_eval = min(alternatives, key=lambda item: item[1].objective)
    reasons = [
        (
            f"因為把本次申請放在 {selected_node}，可以讓這個時段整體 cohort "
            "的最大節點負載分數更低。"
        )
    ]

    if selected_eval.max_node_score + 0.01 < runner_up_eval.max_node_score:
        bottleneck_node = max(
            (runner_up_eval.node_scores or {}).items(),
            key=lambda item: item[1],
            default=(runner_up_node, runner_up_eval.max_node_score),
        )[0]
        reasons.append(f"因為可降低 {bottleneck_node} 的整體負載尖峰風險。")

    selected_storage_penalty = (selected_eval.storage_penalties or {}).get(selected_node, 0.0)
    runner_up_storage_penalty = (runner_up_eval.storage_penalties or {}).get(
        runner_up_node,
        0.0,
    )
    if selected_storage_penalty + 0.08 < runner_up_storage_penalty:
        reasons.append(
            f"因為 {selected_node} 的磁碟 contention 風險較低，可避免把壓力集中到 {runner_up_node}。"
        )

    if selected_eval.movement_count < runner_up_eval.movement_count:
        delta = runner_up_eval.movement_count - selected_eval.movement_count
        reasons.append(f"因為不需要多搬 {delta} 台 VM。")

    selected_priority = priorities.get(selected_node, 5)
    runner_up_priority = priorities.get(runner_up_node, 5)
    if (
        selected_priority < runner_up_priority
        and abs(selected_eval.total_score - runner_up_eval.total_score) <= 0.15
    ):
        reasons.append(
            f"在平衡結果接近時，{selected_node} 的節點優先級也比較高。"
        )

    return reasons[:4]


def rebuild_reserved_assignments(
    *,
    session: Session,
    requests: list[VMRequest],
) -> dict[uuid.UUID, CurrentPlacementSelection]:
    """Rebuild node reservations for all approved requests in chronological order."""
    ordered_requests = sorted(
        requests,
        key=lambda item: (
            _normalize_datetime(item.start_at) or datetime.min.replace(tzinfo=UTC),
            _normalize_datetime(item.reviewed_at) or datetime.min.replace(tzinfo=UTC),
            _normalize_datetime(item.created_at) or datetime.min.replace(tzinfo=UTC),
            str(item.id),
        ),
    )
    reserved_so_far: list[VMRequest] = []
    selections: dict[uuid.UUID, CurrentPlacementSelection] = {}

    for request in ordered_requests:
        selection = select_reserved_target_node(
            session=session,
            db_request=request,
            reserved_requests=reserved_so_far,
        )
        if not selection.node or not selection.plan.feasible:
            raise ValueError(
                f"No feasible reservation exists for request {request.id}"
            )
        request.assigned_node = selection.node
        request.placement_strategy_used = selection.strategy
        selections[request.id] = selection
        reserved_so_far.append(request)

    return selections


def rebalance_active_assignments(
    *,
    session: Session,
    requests: list[VMRequest],
) -> dict[uuid.UUID, CurrentPlacementSelection]:
    ordered_requests = sorted(
        requests,
        key=lambda item: (
            _normalize_datetime(item.start_at) or datetime.min.replace(tzinfo=UTC),
            _normalize_datetime(item.reviewed_at) or datetime.min.replace(tzinfo=UTC),
            _normalize_datetime(item.created_at) or datetime.min.replace(tzinfo=UTC),
            str(item.id),
        ),
    )
    working_nodes = _build_rebalance_baseline_nodes(
        session=session,
        requests=ordered_requests,
    )
    strategy = get_placement_strategy(session)
    priorities = get_node_priorities(session)
    tuning = _get_placement_tuning(session=session)

    baseline_nodes = [item.model_copy(deep=True) for item in working_nodes]
    final_assignments = _solve_rebalance_assignments(
        session=session,
        ordered_requests=ordered_requests,
        baseline_nodes=baseline_nodes,
        strategy=strategy,
        priorities=priorities,
        tuning=tuning,
    )

    selections: dict[uuid.UUID, CurrentPlacementSelection] = {}
    for request in ordered_requests:
        placement_request = _to_placement_request(request)
        effective_resource_type, resource_type_reason = advisor_service._decide_resource_type(
            placement_request
        )
        chosen_node = final_assignments.get(request.id)
        if not chosen_node:
            raise ValueError(f"No feasible active rebalance exists for request {request.id}")
        selections[request.id] = CurrentPlacementSelection(
            node=chosen_node,
            strategy=strategy,
            plan=PlacementPlan(
                feasible=True,
                requested_resource_type=placement_request.resource_type,
                effective_resource_type=effective_resource_type,
                resource_type_reason=resource_type_reason,
                assigned_instances=1,
                unassigned_instances=0,
                recommended_node=chosen_node,
                summary=(
                    "Active window rebalance selected the best feasible node "
                    "after greedy placement and local rebalance search."
                ),
                rationale=[],
                warnings=[],
                placements=[],
                candidate_nodes=baseline_nodes,
            ),
        )

    return selections


def get_placement_strategy(session: Session) -> str:
    config = proxmox_config_repo.get_proxmox_config(session)
    if not config:
        return "priority_dominant_share"
    return _normalize_strategy(config.placement_strategy)


def get_overcommit_ratios(session: Session) -> tuple[float, float]:
    config = proxmox_config_repo.get_proxmox_config(session)
    if not config:
        return 1.0, 1.0

    return (
        max(float(config.cpu_overcommit_ratio or 1.0), 1.0),
        max(float(config.disk_overcommit_ratio or 1.0), 1.0),
    )


def get_node_priorities(session: Session) -> dict[str, int]:
    return {item.name: int(item.priority) for item in proxmox_node_repo.get_all_nodes(session)}


def select_best_storage_name(
    *,
    session: Session,
    node_name: str,
    resource_type: str,
    disk_gb: int,
    fallback_storage: str | None = None,
) -> str | None:
    storage_pools_by_node, has_managed_storage = _build_storage_pool_state(
        session=session,
        node_names=[node_name],
    )
    if not has_managed_storage:
        return fallback_storage

    _, disk_overcommit_ratio = get_overcommit_ratios(session)
    selection = _select_best_storage_for_request(
        storage_pools=storage_pools_by_node.get(node_name, []),
        resource_type=resource_type,
        disk_gb=disk_gb,
        disk_overcommit_ratio=disk_overcommit_ratio,
        tuning=_get_placement_tuning(session=session),
    )
    if selection is None:
        return None
    return selection.pool.storage


def _placement_sort_key(
    node: NodeCapacity,
    *,
    placements: dict[str, int],
    priorities: dict[str, int],
    strategy: str,
    cores: float,
    memory_bytes: int,
    disk_bytes: int,
    storage_selection: _StorageSelection | None = None,
    tuning: _PlacementTuning | None = None,
    current_node: str | None = None,
) -> tuple:
    tuning = tuning or _PlacementTuning(
        migration_cost=0.15,
        peak_cpu_margin=1.1,
        peak_memory_margin=1.05,
        loadavg_warn_per_core=0.8,
        loadavg_max_per_core=1.5,
        loadavg_penalty_weight=0.9,
        disk_contention_warn_share=0.7,
        disk_contention_high_share=0.9,
        disk_penalty_weight=0.75,
        search_max_relocations=2,
        search_depth=3,
    )
    projected_cpu_share = _projected_share(
        used=max(node.total_cpu_cores - node.allocatable_cpu_cores, 0.0) + cores,
        total=max(node.total_cpu_cores, 1.0),
    )
    projected_memory_share = _projected_share(
        used=max(node.total_memory_bytes - node.allocatable_memory_bytes, 0) + memory_bytes,
        total=max(node.total_memory_bytes, 1),
    )
    projected_disk_share = _projected_share(
        used=max(node.total_disk_bytes - node.allocatable_disk_bytes, 0) + disk_bytes,
        total=max(node.total_disk_bytes, 1),
    )
    dominant_share = max(projected_cpu_share, projected_memory_share, projected_disk_share)
    average_share = (
        projected_cpu_share + projected_memory_share + projected_disk_share
    ) / 3.0
    peak_penalty = _peak_penalty(
        projected_cpu_share=_projected_share(
            used=max(node.total_cpu_cores - node.allocatable_cpu_cores, 0.0)
            + (cores * tuning.peak_cpu_margin),
            total=max(node.total_cpu_cores, 1.0),
        ),
        projected_memory_share=_projected_share(
            used=max(node.total_memory_bytes - node.allocatable_memory_bytes, 0)
            + int(memory_bytes * tuning.peak_memory_margin),
            total=max(node.total_memory_bytes, 1),
        ),
    )
    loadavg_penalty = _loadavg_penalty(
        _reference_loadavg_per_core(node),
        tuning=tuning,
    )
    migration_penalty = (
        tuning.migration_cost
        if current_node and current_node != node.node
        else 0.0
    )
    disk_penalty = (
        storage_selection.contention_penalty * tuning.disk_penalty_weight
        if storage_selection is not None
        else 0.0
    )
    total_score = (
        dominant_share
        + peak_penalty
        + (loadavg_penalty * tuning.loadavg_penalty_weight)
        + migration_penalty
        + disk_penalty
    )
    placement_count = placements.get(node.node, 0)
    storage_speed_rank = (
        storage_selection.speed_rank if storage_selection is not None else 99
    )
    storage_user_priority = (
        storage_selection.user_priority if storage_selection is not None else 99
    )
    storage_projected_share = (
        storage_selection.projected_share if storage_selection is not None else 1.0
    )

    return (
        total_score,
        dominant_share,
        average_share,
        priorities.get(node.node, 5),
        placement_count,
        projected_cpu_share,
        storage_speed_rank,
        storage_user_priority,
        storage_projected_share,
        node.node,
    )


def _normalize_strategy(strategy: str | None) -> str:
    # The scheduler now always respects node priority first.
    # When priorities are equal, placement_count + dominant share keep distribution fair.
    return "priority_dominant_share"


def _projected_share(*, used: float | int, total: float | int) -> float:
    denominator = float(total or 1.0)
    return float(used) / denominator if denominator > 0 else 1.0


def _storage_contention_penalty(
    *,
    projected_share: float,
    placed_count: int,
    overcommit_placed_count: int,
    tuning: _PlacementTuning,
    overcommit: bool,
) -> float:
    share_penalty = _linear_penalty(
        projected_share,
        low=tuning.disk_contention_warn_share,
        high=max(
            tuning.disk_contention_high_share,
            tuning.disk_contention_warn_share + 0.01,
        ),
    )
    placement_penalty = min(
        (max(int(placed_count), 0) + max(int(overcommit_placed_count), 0)) / 6.0,
        1.0,
    ) * 0.35
    overcommit_penalty = 0.5 if overcommit else 0.0
    return share_penalty + placement_penalty + overcommit_penalty


def _node_balance_score(node: NodeCapacity, *, tuning: _PlacementTuning) -> float:
    cpu_share = _projected_share(
        used=max(node.total_cpu_cores - node.allocatable_cpu_cores, 0.0),
        total=max(node.total_cpu_cores, 1.0),
    )
    memory_share = _projected_share(
        used=max(node.total_memory_bytes - node.allocatable_memory_bytes, 0),
        total=max(node.total_memory_bytes, 1),
    )
    disk_share = _projected_share(
        used=max(node.total_disk_bytes - node.allocatable_disk_bytes, 0),
        total=max(node.total_disk_bytes, 1),
    )
    dominant_share = max(cpu_share, memory_share, disk_share)
    average_share = (cpu_share + memory_share + disk_share) / 3.0
    return (
        dominant_share
        + (average_share * 0.2)
        + _peak_penalty(
            projected_cpu_share=cpu_share,
            projected_memory_share=memory_share,
        )
        + (
            _loadavg_penalty(
                _reference_loadavg_per_core(node),
                tuning=tuning,
            )
            * tuning.loadavg_penalty_weight
        )
    )


def _peak_penalty(
    *,
    projected_cpu_share: float,
    projected_memory_share: float,
) -> float:
    return max(
        _linear_penalty(
            projected_cpu_share,
            low=_CPU_PEAK_WARN_SHARE,
            high=_CPU_PEAK_HIGH_SHARE,
        ),
        _linear_penalty(
            projected_memory_share,
            low=_RAM_PEAK_WARN_SHARE,
            high=_RAM_PEAK_HIGH_SHARE,
        ),
    )


def _loadavg_penalty(
    loadavg_per_core: float | None,
    *,
    tuning: _PlacementTuning,
) -> float:
    if loadavg_per_core is None or loadavg_per_core <= tuning.loadavg_warn_per_core:
        return 0.0
    if loadavg_per_core >= tuning.loadavg_max_per_core:
        return 1.0
    denominator = max(
        tuning.loadavg_max_per_core - tuning.loadavg_warn_per_core,
        0.01,
    )
    return (loadavg_per_core - tuning.loadavg_warn_per_core) / denominator


def _reference_loadavg_per_core(node: NodeCapacity) -> float | None:
    total_cpu = max(float(node.total_cpu_cores or 0.0), 0.0)
    if total_cpu <= 0:
        return None
    reference = max(
        float(node.current_loadavg_1 or 0.0),
        float(node.average_loadavg_1 or 0.0),
    )
    if reference <= 0:
        return None
    return reference / total_cpu


def _linear_penalty(value: float, *, low: float, high: float) -> float:
    if value <= low:
        return 0.0
    if value >= high:
        return 1.0
    denominator = max(high - low, 0.0001)
    return (value - low) / denominator


def _to_placement_request(db_request: VMRequest) -> PlacementRequest:
    disk_gb = (
        int(db_request.disk_size or 0)
        if db_request.resource_type == "vm"
        else int(db_request.rootfs_size or 0)
    )
    if disk_gb <= 0:
        disk_gb = 20 if db_request.resource_type == "vm" else 8

    return PlacementRequest(
        resource_type=db_request.resource_type,
        cpu_cores=int(db_request.cores or 1),
        memory_mb=int(db_request.memory or 512),
        disk_gb=disk_gb,
        instance_count=1,
        gpu_required=0,
    )
