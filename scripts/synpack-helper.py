#!/usr/bin/env python3
"""Safe wrapper for staged SynPack language-pack builds.

The indexer CLI intentionally exposes many knobs. This helper provides stable
defaults for day-to-day pack generation and keeps each language in an isolated
repo-local work directory.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
from collections.abc import Iterable
from pathlib import Path

SUPPORTED_LANGUAGES = ("go", "rust", "quarkus", "python", "godot", "terraform", "ecma", "bash")
DEFAULT_UV_PACKAGES = ("pyyaml", "defusedxml", "httpx", "numpy", "neo4j")


def _repo_root() -> Path:
    here = Path(__file__).resolve()
    root = here.parents[1]
    if not (root / "base/rag/indexer/app/cli.py").exists():
        raise SystemExit(f"could not locate repository root from {here}")
    return root


def _json_file(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def _display_cmd(cmd: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in cmd)


def _run(cmd: list[str], *, cwd: Path, env: dict[str, str], dry_run: bool) -> None:
    print(f"+ (cd {cwd} && {_display_cmd(cmd)})")
    if dry_run:
        return
    subprocess.run(cmd, cwd=str(cwd), env=env, check=True)


def _language_list(value: str) -> list[str]:
    raw = [item.strip().lower() for item in value.split(",") if item.strip()]
    if not raw or raw == ["all"]:
        return list(SUPPORTED_LANGUAGES)
    unknown = [item for item in raw if item not in SUPPORTED_LANGUAGES]
    if unknown:
        raise SystemExit(f"unsupported language(s): {', '.join(unknown)}")
    return raw


def _default_pack_id(language: str) -> str:
    return f"{language}-latest"


def _resolve_pack_id(args: argparse.Namespace, language: str) -> str:
    return args.pack_id or _default_pack_id(language)


def _work_dir(args: argparse.Namespace, repo_root: Path, pack_id: str) -> Path:
    if args.work_dir:
        return Path(args.work_dir).expanduser().resolve()
    return (repo_root / args.work_root / pack_id).resolve()


def _output_path(args: argparse.Namespace, repo_root: Path, pack_id: str) -> Path:
    if args.output:
        return Path(args.output).expanduser().resolve()
    return (repo_root / args.output_dir / f"{pack_id}.synpack").resolve()


def _ensure_repo_local_workdir(repo_root: Path, work_dir: Path) -> None:
    try:
        work_dir.relative_to(repo_root)
    except ValueError as exc:
        raise SystemExit(
            f"refusing work dir outside repository: {work_dir}\n"
            "Use the default .work/synpacks/<pack-id> location to avoid cross-pack overwrite mistakes."
        ) from exc

    forbidden = {repo_root, repo_root / "base", repo_root / "base/rag", repo_root / "base/rag/indexer"}
    if work_dir in forbidden:
        raise SystemExit(f"refusing broad work dir: {work_dir}")


def _assert_matching_manifest(work_dir: Path, *, language: str, pack_id: str) -> dict:
    manifest = _json_file(work_dir / "run_manifest.json")
    if not manifest:
        raise SystemExit(f"missing staged manifest: {work_dir / 'run_manifest.json'}")
    found_language = str(manifest.get("language") or "").lower()
    found_pack_id = str(manifest.get("pack_id") or "")
    if found_language != language or found_pack_id != pack_id:
        raise SystemExit(
            "refusing to use mismatched SynPack work dir\n"
            f"  work_dir: {work_dir}\n"
            f"  expected: language={language} pack_id={pack_id}\n"
            f"  found:    language={found_language or '(missing)'} pack_id={found_pack_id or '(missing)'}"
        )
    return manifest


def _assert_prepare_safe(work_dir: Path, *, language: str, pack_id: str, overwrite_prepare: bool) -> None:
    if not work_dir.exists():
        return
    manifest = _json_file(work_dir / "run_manifest.json")
    if manifest:
        found_language = str(manifest.get("language") or "").lower()
        found_pack_id = str(manifest.get("pack_id") or "")
        if found_language != language or found_pack_id != pack_id:
            raise SystemExit(
                "refusing to prepare into a work dir that belongs to another pack\n"
                f"  work_dir: {work_dir}\n"
                f"  expected: language={language} pack_id={pack_id}\n"
                f"  found:    language={found_language or '(missing)'} pack_id={found_pack_id or '(missing)'}"
            )
        if not overwrite_prepare:
            raise SystemExit(
                f"{work_dir} is already prepared for {pack_id}. "
                "Run enrich/finalize, or pass --overwrite-prepare to intentionally rebuild staging files."
            )
        return
    if any(work_dir.iterdir()) and not overwrite_prepare:
        raise SystemExit(
            f"refusing to prepare into non-empty directory without a SynPack manifest: {work_dir}\n"
            "Choose the default work dir or pass --overwrite-prepare after inspecting it."
        )


def _base_uv_cmd(repo_root: Path) -> list[str]:
    telemetry = repo_root / "base/images/base-api/synesis-telemetry"
    cmd = ["uv", "run", "--with-editable", str(telemetry)]
    for package in DEFAULT_UV_PACKAGES:
        cmd.extend(["--with", package])
    cmd.extend(["python", "-m", "app.cli", "--mode", "synpack"])
    return cmd


def _common_synpack_args(args: argparse.Namespace, language: str, pack_id: str, work_dir: Path) -> list[str]:
    out = ["--language", language, "--pack-id", pack_id, "--work-dir", str(work_dir)]
    if args.pack_version:
        out.extend(["--pack-version", args.pack_version])
    if args.source_version:
        out.extend(["--source-version", args.source_version])
    if args.latest_tag:
        out.extend(["--latest-tag", args.latest_tag])
    if args.pack_config:
        out.extend(["--pack-config", str(Path(args.pack_config).expanduser().resolve())])
    if args.source_dir:
        out.extend(["--source-dir", str(Path(args.source_dir).expanduser().resolve())])
    if args.provider_schema:
        out.extend(["--provider-schema", str(Path(args.provider_schema).expanduser().resolve())])
    if args.doc_language:
        out.extend(["--doc-language", args.doc_language])
    if args.max_chunks:
        out.extend(["--max-chunks", str(args.max_chunks)])
    return out


def _prepare_cmd(args: argparse.Namespace, repo_root: Path, language: str, pack_id: str, work_dir: Path) -> list[str]:
    cmd = _base_uv_cmd(repo_root)
    cmd.extend(["--synpack-command", "prepare-language"])
    cmd.extend(_common_synpack_args(args, language, pack_id, work_dir))
    cmd.extend(
        [
            "--enrichment-model",
            args.enrichment_model,
            "--enrichment-provider",
            args.enrichment_provider,
            "--enrichment-concurrency",
            str(args.enrichment_concurrency),
            "--enrichment-max-tokens",
            str(args.enrichment_max_tokens),
        ]
    )
    if args.enrichment_url:
        cmd.extend(["--enrichment-url", args.enrichment_url])
    if args.enrich_zero_quality:
        cmd.append("--enrich-zero-quality")
    if args.enrichment_input_price_per_mtok:
        cmd.extend(["--enrichment-input-price-per-mtok", str(args.enrichment_input_price_per_mtok)])
    if args.enrichment_output_price_per_mtok:
        cmd.extend(["--enrichment-output-price-per-mtok", str(args.enrichment_output_price_per_mtok)])
    return cmd


def _enrich_cmd(args: argparse.Namespace, repo_root: Path, language: str, pack_id: str, work_dir: Path) -> list[str]:
    cmd = _base_uv_cmd(repo_root)
    cmd.extend(["--synpack-command", "enrich-language"])
    cmd.extend(["--language", language, "--pack-id", pack_id, "--work-dir", str(work_dir)])
    cmd.extend(
        [
            "--enrichment-url",
            args.enrichment_url,
            "--enrichment-model",
            args.enrichment_model,
            "--enrichment-provider",
            args.enrichment_provider,
            "--enrichment-concurrency",
            str(args.enrichment_concurrency),
            "--enrichment-max-tokens",
            str(args.enrichment_max_tokens),
            "--enrichment-timeout",
            str(args.enrichment_timeout),
            "--batch-size",
            str(args.batch_size),
        ]
    )
    if args.request_limit:
        cmd.extend(["--request-limit", str(args.request_limit)])
    if args.skip_enrichment:
        cmd.append("--skip-enrichment")
    if args.enrich_zero_quality:
        cmd.append("--enrich-zero-quality")
    return cmd


def _finalize_cmd(
    args: argparse.Namespace, repo_root: Path, language: str, pack_id: str, work_dir: Path, output: Path
) -> list[str]:
    cmd = _base_uv_cmd(repo_root)
    cmd.extend(["--synpack-command", "finalize-language"])
    cmd.extend(["--language", language, "--pack-id", pack_id, "--work-dir", str(work_dir), "--output", str(output)])
    if args.embedder_url:
        cmd.extend(["--embedder-url", args.embedder_url])
    cmd.extend(
        ["--embedder-batch-size", str(args.embedder_batch_size), "--embedder-timeout", str(args.embedder_timeout)]
    )
    return cmd


def _load_cmd(args: argparse.Namespace, repo_root: Path, output: Path) -> list[str]:
    cmd = _base_uv_cmd(repo_root)
    cmd.extend(["--synpack-command", "bulk-load", "--synpack", str(output)])
    if args.nornic_uri:
        cmd.extend(["--nornic-uri", args.nornic_uri])
    if args.replace:
        cmd.append("--replace")
    return cmd


def _print_status(work_dir: Path, output: Path) -> None:
    manifest = _json_file(work_dir / "run_manifest.json")
    state = _json_file(work_dir / "checkpoints/enrich-state.json")
    status = {
        "work_dir": str(work_dir),
        "prepared": bool(manifest),
        "pack_id": manifest.get("pack_id") if manifest else "",
        "language": manifest.get("language") if manifest else "",
        "chunks": manifest.get("row_count") if manifest else 0,
        "enrichment": state,
        "output": str(output),
        "output_exists": output.exists(),
    }
    print(json.dumps(status, indent=2, sort_keys=True))


def _build_env(args: argparse.Namespace) -> dict[str, str]:
    env = os.environ.copy()
    env["UV_CACHE_DIR"] = args.uv_cache_dir
    token = args.enrichment_token or (
        os.environ.get(args.enrichment_token_env or "") if args.enrichment_token_env else ""
    )
    if token:
        env["SYNESIS_INDEXER_ENRICHMENT_TOKEN"] = token
        env["SYNESIS_INDEXER_ENRICHMENT_API_KEY"] = token
    return env


def _validate_enrich_inputs(args: argparse.Namespace) -> None:
    if args.skip_enrichment:
        return
    if not args.enrichment_url:
        raise SystemExit("--enrichment-url is required for enrich/all unless --skip-enrichment is set")
    has_token = bool(
        args.enrichment_token
        or (args.enrichment_token_env and os.environ.get(args.enrichment_token_env))
        or os.environ.get("SYNESIS_INDEXER_ENRICHMENT_TOKEN")
        or os.environ.get("SYNESIS_INDEXER_ENRICHMENT_API_KEY")
        or os.environ.get("DEEPSEEK_TOKEN")
        or os.environ.get("DEEPSEEK_API_KEY")
        or os.environ.get("OPENAI_API_KEY")
    )
    if not has_token and not args.allow_no_enrichment_token:
        raise SystemExit(
            "no enrichment token found. Pass --enrichment-token, --enrichment-token-env, "
            "or set SYNESIS_INDEXER_ENRICHMENT_TOKEN. Use --allow-no-enrichment-token only for unauthenticated endpoints."
        )
    if not args.request_limit and not args.confirm_spend:
        raise SystemExit(
            "refusing unbounded enrichment run. Pass --request-limit N for an incremental batch, "
            "or --confirm-spend to process all remaining chunks."
        )


def _validate_multi_language_args(args: argparse.Namespace, languages: list[str]) -> None:
    if len(languages) <= 1:
        return
    single_language_options = {
        "--pack-id": args.pack_id,
        "--work-dir": args.work_dir,
        "--output": args.output,
        "--source-dir": args.source_dir,
        "--provider-schema": args.provider_schema,
        "--pack-config": args.pack_config,
        "--latest-tag": args.latest_tag,
        "--source-version": args.source_version,
        "--doc-language": args.doc_language,
    }
    used = [name for name, value in single_language_options.items() if value]
    if used:
        raise SystemExit(
            f"{', '.join(used)} can only be used with one --language value. "
            "Run each language separately when overriding source or artifact paths."
        )


def _run_for_language(args: argparse.Namespace, repo_root: Path, language: str, env: dict[str, str]) -> None:
    pack_id = _resolve_pack_id(args, language)
    work_dir = _work_dir(args, repo_root, pack_id)
    output = _output_path(args, repo_root, pack_id)
    indexer_dir = repo_root / "base/rag/indexer"

    _ensure_repo_local_workdir(repo_root, work_dir)

    if args.phase == "all":
        _validate_enrich_inputs(args)

    if args.phase == "status":
        _print_status(work_dir, output)
        return

    if args.phase in {"prepare", "all"}:
        _assert_prepare_safe(work_dir, language=language, pack_id=pack_id, overwrite_prepare=args.overwrite_prepare)
        _run(_prepare_cmd(args, repo_root, language, pack_id, work_dir), cwd=indexer_dir, env=env, dry_run=args.dry_run)

    if args.phase in {"enrich", "all"}:
        if not (args.dry_run and args.phase == "all"):
            _assert_matching_manifest(work_dir, language=language, pack_id=pack_id)
        if args.phase != "all":
            _validate_enrich_inputs(args)
        _run(_enrich_cmd(args, repo_root, language, pack_id, work_dir), cwd=indexer_dir, env=env, dry_run=args.dry_run)

    if args.phase in {"finalize", "all"}:
        if not (args.dry_run and args.phase == "all"):
            _assert_matching_manifest(work_dir, language=language, pack_id=pack_id)
        if output.exists() and not args.replace_output:
            raise SystemExit(
                f"refusing to overwrite existing SynPack artifact: {output}\nPass --replace-output to overwrite."
            )
        _run(
            _finalize_cmd(args, repo_root, language, pack_id, work_dir, output),
            cwd=indexer_dir,
            env=env,
            dry_run=args.dry_run,
        )

    if args.phase == "load":
        if not output.exists():
            raise SystemExit(f"SynPack artifact does not exist: {output}")
        _run(_load_cmd(args, repo_root, output), cwd=indexer_dir, env=env, dry_run=args.dry_run)


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Safe staged SynPack language-pack helper")
    parser.add_argument("phase", choices=["prepare", "enrich", "finalize", "load", "status", "all"])
    parser.add_argument(
        "--language",
        "--languages",
        dest="languages",
        default="go",
        help=f"Language, comma-separated languages, or all. Supported: {', '.join(SUPPORTED_LANGUAGES)}",
    )
    parser.add_argument(
        "--pack-id", default="", help="Pack id. Only valid with one language; default <language>-latest"
    )
    parser.add_argument("--pack-version", default="1.0.0")
    parser.add_argument("--source-version", default="")
    parser.add_argument("--latest-tag", default="")
    parser.add_argument("--doc-language", default="")
    parser.add_argument("--pack-config", default="")
    parser.add_argument("--source-dir", default="")
    parser.add_argument("--provider-schema", default="")
    parser.add_argument("--max-chunks", type=int, default=0)
    parser.add_argument("--work-root", default=".work/synpacks", help="Repo-local ignored work root")
    parser.add_argument("--work-dir", default="", help="Explicit repo-local work dir. Only valid with one language")
    parser.add_argument("--output-dir", default="dist/synpacks")
    parser.add_argument("--output", default="", help="Explicit artifact path. Only valid with one language")
    parser.add_argument(
        "--overwrite-prepare", action="store_true", help="Allow prepare to replace existing staging files"
    )
    parser.add_argument(
        "--replace-output", action="store_true", help="Allow finalize to overwrite an existing artifact"
    )
    parser.add_argument("--replace", action="store_true", help="Pass --replace when loading into NornicDB")
    parser.add_argument("--nornic-uri", default="")
    parser.add_argument("--embedder-url", default=os.environ.get("SYNESIS_EMBEDDER_URL", ""))
    parser.add_argument("--embedder-batch-size", type=int, default=8)
    parser.add_argument("--embedder-timeout", type=float, default=300.0)
    parser.add_argument("--enrichment-url", default=os.environ.get("SYNESIS_INDEXER_ENRICHMENT_URL", ""))
    parser.add_argument(
        "--enrichment-model", default=os.environ.get("SYNESIS_INDEXER_ENRICHMENT_MODEL", "deepseek-v4-pro")
    )
    parser.add_argument(
        "--enrichment-provider", default=os.environ.get("SYNESIS_INDEXER_ENRICHMENT_PROVIDER", "deepseek")
    )
    parser.add_argument(
        "--enrichment-token", default="", help="Token is passed via env to avoid putting it on app.cli argv"
    )
    parser.add_argument(
        "--enrichment-token-env", default="", help="Environment variable containing the enrichment token"
    )
    parser.add_argument("--allow-no-enrichment-token", action="store_true")
    parser.add_argument("--enrichment-concurrency", type=int, default=6)
    parser.add_argument("--enrichment-max-tokens", type=int, default=8192)
    parser.add_argument("--enrichment-timeout", type=float, default=180.0)
    parser.add_argument("--enrichment-input-price-per-mtok", type=float, default=0.0)
    parser.add_argument("--enrichment-output-price-per-mtok", type=float, default=0.0)
    parser.add_argument("--request-limit", type=int, default=0, help="Max enrichment requests for this run")
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--skip-enrichment", action="store_true")
    parser.add_argument("--enrich-zero-quality", action="store_true")
    parser.add_argument("--confirm-spend", action="store_true", help="Allow an unbounded enrich/all phase")
    parser.add_argument("--uv-cache-dir", default=os.environ.get("UV_CACHE_DIR", "/tmp/uv-cache"))
    parser.add_argument("--dry-run", action="store_true", help="Print commands without executing")
    return parser.parse_args(list(argv))


def main(argv: Iterable[str] = sys.argv[1:]) -> int:
    args = parse_args(argv)
    repo_root = _repo_root()
    env = _build_env(args)
    languages = _language_list(args.languages)
    _validate_multi_language_args(args, languages)
    for language in languages:
        _run_for_language(args, repo_root, language, env)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
