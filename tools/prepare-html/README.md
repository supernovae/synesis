# Saved HTML preparation

Convert one explicitly selected saved HTML file to reviewable Markdown:

```bash
uv run --script tools/prepare-html/extract.py \
  --root /absolute/source-directory --input guide.html \
  --output /absolute/new-guide.md
```

Use Python 3.12+ and uv. The script declares its two direct dependencies inline; initial installation may require network access. Conversion does not fetch URLs, load images, execute JavaScript or call a model.

Inputs are bounded UTF-8 HTML files under an explicit root. The command rejects symlinks/traversal and publishes a private output file without overwriting an existing file. A JSON comment records the original path, hash and extractor version. Citations in a resulting pack address Markdown lines, not original HTML positions.

Review tables, links and code after conversion. Keep the original source separately. See [the complete build example](../../docs/SOURCE_PACKS.md#prepare-saved-html).

The generated `requirements.lock` pins the test/audit environment from the same inline declaration. Refresh with `./scripts/lock-deps.sh`; check with `--check`. No separate input requirements file is maintained.
