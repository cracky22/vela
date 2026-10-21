"""Echtzeit-Verbindungen (WebSocket) und thread-sichere Benachrichtigung.

REST-Endpunkte laufen im Thread-Pool. Sie benachrichtigen verbundene Clients über
`notify()`, das die Sendeaufgabe threadsicher auf die Event-Loop übergibt, ohne den
Worker-Thread auf langsame Clients warten zu lassen.
"""
from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any

import anyio.from_thread
from starlette.websockets import WebSocket


class ConnectionManager:
    def __init__(self) -> None:
        self._conns: dict[str, set[WebSocket]] = defaultdict(set)
        self._tasks: set[asyncio.Task] = set()

    def add(self, user_id: str, ws: WebSocket) -> None:
        self._conns[user_id].add(ws)

    def remove(self, user_id: str, ws: WebSocket) -> None:
        conns = self._conns.get(user_id)
        if conns is not None:
            conns.discard(ws)
            if not conns:
                self._conns.pop(user_id, None)

    def is_online(self, user_id: str) -> bool:
        return bool(self._conns.get(user_id))

    async def send(self, user_id: str, payload: dict[str, Any], exclude: WebSocket | None = None) -> None:
        for ws in list(self._conns.get(user_id, ())):
            if ws is exclude:
                continue
            try:
                await asyncio.wait_for(ws.send_json(payload), timeout=10)
            except Exception:
                self.remove(user_id, ws)

    def _schedule(self, user_id: str, payload: dict[str, Any]) -> None:
        task = asyncio.get_running_loop().create_task(self.send(user_id, payload))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def notify(self, user_id: str, payload: dict[str, Any]) -> None:
        """Aus einem Worker-Thread (oder der Event-Loop) aufrufbar."""
        try:
            anyio.from_thread.run_sync(self._schedule, user_id, payload)
        except RuntimeError:
            # Wir befinden uns bereits auf der Event-Loop
            self._schedule(user_id, payload)

    async def close_user(self, user_id: str, code: int = 4401) -> None:
        for ws in list(self._conns.get(user_id, ())):
            try:
                await ws.close(code=code)
            except Exception:
                pass
            self.remove(user_id, ws)

    def close_user_from_thread(self, user_id: str) -> None:
        try:
            anyio.from_thread.run(self.close_user, user_id)
        except RuntimeError:
            pass


manager = ConnectionManager()
