#!/usr/bin/env python3
"""Small OpenAI-compatible session harness for Synesis Yarn.

Purpose:
- Validate multi-turn session continuity independent of opencode behavior
- Validate streaming does not timeout unexpectedly
- Validate tool-call roundtrips with a minimal function schema
- Force explicit client + conversation identifiers for reproducible debugging

Requirements:
  pip install openai

Environment (optional):
  SYNESIS_YARN_URL               e.g. https://synesis-yarn.apps.openshiftdemo.dev
  SYNESIS_TEST_PAT_TOKEN         PAT token (recommended)
  SYNESIS_VERIFY_MODEL           model name (default: synesis-core)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from typing import Any

try:
    from openai import OpenAI
except Exception as exc:  # pragma: no cover
    print("Missing dependency: openai. Install with `pip install openai`.", file=sys.stderr)
    raise SystemExit(2) from exc


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


def _run_non_stream_turn(
    client: OpenAI,
    *,
    model: str,
    prompt: str,
    conversation_id: str,
    user: str,
    client_label: str,
    metadata: dict[str, Any],
) -> tuple[str, str]:
    resp = client.chat.completions.create(
        model=model,
        stream=False,
        max_tokens=250,
        conversation_id=conversation_id,
        user=user,
        messages=[
            {"role": "system", "content": "You are concise. Keep answers to <=2 sentences."},
            {"role": "user", "content": prompt},
        ],
        extra_headers={
            "x-synesis-client": client_label,
            "x-synesis-conversation-id": conversation_id,
        },
        extra_body={"metadata": metadata},
    )
    text = _first_text(resp)
    return str(getattr(resp, "id", "")), text


def _run_stream_turn(
    client: OpenAI,
    *,
    model: str,
    prompt: str,
    conversation_id: str,
    user: str,
    client_label: str,
    metadata: dict[str, Any],
) -> tuple[float, str, str]:
    started = time.time()
    chunks: list[str] = []
    response_id = ""
    stream = client.chat.completions.create(
        model=model,
        stream=True,
        max_tokens=500,
        conversation_id=conversation_id,
        user=user,
        messages=[
            {"role": "system", "content": "You are concise and practical."},
            {"role": "user", "content": prompt},
        ],
        extra_headers={
            "x-synesis-client": client_label,
            "x-synesis-conversation-id": conversation_id,
        },
        extra_body={"metadata": metadata},
    )
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
            chunks.append(content)
    elapsed = time.time() - started
    return elapsed, response_id, "".join(chunks)


def _run_tool_probe(
    client: OpenAI,
    *,
    model: str,
    conversation_id: str,
    user: str,
    client_label: str,
    metadata: dict[str, Any],
) -> tuple[str, bool]:
    response = client.chat.completions.create(
        model=model,
        stream=False,
        max_tokens=250,
        conversation_id=conversation_id,
        user=user,
        messages=[
            {"role": "system", "content": "Use tools when helpful."},
            {"role": "user", "content": "Call the echo_status tool with status='ok'."},
        ],
        tools=[
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
        tool_choice="auto",
        extra_headers={
            "x-synesis-client": client_label,
            "x-synesis-conversation-id": conversation_id,
        },
        extra_body={"metadata": metadata},
    )
    msg = response.choices[0].message if response.choices else None
    has_tool_call = bool(getattr(msg, "tool_calls", None))
    return str(getattr(response, "id", "")), has_tool_call


def main() -> int:
    parser = argparse.ArgumentParser(description="Synesis OpenAI session harness")
    parser.add_argument(
        "--base-url",
        default=os.environ.get("SYNESIS_YARN_URL", "").strip(),
        help="Yarn base URL (without /v1 suffix is fine)",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("SYNESIS_TEST_PAT_TOKEN", "").strip(),
        help="PAT token",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("SYNESIS_VERIFY_MODEL", "synesis-core"),
    )
    parser.add_argument(
        "--client",
        default="opencode-harness",
        help="x-synesis-client header value",
    )
    parser.add_argument(
        "--conversation-id",
        default=f"harness-{uuid.uuid4()}",
        help="Conversation id to keep turns cohesive",
    )
    parser.add_argument(
        "--user",
        default="harness-user@example.com",
        help="OpenAI user field for attribution",
    )
    parser.add_argument(
        "--cwd",
        default=os.getcwd(),
        help="Working directory to include in metadata/system hints",
    )
    args = parser.parse_args()

    if not args.base_url:
        print("Missing --base-url (or SYNESIS_YARN_URL).", file=sys.stderr)
        return 2
    if not args.token:
        print("Missing --token (or SYNESIS_TEST_PAT_TOKEN).", file=sys.stderr)
        return 2

    base_url = _normalize_base_url(args.base_url)
    client = OpenAI(base_url=base_url, api_key=args.token, timeout=240.0)
    metadata: dict[str, Any] = {
        "synesis_project_root": args.cwd,
        "synesis_shell_cwd": args.cwd,
        "synesis_conversation_id": args.conversation_id,
        "synesis_runtime": {
            "platform": sys.platform,
            "os_version": "unknown",
            "shell": os.environ.get("SHELL", ""),
        },
    }

    print(f"Base URL: {base_url}")
    print(f"Model: {args.model}")
    print(f"Conversation ID: {args.conversation_id}")
    print(f"Client label: {args.client}")
    print("")

    turn1_id, turn1_text = _run_non_stream_turn(
        client,
        model=args.model,
        prompt="In one sentence, confirm you can read this request and keep continuity.",
        conversation_id=args.conversation_id,
        user=args.user,
        client_label=args.client,
        metadata=metadata,
    )
    print(f"Turn 1 response id: {turn1_id}")
    print(f"Turn 1 text: {turn1_text[:180]}")

    turn2_id, turn2_text = _run_non_stream_turn(
        client,
        model=args.model,
        prompt="What did I ask you in the previous turn? Reply in <=1 sentence.",
        conversation_id=args.conversation_id,
        user=args.user,
        client_label=args.client,
        metadata=metadata,
    )
    print(f"Turn 2 response id: {turn2_id}")
    print(f"Turn 2 text: {turn2_text[:180]}")

    stream_elapsed, stream_id, stream_text = _run_stream_turn(
        client,
        model=args.model,
        prompt=(
            "Do a tiny python security checklist for this pseudo script and keep it short: "
            "import subprocess; subprocess.run(user_input, shell=True)"
        ),
        conversation_id=args.conversation_id,
        user=args.user,
        client_label=args.client,
        metadata=metadata,
    )
    print(f"Stream response id: {stream_id}")
    print(f"Stream elapsed sec: {stream_elapsed:.2f}")
    print(f"Stream text (first 220 chars): {stream_text[:220]}")

    tool_id, has_tool_call = _run_tool_probe(
        client,
        model=args.model,
        conversation_id=args.conversation_id,
        user=args.user,
        client_label=args.client,
        metadata=metadata,
    )
    print(f"Tool probe response id: {tool_id}")
    print(f"Tool call emitted: {has_tool_call}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
