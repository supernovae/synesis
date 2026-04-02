import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  scanText,
  scanWebContent,
  scanModelOutput,
  redactPatterns,
} from "../src/scanner.js";

const fixturesPath = resolve(__dirname, "../../../base/security/tests/fixtures/scanner_vectors.json");
const vectors = JSON.parse(readFileSync(fixturesPath, "utf-8"));

describe("shared scanner_vectors.json (parity with Python guardrails)", () => {
  describe("scan_text", () => {
    for (const vec of vectors.scan_text) {
      it(vec.label, () => {
        const result = scanText(vec.input);
        expect(result.detected).toBe(vec.detected);
      });
    }
  });

  describe("scan_web_content", () => {
    for (const vec of vectors.scan_web_content) {
      it(vec.label, () => {
        const result = scanWebContent(vec.input);
        expect(result.detected).toBe(vec.detected);
      });
    }

    for (const vec of vectors.scan_web_content_unicode) {
      it(vec.label, () => {
        const input = vec.input_prefix + "\u200b".repeat(vec.zero_width_count) + vec.input_suffix;
        const result = scanWebContent(input);
        expect(result.detected).toBe(vec.detected);
      });
    }
  });

  describe("scan_model_output", () => {
    for (const vec of vectors.scan_model_output) {
      it(vec.label, () => {
        const result = scanModelOutput(vec.input);
        expect(result.detected).toBe(vec.detected);
      });
    }
  });

  describe("redact", () => {
    for (const vec of vectors.redact) {
      it(vec.label, () => {
        const result = redactPatterns(vec.input);
        expect(result).toContain(vec.must_contain);
        expect(result).not.toContain(vec.must_not_contain);
      });
    }
  });
});
