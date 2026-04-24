#!/usr/bin/env python3
"""Compare OpenAI client profiles against Synesis Yarn.

This harness runs the same mini workflow across multiple request profiles so
you can see how client headers/body metadata affect:
  - session continuity behavior
  - streaming latency/timeouts
  - tool-call availability

Profiles:
  - raw_opencode_like: minimal body, no synesis headers/metadata
  - shimmed_opencode: opencode-like + synesis metadata/header shims
  - explicit_cohesive: explicit x-synesis-client + conversation_id + metadata
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from dataclasses import dataclass
from typing import Any

try:
    from openai import OpenAI
except Exception as exc:  # pragma: no cover
    print("Missing dependency: openai. Install with `pip install openai`.", file=sys.stderr)
    raise SystemExit(2) from exc


@dataclass
class Profile:
    name: str
    client_header: str | None
    include_conversation_id: bool
    include_user_field: bool
    include_metadata: bool


def _normalize_base_url(base_url: str) -> str:
    base = base_url.strip().rstrip("/")
    if base.endswith("/v1"):
        return base
    return f"{base}/v1"


def _first_text(resp: Any) -> str:
    choices = getattr(resp, "choices", None) or []
    if not choices:
        return ""
    msg = choices[0].message
    content = getattr(msg, "content", None)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for part in content:
            text = getattr(part, "text", None)
            if isinstance(text, str) and text:
                return text
    return ""


def _build_context(profile: Profile, *, conversation_id: str, user: str, cwd: str) -> tuple[dict[str, str], dict[str, Any]]:
    headers: dict[str, str] = {}
    if profile.client_header:
        headers["x-synesis-client"] = profile.client_header
    if profile.include_conversation_id:
        headers["x-synesis-conversation-id"] = conversation_id

    body_meta: dict[str, Any] = {}
    if profile.include_metadata:
        body_meta = {
            "synesis_project_root": cwd,
            "synesis_shell_cwd": cwd,
            "synesis_conversation_id": conversation_id,
            "synesis_client": profile.client_header or profile.name,
            "synesis_runtime": {
                "platform": sys.platform,
                "os_version": "unknown",
                "shell": os.environ.get("SHELL", ""),
            },
        }

    kwargs: dict[str, Any] = {
        "extra_headers": headers if headers else None,
        "extra_body": {"metadata": body_meta} if body_meta else None,
        "conversation_id": conversation_id if profile.include_conversation_id else None,
        "user": user if profile.include_user_field else None,
    }
    return headers, kwargs


def _create_non_stream(
    client: OpenAI,
    *,
    model: str,
    prompt: str,
    kwargs: dict[str, Any],
) -> tuple[str, str]:
    req: dict[str, Any] = {
        "model": model,
        "stream": False,
        "max_tokens": 220,
        "messages": [
            {"role": "system", "content": "Be concise."},
            {"role": "user", "content": prompt},
        ],
    }
    req.update({k: v for k, v in kwargs.items() if v is not None})
    resp = client.chat.completions.create(**req)
    return str(getattr(resp, "id", "")), _first_text(resp)


def _create_stream(
    client: OpenAI,
    *,
    model: str,
    prompt: str,
    kwargs: dict[str, Any],
) -> tuple[float, str, str]:
    req: dict[str, Any] = {
        "model": model,
        "stream": True,
        "max_tokens": 450,
        "messages": [
            {"role": "system", "content": "Be concise and practical."},
            {"role": "user", "content": prompt},
        ],
    }
    req.update({k: v for k, v in kwargs.items() if v is not None})
    started = time.time()
    response_id = ""
    text_chunks: list[str] = []
    stream = client.chat.completions.create(**req)
    for event in stream:
        if getattr(event, "id", None) and not response_id:
            response_id = str(event.id)
        choices = getattr(event, "choices", None) or []
        if not choices:
            continue
        delta = getattr(choices[0], "delta", None)
        if delta is None:
            continue
        content = getattr(delta, "content", None)
        if isinstance(content, str) and content:
            text_chunks.append(content)
    return time.time() - started, response_id, "".join(text_chunks)


def _create_tool_probe(
    client: OpenAI,
    *,
    model: str,
    kwargs: dict[str, Any],
) -> tuple[str, bool]:
    req: dict[str, Any] = {
        "model": model,
        "stream": False,
        "max_tokens": 220,
        "messages": [
            {"role": "system", "content": "Use tools when useful."},
            {"role": "user", "content": "Call echo_status with status='ok'."},
        ],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "echo_status",
                    "description": "Echoes status",
                    "parameters": {
                        "type": "object",
                        "properties": {"status": {"type": "string"}},
                        "required": ["status"],
                    },
                },
            }
        ],
        "tool_choice": "auto",
    }
    req.update({k: v for k, v in kwargs.items() if v is not None})
    resp = client.chat.completions.create(**req)
    msg = resp.choices[0].message if resp.choices else None
    return str(getattr(resp, "id", "")), bool(getattr(msg, "tool_calls", None))


def run_profile(
    client: OpenAI,
    *,
    profile: Profile,
    model: str,
    user: str,
    cwd: str,
) -> dict[str, Any]:
    conversation_id = f"{profile.name}-{uuid.uuid4()}"
    headers, kwargs = _build_context(profile, conversation_id=conversation_id, user=user, cwd=cwd)

    turn1_id, turn1_text = _create_non_stream(
        client,
        model=model,
        prompt="Say exactly: profile connected.",
        kwargs=kwargs,
    )
    turn2_id, turn2_text = _create_non_stream(
        client,
        model=model,
        prompt="What did I ask in the previous turn? Keep to one sentence.",
        kwargs=kwargs,
    )
    stream_elapsed, stream_id, stream_text = _create_stream(
        client,
        model=model,
        prompt="Give a 3-bullet python security review for: subprocess.run(user_input, shell=True)",
        kwargs=kwargs,
    )
    tool_id, tool_call = _create_tool_probe(
        client,
        model=model,
        kwargs=kwargs,
    )

    continuity_ok = "profile connected" in turn2_text.lower()
    return {
        "profile": profile.name,
        "conversation_id": conversation_id,
        "headers": headers,
        "has_metadata": profile.include_metadata,
        "turn1": {"id": turn1_id, "text": turn1_text[:220]},
        "turn2": {"id": turn2_id, "text": turn2_text[:220], "continuity_hint_found": continuity_ok},
        "stream": {
            "id": stream_id,
            "elapsed_seconds": round(stream_elapsed, 3),
            "text_preview": stream_text[:260],
        },
        "tool_probe": {"id": tool_id, "tool_call_emitted": tool_call},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Synesis OpenAI profile comparison harness")
    parser.add_argument("--base-url", default=os.environ.get("SYNESIS_YARN_URL", "").strip())
    parser.add_argument("--token", default=os.environ.get("SYNESIS_TEST_PAT_TOKEN", "").strip())
    parser.add_argument("--model", default=os.environ.get("SYNESIS_VERIFY_MODEL", "synesis-core"))
    parser.add_argument("--user", default="harness-user@example.com")
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--output-json", default="")
    args = parser.parse_args()

    if not args.base_url:
        print("Missing --base-url (or SYNESIS_YARN_URL).", file=sys.stderr)
        return 2
    if not args.token:
        print("Missing --token (or SYNESIS_TEST_PAT_TOKEN).", file=sys.stderr)
        return 2

    client = OpenAI(base_url=_normalize_base_url(args.base_url), api_key=args.token, timeout=240.0)
    profiles = [
        Profile(
            name="raw_opencode_like",
            client_header=None,
            include_conversation_id=False,
            include_user_field=False,
            include_metadata=False,
        ),
        Profile(
            name="shimmed_opencode",
            client_header="opencode",
            include_conversation_id=True,
            include_user_field=True,
            include_metadata=True,
        ),
        Profile(
            name="explicit_cohesive",
            client_header="opencode-harness",
            include_conversation_id=True,
            include_user_field=True,
            include_metadata=True,
        ),
    ]

    results: list[dict[str, Any]] = []
    for profile in profiles:
        print(f"Running profile: {profile.name}")
        result = run_profile(
            client,
            profile=profile,
            model=args.model,
            user=args.user,
            cwd=args.cwd,
        )
        results.append(result)
        print(
            f"  stream={result['stream']['elapsed_seconds']}s "
            f"tool_call={result['tool_probe']['tool_call_emitted']} "
            f"continuity_hint={result['turn2']['continuity_hint_found']}",
        )

    report = {
        "base_url": _normalize_base_url(args.base_url),
        "model": args.model,
        "generated_at_unix": int(time.time()),
        "results": results,
    }
    payload = json.dumps(report, indent=2)
    print("\n=== Comparison Report ===")
    print(payload)

    if args.output_json:
        with open(args.output_json, "w", encoding="utf-8") as f:
            f.write(payload)
        print(f"\nWrote report: {args.output_json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
