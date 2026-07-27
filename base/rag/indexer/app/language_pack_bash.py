"""Bash and shell language-pack extraction."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .language_pack_common import BASH_PROMPT_ID, LanguageChunk, _doc_chunks, _read_text, _split_text

SHELL_SCRIPT_SUFFIXES = {".sh", ".bash", ".zsh", ".ksh", ".bats"}


def _shell_dialect(text: str, rel_path: str = "") -> str:
    first = text.splitlines()[0].lower() if text.splitlines() else ""
    haystack = f"{rel_path}\n{first}".lower()
    if "zsh" in haystack:
        return "zsh"
    if "ksh" in haystack:
        return "ksh"
    if "bash" in haystack:
        return "bash"
    if "dash" in haystack or "/bin/sh" in haystack or "posix" in haystack:
        return "posix-sh"
    return "shell"


def _bash_prompt_for_chunk(text: str, *, rel_path: str, artifact_kind: str, symbol_kind: str = "") -> str:
    lower = f"{rel_path}\n{text}".lower()
    if artifact_kind == "shellcheck_rule" or re.search(r"\bSC\d{4}\b", text):
        return "shellcheck_rule_architect_v1"
    if artifact_kind in {"feedback_loop", "script_pattern"} or any(
        token in lower for token in ("shellcheck", "shfmt", "bats", "bash -n", "set -euo pipefail")
    ):
        return "shell_feedback_loop_architect_v1"
    return BASH_PROMPT_ID


def _bash_metadata(
    *,
    text: str,
    rel_path: str,
    artifact_kind: str,
    symbol_kind: str = "",
    prompt_id: str = "",
) -> dict[str, Any]:
    lower = f"{rel_path}\n{text}".lower()
    tags = ["language-pack", "bash", "shell"]
    if "shellcheck" in lower or artifact_kind == "shellcheck_rule":
        tags.extend(["shellcheck", "linter-rules"])
    if "shfmt" in lower:
        tags.append("shfmt")
    if "bats" in lower or "test" in lower:
        tags.append("testing")
    if "set -euo pipefail" in lower or "errexit" in lower or "nounset" in lower:
        tags.append("strict-mode")
    if "trap" in lower or "cleanup" in lower:
        tags.append("cleanup-traps")
    if "mktemp" in lower or "tmp" in lower:
        tags.append("safe-tempfiles")
    if "quote" in lower or "word splitting" in lower or "$@" in text:
        tags.append("quoting")
    if any(token in lower for token in ("eval", "curl |", "| bash", "rm -rf", "sudo", "chmod +x")):
        tags.append("dangerous-command")
    if artifact_kind == "style_guide":
        tags.append("style-guide")
    if artifact_kind == "bash_reference":
        tags.append("bash-reference")
    if artifact_kind == "defensive_pattern":
        tags.append("defensive-programming")
    if artifact_kind == "pure_bash_pattern":
        tags.append("pure-bash")
    return {
        "scope_tags": tags,
        "constraint_kind": "hard" if artifact_kind == "shellcheck_rule" or "dangerous-command" in tags else "guiding",
        "constraint_source": "shellcheck"
        if artifact_kind == "shellcheck_rule"
        else "shell-style-guide"
        if artifact_kind == "style_guide"
        else "bash-reference"
        if artifact_kind == "bash_reference"
        else "shell-patterns",
        "content_profile": "diagnostic" if artifact_kind == "shellcheck_rule" else "procedural",
        "shell_dialect": _shell_dialect(text, rel_path),
        "command_safety": "dangerous"
        if "dangerous-command" in tags
        else "guarded"
        if "cleanup-traps" in tags
        else "safe",
        "prompt_id": prompt_id or _bash_prompt_for_chunk(text, rel_path=rel_path, artifact_kind=artifact_kind),
    }


def _shellcheck_rule_id(text: str, rel_path: str) -> str:
    name_match = re.search(r"\b(SC\d{4})\b", Path(rel_path).stem, re.I)
    if name_match:
        return name_match.group(1).upper()
    text_match = re.search(r"\b(SC\d{4})\b", text)
    return text_match.group(1).upper() if text_match else ""


def _extract_shellcheck_rule_chunks(
    root: Path,
    rel: str,
    *,
    repo: str,
    tag: str,
    package_name: str,
    prompt_id: str = "",
) -> list[LanguageChunk]:
    chunks: list[LanguageChunk] = []
    path = root / rel
    files = sorted(path.rglob("*")) if path.is_dir() else [path]
    for file_path in files:
        if not file_path.is_file():
            continue
        if file_path.suffix.lower() not in {"", ".md", ".markdown", ".txt", ".rst"}:
            continue
        rel_path = file_path.relative_to(root).as_posix()
        text = _read_text(file_path)
        rule_id = _shellcheck_rule_id(text, rel_path)
        if not rule_id:
            continue
        for index, part in enumerate(_split_text(text, max_chars=6500)):
            chunks.append(
                LanguageChunk(
                    text=part,
                    doc_id=f"bash:{repo}:{rel_path}:{rule_id}",
                    chunk_index=index,
                    document_name=rel_path,
                    heading_path=rule_id,
                    section=rule_id,
                    source_url=f"https://{repo}/blob/{tag}/{rel_path}",
                    package_name=package_name,
                    symbol_kind="shellcheck_rule",
                    symbol_fqn=rule_id,
                    symbol_name=rule_id,
                    module_path=rel_path,
                    artifact_kind="shellcheck_rule",
                    content_format=file_path.suffix.lstrip(".") or "text",
                    metadata=_bash_metadata(
                        text=part,
                        rel_path=rel_path,
                        artifact_kind="shellcheck_rule",
                        symbol_kind="shellcheck_rule",
                        prompt_id=prompt_id,
                    ),
                )
            )
    return chunks


def _is_shell_script(path: Path, text: str) -> bool:
    return path.suffix.lower() in SHELL_SCRIPT_SUFFIXES or (text.startswith("#!") and "sh" in text.splitlines()[0])


def _shell_function_comment(lines: list[str], start: int) -> str:
    out: list[str] = []
    i = start - 1
    while i >= 0:
        stripped = lines[i].strip()
        if stripped.startswith("#") and not stripped.startswith("#!"):
            out.append(stripped.lstrip("#").strip())
            i -= 1
            continue
        if not stripped:
            i -= 1
            continue
        break
    return "\n".join(reversed([item for item in out if item])).strip()


def _extract_shell_script_chunks(
    root: Path,
    rel: str,
    *,
    repo: str,
    tag: str,
    package_name: str,
    prompt_id: str = "",
) -> list[LanguageChunk]:
    chunks: list[LanguageChunk] = []
    path = root / rel
    files = sorted(path.rglob("*")) if path.is_dir() else [path]
    function_re = re.compile(r"(?m)^\s*(?:function\s+)?(?P<name>[A-Za-z_][A-Za-z0-9_:-]*)\s*(?:\(\))?\s*\{")
    for file_path in files:
        if not file_path.is_file():
            continue
        text = _read_text(file_path)
        if not _is_shell_script(file_path, text):
            continue
        rel_path = file_path.relative_to(root).as_posix()
        lines = text.splitlines()
        matched = False
        for match in function_re.finditer(text):
            matched = True
            name = match.group("name")
            line_no = text[: match.start()].count("\n")
            comment = _shell_function_comment(lines, line_no)
            snippet = "\n".join(lines[line_no : min(len(lines), line_no + 80)]).strip()
            body = f"{comment}\n\n```bash\n{snippet}\n```".strip()
            chunks.append(
                LanguageChunk(
                    text=body,
                    doc_id=f"bash:{repo}:{rel_path}:{name}",
                    chunk_index=len(chunks),
                    document_name=rel_path,
                    heading_path=name,
                    section=name,
                    source_url=f"https://{repo}/blob/{tag}/{rel_path}",
                    package_name=package_name,
                    symbol_kind="function",
                    symbol_fqn=f"{rel_path}:{name}",
                    symbol_name=name,
                    module_path=rel_path,
                    artifact_kind="script_pattern",
                    content_format=file_path.suffix.lstrip(".") or "shell",
                    metadata=_bash_metadata(
                        text=body,
                        rel_path=rel_path,
                        artifact_kind="script_pattern",
                        symbol_kind="function",
                        prompt_id=prompt_id,
                    ),
                )
            )
        if not matched:
            chunks.append(
                LanguageChunk(
                    text=text[:6500],
                    doc_id=f"bash:{repo}:{rel_path}",
                    chunk_index=len(chunks),
                    document_name=rel_path,
                    heading_path=rel_path,
                    section=file_path.stem,
                    source_url=f"https://{repo}/blob/{tag}/{rel_path}",
                    package_name=package_name,
                    symbol_kind="script",
                    symbol_fqn=rel_path,
                    symbol_name=file_path.name,
                    module_path=rel_path,
                    artifact_kind="script_pattern",
                    content_format=file_path.suffix.lstrip(".") or "shell",
                    metadata=_bash_metadata(
                        text=text,
                        rel_path=rel_path,
                        artifact_kind="script_pattern",
                        symbol_kind="script",
                        prompt_id=prompt_id,
                    ),
                )
            )
    return chunks


def extract_bash_chunks(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    repo = str(config.get("repo") or "github.com/koalaman/shellcheck")
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    chunks: list[LanguageChunk] = []
    for chunk in _doc_chunks(
        source_root,
        [str(x) for x in include.get("docs", ["README.md"])],
        language="bash",
        repo=repo,
        tag=tag,
        package_name="shellcheck",
        artifact_kind="feedback_loop",
        prompt_id="shell_feedback_loop_architect_v1",
    ):
        chunk.metadata.update(
            _bash_metadata(
                text=chunk.text,
                rel_path=chunk.module_path,
                artifact_kind="feedback_loop",
                prompt_id="shell_feedback_loop_architect_v1",
            )
        )
        chunks.append(chunk)

    for rel in include.get("shellcheck_rules", []):
        chunks.extend(
            _extract_shellcheck_rule_chunks(
                source_root,
                str(rel),
                repo=repo,
                tag=tag,
                package_name="shellcheck",
                prompt_id="shellcheck_rule_architect_v1",
            )
        )
    for rel in include.get("script_roots", []):
        chunks.extend(
            _extract_shell_script_chunks(
                source_root,
                str(rel),
                repo=repo,
                tag=tag,
                package_name="shell-patterns",
                prompt_id="shell_feedback_loop_architect_v1",
            )
        )

    for aux in include.get("aux_sources", []):
        if not isinstance(aux, dict):
            continue
        name = str(aux.get("name") or "")
        aux_root = source_root / name if name and (source_root / name).exists() else source_root
        repo_name = str(aux.get("repo") or repo)
        raw_path = aux.get("path") or "."
        paths = [str(path) for path in raw_path] if isinstance(raw_path, list) else [str(raw_path)]
        artifact_kind = str(aux.get("artifact_kind") or "docs")
        package_name = str(aux.get("package_name") or name or "shell")
        prompt_id = str(aux.get("prompt_id") or "")
        for rel in paths:
            if artifact_kind == "shellcheck_rule":
                chunks.extend(
                    _extract_shellcheck_rule_chunks(
                        aux_root,
                        rel,
                        repo=repo_name,
                        tag=str(aux.get("resolved_ref") or "main"),
                        package_name=package_name,
                        prompt_id=prompt_id or "shellcheck_rule_architect_v1",
                    )
                )
                continue
            for chunk in _doc_chunks(
                aux_root,
                [rel],
                language="bash",
                repo=repo_name,
                tag=str(aux.get("resolved_ref") or "main"),
                package_name=package_name,
                artifact_kind=artifact_kind,
                prompt_id=prompt_id,
            ):
                chunk.metadata.update(
                    _bash_metadata(
                        text=chunk.text,
                        rel_path=chunk.module_path,
                        artifact_kind=artifact_kind,
                        prompt_id=prompt_id,
                    )
                )
                chunks.append(chunk)
            if artifact_kind in {"script_pattern", "feedback_loop"}:
                chunks.extend(
                    _extract_shell_script_chunks(
                        aux_root,
                        rel,
                        repo=repo_name,
                        tag=str(aux.get("resolved_ref") or "main"),
                        package_name=package_name,
                        prompt_id=prompt_id or "shell_feedback_loop_architect_v1",
                    )
                )

    for idx, chunk in enumerate(chunks):
        chunk.chunk_index = idx
    return chunks
