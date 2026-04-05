from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime

from sqlmodel import Session, select

from app.core.db import engine
from app.exceptions import NotFoundError
from app.models import VMMigrationStatus, VMRequest, VMRequestStatus
from app.repositories import resource as resource_repo
from app.repositories import vm_request as vm_request_repo
from app.services import (
    audit_service,
    provisioning_service,
    proxmox_service,
    vm_request_placement_service,
)

logger = logging.getLogger(__name__)

SCHEDULER_POLL_SECONDS = 60
_VM_DISK_PREFIXES = ("scsi", "sata", "ide", "virtio", "efidisk", "tpmstate")
_LXC_MOUNT_PREFIXES = ("rootfs", "mp")


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _resource_type_for_request(request: VMRequest) -> str:
    return "lxc" if request.resource_type == "lxc" else "qemu"


def _find_existing_resource_for_request(
    *,
    session: Session,
    request: VMRequest,
) -> dict | None:
    expected_type = _resource_type_for_request(request)
    claimed_vmids = {
        int(item.vmid)
        for item in session.exec(
            select(VMRequest).where(
                VMRequest.status == VMRequestStatus.approved,
                VMRequest.vmid.is_not(None),
                VMRequest.id != request.id,
            )
        )
        .all()
        if item.vmid is not None
    }
    for resource in proxmox_service.list_all_resources():
        if str(resource.get("type") or "") != expected_type:
            continue
        if str(resource.get("name") or "") != str(request.hostname or ""):
            continue
        vmid = int(resource.get("vmid"))
        if vmid in claimed_vmids:
            continue
        pool = str(resource.get("pool") or "")
        if pool and pool != "CampusCloud":
            continue
        return resource
    return None


def _adopt_or_provision_due_request(
    *,
    session: Session,
    request: VMRequest,
) -> tuple[int, str, str | None, bool]:
    resource_type = _resource_type_for_request(request)
    existing_resource = _find_existing_resource_for_request(
        session=session,
        request=request,
    )
    desired_node = str(request.desired_node or request.assigned_node or "")
    placement_strategy_used = (
        request.placement_strategy_used or "priority_dominant_share"
    )

    if existing_resource is not None:
        vmid = int(existing_resource["vmid"])
        actual_node = str(existing_resource["node"])
        if not resource_repo.get_resource_by_vmid(
            session=session,
            vmid=vmid,
        ):
            resource_repo.create_resource(
                session=session,
                vmid=vmid,
                user_id=request.user_id,
                environment_type=request.environment_type,
                os_info=request.os_info,
                expiry_date=request.expiry_date,
                template_id=request.template_id,
                commit=False,
            )
        vm_request_repo.update_vm_request_provisioning(
            session=session,
            db_request=request,
            vmid=vmid,
            assigned_node=desired_node or actual_node,
            desired_node=desired_node or actual_node,
            actual_node=actual_node,
            placement_strategy_used=placement_strategy_used,
            migration_status=(
                VMMigrationStatus.pending
                if desired_node and desired_node != actual_node
                else VMMigrationStatus.idle
            ),
            migration_error=None,
            commit=False,
        )
        status = proxmox_service.get_status(
            actual_node,
            vmid,
            resource_type,
        )
        started = False
        if str(status.get("status") or "").lower() != "running":
            proxmox_service.control(
                actual_node,
                vmid,
                resource_type,
                "start",
            )
            started = True
        audit_service.log_action(
            session=session,
            user_id=None,
            vmid=vmid,
            action="resource_start",
            details=(
                "Scheduled provisioning adopted an existing resource for approved "
                f"{request.resource_type} request {request.id}"
            ),
            commit=False,
        )
        logger.warning(
            "Adopted existing %s resource VMID %s for approved request %s",
            resource_type,
            vmid,
            request.id,
        )
        return vmid, actual_node, placement_strategy_used, started

    vmid, actual_node, placement_strategy_used = (
        provisioning_service.provision_from_request(
            session=session,
            db_request=request,
        )
    )
    vm_request_repo.update_vm_request_provisioning(
        session=session,
        db_request=request,
        vmid=vmid,
        assigned_node=desired_node or actual_node,
        desired_node=desired_node or actual_node,
        actual_node=actual_node,
        placement_strategy_used=placement_strategy_used,
        migration_status=(
            VMMigrationStatus.pending
            if desired_node and desired_node != actual_node
            else VMMigrationStatus.completed
        ),
        migration_error=None,
        commit=False,
    )
    audit_service.log_action(
        session=session,
        user_id=None,
        vmid=vmid,
        action=(
            "lxc_create"
            if request.resource_type == "lxc"
            else "vm_create"
        ),
        details=(
            "Scheduled provisioning completed for approved "
            f"{request.resource_type} request {request.id}"
            + (
                f" on node {actual_node}"
                if actual_node
                else ""
            )
        ),
        commit=False,
    )
    logger.info(
        "Auto-provisioned approved request %s with VMID %s on node %s",
        request.id,
        vmid,
        actual_node,
    )
    return vmid, actual_node, placement_strategy_used, True


def _mark_request_runtime_error(
    *,
    session: Session,
    request_id,
    message: str,
) -> None:
    request = vm_request_repo.get_vm_request_by_id(
        session=session,
        request_id=request_id,
        for_update=True,
    )
    if not request:
        return
    vm_request_repo.update_vm_request_provisioning(
        session=session,
        db_request=request,
        vmid=request.vmid,
        assigned_node=request.assigned_node,
        desired_node=request.desired_node,
        actual_node=request.actual_node,
        placement_strategy_used=request.placement_strategy_used,
        migration_status=VMMigrationStatus.failed,
        migration_error=message[:500],
        rebalance_epoch=request.rebalance_epoch,
        last_rebalanced_at=request.last_rebalanced_at,
        commit=False,
    )
    session.commit()


def _refresh_actual_node(
    *,
    session: Session,
    request: VMRequest,
) -> tuple[str, dict]:
    if request.vmid is None:
        raise NotFoundError(f"Request {request.id} has no provisioned VMID")
    resource = proxmox_service.find_resource(request.vmid)
    if str(resource.get("name") or "") != str(request.hostname or ""):
        raise NotFoundError(
            f"Provisioned resource {request.vmid} no longer matches request hostname"
        )
    actual_node = str(resource["node"])
    vm_request_repo.update_vm_request_provisioning(
        session=session,
        db_request=request,
        vmid=request.vmid,
        assigned_node=request.assigned_node,
        desired_node=request.desired_node,
        actual_node=actual_node,
        placement_strategy_used=request.placement_strategy_used,
        migration_status=(
            VMMigrationStatus.pending
            if request.desired_node and request.desired_node != actual_node
            else request.migration_status
        ),
        migration_error=None if request.desired_node == actual_node else request.migration_error,
        rebalance_epoch=request.rebalance_epoch,
        last_rebalanced_at=request.last_rebalanced_at,
        commit=False,
    )
    return actual_node, resource


def _extract_storage_id(config_value: object) -> str | None:
    text = str(config_value or "").strip()
    if not text:
        return None
    if text.startswith("/"):
        return None
    if ":" not in text:
        return None
    return text.split(":", 1)[0].strip() or None


def _storage_ids_available_on_node(*, node: str) -> set[str]:
    return {
        str(item.get("storage") or item.get("id") or "").strip()
        for item in proxmox_service.list_node_storages(node)
        if str(item.get("storage") or item.get("id") or "").strip()
    }


def _migration_block_reason(
    *,
    source_node: str,
    target_node: str,
    vmid: int,
    resource_type: str,
) -> str | None:
    config = proxmox_service.get_config(source_node, vmid, resource_type)
    target_storages = _storage_ids_available_on_node(node=target_node)

    if resource_type == "qemu":
        passthrough_keys = [
            key
            for key in config
            if key.startswith("hostpci") or key.startswith("usb")
        ]
        if passthrough_keys:
            return (
                "Migration blocked because this VM uses passthrough devices: "
                + ", ".join(sorted(passthrough_keys))
            )

        for key, value in config.items():
            if not key.startswith(_VM_DISK_PREFIXES):
                continue
            storage_id = _extract_storage_id(value)
            if storage_id is None:
                text = str(value or "").strip()
                if text.startswith("/"):
                    return (
                        f"Migration blocked because disk '{key}' uses a direct path mount."
                    )
                continue
            if storage_id not in target_storages:
                return (
                    f"Migration blocked because target node '{target_node}' "
                    f"does not expose storage '{storage_id}' required by disk '{key}'."
                )
        return None

    for key, value in config.items():
        if not key.startswith(_LXC_MOUNT_PREFIXES):
            continue
        text = str(value or "").strip()
        if text.startswith("/"):
            return (
                f"Migration blocked because container mount '{key}' is a direct bind mount."
            )
        storage_id = _extract_storage_id(value)
        if storage_id and storage_id not in target_storages:
            return (
                f"Migration blocked because target node '{target_node}' "
                f"does not expose storage '{storage_id}' required by mount '{key}'."
            )
    return None


def _migrate_request_to_desired_node(
    *,
    session: Session,
    request: VMRequest,
    current_node: str,
) -> str:
    desired_node = str(request.desired_node or request.assigned_node or "")
    if not desired_node or desired_node == current_node:
        return current_node
    if request.vmid is None:
        raise NotFoundError(f"Request {request.id} has no provisioned VMID")

    resource_type = _resource_type_for_request(request)
    current_status = proxmox_service.get_status(
        current_node,
        request.vmid,
        resource_type,
    )
    online = str(current_status.get("status") or "").lower() == "running"
    block_reason = _migration_block_reason(
        source_node=current_node,
        target_node=desired_node,
        vmid=request.vmid,
        resource_type=resource_type,
    )
    if block_reason:
        vm_request_repo.update_vm_request_provisioning(
            session=session,
            db_request=request,
            vmid=request.vmid,
            assigned_node=desired_node,
            desired_node=desired_node,
            actual_node=current_node,
            placement_strategy_used=request.placement_strategy_used,
            migration_status=VMMigrationStatus.blocked,
            migration_error=block_reason,
            rebalance_epoch=request.rebalance_epoch,
            last_rebalanced_at=request.last_rebalanced_at,
            commit=False,
        )
        logger.warning(
            "Blocked migration for request %s VMID %s from %s to %s: %s",
            request.id,
            request.vmid,
            current_node,
            desired_node,
            block_reason,
        )
        return current_node
    vm_request_repo.update_vm_request_provisioning(
        session=session,
        db_request=request,
        vmid=request.vmid,
        assigned_node=desired_node,
        desired_node=desired_node,
        actual_node=current_node,
        placement_strategy_used=request.placement_strategy_used,
        migration_status=VMMigrationStatus.running,
        migration_error=None,
        rebalance_epoch=request.rebalance_epoch,
        last_rebalanced_at=request.last_rebalanced_at,
        commit=False,
    )
    proxmox_service.migrate_resource(
        current_node,
        desired_node,
        request.vmid,
        resource_type,
        online=online,
    )
    migrated_resource = proxmox_service.find_resource(request.vmid)
    new_actual_node = str(migrated_resource["node"])
    vm_request_repo.update_vm_request_provisioning(
        session=session,
        db_request=request,
        vmid=request.vmid,
        assigned_node=desired_node,
        desired_node=desired_node,
        actual_node=new_actual_node,
        placement_strategy_used=request.placement_strategy_used,
        migration_status=(
            VMMigrationStatus.completed
            if new_actual_node == desired_node
            else VMMigrationStatus.blocked
        ),
        migration_error=(
            None
            if new_actual_node == desired_node
            else f"Migration finished on unexpected node {new_actual_node}"
        ),
        rebalance_epoch=request.rebalance_epoch,
        last_rebalanced_at=request.last_rebalanced_at,
        commit=False,
    )
    audit_service.log_action(
        session=session,
        user_id=None,
        vmid=request.vmid,
        action="resource_migrate",
        details=(
            f"Auto-rebalanced request {request.id} from {current_node} "
            f"to {new_actual_node} for active time slot balancing"
        ),
        commit=False,
    )
    logger.info(
        "Migrated request %s VMID %s from %s to %s",
        request.id,
        request.vmid,
        current_node,
        new_actual_node,
    )
    return new_actual_node


def _ensure_request_running(
    *,
    session: Session,
    request: VMRequest,
) -> bool:
    resource_type = _resource_type_for_request(request)

    if request.vmid is None:
        _, actual_node, placement_strategy_used, started = _adopt_or_provision_due_request(
            session=session,
            request=request,
        )
        db_request = vm_request_repo.get_vm_request_by_id(
            session=session,
            request_id=request.id,
            for_update=True,
        )
        if db_request is None:
            return started
        if db_request.desired_node and actual_node != db_request.desired_node:
            actual_node = _migrate_request_to_desired_node(
                session=session,
                request=db_request,
                current_node=actual_node,
            )
        vm_request_repo.update_vm_request_provisioning(
            session=session,
            db_request=db_request,
            vmid=db_request.vmid,
            assigned_node=db_request.desired_node or actual_node,
            desired_node=db_request.desired_node or actual_node,
            actual_node=actual_node,
            placement_strategy_used=placement_strategy_used,
            migration_status=(
                VMMigrationStatus.completed
                if db_request.desired_node and db_request.desired_node == actual_node
                else VMMigrationStatus.idle
            ),
            migration_error=None,
            rebalance_epoch=db_request.rebalance_epoch,
            last_rebalanced_at=db_request.last_rebalanced_at,
            commit=False,
        )
        return started

    actual_node, _ = _refresh_actual_node(
        session=session,
        request=request,
    )
    if request.desired_node and request.desired_node != actual_node:
        actual_node = _migrate_request_to_desired_node(
            session=session,
            request=request,
            current_node=actual_node,
        )

    status = proxmox_service.get_status(
        actual_node,
        request.vmid,
        resource_type,
    )
    if str(status.get("status") or "").lower() == "running":
        vm_request_repo.update_vm_request_provisioning(
            session=session,
            db_request=request,
            vmid=request.vmid,
            assigned_node=request.desired_node or actual_node,
            desired_node=request.desired_node or actual_node,
            actual_node=actual_node,
            placement_strategy_used=request.placement_strategy_used,
            migration_status=(
                VMMigrationStatus.completed
                if request.desired_node and request.desired_node == actual_node
                else VMMigrationStatus.idle
            ),
            migration_error=None,
            rebalance_epoch=request.rebalance_epoch,
            last_rebalanced_at=request.last_rebalanced_at,
            commit=False,
        )
        return False

    proxmox_service.control(actual_node, request.vmid, resource_type, "start")
    vm_request_repo.update_vm_request_provisioning(
        session=session,
        db_request=request,
        vmid=request.vmid,
        assigned_node=request.desired_node or actual_node,
        desired_node=request.desired_node or actual_node,
        actual_node=actual_node,
        placement_strategy_used=request.placement_strategy_used,
        migration_status=(
            VMMigrationStatus.completed
            if request.desired_node and request.desired_node == actual_node
            else VMMigrationStatus.idle
        ),
        migration_error=None,
        rebalance_epoch=request.rebalance_epoch,
        last_rebalanced_at=request.last_rebalanced_at,
        commit=False,
    )
    audit_service.log_action(
        session=session,
        user_id=None,
        vmid=request.vmid,
        action="resource_start",
        details=(
            "Scheduled auto-start for approved "
            f"{request.resource_type} request {request.id}"
        ),
        commit=False,
    )
    logger.info(
        "Auto-started approved request %s on node %s with VMID %s",
        request.id,
        actual_node,
        request.vmid,
    )
    return True


def _rebalance_active_window(now: datetime) -> int:
    with Session(engine) as session:
        due_requests = vm_request_repo.list_due_for_rebalance_vm_requests(
            session=session,
            at_time=now,
        )
        if not due_requests:
            return 0

        active_requests = vm_request_repo.list_active_approved_vm_requests(
            session=session,
            at_time=now,
        )
        if not active_requests:
            return 0

        selections = vm_request_placement_service.rebalance_active_assignments(
            session=session,
            requests=active_requests,
        )
        rebalance_epoch = max(
            (int(item.rebalance_epoch or 0) for item in active_requests),
            default=0,
        ) + 1

        for request in active_requests:
            selection = selections.get(request.id)
            if not selection or not selection.node:
                raise ValueError(
                    f"No feasible active placement exists for request {request.id}"
                )
            known_actual_node = request.actual_node
            if request.vmid is not None and not known_actual_node:
                known_actual_node = request.assigned_node
            vm_request_repo.update_vm_request_provisioning(
                session=session,
                db_request=request,
                vmid=request.vmid,
                assigned_node=selection.node,
                desired_node=selection.node,
                actual_node=known_actual_node,
                placement_strategy_used=selection.strategy,
                migration_status=(
                    VMMigrationStatus.pending
                    if request.vmid is not None
                    and known_actual_node
                    and known_actual_node != selection.node
                    else VMMigrationStatus.idle
                ),
                migration_error=None,
                rebalance_epoch=rebalance_epoch,
                last_rebalanced_at=now,
                commit=False,
            )
        session.commit()
        return len(due_requests)


def process_due_request_starts() -> int:
    started_count = 0
    now = _utc_now()

    try:
        _rebalance_active_window(now)
    except ValueError:
        logger.exception("Failed to rebalance active VM request window")
    except Exception:
        logger.exception("Unexpected error while rebalancing active VM request window")

    with Session(engine) as session:
        active_requests = vm_request_repo.list_active_approved_vm_requests(
            session=session,
            at_time=now,
        )

        for request in active_requests:
            try:
                if _ensure_request_running(session=session, request=request):
                    started_count += 1
                session.commit()
            except NotFoundError:
                stale_vmid = request.vmid
                try:
                    if stale_vmid is not None:
                        vm_request_repo.clear_vm_request_provisioning(
                            session=session,
                            db_request=request,
                            commit=False,
                        )
                    if _ensure_request_running(session=session, request=request):
                        started_count += 1
                    session.commit()
                    logger.warning(
                        "Recovered approved request %s from stale VMID %s",
                        request.id,
                        stale_vmid,
                    )
                except Exception as exc:
                    session.rollback()
                    _mark_request_runtime_error(
                        session=session,
                        request_id=request.id,
                        message=str(exc),
                    )
                    logger.exception(
                        "Failed to recover approved request %s from stale VMID %s",
                        request.id,
                        stale_vmid,
                    )
            except Exception as exc:
                session.rollback()
                _mark_request_runtime_error(
                    session=session,
                    request_id=request.id,
                    message=str(exc),
                )
                logger.exception(
                    "Failed to reconcile approved request %s with VMID %s",
                    request.id,
                    request.vmid,
                )

    return started_count


def process_due_request_stops() -> int:
    stopped_count = 0
    now = _utc_now()

    with Session(engine) as session:
        due_requests = list(
            session.exec(
                select(VMRequest).where(
                    VMRequest.status == VMRequestStatus.approved,
                    VMRequest.vmid.is_not(None),
                    VMRequest.end_at.is_not(None),
                    VMRequest.end_at <= now,
                )
            ).all()
        )

        for request in due_requests:
            vmid = request.vmid
            if vmid is None:
                continue

            resource_type = _resource_type_for_request(request)

            try:
                resource = proxmox_service.find_resource(vmid)
                node = str(resource["node"])
                status = proxmox_service.get_status(node, vmid, resource_type)
                current_status = str(status.get("status") or "").lower()
                if current_status in {"stopped", "paused"}:
                    continue

                proxmox_service.control(node, vmid, resource_type, "shutdown")
                audit_service.log_action(
                    session=session,
                    user_id=None,
                    vmid=vmid,
                    action="resource_shutdown",
                    details=(
                        "Scheduled auto-shutdown for approved "
                        f"{request.resource_type} request {request.id}"
                    ),
                    commit=False,
                )
                stopped_count += 1
                logger.info(
                    "Auto-shutdown triggered for approved request %s on node %s with VMID %s",
                    request.id,
                    node,
                    vmid,
                )
            except NotFoundError:
                logger.warning(
                    "Scheduled shutdown skipped because resource %s was not found for request %s",
                    vmid,
                    request.id,
                )
            except Exception:
                logger.exception(
                    "Failed to auto-shutdown approved request %s with VMID %s",
                    request.id,
                    vmid,
                )

        if stopped_count > 0:
            session.commit()

    return stopped_count


async def run_scheduler(stop_event: asyncio.Event) -> None:
    logger.info("VM request scheduler is running")
    while not stop_event.is_set():
        try:
            process_due_request_starts()
            process_due_request_stops()
        except Exception:
            logger.exception("VM request scheduler iteration failed")

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=SCHEDULER_POLL_SECONDS)
        except TimeoutError:
            continue

    logger.info("VM request scheduler stopped")
