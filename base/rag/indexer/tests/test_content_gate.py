"""Tests for the content gate: URL filtering, page scoring, chunk scoring,
doc-type classification, and child-follow decisions."""

from __future__ import annotations

import pytest
from app.content_gate import (
    GatePolicy,
    PageFeatures,
    _detect_rescue_signals,
    classify_doc_type,
    evaluate_page,
    normalize_url,
    score_chunk,
    score_page,
    url_passes_filter,
)

# ═══════════════════════════════════════════════════════════════════════
# URL Normalization
# ═══════════════════════════════════════════════════════════════════════


class TestNormalizeUrl:
    def test_strips_fragment(self):
        assert normalize_url("https://example.com/docs#section") == "https://example.com/docs"

    def test_strips_trailing_slash(self):
        assert normalize_url("https://example.com/docs/") == "https://example.com/docs"

    def test_strips_querystring(self):
        assert normalize_url("https://example.com/docs?lang=en") == "https://example.com/docs"

    def test_lowercases_host(self):
        assert normalize_url("https://EXAMPLE.COM/Docs") == "https://example.com/Docs"

    def test_preserves_path_case(self):
        result = normalize_url("https://example.com/API/Reference")
        assert "/API/Reference" in result

    def test_decodes_percent_encoding(self):
        result = normalize_url("https://example.com/docs%20page")
        assert "docs page" in result

    def test_root_path(self):
        assert normalize_url("https://example.com") == "https://example.com/"

    def test_deduplicates_equivalent_urls(self):
        a = normalize_url("https://example.com/docs/#intro?q=1")
        b = normalize_url("https://example.com/docs#intro")
        assert a == b


# ═══════════════════════════════════════════════════════════════════════
# URL Filtering
# ═══════════════════════════════════════════════════════════════════════


class TestUrlFilter:
    @pytest.fixture()
    def policy(self):
        return GatePolicy()

    def test_blocks_pricing_page(self, policy):
        ok, reason = url_passes_filter("https://example.com/pricing", policy)
        assert not ok
        assert "blocked path signal" in reason

    def test_blocks_careers_page(self, policy):
        ok, _reason = url_passes_filter("https://example.com/careers", policy)
        assert not ok

    def test_blocks_login_page(self, policy):
        ok, _reason = url_passes_filter("https://example.com/login", policy)
        assert not ok

    def test_allows_docs_page(self, policy):
        ok, _reason = url_passes_filter("https://example.com/docs/getting-started", policy)
        assert ok

    def test_allows_api_reference(self, policy):
        ok, _reason = url_passes_filter("https://example.com/api/v2/reference", policy)
        assert ok

    def test_blocks_image_extension(self, policy):
        ok, reason = url_passes_filter("https://example.com/logo.png", policy)
        assert not ok
        assert "blocked extension" in reason

    def test_blocks_css_extension(self, policy):
        ok, _ = url_passes_filter("https://example.com/style.css", policy)
        assert not ok

    def test_blocks_off_host(self, policy):
        ok, reason = url_passes_filter("https://ads.example.com/track", policy, seed_host="example.com")
        assert not ok
        assert "off-host" in reason

    def test_allows_same_host(self, policy):
        ok, _ = url_passes_filter("https://example.com/docs/guide", policy, seed_host="example.com")
        assert ok

    def test_allowed_prefix_restriction(self):
        policy = GatePolicy(allowed_prefixes=["/docs/"])
        ok, _ = url_passes_filter("https://example.com/docs/guide", policy)
        assert ok
        ok, reason = url_passes_filter("https://example.com/about", policy)
        assert not ok
        assert "allowed prefix" in reason

    def test_blog_blocked_by_default(self, policy):
        ok, _ = url_passes_filter("https://example.com/blog/post-1", policy)
        assert not ok

    def test_blog_allowed_when_configured(self):
        policy = GatePolicy(allow_blog=True)
        ok, _ = url_passes_filter("https://example.com/blog/post-1", policy)
        assert ok

    def test_blocked_prefix_override(self):
        policy = GatePolicy(blocked_prefixes=["/internal/"])
        ok, reason = url_passes_filter("https://example.com/internal/secret", policy)
        assert not ok
        assert "blocked prefix" in reason


# ═══════════════════════════════════════════════════════════════════════
# Page Quality Scoring
# ═══════════════════════════════════════════════════════════════════════


class TestPageScoring:
    @pytest.fixture()
    def policy(self):
        return GatePolicy()

    def test_good_docs_page_scores_high(self, policy):
        features = PageFeatures(
            url_path="/docs/getting-started",
            title="Getting Started — Documentation",
            headings=["Introduction", "Prerequisites", "Installation"],
            word_count=800,
            code_block_count=3,
            heading_count=3,
            internal_link_count=5,
            total_link_count=8,
            text_sample="This tutorial covers configuration and deployment best practices.",
        )
        score = score_page(features, policy)
        assert score >= 0.5

    def test_thin_page_scores_low(self, policy):
        features = PageFeatures(
            url_path="/about",
            title="About Us",
            headings=[],
            word_count=30,
            code_block_count=0,
            heading_count=0,
            text_sample="We are a company.",
        )
        score = score_page(features, policy)
        assert score < 0.35

    def test_marketing_page_penalized(self, policy):
        features = PageFeatures(
            url_path="/enterprise",
            title="Enterprise Plans",
            headings=["Plans"],
            word_count=500,
            heading_count=1,
            text_sample=(
                "Trusted by 500+ companies. Request a demo today. "
                "Start your free trial. Contact sales for pricing plans."
            ),
        )
        score = score_page(features, policy)
        assert score < 0.35

    def test_api_reference_scores_well(self, policy):
        features = PageFeatures(
            url_path="/api/v2/reference",
            title="API Reference",
            headings=["Authentication", "Endpoints", "Errors"],
            word_count=2000,
            code_block_count=10,
            heading_count=3,
            text_sample="The api reference documents all function signatures and parameters.",
        )
        score = score_page(features, policy)
        assert score >= 0.5


# ═══════════════════════════════════════════════════════════════════════
# Doc-Type Classification
# ═══════════════════════════════════════════════════════════════════════


class TestDocTypeClassification:
    def test_api_reference(self):
        assert (
            classify_doc_type(
                "https://example.com/api/v2",
                "API Reference",
                ["Parameters", "Returns", "Examples"],
            )
            == "reference"
        )

    def test_reference_path(self):
        assert (
            classify_doc_type(
                "https://example.com/reference/config",
                "Config Reference",
                ["Options"],
            )
            == "reference"
        )

    def test_how_to(self):
        assert (
            classify_doc_type(
                "https://example.com/how-to/deploy",
                "How to Deploy",
                ["Step 1"],
            )
            == "how_to"
        )

    def test_how_to_title(self):
        assert (
            classify_doc_type(
                "https://example.com/guides/auth",
                "How to Set Up Authentication",
                ["Overview"],
            )
            == "how_to"
        )

    def test_tutorial(self):
        assert (
            classify_doc_type(
                "https://example.com/tutorial/basics",
                "Tutorial: Basics",
                ["Introduction"],
            )
            == "tutorial"
        )

    def test_getting_started(self):
        assert (
            classify_doc_type(
                "https://example.com/docs/start",
                "Getting Started",
                ["Prerequisites"],
            )
            == "tutorial"
        )

    def test_blog(self):
        assert (
            classify_doc_type(
                "https://example.com/blog/new-feature",
                "New Feature Announcement",
                ["Details"],
            )
            == "blog"
        )

    def test_marketing(self):
        assert (
            classify_doc_type(
                "https://example.com/product",
                "Pricing Plans for Teams",
                ["Choose Your Plan"],
            )
            == "marketing"
        )

    def test_legal(self):
        assert (
            classify_doc_type(
                "https://example.com/terms",
                "Terms of Service",
                [],
            )
            == "legal"
        )

    def test_community(self):
        assert (
            classify_doc_type(
                "https://example.com/community/discuss",
                "Community Forum",
                [],
            )
            == "community"
        )

    def test_paper(self):
        assert (
            classify_doc_type(
                "https://arxiv.org/abs/2312.10997",
                "RAG Survey",
                ["Abstract"],
            )
            == "paper"
        )

    def test_framework(self):
        assert (
            classify_doc_type(
                "https://example.com/framework/overview",
                "Well-Architected Framework",
                ["Pillars"],
            )
            == "framework"
        )

    def test_docs_fallback(self):
        assert (
            classify_doc_type(
                "https://example.com/docs/concepts/auth",
                "Authentication Concepts",
                ["Overview"],
            )
            == "explanation"
        )


# ═══════════════════════════════════════════════════════════════════════
# Full Page Evaluation
# ═══════════════════════════════════════════════════════════════════════


class TestPageEvaluation:
    def test_marketing_page_rejected(self):
        html = """<html><head><title>Pricing Plans</title></head><body>
        <h1>Choose Your Plan</h1>
        <p>Start your free trial. Trusted by 1000+ companies.
        Contact sales for a demo. See pricing plans.</p>
        </body></html>"""
        verdict = evaluate_page("https://example.com/pricing", html, GatePolicy())
        assert not verdict.should_index

    def test_legal_page_rejected(self):
        html = """<html><head><title>Terms of Service</title></head><body>
        <h1>Terms</h1><p>These terms govern your use of our service.</p>
        </body></html>"""
        verdict = evaluate_page("https://example.com/terms", html, GatePolicy())
        assert not verdict.should_index
        assert verdict.doc_type == "legal"

    def test_docs_page_accepted(self):
        html = """<html><head><title>Documentation - Guide</title></head><body>
        <h1>Getting Started</h1>
        <h2>Prerequisites</h2>
        <p>This guide covers the implementation and configuration of the
        authentication system. Follow these steps to deploy.</p>
        <h2>Installation</h2>
        <pre>pip install example</pre>
        <p>After installation, configure the deployment settings.</p>
        </body></html>"""
        verdict = evaluate_page("https://example.com/docs/guide", html, GatePolicy())
        assert verdict.should_index

    def test_child_follow_requires_quality(self):
        html = """<html><head><title>Docs</title></head><body>
        <h1>Overview</h1><p>Architecture overview and best practices.</p>
        </body></html>"""
        verdict = evaluate_page("https://example.com/docs/overview", html, GatePolicy(), depth=0)
        if verdict.quality_score < 0.45:
            assert not verdict.should_follow_children

    def test_depth_limit_prevents_follow(self):
        html = """<html><head><title>Docs</title></head><body>
        <h1>Overview</h1><h2>Details</h2>
        <p>Architecture overview with implementation details and code samples.
        Configuration and deployment best practices for scaling.</p>
        <pre>code here</pre>
        </body></html>"""
        verdict = evaluate_page(
            "https://example.com/docs/overview",
            html,
            GatePolicy(max_depth=1),
            depth=1,
        )
        assert not verdict.should_follow_children


# ═══════════════════════════════════════════════════════════════════════
# Chunk Quality Scoring (Layer 2 — Universal)
# ═══════════════════════════════════════════════════════════════════════


class TestChunkScoring:
    @pytest.fixture()
    def policy(self):
        return GatePolicy()

    def test_good_technical_chunk(self, policy):
        text = (
            "The authentication system uses JWT tokens for stateless session "
            "management. Configuration requires setting the secret key in the "
            "deployment environment. The implementation follows best practices "
            "for security and performance optimization."
        )
        verdict = score_chunk(text, section="Auth", heading_path="Guide > Auth", policy=policy)
        assert verdict.should_index
        assert verdict.quality_score >= 0.3

    def test_thin_chunk_rejected(self, policy):
        verdict = score_chunk("Hello world.", policy=policy)
        assert not verdict.should_index
        assert "thin" in verdict.rejection_reason

    def test_marketing_chunk_penalized(self, policy):
        text = (
            "Trusted by 500+ companies worldwide. Start your free trial today. "
            "Request a demo and contact sales. See pricing plans for enterprise. "
            "As seen in Forbes and TechCrunch. Subscribe to our newsletter."
        )
        verdict = score_chunk(text, policy=policy)
        assert verdict.quality_score < 0.25

    def test_boilerplate_chunk_penalized(self, policy):
        text = (
            "All rights reserved. Cookie policy. Privacy policy. "
            "Terms of service. Follow us on Twitter. Share this page. "
            "Powered by Example Corp. Subscribe to our newsletter."
        )
        verdict = score_chunk(text, policy=policy)
        assert not verdict.should_index

    def test_code_documentation_chunk(self, policy):
        text = (
            "The function signature accepts a query parameter and returns "
            "matching results. Parameters include the search query, top_k "
            "count, and an optional filter. Implementation uses the algorithm "
            "described in the specification. Error handling covers timeout "
            "and authentication failures."
        )
        verdict = score_chunk(text, section="API", heading_path="Ref > Search", policy=policy)
        assert verdict.should_index

    def test_min_chunk_words_configurable(self):
        policy = GatePolicy(min_chunk_words=10)
        verdict = score_chunk("Short but valid content here today.", policy=policy)
        assert not verdict.should_index

        policy2 = GatePolicy(min_chunk_words=3)
        verdict2 = score_chunk("Short but valid content here today.", policy=policy2)
        assert verdict2.should_index or verdict2.quality_score > 0

    def test_heading_context_bonus(self, policy):
        text = "This section covers the implementation details of the deployment process including configuration steps."
        v_with = score_chunk(text, section="Deploy", heading_path="Guide > Deploy", policy=policy)
        v_without = score_chunk(text, policy=policy)
        assert v_with.quality_score >= v_without.quality_score


# ═══════════════════════════════════════════════════════════════════════
# GatePolicy
# ═══════════════════════════════════════════════════════════════════════


class TestGatePolicy:
    def test_defaults_populated(self):
        policy = GatePolicy()
        assert len(policy.allow_path_signals) > 0
        assert len(policy.block_path_signals) > 0
        assert len(policy.marketing_phrases) > 0
        assert len(policy.epistemic_phrases) > 0
        assert policy.min_page_quality == 0.35
        assert policy.min_chunk_quality == 0.25
        assert policy.max_depth == 2

    def test_custom_thresholds(self):
        policy = GatePolicy(min_page_quality=0.5, min_chunk_quality=0.4)
        assert policy.min_page_quality == 0.5
        assert policy.min_chunk_quality == 0.4

    def test_from_yaml_missing_file_returns_defaults(self):
        policy = GatePolicy.from_yaml("/nonexistent/path.yaml")
        assert policy.min_page_quality == 0.35


# ═══════════════════════════════════════════════════════════════════════
# Mixed-Content Site Scenarios
# ═══════════════════════════════════════════════════════════════════════


class TestMixedContentSites:
    """Scenarios for vendor sites that mix docs with marketing."""

    def test_vendor_docs_path_accepted(self):
        ok, _ = url_passes_filter("https://vendor.com/docs/api/auth", GatePolicy())
        assert ok

    def test_vendor_marketing_path_blocked(self):
        ok, _ = url_passes_filter("https://vendor.com/pricing", GatePolicy())
        assert not ok

    def test_vendor_careers_blocked(self):
        ok, _ = url_passes_filter("https://vendor.com/careers/engineer", GatePolicy())
        assert not ok

    def test_vendor_legal_blocked(self):
        ok, _ = url_passes_filter("https://vendor.com/legal/terms", GatePolicy())
        assert not ok

    def test_github_pages_docs_accepted(self):
        ok, _ = url_passes_filter("https://org.github.io/project/docs/guide", GatePolicy())
        assert ok

    def test_newsletter_blocked(self):
        ok, _ = url_passes_filter("https://vendor.com/newsletter", GatePolicy())
        assert not ok


# ═══════════════════════════════════════════════════════════════════════
# Rescue Signal Detection
# ═══════════════════════════════════════════════════════════════════════


class TestRescueSignals:
    def test_code_fence_detected(self):
        text = "Example usage:\n```python\nimport os\nos.listdir()\n```"
        result = _detect_rescue_signals(text)
        assert "code_block" in result.signals
        assert result.has_code
        assert result.bonus > 0

    def test_indented_code_detected(self):
        text = "Run this:\n    curl -X POST /api\n    curl -X GET /api/status"
        result = _detect_rescue_signals(text)
        assert "code_block" in result.signals
        assert result.has_code

    def test_inline_code_density_detected(self):
        text = "Use `--verbose` flag with `--output=json` and `--timeout=30` for debugging."
        result = _detect_rescue_signals(text)
        assert "inline_code" in result.signals

    def test_latex_formula_detected(self):
        text = r"The loss is defined as $L = \frac{1}{N}\sum_{i=1}^{N}(y_i - \hat{y}_i)^2$."
        result = _detect_rescue_signals(text)
        assert "formula" in result.signals
        assert result.has_formula

    def test_latex_block_detected(self):
        text = r"The gradient is: $$\nabla_\theta J(\theta) = \mathbb{E}[\log \pi]$$"
        result = _detect_rescue_signals(text)
        assert "formula" in result.signals

    def test_latex_commands_detected(self):
        text = r"Where \alpha and \beta are hyperparameters and \sum over N."
        result = _detect_rescue_signals(text)
        assert "formula" in result.signals

    def test_table_detected(self):
        text = "| Model | Accuracy | F1 |\n|-------|----------|----|\n| BERT | 0.92 | 0.91 |"
        result = _detect_rescue_signals(text)
        assert "table" in result.signals

    def test_definition_detected(self):
        text = "**Retrieval-Augmented Generation** — a technique that combines retrieval with generation."
        result = _detect_rescue_signals(text)
        assert "definition" in result.signals

    def test_cli_flags_detected(self):
        text = "Use --model-name vllm --tensor-parallel-size 2 --max-model-len 8192"
        result = _detect_rescue_signals(text)
        assert "cli" in result.signals

    def test_figure_reference_detected(self):
        text = "As shown in Figure 3, the architecture achieves state-of-the-art results."
        result = _detect_rescue_signals(text)
        assert "figure_ref" in result.signals

    def test_plain_text_no_signals(self):
        text = "This is a simple sentence with no special markers."
        result = _detect_rescue_signals(text)
        assert result.signals == []
        assert result.bonus == 0.0

    def test_multiple_signals_stack(self):
        text = "Use `--flag` and `--verbose`:\n```bash\ncurl -X POST /api\n```"
        result = _detect_rescue_signals(text)
        assert len(result.signals) >= 2
        assert result.bonus > 0.15

    def test_bonus_capped_at_030(self):
        text = (
            "| Col | Val |\n|-----|-----|\n| a | b |\n"
            "```python\nprint('hi')\n```\n"
            r"Where $\alpha = 0.1$ and use --flag --verbose"
        )
        result = _detect_rescue_signals(text)
        assert result.bonus <= 0.30


# ═══════════════════════════════════════════════════════════════════════
# Thin Content Rescue (score_chunk integration)
# ═══════════════════════════════════════════════════════════════════════


class TestThinContentRescue:
    @pytest.fixture()
    def policy(self):
        return GatePolicy()

    def test_code_snippet_rescued(self, policy):
        text = "Install the package:\n```bash\npip install synesis\n```"
        verdict = score_chunk(text, policy=policy)
        assert verdict.should_index
        assert verdict.quality_score > 0

    def test_latex_formula_rescued(self, policy):
        text = r"The cross-entropy loss: $L = -\frac{1}{N}\sum_{i} y_i \log(\hat{y}_i)$"
        verdict = score_chunk(text, policy=policy)
        assert verdict.should_index

    def test_table_chunk_rescued(self, policy):
        text = "Benchmark results:\n| Model | Score |\n|-------|-------|\n| GPT-4 | 0.95 |"
        verdict = score_chunk(text, policy=policy)
        assert verdict.should_index

    def test_skip_to_content_rejected(self, policy):
        text = "Skip to content"
        verdict = score_chunk(text, policy=policy)
        assert not verdict.should_index
        assert "thin" in verdict.rejection_reason

    def test_copyright_rejected(self, policy):
        text = "All rights reserved 2026"
        verdict = score_chunk(text, policy=policy)
        assert not verdict.should_index

    def test_definition_list_rescued(self, policy):
        text = (
            "**Embedding** — a dense vector representation of text in a continuous space. "
            "**Tokenization** — splitting text into subword units for model input."
        )
        verdict = score_chunk(text, policy=policy)
        assert verdict.should_index

    def test_cli_example_rescued(self, policy):
        text = "Configure with --model-name gpt-4 --temperature 0.7 --max-tokens 2048"
        verdict = score_chunk(text, policy=policy)
        assert verdict.should_index

    def test_boilerplate_thin_rejected(self, policy):
        text = "Follow us on Twitter and subscribe to our newsletter for updates."
        verdict = score_chunk(text, policy=policy)
        assert not verdict.should_index
        assert "boilerplate" in verdict.rejection_reason

    def test_thin_no_signals_no_boilerplate_benefit_of_doubt(self, policy):
        text = (
            "The quick brown fox jumps over the lazy dog in the morning sunshine and afternoon breeze and evening calm."
        )
        verdict = score_chunk(text, policy=policy)
        assert verdict.should_index
        assert verdict.quality_score == pytest.approx(0.10, abs=0.01)

    def test_below_absolute_min_pure_text_rejected(self, policy):
        text = "Very short text here."
        verdict = score_chunk(text, policy=policy)
        assert not verdict.should_index
        assert "thin+empty" in verdict.rejection_reason

    def test_below_absolute_min_code_rescued(self, policy):
        text = "Run:\n```\nls -la\n```"
        verdict = score_chunk(text, policy=policy)
        assert verdict.should_index

    def test_min_chunk_words_absolute_configurable(self):
        policy = GatePolicy(min_chunk_words_absolute=5)
        verdict = score_chunk("Three word chunk", policy=policy)
        assert not verdict.should_index

        policy2 = GatePolicy(min_chunk_words_absolute=2)
        text_with_code = "Run: `ls -la` and `pwd`"
        verdict2 = score_chunk(text_with_code, policy=policy2)
        assert verdict2.should_index
