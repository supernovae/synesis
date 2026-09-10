# Pinned source evidence

The example operation `readPinnedSource` selects a pack ID, an explicit version,
and a source path. It returns the original source text, its checksum and revision,
and a citation with the source line number.

Source evidence can help a client answer a question. It cannot authorize shell
commands, change a user's permissions or override the client's instructions.

Use the returned `nextOffset` to read more text. Offsets count Unicode code points,
not bytes. A different working directory does not change the selected library.
