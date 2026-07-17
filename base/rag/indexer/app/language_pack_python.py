"""Python language-pack extraction."""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path
from typing import Any

from .language_pack_common import PYTHON_PROMPT_ID, LanguageChunk, _doc_chunks, _read_text, _split_text


def _python_prompt_for_chunk(text: str, *, rel_path: str, artifact_kind: str, symbol_kind: str = "") -> str:
    lower = f"{rel_path}\n{text}".lower()
    if artifact_kind == "repo_map":
        return "python_repo_architect_v1"
    if artifact_kind in {"packaging_spec", "tool_docs"} or "pyproject" in lower or "uv " in lower or "pixi" in lower:
        return "python_packaging_env_architect_v1"
    if artifact_kind == "type_stub" or "typing" in lower or "type hints" in lower or "pep 649" in lower:
        return "python_typing_architect_v1"
    if artifact_kind == "web_framework_docs" or any(
        marker in lower for marker in ("flask", "werkzeug", "jinja", "wsgi", "blueprint", "request context")
    ):
        return "python_web_flask_architect_v1"
    if artifact_kind in {"ml_framework_docs", "ml_tutorial"} or any(
        marker in lower for marker in ("torch.", "pytorch", "autograd", "cuda", "nn.module", "dataloader")
    ):
        return "python_ml_pytorch_architect_v1"
    if artifact_kind in {"data_science_docs", "notebook_docs"} or any(
        marker in lower
        for marker in (
            "numpy",
            "pandas",
            "scipy",
            "scikit-learn",
            "sklearn",
            "matplotlib",
            "jupyter",
            "dataframe",
            "ndarray",
        )
    ):
        return "python_data_science_architect_v1"
    if "asyncio" in rel_path or "taskgroup" in lower or "await" in lower or "cancel" in lower:
        return "python_async_architect_v1"
    return PYTHON_PROMPT_ID


def _python_metadata(
    *,
    text: str,
    rel_path: str,
    artifact_kind: str,
    symbol_kind: str = "",
    prompt_id: str = "",
) -> dict[str, Any]:
    lower = f"{rel_path}\n{text}".lower()
    tags = ["language-pack", "python"]
    if "pep 703" in lower or "free-thread" in lower or "nogil" in lower or "no-gil" in lower:
        tags.append("free-threading")
    if "pep 734" in lower or "subinterpreter" in lower or "interpreters" in lower:
        tags.append("subinterpreters")
    if "pep 649" in lower or ("deferred" in lower and "annotation" in lower):
        tags.append("deferred-annotations")
    if "pep 750" in lower or "template string" in lower or "t-string" in lower or "templatelib" in lower:
        tags.append("t-strings")
    if "asyncio" in lower or "taskgroup" in lower:
        tags.append("async")
    if "uv" in lower:
        tags.append("uv")
    if "pixi" in lower:
        tags.append("pixi")
    if artifact_kind == "web_framework_docs":
        tags.extend(["web-framework", "flask-ecosystem"])
        if "flask" in lower:
            tags.append("flask")
        if "werkzeug" in lower or "wsgi" in lower:
            tags.append("werkzeug-wsgi")
        if "jinja" in lower or "template" in lower:
            tags.append("jinja-template")
        if "click" in lower or "cli" in lower:
            tags.append("click-cli")
    if artifact_kind in {"ml_framework_docs", "ml_tutorial"}:
        tags.extend(["ml", "pytorch"])
        if "cuda" in lower or "mps" in lower or "device" in lower:
            tags.append("accelerator-device")
        if "autograd" in lower or "gradient" in lower:
            tags.append("autograd")
        if "dataloader" in lower or "dataset" in lower:
            tags.append("data-loading")
        if "distributed" in lower:
            tags.append("distributed-training")
    if artifact_kind in {"data_science_docs", "notebook_docs"}:
        tags.extend(["data-science", "numeric-python"])
        if "numpy" in lower or "ndarray" in lower:
            tags.append("numpy-array")
        if "pandas" in lower or "dataframe" in lower:
            tags.append("pandas-dataframe")
        if "scipy" in lower:
            tags.append("scipy")
        if "scikit-learn" in lower or "sklearn" in lower or "estimator" in lower:
            tags.append("sklearn-estimator")
        if "jupyter" in lower or "notebook" in lower:
            tags.append("notebook")
    if artifact_kind == "repo_map":
        tags.extend(["repo-map", "python-architecture", "repo-repair"])
    if artifact_kind == "type_stub":
        tags.append("typeshed")
    if artifact_kind == "pep":
        tags.append("pep")
    return {
        "scope_tags": tags,
        "constraint_kind": "hard" if artifact_kind in {"pep", "type_stub", "packaging_spec"} else "guiding",
        "constraint_source": "python-peps"
        if artifact_kind == "pep"
        else "typeshed"
        if artifact_kind == "type_stub"
        else "python-repo-map"
        if artifact_kind == "repo_map"
        else "python-web-framework-docs"
        if artifact_kind == "web_framework_docs"
        else "python-ml-framework-docs"
        if artifact_kind in {"ml_framework_docs", "ml_tutorial"}
        else "python-data-science-docs"
        if artifact_kind in {"data_science_docs", "notebook_docs"}
        else "python-docs",
        "content_profile": "architecture"
        if artifact_kind == "repo_map"
        else "procedural"
        if artifact_kind in {"ml_tutorial", "notebook_docs"}
        else "reference",
        "prompt_id": prompt_id
        or _python_prompt_for_chunk(text, rel_path=rel_path, artifact_kind=artifact_kind, symbol_kind=symbol_kind),
    }


def _python_package_for_path(rel_path: str) -> str:
    if rel_path.startswith("Lib/"):
        parts = rel_path.split("/")
        if len(parts) > 1:
            return parts[1].removesuffix(".py")
    if rel_path.startswith("Doc/"):
        return "python-docs"
    if rel_path.startswith("peps/"):
        return "peps"
    if rel_path.startswith("typeshed/"):
        return "typeshed"
    return "python"


def _annotation_to_string(node: ast.AST | None) -> str:
    if node is None:
        return ""
    try:
        return ast.unparse(node)
    except Exception:
        return ""


def _extract_python_symbols(
    file_path: Path, root: Path, *, repo: str, tag: str, artifact_kind: str = "code"
) -> list[LanguageChunk]:
    text = _read_text(file_path)
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return []
    rel_path = file_path.relative_to(root).as_posix()
    package = _python_package_for_path(rel_path)
    chunks: list[LanguageChunk] = []
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        name = node.name
        if name.startswith("_") and name != "__init__":
            continue
        kind = (
            "class"
            if isinstance(node, ast.ClassDef)
            else "async_function"
            if isinstance(node, ast.AsyncFunctionDef)
            else "function"
        )
        doc = ast.get_docstring(node) or ""
        lineno = max(1, getattr(node, "lineno", 1))
        end = min(len(text.splitlines()), getattr(node, "end_lineno", lineno + 40))
        snippet = "\n".join(text.splitlines()[lineno - 1 : min(end, lineno + 60)]).strip()
        body = f"{doc}\n\n```python\n{snippet}\n```".strip()
        symbol_fqn = f"{package}.{name}" if package else name
        chunks.append(
            LanguageChunk(
                text=body,
                doc_id=f"python:{repo}:{rel_path}:{name}",
                chunk_index=0,
                document_name=rel_path,
                heading_path=symbol_fqn,
                section=name,
                source_url=f"https://{repo}/blob/{tag}/{rel_path}",
                package_name=package,
                symbol_kind=kind,
                symbol_fqn=symbol_fqn,
                symbol_name=name,
                module_path=rel_path,
                artifact_kind=artifact_kind,
                content_format=file_path.suffix.lstrip(".") or "python",
                metadata=_python_metadata(text=body, rel_path=rel_path, artifact_kind=artifact_kind, symbol_kind=kind),
            )
        )
    return chunks


def _extract_python_module_doc(
    file_path: Path, root: Path, *, repo: str, tag: str, artifact_kind: str = "docs"
) -> LanguageChunk | None:
    text = _read_text(file_path)
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return None
    doc = ast.get_docstring(tree) or ""
    if not doc:
        return None
    rel_path = file_path.relative_to(root).as_posix()
    package = _python_package_for_path(rel_path)
    return LanguageChunk(
        text=doc[:6500],
        doc_id=f"python:{repo}:{rel_path}:module-doc",
        chunk_index=0,
        document_name=rel_path,
        heading_path=package,
        section=package,
        source_url=f"https://{repo}/blob/{tag}/{rel_path}",
        package_name=package,
        symbol_kind="module",
        symbol_fqn=package,
        symbol_name=package,
        module_path=rel_path,
        artifact_kind=artifact_kind,
        content_format=file_path.suffix.lstrip(".") or "python",
        metadata=_python_metadata(text=doc, rel_path=rel_path, artifact_kind=artifact_kind, symbol_kind="module"),
    )


def _extract_python_pep_chunks(root: Path, rel: str, *, repo: str, tag: str) -> list[LanguageChunk]:
    base = root / rel
    if not base.exists():
        return []
    chunks: list[LanguageChunk] = []
    for file_path in sorted(base.rglob("pep-*.rst")):
        rel_path = file_path.relative_to(root).as_posix()
        text = _read_text(file_path)
        m = re.search(r"pep-(\d{4})", file_path.name, re.IGNORECASE)
        if not m:
            continue
        pep = f"PEP-{m.group(1)}"
        for part in _split_text(text):
            chunks.append(
                LanguageChunk(
                    text=part,
                    doc_id=f"python:{repo}:{rel_path}:{pep}",
                    chunk_index=len(chunks),
                    document_name=rel_path,
                    heading_path=pep,
                    section=pep,
                    source_url=f"https://{repo}/blob/{tag}/{rel_path}",
                    package_name="peps",
                    symbol_kind="pep",
                    symbol_fqn=pep,
                    symbol_name=pep,
                    module_path=rel_path,
                    artifact_kind="pep",
                    content_format="rst",
                    metadata=_python_metadata(text=part, rel_path=rel_path, artifact_kind="pep", symbol_kind="pep"),
                )
            )
    return chunks


def _extract_python_repo_map(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    repo = str(config.get("repo") or "github.com/python/cpython")
    chunks: list[LanguageChunk] = []
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    repo_map_paths = [str(x) for x in include.get("repo_map_paths", ["Lib"])]
    py_files: list[Path] = []
    for rel in repo_map_paths:
        root = source_root / rel
        if root.is_file() and root.suffix == ".py":
            py_files.append(root)
        elif root.exists():
            py_files.extend(p for p in root.rglob("*.py") if ".git" not in p.parts and "__pycache__" not in p.parts)
    if not py_files:
        py_files = sorted(
            p for p in source_root.rglob("*.py") if ".git" not in p.parts and "__pycache__" not in p.parts
        )
    else:
        py_files = sorted(set(py_files))
    py_files = py_files[:1000]
    internal_import_counts: dict[str, int] = {}
    module_infos: list[dict[str, Any]] = []
    package_roots = {p.parent for p in py_files if p.name == "__init__.py"}
    for file_path in py_files:
        text = _read_text(file_path)
        try:
            tree = ast.parse(text)
        except SyntaxError:
            continue
        rel_path = file_path.relative_to(source_root).as_posix()
        public: list[str] = []
        imports: list[str] = []
        type_hints: list[str] = []
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and not node.name.startswith(
                "_"
            ):
                public.append(node.name)
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    ann = _annotation_to_string(node.returns)
                    if ann:
                        type_hints.append(f"{node.name} -> {ann}")
            elif isinstance(node, ast.Import):
                imports.extend(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imports.append(node.module)
        for item in imports:
            internal_import_counts[item.split(".")[0]] = internal_import_counts.get(item.split(".")[0], 0) + 1
        module_infos.append(
            {
                "rel_path": rel_path,
                "doc": ast.get_docstring(tree) or "",
                "public": public[:50],
                "imports": imports[:50],
                "type_hints": type_hints[:50],
                "map_level": 1 if file_path in package_roots else 2,
            }
        )
    max_imports = max(internal_import_counts.values(), default=1)
    project_files = [p.relative_to(source_root).as_posix() for p in py_files[:200]]
    project_json = {
        "map_level": 0,
        "module_intent": "Python project root inferred from pyproject/package layout.",
        "entry_points": [p for p in project_files if p.endswith("__init__.py") or p.endswith("pyproject.toml")][:20],
        "api_surface": [],
        "export_surface": [],
        "dependency_edge": [],
        "center_of_gravity": 1.0,
        "side_effects": "unknown",
        "agent_brief": "Start here to orient on package layout before searching implementation files.",
    }
    chunks.append(
        LanguageChunk(
            text=json.dumps(project_json, sort_keys=True),
            doc_id=f"python:{repo}:repo-map:root",
            chunk_index=0,
            document_name="repo-map",
            heading_path="Project Root",
            section="project_root",
            source_url=f"https://{repo}/tree/{tag}",
            package_name="repo_map",
            symbol_kind="project_root",
            symbol_fqn="repo_map:root",
            symbol_name="root",
            module_path="",
            artifact_kind="repo_map",
            content_format="json",
            metadata={
                **_python_metadata(
                    text=json.dumps(project_json),
                    rel_path="repo-map",
                    artifact_kind="repo_map",
                    symbol_kind="project_root",
                ),
                "repo_map_json": project_json,
            },
        )
    )
    for info in module_infos:
        rel_path = str(info["rel_path"])
        module_name = rel_path.removesuffix(".py").replace("/", ".")
        center = min(1.0, internal_import_counts.get(module_name.split(".")[0], 0) / max_imports)
        map_json = {
            "map_level": info["map_level"],
            "module_intent": info["doc"][:500] or f"Python module {module_name}.",
            "entry_points": info["public"][:20],
            "api_surface": info["public"][:50],
            "export_surface": info["type_hints"][:50],
            "dependency_edge": info["imports"][:50],
            "center_of_gravity": round(center, 4),
            "side_effects": "YES"
            if any(x in ",".join(info["imports"]) for x in ["os", "socket", "subprocess", "sqlite", "requests"])
            else "unknown",
            "agent_brief": f"Use {module_name} as a high-level map row before opening source when the bug report mentions related APIs.",
        }
        chunks.append(
            LanguageChunk(
                text=json.dumps(map_json, sort_keys=True),
                doc_id=f"python:{repo}:repo-map:{rel_path}",
                chunk_index=len(chunks),
                document_name=rel_path,
                heading_path=module_name,
                section=module_name,
                source_url=f"https://{repo}/blob/{tag}/{rel_path}",
                package_name="repo_map",
                symbol_kind="module",
                symbol_fqn=module_name,
                symbol_name=module_name.rsplit(".", 1)[-1],
                module_path=rel_path,
                artifact_kind="repo_map",
                content_format="json",
                metadata={
                    **_python_metadata(
                        text=json.dumps(map_json), rel_path=rel_path, artifact_kind="repo_map", symbol_kind="module"
                    ),
                    "repo_map_json": map_json,
                },
            )
        )
    return chunks


def extract_python_chunks(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    repo = str(config.get("repo") or "github.com/python/cpython")
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    chunks: list[LanguageChunk] = []
    for rel in include.get("stdlib", ["Lib"]):
        root = source_root / str(rel)
        if not root.exists():
            continue
        for file_path in sorted(root.rglob("*.py")):
            if "test" in file_path.relative_to(root).parts:
                continue
            module_doc = _extract_python_module_doc(file_path, source_root, repo=repo, tag=tag)
            if module_doc:
                chunks.append(module_doc)
            chunks.extend(_extract_python_symbols(file_path, source_root, repo=repo, tag=tag))
    for rel in include.get("docs", ["Doc"]):
        chunks.extend(
            _doc_chunks(
                source_root,
                [str(rel)],
                language="python",
                repo=repo,
                tag=tag,
                package_name="python-docs",
                artifact_kind="docs",
                prompt_id=PYTHON_PROMPT_ID,
            )
        )
    for aux in include.get("aux_sources", []):
        if not isinstance(aux, dict):
            continue
        name = str(aux.get("name") or "")
        aux_root = source_root / name if name and (source_root / name).exists() else source_root
        repo_name = str(aux.get("repo") or repo)
        path = str(aux.get("path") or "")
        artifact_kind = str(aux.get("artifact_kind") or "docs")
        if artifact_kind == "pep":
            chunks.extend(
                _extract_python_pep_chunks(
                    aux_root, path or ".", repo=repo_name, tag=str(aux.get("resolved_ref") or "main")
                )
            )
            continue
        if artifact_kind == "type_stub":
            for pyi in sorted((aux_root / path).rglob("*.pyi")) if (aux_root / path).exists() else []:
                chunks.extend(
                    _extract_python_symbols(
                        pyi,
                        aux_root,
                        repo=repo_name,
                        tag=str(aux.get("resolved_ref") or "main"),
                        artifact_kind="type_stub",
                    )
                )
            continue
        for chunk in _doc_chunks(
            aux_root,
            [path or "."],
            language="python",
            repo=repo_name,
            tag=str(aux.get("resolved_ref") or "main"),
            package_name=str(aux.get("package_name") or name or "python"),
            artifact_kind=artifact_kind,
            prompt_id=str(aux.get("prompt_id") or ""),
        ):
            chunk.metadata.update(
                _python_metadata(
                    text=chunk.text,
                    rel_path=chunk.module_path,
                    artifact_kind=artifact_kind,
                    prompt_id=str(aux.get("prompt_id") or ""),
                )
            )
            chunks.append(chunk)
    pyproject = source_root / "pyproject.toml"
    if pyproject.exists():
        text = _read_text(pyproject)
        map_json = {
            "map_level": 0,
            "module_intent": "Python project metadata, dependency groups, build backend, and tool configuration.",
            "entry_points": re.findall(r"(?m)^\s*([A-Za-z0-9_.-]+)\s*=", text)[:20],
            "api_surface": [],
            "export_surface": [],
            "dependency_edge": re.findall(r"['\"]([A-Za-z0-9_.-]+)[<>=~!;,'\"]", text)[:50],
            "center_of_gravity": 1.0,
            "side_effects": "NO",
            "agent_brief": "Inspect pyproject.toml before changing dependencies, test commands, build backend, or Python version constraints.",
        }
        chunks.append(
            LanguageChunk(
                text=text[:6500],
                doc_id=f"python:{repo}:pyproject.toml",
                chunk_index=len(chunks),
                document_name="pyproject.toml",
                heading_path="pyproject.toml",
                section="pyproject",
                source_url=f"https://{repo}/blob/{tag}/pyproject.toml",
                package_name="repo_map",
                symbol_kind="project_config",
                symbol_fqn="pyproject.toml",
                symbol_name="pyproject.toml",
                module_path="pyproject.toml",
                artifact_kind="repo_map",
                content_format="toml",
                metadata={
                    **_python_metadata(
                        text=text, rel_path="pyproject.toml", artifact_kind="repo_map", symbol_kind="project_config"
                    ),
                    "repo_map_json": map_json,
                },
            )
        )
    chunks.extend(_extract_python_repo_map(source_root, config=config, tag=tag))
    for idx, chunk in enumerate(chunks):
        chunk.chunk_index = idx
    return chunks
