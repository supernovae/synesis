# /// script
# requires-python = ">=3.12"
# dependencies = ["trafilatura==2.2.0", "lxml==6.1.3"]
# ///
"""Shared HTML extraction and an optional offline saved-HTML command.

Run with ``uv run --script base/rag/indexer/app/extract.py --help``.
The command needs only its declared extraction dependency, not the indexer stack.
"""

from __future__ import annotations


def normalize_doc_markdown(md: str) -> str:
    """Trim outer whitespace; keep source lines and code intact.

    Words such as Home, Search and Close can be real content. Extraction owns
    boilerplate handling; an extra line-deletion heuristic cannot prove context.
    """
    return md.strip()


def html_to_markdown(
    html: str,
    *,
    include_tables: bool = True,
    include_links: bool = True,
    fast: bool = False,
) -> str:
    """Extract HTML with one converter. Never fetch URLs or execute scripts.

    A missing dependency or parser failure remains an error, rather than silently
    switching to a regex converter with different evidence preservation behavior.
    """
    if not html or not html.strip():
        return ""
    from lxml.html import Element, fromstring
    from trafilatura import extract
    from trafilatura.settings import use_config

    tree = fromstring(html)
    if tree.tag not in {"html", "body"}:
        # A supplied fragment is already a selected body, not a whole web page.
        # Give its headings and paragraphs one content container for extraction.
        article = Element("article")
        article.append(tree)
        body = Element("body")
        body.append(article)
        tree = Element("html")
        tree.append(body)
    config = use_config()
    # Short references are valid evidence; size-based rescues can discard them.
    config["DEFAULT"]["MIN_EXTRACTED_SIZE"] = "0"

    return (
        extract(
            tree,
            output_format="markdown",
            include_tables=include_tables,
            include_links=include_links,
            include_formatting=True,
            include_comments=False,
            fast=fast,
            config=config,
        )
        or ""
    )


def extract_saved_html(root: str, source: str, output: str) -> dict[str, str | int]:
    """Convert one explicitly selected UTF-8 file and publish a new private Markdown file."""
    import hashlib
    import json
    import os
    import stat
    import tempfile
    from importlib.metadata import version
    from pathlib import Path, PurePosixPath

    if not root or not source or "\\" in source or ":" in source or any(ord(c) < 32 or ord(c) == 127 for c in source):
        raise ValueError("An explicit root and relative POSIX HTML path are required")
    if source.startswith("/") or any(part in {"", ".", ".."} for part in source.split("/")):
        raise ValueError("Source must stay inside the explicit root")
    if PurePosixPath(source).suffix.lower() not in {".html", ".htm"}:
        raise ValueError("Select a saved .html or .htm file")
    directory = Path(root).resolve(strict=True)
    if not directory.is_dir():
        raise ValueError("Root must be a directory")
    path = directory
    for part in source.split("/"):
        path = path / part
        if path.is_symlink():
            raise ValueError("Symlinks are not HTML inputs")
    path.resolve(strict=True).relative_to(directory)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > 8 * 1024 * 1024:
            raise ValueError("HTML input must be a regular file no larger than 8 MiB")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            data = stream.read(before.st_size + 1)
        after = os.fstat(fd)
        if len(data) != before.st_size or before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
            raise ValueError("HTML input changed during reading")
    finally:
        os.close(fd)
    html = data.decode("utf-8-sig", errors="strict")
    if "\0" in html:
        raise ValueError("HTML input must not contain NUL bytes")
    markdown = normalize_doc_markdown(html_to_markdown(html))
    if not markdown:
        raise ValueError("No extractable text; render or review the source explicitly")
    provenance: dict[str, str | int] = {
        "kind": "derived-html",
        "sourcePath": source,
        "sourceSha256": hashlib.sha256(data).hexdigest(),
        "sourceBytes": len(data),
        "extractor": "trafilatura",
        "extractorVersion": version("trafilatura"),
    }
    # Provenance travels with the derived text; the pack later hashes this entire file.
    # Markdown citations refer to derived lines, not original HTML line positions.
    metadata = json.dumps(provenance, sort_keys=True, ensure_ascii=True).replace("<", "\\u003c").replace(">", "\\u003e")
    header = "<!-- synesis-source " + metadata + " -->\n\n"
    encoded = (header + markdown + "\n").encode("utf-8")
    if len(encoded) > 2 * 1024 * 1024:
        raise ValueError("Extracted Markdown exceeds the 2 MiB source-pack limit")
    target = Path(output).absolute()
    with tempfile.TemporaryDirectory(prefix=".synesis-extract-", dir=target.parent) as staging:
        staged = Path(staging) / "source.md"
        fd = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(staged, target)  # Same filesystem, complete bytes, refuses overwrite.
    return {**provenance, "outputBytes": len(encoded), "outputSha256": hashlib.sha256(encoded).hexdigest()}


def main() -> None:
    import argparse
    import json

    parser = argparse.ArgumentParser(description="Extract one saved HTML file without network or model calls.")
    parser.add_argument("--root", required=True, help="Explicit source directory")
    parser.add_argument("--input", required=True, help="Relative POSIX path of one saved HTML file")
    parser.add_argument("--output", required=True, help="New Markdown file; existing files are never overwritten")
    args = parser.parse_args()
    try:
        result = extract_saved_html(args.root, args.input, args.output)
    except (OSError, ValueError, ImportError) as exc:
        parser.exit(1, f"synesis-extract: {exc}\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
