"""Apply the Synesis delta to the pinned Open WebUI middleware."""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

UPSTREAM_SHA256 = "861978ea80b69c4201c0742d1401691834ea7202e75d4eb47250ac0c14af2ea9"


def _replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one upstream anchor, found {count}")
    return source.replace(old, new, 1)


def patch_source(source: str) -> str:
    digest = hashlib.sha256(source.encode()).hexdigest()
    if digest != UPSTREAM_SHA256:
        raise RuntimeError(f"unsupported Open WebUI middleware sha256: {digest}")

    source = _replace_once(
        source,
        """    if not isinstance(metadata.get('chat_id'), str):
        metadata['chat_id'] = ''

    # Pipeline Inlet -> Filter Inlet -> Chat Memory -> Chat Web Search -> Chat Image Generation
""",
        """    if not isinstance(metadata.get('chat_id'), str):
        metadata['chat_id'] = ''

    original_messages = form_data.get('messages') if isinstance(form_data.get('messages'), list) else []
    original_messages = copy.deepcopy(original_messages)

    # Pipeline Inlet -> Filter Inlet -> Chat Memory -> Chat Web Search -> Chat Image Generation
""",
        "original planner payload",
    )
    source = _replace_once(
        source,
        """    return [{k: v for k, v in msg.items() if k in ('role', 'content', 'output', 'files')} for msg in db_messages]


def get_reasoning_format(model: dict) -> str | None:
""",
        """    return [{k: v for k, v in msg.items() if k in ('role', 'content', 'output', 'files')} for msg in db_messages]


async def recover_empty_messages_from_db(metadata: dict, original_messages: list[dict]):
    if original_messages:
        return copy.deepcopy(original_messages), 'request'

    chat_id = metadata.get('chat_id')
    if not chat_id or chat_id.startswith(('local:', 'channel:')):
        return None, 'none'

    for source_name, message_id in (
        ('user_message_id', metadata.get('user_message_id')),
        ('parent_message_id', metadata.get('parent_message_id')),
        ('message_id', metadata.get('message_id')),
    ):
        if message_id:
            db_messages = await load_messages_from_db(chat_id, message_id)
            if db_messages:
                return db_messages, source_name
    return None, 'none'


def get_reasoning_format(model: dict) -> str | None:
""",
        "empty payload recovery",
    )
    source = _replace_once(
        source,
        "from open_webui.utils.webhook import post_webhook\nfrom starlette.responses import JSONResponse, Response, StreamingResponse\n",
        "from open_webui.utils.webhook import post_webhook\n"
        "from open_webui.utils.capability_matrix import resolve_webui_capabilities\n"
        "from starlette.responses import JSONResponse, Response, StreamingResponse\n",
        "capability import",
    )
    source = _replace_once(
        source,
        """        if selected_model:
            model = selected_model
            form_data['model'] = selected_model_id
            metadata['selected_model_id'] = selected_model_id

    form_data = apply_params_to_form_data(form_data, model)
""",
        """        if selected_model:
            model = selected_model
            form_data['model'] = selected_model_id
            metadata['selected_model_id'] = selected_model_id

    capability_matrix = await resolve_webui_capabilities(model)
    metadata['capability_matrix_resolution_v1'] = {
        'mode': capability_matrix['resolution'].get('mode'),
        'global_optimizations_enabled': capability_matrix['resolution'].get('global_optimizations_enabled'),
        'model_id': capability_matrix['model_id'],
        'model_path': capability_matrix['model_path'],
        'family': capability_matrix['family'],
        'matched_override_ids': capability_matrix['resolution'].get('matched_override_ids', []),
        'resolved_capabilities': capability_matrix['resolution'].get('resolved_capabilities', {}),
    }
    log.debug(
        'capability_matrix_resolution_v1 mode=%s model=%s matched=%s',
        capability_matrix['resolution'].get('mode'),
        capability_matrix['model_id'],
        ','.join(capability_matrix['resolution'].get('matched_override_ids', [])) or 'none',
    )

    form_data = apply_params_to_form_data(form_data, model)
""",
        "capability resolution",
    )
    source = _replace_once(
        source,
        """    # Merge any duplicate system messages into a single message at position 0
    # to prevent template parsing errors with strict chat templates (e.g. Qwen)
    form_data['messages'] = merge_system_messages(form_data.get('messages', []))

    return form_data, metadata, events
""",
        """    # Merge any duplicate system messages into a single message at position 0
    # to prevent template parsing errors with strict chat templates (e.g. Qwen)
    form_data['messages'] = merge_system_messages(form_data.get('messages', []))

    if not form_data['messages']:
        recovered_messages, recovery_source = await recover_empty_messages_from_db(metadata, original_messages)
        if not recovered_messages:
            log.warning(
                'Refusing empty outbound messages for model=%s chat_id=%s message_id=%s',
                form_data.get('model'),
                metadata.get('chat_id'),
                metadata.get('message_id'),
            )
            raise HTTPException(status_code=400, detail='No chat messages available to send to the model.')
        form_data['messages'] = process_messages_with_output(recovered_messages, get_reasoning_format(model))
        form_data['messages'] = strip_empty_content_blocks(form_data['messages'])
        form_data['messages'] = merge_system_messages(form_data['messages'])
        log.warning('Recovered empty outbound messages from %s', recovery_source)

    return form_data, metadata, events
""",
        "empty payload guard",
    )
    source = _replace_once(
        source,
        """        # Inject builtin tools for native function calling based on enabled features and model capability
        # Check if builtin_tools capability is enabled for this model (defaults to True if not specified)
        builtin_tools_enabled = (model.get('info', {}).get('meta', {}).get('capabilities') or {}).get(
            'builtin_tools', True
        )
""",
        """        # Inject builtin tools for native function calling based on enabled features and model capability
        builtin_tools_enabled = capability_matrix['builtin_tools_enabled']
""",
        "builtin tools gate",
    )
    source = _replace_once(
        source,
        """    # Check if file context extraction is enabled for this model (default True)
    file_context_enabled = (model.get('info', {}).get('meta', {}).get('capabilities') or {}).get('file_context', True)
""",
        """    # Check if file context extraction is enabled for this model.
    file_context_enabled = capability_matrix['file_context_enabled']
""",
        "file context gate",
    )
    source = _replace_once(
        source,
        """            usage = None
            prior_output = []
            last_response_id = None
""",
        """            usage = None
            synesis_run_id = None
            synesis_authz_trace_id = None
            prior_output = []
            last_response_id = None
""",
        "trace state",
    )
    source = _replace_once(
        source,
        """                    nonlocal output
                    nonlocal prior_output
                    nonlocal last_response_id
""",
        """                    nonlocal output
                    nonlocal prior_output
                    nonlocal last_response_id
                    nonlocal synesis_run_id
                    nonlocal synesis_authz_trace_id
""",
        "trace closure",
    )
    source = _replace_once(
        source,
        """                                    if raw_usage:
                                        usage = normalize_usage(raw_usage)
                                        await event_emitter(
                                            {
                                                'type': 'chat:completion',
                                                'data': {
                                                    'usage': usage,
                                                },
                                            }
                                        )
""",
        """                                    if raw_usage:
                                        usage = normalize_usage(raw_usage)
                                        emit_data = {'usage': usage}
                                        if data.get('run_id'):
                                            synesis_run_id = data['run_id']
                                            emit_data['run_id'] = synesis_run_id
                                        if data.get('authz_trace_id'):
                                            synesis_authz_trace_id = data['authz_trace_id']
                                            emit_data['authz_trace_id'] = synesis_authz_trace_id
                                        await event_emitter({'type': 'chat:completion', 'data': emit_data})
                                        if synesis_run_id or synesis_authz_trace_id:
                                            await Chats.upsert_message_to_chat_by_id_and_message_id(
                                                metadata['chat_id'],
                                                metadata['message_id'],
                                                {
                                                    **({'synesis_run_id': synesis_run_id} if synesis_run_id else {}),
                                                    **(
                                                        {'synesis_authz_trace_id': synesis_authz_trace_id}
                                                        if synesis_authz_trace_id
                                                        else {}
                                                    ),
                                                },
                                            )
""",
        "stream trace capture",
    )
    source = _replace_once(
        source,
        """                data = {
                    'done': True,
                    'content': serialize_output(output),
                    'output': output,
                    'title': title,
                    **({'usage': usage} if usage else {}),
                }

                if not metadata.get('chat_id', '').startswith('channel:'):
""",
        """                synesis_msg_extra = {
                    **({'synesis_run_id': synesis_run_id} if synesis_run_id else {}),
                    **(
                        {'synesis_authz_trace_id': synesis_authz_trace_id}
                        if synesis_authz_trace_id
                        else {}
                    ),
                }
                data = {
                    'done': True,
                    'content': serialize_output(output),
                    'output': output,
                    'title': title,
                    **({'usage': usage} if usage else {}),
                    **({'run_id': synesis_run_id} if synesis_run_id else {}),
                    **({'authz_trace_id': synesis_authz_trace_id} if synesis_authz_trace_id else {}),
                }

                if not metadata.get('chat_id', '').startswith('channel:'):
""",
        "final trace event",
    )
    source = _replace_once(
        source,
        """                                'output': output,
                                **({'usage': usage} if usage else {}),
                            },
""",
        """                                'output': output,
                                **({'usage': usage} if usage else {}),
                                **synesis_msg_extra,
                            },
""",
        "saved trace metadata",
    )
    source = _replace_once(
        source,
        """                            metadata['message_id'],
                            {'done': True, 'usage': usage},
                        )
                    else:
                        await Chats.upsert_message_to_chat_by_id_and_message_id(
                            metadata['chat_id'],
                            metadata['message_id'],
                            {'done': True},
                        )
""",
        """                            metadata['message_id'],
                            {'done': True, 'usage': usage, **synesis_msg_extra},
                        )
                    else:
                        await Chats.upsert_message_to_chat_by_id_and_message_id(
                            metadata['chat_id'],
                            metadata['message_id'],
                            {'done': True, **synesis_msg_extra},
                        )
""",
        "realtime trace metadata",
    )
    source = _replace_once(
        source,
        """                ctx['assistant_message'] = {
                    'content': serialize_output(output),
                    'output': output,
                    **({'usage': usage} if usage else {}),
                }
""",
        """                ctx['assistant_message'] = {
                    'content': serialize_output(output),
                    'output': output,
                    **({'usage': usage} if usage else {}),
                    **synesis_msg_extra,
                }
""",
        "outlet trace metadata",
    )
    return source


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {Path(sys.argv[0]).name} MIDDLEWARE_PATH")
    path = Path(sys.argv[1])
    path.write_text(patch_source(path.read_text(encoding="utf-8")), encoding="utf-8")


if __name__ == "__main__":
    main()
