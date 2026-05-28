import { describe, expect, it } from "vitest";
import {
  appendPathContextToAdapterBlock,
  ClientAdapterPacks,
  parseSessionExecutionContext,
} from "../src/adapters/client-adapter-packs.js";
import { toSessionExecutionContextSystemBlock } from "../src/adapters/session-execution-context.js";

describe("ClientAdapterPacks", () => {
  it("resolves IDE clients to ide mode by default", () => {
    const packs = new ClientAdapterPacks();
    const p = packs.resolve("cursor");
    expect(p.mode).toBe("ide");
    expect(p.family).toBe("default");
    expect(p.workflow).toBe("mixed");
  });

  it("resolves CLI clients to cli mode", () => {
    const packs = new ClientAdapterPacks();
    const p = packs.resolve("codex-cli");
    expect(p.mode).toBe("cli");
    expect(p.workflow).toBe("validation");
  });

  it("respects explicitly requested mode", () => {
    const packs = new ClientAdapterPacks();
    const p = packs.resolve("cursor", "background");
    expect(p.mode).toBe("background");
    expect(p.workflow).toBe("planning");
  });

  it("returns adapter system block", () => {
    const packs = new ClientAdapterPacks();
    const p = packs.resolve("claude-code");
    const block = packs.toSystemBlock(p);
    expect(block).toContain("<CLIENT_ADAPTER>");
    expect(block).toContain("client=claude-code");
    expect(block).toContain("family=default");
    expect(block).toContain("prefer Update/Edit-style targeted diffs");
    expect(block).toContain("do not delete or weaken failing tests");
  });

  it("resolves openclaw variants to openclaw family features", () => {
    const packs = new ClientAdapterPacks();
    const p = packs.resolve("openclaw-desktop");
    expect(p.family).toBe("openclaw");
    expect(p.features.strictWriteToolGovernance).toBe(true);
    expect(p.features.toolSchemaBudgetCap).toBe(8);
    const block = packs.toSystemBlock(p);
    expect(block).toContain("family=openclaw");
    expect(block).toContain("strict_write_tool_governance=true");
  });

  it("tracks stats by mode", () => {
    const packs = new ClientAdapterPacks();
    packs.resolve("cursor");
    packs.resolve("codex-cli");
    packs.resolve("continue", "mcp_native");
    const s = packs.getStats();
    expect(s.resolutions).toBe(3);
    expect(s.byMode.ide).toBe(1);
    expect(s.byMode.cli).toBe(1);
    expect(s.byMode.mcp_native).toBe(1);
  });
});

describe("appendPathContextToAdapterBlock", () => {
  it("passes through when no path context and no claude-code hint", () => {
    expect(
      appendPathContextToAdapterBlock("<CLIENT_ADAPTER>x</CLIENT_ADAPTER>", {}, null),
    ).toBe("<CLIENT_ADAPTER>x</CLIENT_ADAPTER>");
    expect(
      appendPathContextToAdapterBlock("<CLIENT_ADAPTER>x</CLIENT_ADAPTER>", {}, null, "cursor"),
    ).toBe("<CLIENT_ADAPTER>x</CLIENT_ADAPTER>");
  });

  it("appends PATH_HYGIENE when claude-code hint and no session context", () => {
    const out = appendPathContextToAdapterBlock("base", {}, null, "claude-code");
    expect(out).toContain("base");
    expect(out).toContain("<PATH_HYGIENE>");
    expect(out).toContain("aws-cost-calculator/aws-cost-calculator");
    expect(out).toContain("Do not infer package/module ownership from surrounding platform names");
    expect(out).toContain("human-readable paths");
  });

  it("appends PATH_HYGIENE for opencode when no session context", () => {
    const out = appendPathContextToAdapterBlock("base", {}, null, "opencode");
    expect(out).toContain("<PATH_HYGIENE>");
    expect(out).toContain("from /home/byron/src/test use taskpulse/README.md");
    expect(out).toContain("/home/byron/src/test/src/test/");
    expect(out).toContain("Do not regenerate the project");
  });

  it("shell_cwd without project_root includes duplicate-segment warning", () => {
    const block = toSessionExecutionContextSystemBlock({
      projectRoot: null,
      shellCwd: "/Users/me/aws-cost-calculator",
    });
    expect(block).toContain("shell_cwd=");
    expect(block).toContain("aws-cost-calculator/aws-cost-calculator");
    expect(block).toContain("human-readable paths");
    expect(block).toContain("<FILE_PATH_RESOLUTION>");
    expect(block).toContain("paths relative to shell_cwd/current working directory");
  });

  it("appends SESSION_EXECUTION_CONTEXT when workspace root header set", () => {
    const out = appendPathContextToAdapterBlock("base", { "x-synesis-workspace-root": "/Users/me/calc" }, null);
    expect(out).toContain("base");
    expect(out).toContain("<SESSION_EXECUTION_CONTEXT>");
    expect(out).toContain("project_root=/Users/me/calc");
    expect(out).toContain("Language package identity (for example Go `module` path) must come from explicit user input");
    expect(out).toContain("human-readable paths");
    expect(out).toContain("<FILE_PATH_RESOLUTION>");
  });

  it("includes repo-relative cwd hint when project_root and shell_cwd differ", () => {
    const block = toSessionExecutionContextSystemBlock({
      projectRoot: "/Users/me/monorepo",
      shellCwd: "/Users/me/monorepo/services/api",
    });
    expect(block).toContain("<FILE_PATH_RESOLUTION>");
    expect(block).toContain("Current shell working directory for this session is repo-relative: services/api");
    expect(block).toContain("shell_cwd is the file-tool execution root");
  });

  it("prefers metadata synesis_project_root over header", () => {
    const ctx = parseSessionExecutionContext(
      { "x-synesis-workspace-root": "/hdr" },
      { synesis_project_root: "/meta" },
    );
    expect(ctx.projectRoot).toBe("/meta");
  });

  it("parses structured git metadata fields", () => {
    const ctx = parseSessionExecutionContext(
      {},
      {
        synesis_git_is_repo: true,
        synesis_git_branch: "feature/git-first",
        synesis_git_dirty: true,
        synesis_git_has_untracked: true,
        synesis_git_ahead: 2,
        synesis_git_behind: 1,
      },
      { gitPolicyMode: "advisory" },
    );
    expect(ctx.gitIsRepo).toBe(true);
    expect(ctx.gitBranch).toBe("feature/git-first");
    expect(ctx.gitDirty).toBe(true);
    expect(ctx.gitHasUntracked).toBe(true);
    expect(ctx.gitAhead).toBe(2);
    expect(ctx.gitBehind).toBe(1);
    expect(ctx.gitPolicyMode).toBe("advisory");
  });

  it("infers branch info from git summary when structured fields are absent", () => {
    const ctx = parseSessionExecutionContext(
      {},
      {
        synesis_git_summary: "## feature/test...origin/feature/test [ahead 3, behind 1]\n M src/app.ts\n?? notes.txt",
      },
      { gitPolicyMode: "enforced" },
    );
    const block = toSessionExecutionContextSystemBlock(ctx);
    expect(ctx.gitBranch).toBe("feature/test");
    expect(ctx.gitDirty).toBe(true);
    expect(ctx.gitHasUntracked).toBe(true);
    expect(block).toContain("git_policy_mode=enforced");
    expect(block).toContain("is_git_repo=true");
  });
});
