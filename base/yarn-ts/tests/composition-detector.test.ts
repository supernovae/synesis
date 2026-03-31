import { describe, it, expect } from "vitest";
import { detectCompositionIntent } from "../src/evidence/composition-detector.js";

describe("detectCompositionIntent", () => {
  describe("composition intent detection", () => {
    it('detects Go HTTP handler as api_endpoint', () => {
      const r = detectCompositionIntent("Create a Go HTTP handler");
      expect(r).not.toBeNull();
      expect(r!.language).toBe("go");
      expect(r!.skillFamily).toBe("api_endpoint");
    });

    it('detects Python FastAPI endpoint', () => {
      const r = detectCompositionIntent("Write a Python FastAPI endpoint");
      expect(r).not.toBeNull();
      expect(r!.language).toBe("python");
      expect(r!.skillFamily).toBe("api_endpoint");
    });

    it('detects Rust axum handler as api_endpoint', () => {
      const r = detectCompositionIntent("Build a Rust axum handler");
      expect(r).not.toBeNull();
      expect(r!.language).toBe("rust");
      expect(r!.skillFamily).toBe("api_endpoint");
    });

    it('detects TypeScript test suite as test_scaffold', () => {
      const r = detectCompositionIntent("Scaffold a TypeScript test suite");
      expect(r).not.toBeNull();
      expect(r!.language).toBe("typescript");
      expect(r!.skillFamily).toBe("test_scaffold");
    });

    it('detects JWT auth middleware as auth_pattern when language is present', () => {
      const r = detectCompositionIntent("Implement JWT auth middleware in Python");
      expect(r).not.toBeNull();
      expect(r!.language).toBe("python");
      expect(r!.skillFamily).toBe("auth_pattern");
    });

    it('detects async or error-handling composition in TypeScript', () => {
      const r = detectCompositionIntent("Set up async error handling in TypeScript");
      expect(r).not.toBeNull();
      expect(r!.language).toBe("typescript");
      expect(["async_pattern", "error_handling"]).toContain(r!.skillFamily);
    });
  });

  describe("no-intent passthrough", () => {
    it('returns null for a question without a composition verb', () => {
      expect(detectCompositionIntent("What is a goroutine?")).toBeNull();
    });

    it('returns null for fix/debug style prompts', () => {
      expect(detectCompositionIntent("Fix this TypeScript error")).toBeNull();
    });

    it('returns null for explain-style prompts', () => {
      expect(
        detectCompositionIntent("Explain the difference between mutex and channel"),
      ).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(detectCompositionIntent("")).toBeNull();
    });
  });

  describe("phase gating", () => {
    const prompt = "Create a Go HTTP handler";

    it('allows detection in implement phase', () => {
      expect(detectCompositionIntent(prompt, "implement")).not.toBeNull();
    });

    it('returns null in review phase', () => {
      expect(detectCompositionIntent(prompt, "review")).toBeNull();
    });

    it('allows detection when phase is omitted', () => {
      expect(detectCompositionIntent(prompt)).not.toBeNull();
    });
  });

  describe("confidence scoring", () => {
    it('keeps confidence in [0, 1] when intent is detected', () => {
      const samples = [
        detectCompositionIntent("Write a Python FastAPI endpoint"),
        detectCompositionIntent("Build a Rust axum handler", "implement"),
        detectCompositionIntent("Scaffold a TypeScript test suite", "plan"),
      ];
      for (const r of samples) {
        expect(r).not.toBeNull();
        expect(r!.confidence).toBeGreaterThanOrEqual(0);
        expect(r!.confidence).toBeLessThanOrEqual(1);
      }
    });

    it('boosts confidence when working phase is implement', () => {
      const prompt = "Create a Go HTTP handler";
      const base = detectCompositionIntent(prompt);
      const boosted = detectCompositionIntent(prompt, "implement");
      expect(base).not.toBeNull();
      expect(boosted).not.toBeNull();
      expect(boosted!.confidence).toBeGreaterThan(base!.confidence);
    });
  });
});
