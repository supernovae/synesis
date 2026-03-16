"""
title: Synesis Progress Pipe
author: Synesis
author_url: https://github.com/supernovae/synesis
funding_url: https://github.com/supernovae/synesis
version: 0.1.0
required_open_webui_version: 0.8.10
license: MIT
"""

from __future__ import annotations

import json
from typing import Any

import httpx
from pydantic import BaseModel, Field


class Pipe:
    """Open WebUI Pipe that proxies Synesis planner SSE and mirrors progress in-chat."""

    class Valves(BaseModel):
        planner_url: str = Field(
            default="http://synesis-planner.synesis-planner.svc.cluster.local:8000",
            description="Synesis planner base URL (no trailing /v1/chat/completions).",
        )
        planner_model: str = Field(
            default="synesis-agent",
            description="Model passed to planner /v1/chat/completions.",
        )
        request_timeout_seconds: int = Field(
            default=600,
            description="Planner request timeout (seconds).",
        )
        mirror_status_to_chat: bool = Field(
            default=True,
            description="When true, also emit phase updates as chat text (GPT-like visible progress).",
        )
        status_prefix: str = Field(
            default="Progress",
            description="Prefix shown before mirrored status lines.",
        )

    def __init__(self) -> None:
        self.valves = self.Valves()

    async def _emit(self, emitter: Any, event_type: str, data: dict[str, Any]) -> None:
        if emitter is None:
            return
        await emitter({"type": event_type, "data": data})

    async def _emit_status(self, emitter: Any, description: str, done: bool = False) -> None:
        await self._emit(
            emitter,
            "status",
            {
                "description": description,
                "done": done,
                "hidden": False,
            },
        )
        if self.valves.mirror_status_to_chat and description:
            await self._emit(
                emitter,
                "message",
                {
                    "content": f"\n> {self.valves.status_prefix}: {description}\n",
                },
            )

    async def pipe(
        self,
        body: dict[str, Any],
        __event_emitter__=None,
        __user__=None,
    ) -> str:
        """Stream planner response while surfacing status phases in chat."""
        planner_url = self.valves.planner_url.rstrip("/") + "/v1/chat/completions"
        upstream_messages = body.get("messages") or []

        payload: dict[str, Any] = {
            "model": self.valves.planner_model,
            "messages": upstream_messages,
            "stream": True,
        }

        if body.get("user"):
            payload["user"] = body.get("user")

        full_text: list[str] = []
        last_status = ""

        async with httpx.AsyncClient(timeout=self.valves.request_timeout_seconds) as client:
            async with client.stream("POST", planner_url, json=payload) as resp:
                resp.raise_for_status()

                async for line in resp.aiter_lines():
                    if not line or not line.startswith("data: "):
                        continue

                    raw = line[6:].strip()
                    if raw == "[DONE]":
                        break

                    try:
                        packet = json.loads(raw)
                    except json.JSONDecodeError:
                        continue

                    # Synesis status format:
                    # {"event":{"type":"status","data":{"description":"...",...}}}
                    event = packet.get("event")
                    if isinstance(event, dict) and event.get("type") == "status":
                        data = event.get("data") or {}
                        desc = str(data.get("description") or "").strip()
                        done = bool(data.get("done", False))
                        if done:
                            await self._emit_status(__event_emitter__, "", done=True)
                        elif desc and desc != last_status:
                            last_status = desc
                            await self._emit_status(__event_emitter__, desc, done=False)
                        continue

                    # OpenAI-compatible chunk format
                    choices = packet.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    text = delta.get("content") or ""
                    if not text:
                        continue
                    full_text.append(text)
                    await self._emit(__event_emitter__, "message", {"content": text})

        await self._emit_status(__event_emitter__, "", done=True)
        return "".join(full_text)
