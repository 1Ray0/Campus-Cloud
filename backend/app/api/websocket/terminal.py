import asyncio
import logging
import ssl
from urllib.parse import quote

import httpx
import websockets
from fastapi import WebSocket, WebSocketDisconnect

from app.api.deps.auth import get_ws_current_user
from app.api.deps.proxmox import check_resource_ownership
from app.core.config import settings
from app.core.proxmox import get_proxmox_api

logger = logging.getLogger(__name__)


async def terminal_proxy(websocket: WebSocket, vmid: int, token: str):
    """WebSocket proxy for LXC container terminal access."""
    # Authenticate user and check ownership before accepting
    user, session = await get_ws_current_user(websocket, token=token)
    try:
        check_resource_ownership(vmid, user, session)
    except Exception:
        await websocket.close(code=1008, reason="Permission denied")
        return

    await websocket.accept()
    logger.info(f"Terminal proxy connection for LXC {vmid} by user {user.email}")

    pve_websocket = None

    try:
        # Get session ticket using password authentication
        # NOTE: Proxmox termproxy WebSocket does NOT support API token authentication
        # We must use password to get a session ticket (PVEAuthCookie)
        async with httpx.AsyncClient(verify=settings.PROXMOX_VERIFY_SSL) as client:
            auth_response = await client.post(
                f"https://{settings.PROXMOX_HOST}:8006/api2/json/access/ticket",
                data={
                    "username": settings.PROXMOX_USER,
                    "password": settings.PROXMOX_PASSWORD,
                },
            )

            if auth_response.status_code != 200:
                logger.error(
                    f"Proxmox authentication failed: {auth_response.status_code}"
                )
                await websocket.close(code=1008, reason="Authentication failed")
                return

            auth_data = auth_response.json()["data"]
            pve_auth_cookie = auth_data["ticket"]
            logger.info("Retrieved session ticket for WebSocket authentication")

        # Use API token for REST API calls (more secure for resource queries)
        proxmox = get_proxmox_api()

        # Find LXC container in cluster resources
        container_info = None
        for resource in proxmox.cluster.resources.get(type="vm"):
            if resource["vmid"] == vmid and resource["type"] == "lxc":
                container_info = resource
                break

        if not container_info:
            logger.error(f"LXC container {vmid} not found in cluster")
            await websocket.close(code=1008, reason="LXC container not found")
            return

        node = container_info["node"]
        logger.info(
            f"LXC container {vmid} found on node {node}, status: {container_info.get('status', 'unknown')}"
        )

        # Get terminal proxy ticket
        console_data = proxmox.nodes(node).lxc(vmid).termproxy.post()
        terminal_port = console_data["port"]
        terminal_ticket = console_data["ticket"]

        encoded_terminal_ticket = quote(terminal_ticket, safe="")
        encoded_auth_cookie = quote(pve_auth_cookie, safe="")

        # WebSocket URL for terminal (using vncwebsocket endpoint for termproxy)
        pve_ws_url = (
            f"wss://{settings.PROXMOX_HOST}:8006"
            f"/api2/json/nodes/{node}/lxc/{vmid}/vncwebsocket"
            f"?port={terminal_port}&vncticket={encoded_terminal_ticket}"
        )

        ssl_context = ssl.create_default_context()
        if not settings.PROXMOX_VERIFY_SSL:
            ssl_context.check_hostname = False
            ssl_context.verify_mode = ssl.CERT_NONE

        try:
            # Use Cookie with session ticket (NOT API token!)
            pve_websocket = await websockets.connect(
                pve_ws_url,
                ssl=ssl_context,
                additional_headers={"Cookie": f"PVEAuthCookie={encoded_auth_cookie}"},
                max_size=2**20,
            )
            logger.info("Successfully connected to Proxmox WebSocket for terminal")

            # Send initial authentication to termproxy
            # Format: username:ticket\n (newline is critical!)
            auth_message = f"{settings.PROXMOX_USER}:{terminal_ticket}\n"
            await pve_websocket.send(auth_message)
            logger.info("Sent authentication to termproxy")

        except websockets.exceptions.InvalidStatus as e:
            logger.error(
                f"Proxmox WebSocket connection rejected: HTTP {e.response.status_code}"
            )
            await websocket.close(code=1008, reason="Proxmox connection failed")
            return

        logger.info(f"WebSocket proxy established for LXC {vmid}")

        async def forward_from_proxmox():
            try:
                async for message in pve_websocket:
                    try:
                        if isinstance(message, bytes):
                            await websocket.send_bytes(message)
                        else:
                            await websocket.send_text(message)
                    except Exception:
                        break
            except websockets.exceptions.ConnectionClosed:
                pass
            except Exception as e:
                logger.error(f"Error forwarding from Proxmox: {e}")

        async def forward_to_proxmox():
            try:
                while True:
                    data = await websocket.receive()
                    if data.get("type") == "websocket.disconnect":
                        break
                    if "bytes" in data:
                        await pve_websocket.send(data["bytes"])
                    elif "text" in data:
                        await pve_websocket.send(data["text"])
            except WebSocketDisconnect:
                pass
            except Exception as e:
                logger.error(f"Error forwarding to Proxmox: {e}")

        # Run both directions concurrently; first to finish cancels the other
        await asyncio.gather(
            forward_from_proxmox(),
            forward_to_proxmox(),
            return_exceptions=True,
        )

    except Exception as e:
        logger.error(f"Failed to establish WebSocket proxy: {e}", exc_info=True)
        await websocket.close(code=1011, reason=str(e))
    finally:
        if pve_websocket:
            await pve_websocket.close()
        logger.info(f"Terminal proxy disconnected for LXC {vmid}")
