"""Stable upstream tag parsing and resolution for language packs."""

from __future__ import annotations

import re
import subprocess

from .synpack import SynPackError

GO_TAG_RE = re.compile(r"^go(?P<major>\d+)\.(?P<minor>\d+)\.(?P<patch>\d+)$")
RUST_TAG_RE = re.compile(r"^(?P<major>\d+)\.(?P<minor>\d+)\.(?P<patch>\d+)$")
QUARKUS_TAG_RE = re.compile(r"^(?P<major>\d+)\.(?P<minor>\d+)\.(?P<patch>\d+)(?:\.Final)?$")
PYTHON_TAG_RE = re.compile(r"^v?(?P<major>\d+)\.(?P<minor>\d+)\.(?P<patch>\d+)$")
GODOT_TAG_RE = re.compile(r"^(?P<major>\d+)\.(?P<minor>\d+)(?:\.(?P<patch>\d+))?-stable$")
TERRAFORM_TAG_RE = re.compile(r"^v?(?P<major>\d+)\.(?P<minor>\d+)\.(?P<patch>\d+)$")


def parse_go_stable_tag(tag: str) -> tuple[int, int, int] | None:
    """Return comparable version tuple for stable Go tags, rejecting rc/beta/weekly."""
    m = GO_TAG_RE.match(tag.strip())
    if not m:
        return None
    return (int(m.group("major")), int(m.group("minor")), int(m.group("patch")))


def latest_go_stable_tag_from_refs(refs: str) -> str:
    tags: list[tuple[tuple[int, int, int], str]] = []
    for line in refs.splitlines():
        ref = line.rsplit("/", 1)[-1].strip()
        ref = ref[:-3] if ref.endswith("^{}") else ref
        parsed = parse_go_stable_tag(ref)
        if parsed:
            tags.append((parsed, ref))
    if not tags:
        raise SynPackError("no stable Go tags found")
    tags.sort(key=lambda x: x[0])
    return tags[-1][1]


def parse_rust_stable_tag(tag: str) -> tuple[int, int, int] | None:
    """Return comparable version tuple for stable Rust tags, rejecting beta/nightly/rc."""
    value = tag.strip()
    if any(marker in value.lower() for marker in ("beta", "nightly", "rc")):
        return None
    m = RUST_TAG_RE.match(value)
    if not m:
        return None
    return (int(m.group("major")), int(m.group("minor")), int(m.group("patch")))


def latest_rust_stable_tag_from_refs(refs: str) -> str:
    tags: list[tuple[tuple[int, int, int], str]] = []
    for line in refs.splitlines():
        ref = line.rsplit("/", 1)[-1].strip()
        ref = ref[:-3] if ref.endswith("^{}") else ref
        parsed = parse_rust_stable_tag(ref)
        if parsed:
            tags.append((parsed, ref))
    if not tags:
        raise SynPackError("no stable Rust tags found")
    tags.sort(key=lambda x: x[0])
    return tags[-1][1]


def parse_quarkus_stable_tag(tag: str) -> tuple[int, int, int] | None:
    """Return comparable version tuple for stable Quarkus tags, rejecting prereleases."""
    value = tag.strip()
    if any(marker in value.lower() for marker in ("alpha", "beta", "cr", "rc", "snapshot")):
        return None
    m = QUARKUS_TAG_RE.match(value)
    if not m:
        return None
    return (int(m.group("major")), int(m.group("minor")), int(m.group("patch")))


def latest_quarkus_stable_tag_from_refs(refs: str) -> str:
    tags: list[tuple[tuple[int, int, int], str]] = []
    for line in refs.splitlines():
        ref = line.rsplit("/", 1)[-1].strip()
        ref = ref[:-3] if ref.endswith("^{}") else ref
        parsed = parse_quarkus_stable_tag(ref)
        if parsed:
            tags.append((parsed, ref))
    if not tags:
        raise SynPackError("no stable Quarkus tags found")
    tags.sort(key=lambda x: x[0])
    return tags[-1][1]


def parse_python_stable_tag(tag: str) -> tuple[int, int, int] | None:
    """Return comparable version tuple for stable CPython tags, rejecting prereleases."""
    value = tag.strip()
    if any(marker in value.lower() for marker in ("a", "b", "rc", "dev")):
        return None
    m = PYTHON_TAG_RE.match(value)
    if not m:
        return None
    return (int(m.group("major")), int(m.group("minor")), int(m.group("patch")))


def latest_python_stable_tag_from_refs(refs: str) -> str:
    tags: list[tuple[tuple[int, int, int], str]] = []
    for line in refs.splitlines():
        ref = line.rsplit("/", 1)[-1].strip()
        ref = ref[:-3] if ref.endswith("^{}") else ref
        parsed = parse_python_stable_tag(ref)
        if parsed:
            tags.append((parsed, ref))
    if not tags:
        raise SynPackError("no stable Python tags found")
    tags.sort(key=lambda x: x[0])
    return tags[-1][1]


def parse_godot_stable_tag(tag: str) -> tuple[int, int, int] | None:
    """Return comparable version tuple for stable Godot 4 tags, rejecting prereleases."""
    value = tag.strip()
    if any(marker in value.lower() for marker in ("alpha", "beta", "rc", "dev")):
        return None
    m = GODOT_TAG_RE.match(value)
    if not m:
        return None
    return (int(m.group("major")), int(m.group("minor")), int(m.group("patch") or 0))


def latest_godot_stable_tag_from_refs(refs: str) -> str:
    tags: list[tuple[tuple[int, int, int], str]] = []
    for line in refs.splitlines():
        ref = line.rsplit("/", 1)[-1].strip()
        ref = ref[:-3] if ref.endswith("^{}") else ref
        parsed = parse_godot_stable_tag(ref)
        if parsed:
            tags.append((parsed, ref))
    if not tags:
        raise SynPackError("no stable Godot tags found")
    tags.sort(key=lambda x: x[0])
    return tags[-1][1]


def parse_terraform_stable_tag(tag: str) -> tuple[int, int, int] | None:
    """Return comparable version tuple for stable Terraform tags, rejecting prereleases."""
    value = tag.strip()
    if any(marker in value.lower() for marker in ("alpha", "beta", "rc", "dev")):
        return None
    m = TERRAFORM_TAG_RE.match(value)
    if not m:
        return None
    return (int(m.group("major")), int(m.group("minor")), int(m.group("patch")))


def latest_terraform_stable_tag_from_refs(refs: str) -> str:
    tags: list[tuple[tuple[int, int, int], str]] = []
    for line in refs.splitlines():
        ref = line.rsplit("/", 1)[-1].strip()
        ref = ref[:-3] if ref.endswith("^{}") else ref
        parsed = parse_terraform_stable_tag(ref)
        if parsed:
            tags.append((parsed, ref))
    if not tags:
        raise SynPackError("no stable Terraform tags found")
    tags.sort(key=lambda x: x[0])
    return tags[-1][1]


def _git_ls_remote_tags(repo: str) -> str:
    proc = subprocess.run(
        ["git", "ls-remote", "--tags", f"https://{repo}"],
        check=True,
        text=True,
        capture_output=True,
    )
    return proc.stdout


def resolve_latest_go_tag() -> str:
    return latest_go_stable_tag_from_refs(_git_ls_remote_tags("github.com/golang/go"))


def resolve_latest_rust_tag() -> str:
    return latest_rust_stable_tag_from_refs(_git_ls_remote_tags("github.com/rust-lang/rust"))


def resolve_latest_quarkus_tag() -> str:
    return latest_quarkus_stable_tag_from_refs(_git_ls_remote_tags("github.com/quarkusio/quarkus"))


def resolve_latest_python_tag() -> str:
    return latest_python_stable_tag_from_refs(_git_ls_remote_tags("github.com/python/cpython"))


def resolve_latest_godot_tag() -> str:
    return latest_godot_stable_tag_from_refs(_git_ls_remote_tags("github.com/godotengine/godot"))


def resolve_latest_terraform_tag() -> str:
    return latest_terraform_stable_tag_from_refs(_git_ls_remote_tags("github.com/hashicorp/terraform"))


def resolve_latest_ecma_tag() -> str:
    return "main"
