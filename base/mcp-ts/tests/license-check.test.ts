import { describe, it, expect } from "vitest";
import { createLicenseCheckTool } from "../src/handlers/license-check.js";

describe("createLicenseCheckTool", () => {
  const tool = createLicenseCheckTool();

  it("MIT packages are compatible with Apache-2.0 target", async () => {
    const result = (await tool.handler({
      packages: [{ name: "foo", license: "MIT" }],
    })) as Record<string, unknown>;

    expect(result.all_compatible).toBe(true);
    expect(result.conflicts).toBe(0);
    expect(result.target_license).toBe("Apache-2.0");
    const details = result.details as Record<string, unknown>[];
    expect(details[0]?.compatible).toBe(true);
  });

  it("GPL package blocks with Apache-2.0 target", async () => {
    const result = (await tool.handler({
      packages: [{ name: "badlib", license: "GPL-3.0-only" }],
    })) as Record<string, unknown>;

    expect(result.all_compatible).toBe(false);
    expect(result.conflicts).toBeGreaterThan(0);
    const details = result.details as Record<string, unknown>[];
    const row = details.find((d) => d.package === "badlib");
    expect(row?.compatible).toBe(false);
    expect(row?.severity).toBe("blocking");
  });

  it("unknown SPDX returns warning severity", async () => {
    const result = (await tool.handler({
      packages: [{ name: "mystery", license: "UNKNOWN" }],
    })) as Record<string, unknown>;

    expect(result.all_compatible).toBe(false);
    const details = result.details as Record<string, unknown>[];
    expect(details[0]?.severity).toBe("warning");
  });

  it("all compatible sets all_compatible: true", async () => {
    const result = (await tool.handler({
      packages: [
        { name: "a", license: "MIT" },
        { name: "b", license: "ISC" },
      ],
    })) as Record<string, unknown>;

    expect(result.all_compatible).toBe(true);
    expect(result.conflicts).toBe(0);
  });

  it("respects custom target_license", async () => {
    const result = (await tool.handler({
      packages: [{ name: "x", license: "GPL-3.0-only" }],
      target_license: "GPL-3.0-only",
    })) as Record<string, unknown>;

    expect(result.target_license).toBe("GPL-3.0-only");
    expect(result.all_compatible).toBe(true);
  });
});
