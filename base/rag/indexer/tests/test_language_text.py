from app.language_text import basic_source_text_cleanup, normalize_source_text_by_format, strip_html_tags


def test_basic_source_text_cleanup_removes_control_chars_and_compacts_blank_lines():
    text = "hello\x00  \r\nworld  \n\n\n\nnext"
    assert basic_source_text_cleanup(text) == "hello\nworld\n\n\nnext"


def test_strip_html_tags_drops_script_and_preserves_breaks():
    html = "<html><body><script>alert(1)</script><p>Hello<br>World &amp; docs</p></body></html>"
    assert strip_html_tags(html) == "Hello\nWorld & docs"


def test_normalize_source_text_by_format_converts_html_to_markdown():
    text, fmt = normalize_source_text_by_format("<h1>Title</h1><p>Hello</p>", "html")
    assert fmt == "markdown"
    assert "Title" in text
    assert "Hello" in text


def test_normalize_source_text_by_format_keeps_unknown_format_cleaned():
    text, fmt = normalize_source_text_by_format(" line  \n\n\n\nnext ", "custom")
    assert fmt == "custom"
    assert text == "line\n\n\nnext"
