from __future__ import annotations

from app.sitemap_collect import _parse_sitemap_xml


def test_parse_urlset_sitemap():
    xml = """<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/docs/a</loc></url>
  <url><loc>https://example.com/docs/b</loc></url>
</urlset>
"""
    nested, pages = _parse_sitemap_xml(xml)
    assert nested == []
    assert pages == ["https://example.com/docs/a", "https://example.com/docs/b"]


def test_parse_rss_feed_links():
    xml = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Blog</title>
    <item><title>One</title><link>https://example.com/blog/one</link></item>
    <item><title>Two</title><link>https://example.com/blog/two</link></item>
  </channel>
</rss>
"""
    nested, pages = _parse_sitemap_xml(xml)
    assert nested == []
    assert pages == ["https://example.com/blog/one", "https://example.com/blog/two"]


def test_parse_atom_feed_links():
    xml = """<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Feed</title>
  <entry>
    <title>Post A</title>
    <link href="https://example.com/blog/a"/>
  </entry>
  <entry>
    <title>Post B</title>
    <link href="https://example.com/blog/b"/>
  </entry>
</feed>
"""
    nested, pages = _parse_sitemap_xml(xml)
    assert nested == []
    assert pages == ["https://example.com/blog/a", "https://example.com/blog/b"]
