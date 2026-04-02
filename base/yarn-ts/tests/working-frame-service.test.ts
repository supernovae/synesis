import { describe, expect, it } from "vitest";
import { WorkingFrameService } from "../src/frame/working-frame-service.js";

describe("WorkingFrameService", () => {
  it("builds frame from mixed messages", () => {
    const svc = new WorkingFrameService(8);
    const frame = svc.build([
      { role: "system", content: "Do not rewrite full files. Must run tests." },
      { role: "user", content: "Please fix base/yarn-ts/src/index.ts and run npm test?" },
      { role: "assistant", content: "Working on it." }
    ]);
    expect(frame.goal).toContain("Please fix");
    expect(frame.constraints.length).toBeGreaterThan(0);
    expect(frame.activeFiles).toContain("base/yarn-ts/src/index.ts");
    expect(frame.pendingChecks).toContain("tests");
  });

  it("renders system block", () => {
    const svc = new WorkingFrameService(8);
    const frame = svc.build([{ role: "user", content: "Create a roadmap plan." }]);
    const block = svc.toSystemBlock(frame);
    expect(block).toContain("<WORKING_FRAME>");
    expect(block).toContain("current_phase=");
  });

  it("includes project_root and shell_cwd when path hints provided", () => {
    const svc = new WorkingFrameService(8);
    const frame = svc.build([{ role: "user", content: "Do the task." }]);
    const block = svc.toSystemBlock(frame, {
      projectRoot: "/Users/me/repo",
      shellCwd: "/Users/me/repo/sub",
    });
    expect(block).toContain("project_root=/Users/me/repo");
    expect(block).toContain("shell_cwd=/Users/me/repo/sub");
  });
});
