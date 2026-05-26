import crypto from "node:crypto";
import type { AppConfig } from "../config.js";
import type { PromptSnapshot } from "../providers/admin-tier-registry.js";
import { type PromptFrame, computeVolatileFingerprint } from "./prompt-frame.js";
import { generateExtendedMemoryContext } from "../memory/context-injector.js";
import { runGoDoc } from "../memory/go-doc-index.js";
import type { ContentAddressedDedup } from "../reduction/content-addressed-dedup.js";
import type { IncrementalStructuralIndex } from "../memory/incremental-index.js";
import type { MemoryGovernorTracker } from "../memory/governor-integration.js";
import type { BlockStore } from "../store/block-store.js";
import type { WorkingFrameService, ManifestContext } from "../frame/working-frame-service.js";
import type { ProjectManifestService } from "../project/project-manifest-service.js";
import { getTemplate as manifestGetTemplate } from "@synesis/manifest";
import { classify as manifestClassify } from "../manifest/classifier.js";
import { scanForManifest as manifestScan } from "../manifest/repo-scanner.js";
import { compareManifests as manifestCompare } from "../manifest/comparator.js";
import { critiquStructure as manifestCritique } from "../manifest/structural-critic.js";
import { buildVerificationPlan, formatVerificationPlanBlock } from "../verification/planner.js";
import { getLanguagePackRegistry } from "../language-packs/index.js";
import type { StablePrefixService } from "./stable-prefix.js";
import type { AttentionPositioningService } from "./attention-positioning.js";
import { buildResponseStyleBlock } from "../response-style.js";
import type { SessionState } from "../state/session-state.js";
import type { WorkflowPhase } from "../orchestration/phase-model-orchestrator.js";

export interface EnrichResult {
  messages: Array<{ role: string; content: unknown }>;
  workingPhase?: WorkflowPhase;
  workingFrameGoal?: string;
  promptProfileIds?: number[];
  promptProfileHashes?: string[];
  prefixHash?: string;
  prefixChangeReasons?: string[];
}

export function phaseFromFrame(currentPhase: "explore" | "planning" | "implementation" | "validation"): WorkflowPhase {
  if (currentPhase === "explore") return "explore";
  if (currentPhase === "planning") return "planning";
  if (currentPhase === "validation") return "validation";
  return "implementation";
}

function splitAdapterBlockForStability(adapterBlock?: string): { stable?: string; volatile?: string } {
  if (!adapterBlock || !adapterBlock.trim()) return {};
  const volatileLine = /^(git_|runtime=|session_id=|request_id=|project_root=|shell_cwd=|cwd=|pwd=|temp_|tmp_)/i;
  const lines = adapterBlock.split("\n");
  const stable: string[] = [];
  const volatile: string[] = [];
  for (const line of lines) {
    if (volatileLine.test(line.trim())) volatile.push(line);
    else stable.push(line);
  }
  return {
    stable: stable.join("\n").trim() || undefined,
    volatile: volatile.join("\n").trim() || undefined,
  };
}

const TOOL_EFFICIENCY_GUIDANCE = `<TOOL_EFFICIENCY>
When a build or test command fails, read the error output carefully and fix the root cause before re-running. Do not re-run the same command hoping for a different result.
- Identify the specific file and line from the error, fix it, then verify.
- Avoid running broader commands (e.g. \`go test ./...\`) repeatedly when you can target the failing package directly.
- After fixing an error, run the narrowest possible verification first.
- Remove unused imports and fix vet warnings before re-running the full suite.
</TOOL_EFFICIENCY>`;

function buildIntentGateBlock(messages: Array<{ role: string; content: unknown }>): string | null {
  const latestUser = [...messages].reverse().find((m) => m.role === "user" && typeof m.content === "string");
  const text = String(latestUser?.content ?? "").toLowerCase();
  if (!text) return null;
  const lines: string[] = [];
  if (/\b(add|write|create|build).{0,30}\btests?\b/.test(text) || /\bcomprehensive test suite\b/.test(text)) {
    lines.push("- Test-entry contract: inspect existing test configs/patterns first (jest.config/vitest/pytest.ini/pyproject/package.json), then create or modify tests.");
  }
  if (/\b(clean ?up|refactor|harden|polish)\b/.test(text)) {
    lines.push("- Cleanup-entry contract: run a targeted TODO/FIXME/DEBUG harvest before editing; prioritize highest-impact findings.");
  }
  if (/\b(update|implement|build|create|refactor|migrate)\b/.test(text)) {
    lines.push("- Multi-step contract: state a short phase plan before first write-capable tool call.");
  }
  if (lines.length === 0) return null;
  return ["<SYNESIS_INTENT_GATES>", ...lines, "</SYNESIS_INTENT_GATES>"].join("\n");
}

const FILE_RE_GLOBAL = /\b(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|json|yaml|yml|md|sql|sh|tf|hcl)\b/g;

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "typescript", jsx: "typescript",
  py: "python", go: "go", rs: "rust", java: "java", kt: "java",
  cs: "csharp", sql: "sql", sh: "bash", bash: "bash",
  tf: "terraform", hcl: "terraform",
  yaml: "yaml-k8s", yml: "yaml-k8s",
};

export function detectLanguagesFromMessages(messages: Array<{ role: string; content: unknown }>): string[] {
  const allText = messages.map((m) => typeof m.content === "string" ? m.content : "").join("\n");
  const files = allText.match(FILE_RE_GLOBAL) ?? [];
  const langs = new Set<string>();
  for (const f of files) {
    const ext = f.split(".").pop()?.toLowerCase();
    if (ext && EXTENSION_TO_LANGUAGE[ext]) {
      langs.add(EXTENSION_TO_LANGUAGE[ext]);
    }
  }
  return Array.from(langs);
}

export function createRouteEnrichmentService(input: {
  config: AppConfig;
  blockStore: BlockStore;
  workingFrameService: WorkingFrameService;
  projectManifestService: ProjectManifestService;
  stablePrefixService: StablePrefixService;
  attentionPositioning: AttentionPositioningService;
  getPromptSnapshot(): PromptSnapshot | null;
  getStructuralIndex(sessionKey: string): IncrementalStructuralIndex | null;
  getContentDedup(sessionKey: string): ContentAddressedDedup;
  getMemoryGovernor(sessionKey: string): MemoryGovernorTracker;
}) {
  async function enrichWithFrameAndManifest(
    messages: Array<{ role: string; content: unknown }>,
    sessionKey: string,
    adapterBlock?: string,
    promptContext?: { tier?: string; role?: string; modelFamily?: string; node?: string },
    pathHints?: { projectRoot: string | null; shellCwd: string | null } | null,
    governanceBlocks?: string[],
    topLevelDirs?: string[],
    sessionState?: SessionState | null,
    stateChannels?: { chatStateBlock?: string | null; fileStateBlock?: string | null },
  ): Promise<EnrichResult> {
    const out = [...messages];
    let detectedPhase: WorkflowPhase | undefined;
    let detectedGoal: string | undefined;
    const { stable: stableAdapterBlock, volatile: volatileAdapterBlock } = splitAdapterBlockForStability(adapterBlock);

    const partition = input.config.SYNESIS_YARN_STABLE_PREFIX_ENABLED
      ? input.stablePrefixService.partition(sessionKey, stableAdapterBlock, input.getPromptSnapshot(), promptContext)
      : {
        stablePrefix: "You are an AI coding assistant provided by Synesis.",
        prefixHash: "",
        prefixChangeReasons: ["stable_prefix_disabled"],
        promptProfileIds: [],
        promptProfileHashes: [],
      };

    const stablePrefix = input.blockStore.intern(partition.stablePrefix);

    const effectiveRoot = pathHints?.projectRoot ?? pathHints?.shellCwd;
    let projectContext: string | null = null;
    if (topLevelDirs && topLevelDirs.length > 0 && effectiveRoot) {
      projectContext = input.blockStore.intern(`<PROJECT_ROOT path="${effectiveRoot}" dirs="${topLevelDirs.join(",")}" />`);
    }

    if (input.config.SYNESIS_YARN_GOVERNANCE_DISABLED) {
      let prefixContent = stablePrefix;
      if (projectContext) prefixContent += "\n" + projectContext;
      const enriched: Array<{ role: string; content: unknown }> = [
        { role: "system", content: prefixContent },
        ...out,
      ];
      return {
        messages: enriched,
        prefixHash: partition.prefixHash,
        prefixChangeReasons: partition.prefixChangeReasons,
        promptProfileIds: partition.promptProfileIds,
        promptProfileHashes: partition.promptProfileHashes,
      };
    }

    let workingFrameBlock: string | null = null;
    let structuralCriticBlock: string | null = null;

    const wfPathHints =
      input.config.SYNESIS_YARN_SESSION_PATH_HINTS_IN_WORKING_FRAME && pathHints
        ? { projectRoot: pathHints.projectRoot, shellCwd: pathHints.shellCwd }
        : null;

    if (input.config.SYNESIS_YARN_WORKING_FRAME_ENABLED) {
      if (input.config.SYNESIS_YARN_MANIFEST_TEMPLATES_ENABLED) {
        const latestUser = [...out].reverse().find((m) => m.role === "user");
        const userText = typeof latestUser?.content === "string" ? latestUser.content : "";
        const allText = out.map((m) => typeof m.content === "string" ? m.content : "").join("\n");
        const { classification, complexity: complexityResult } = manifestClassify(userText);

        if (complexityResult.complexity === "tiny" || complexityResult.complexity === "small") {
          const frame = input.workingFrameService.build(out);
          detectedPhase = phaseFromFrame(frame.currentPhase);
          detectedGoal = frame.goal;
          workingFrameBlock = input.workingFrameService.toSystemBlock(frame, wfPathHints);
        } else {
          const template = manifestGetTemplate(classification.projectKind);
          const filePaths = (allText.match(FILE_RE_GLOBAL) ?? []).map((f: string) => f.trim());
          const observed = manifestScan({ filePaths, conversationText: allText });
          const manifestCtx: ManifestContext = { complexity: complexityResult.complexity };

          if (template) {
            const comparison = manifestCompare(template.manifest, observed);
            manifestCtx.manifest = template.manifest;
            manifestCtx.comparison = comparison;

            if (input.config.SYNESIS_YARN_STRUCTURAL_CRITIC_ENABLED) {
              const critique = manifestCritique(comparison);
              if (!critique.passed && critique.requiredMissing > 0) {
                structuralCriticBlock = `<STRUCTURAL_CRITIC>\n${critique.summary}\n</STRUCTURAL_CRITIC>`;
              }
            }
          } else {
            manifestCtx.manifest = observed;
          }

          const richFrame = input.workingFrameService.buildRich(out, manifestCtx);
          detectedPhase = richFrame.phase === "plan" ? "planning"
            : richFrame.phase === "validate" ? "validation"
            : richFrame.phase === "explore" ? "explore"
            : "implementation";
          detectedGoal = richFrame.currentGoal;
          workingFrameBlock = input.workingFrameService.toRichSystemBlock(richFrame, wfPathHints);
        }
      } else {
        const frame = input.workingFrameService.build(out);
        detectedPhase = phaseFromFrame(frame.currentPhase);
        detectedGoal = frame.goal;
        workingFrameBlock = input.workingFrameService.toSystemBlock(frame, wfPathHints);
      }
    }

    let projectManifestBlock: string | null = null;
    if (input.config.SYNESIS_YARN_PROJECT_MANIFEST_ENABLED) {
      const manifest = input.projectManifestService.build(out);
      projectManifestBlock = input.projectManifestService.toSystemBlock(manifest);
    }

    let structuralIndexBlock: string | null = null;
    if (input.config.SYNESIS_YARN_STRUCTURAL_INDEX_ENABLED) {
      const sessionIdx = input.getStructuralIndex(sessionKey);
      if (sessionIdx) {
        const stats = sessionIdx.getStats();
        if (stats.fileCount > 0) {
          structuralIndexBlock = sessionIdx.renderMap(input.config.SYNESIS_YARN_STRUCTURAL_INDEX_TOKEN_BUDGET) ?? null;
        }
      }
    }

    let fileSummaryBlock: string | null = null;
    const enrichDedup = input.getContentDedup(sessionKey);
    if (enrichDedup.getTrackedFileCount() > 0) {
      fileSummaryBlock = enrichDedup.generateFilesSummaryBlock() ?? null;
    }

    let verificationPlanBlock: string | null = null;
    if (input.config.SYNESIS_YARN_VERIFICATION_PLAN_ENABLED) {
      const detectedLangs = detectLanguagesFromMessages(out);
      if (detectedLangs.length > 0) {
        const vPlan = buildVerificationPlan(
          detectedLangs,
          getLanguagePackRegistry(),
          input.config.SYNESIS_YARN_VERIFICATION_MAX_ROUNDS,
          input.config.SYNESIS_YARN_VERIFICATION_BUDGET_MS,
        );
        verificationPlanBlock = formatVerificationPlanBlock(vPlan) ?? null;
      }
    }

    const sessionIdxForExtMem = input.getStructuralIndex(sessionKey);
    const structuralMapFromIncremental = Boolean(structuralIndexBlock);
    const detectedLangsForExt = detectLanguagesFromMessages(out);
    const projectLanguageForExt = sessionIdxForExtMem?.getIndex().language ?? detectedLangsForExt[0] ?? "unknown";
    const recentFilesForExt = sessionIdxForExtMem ? sessionIdxForExtMem.getIndex().files.map((f) => f.path) : [];
    let goDocOutputForExt: string | null = null;
    if (
      input.config.SYNESIS_YARN_GO_DOC_REPOMAP_ENABLED
      && !structuralMapFromIncremental
      && pathHints?.projectRoot
      && projectLanguageForExt === "go"
    ) {
      goDocOutputForExt = await runGoDoc(pathHints.projectRoot);
    }
    const extendedMemoryInjected = generateExtendedMemoryContext(input.config, {
      structuralIndex: null,
      structuralMapFromIncremental,
      goDocOutput: goDocOutputForExt,
      evalPlan: null,
      recentFiles: recentFilesForExt,
      projectLanguage: projectLanguageForExt,
      memorySignals: input.getMemoryGovernor(sessionKey).getSignals(),
    });

    const responseStyleOverride = input.stablePrefixService.resolveNodePromptBlock(
      input.getPromptSnapshot(),
      "response_style",
    ).block ?? undefined;
    const responseStyleBlock = buildResponseStyleBlock({
      mode: input.config.SYNESIS_YARN_RESPONSE_STYLE_MODE,
      allowMermaid: input.config.SYNESIS_YARN_RESPONSE_STYLE_ALLOW_MERMAID,
      adminOverride: responseStyleOverride,
    });

    const intentGateBlock = buildIntentGateBlock(out);

    const frame: PromptFrame = {
      stablePrefix,
      projectContext,
      volatileAdapter: volatileAdapterBlock ?? null,
      chatState: stateChannels?.chatStateBlock ?? null,
      fileState: stateChannels?.fileStateBlock ?? null,
      workingFrame: workingFrameBlock,
      structuralCritic: structuralCriticBlock,
      projectManifest: projectManifestBlock ? input.blockStore.intern(projectManifestBlock) : null,
      structuralIndex: structuralIndexBlock ? input.blockStore.intern(structuralIndexBlock) : null,
      fileSummary: fileSummaryBlock,
      verificationPlan: verificationPlanBlock ? input.blockStore.intern(verificationPlanBlock) : null,
      extendedMemoryBlocks: extendedMemoryInjected.blocks,
      responseStyle: responseStyleBlock ? input.blockStore.intern(responseStyleBlock) : null,
      governanceBlocks: (governanceBlocks ?? []).filter((b) => b && b.trim()),
      intentGate: intentGateBlock,
      toolEfficiency: input.blockStore.intern(TOOL_EFFICIENCY_GUIDANCE),
    };

    const volatileFingerprint = computeVolatileFingerprint(frame);
    const volatileHash = crypto.createHash("sha256").update(volatileFingerprint).digest("hex").slice(0, 16);

    if (sessionState?.lastVolatileHash === volatileHash && sessionState.lastVolatileContent) {
      // Reuse last turn's content string — same reference, same bytes.
    } else if (sessionState) {
      sessionState.lastVolatileHash = volatileHash;
      sessionState.lastVolatileContent = volatileFingerprint;
    }

    const resolvedVolatile = sessionState?.lastVolatileContent ?? volatileFingerprint;

    let prefixContent = frame.stablePrefix;
    if (frame.projectContext) prefixContent += "\n" + frame.projectContext;

    const enriched: Array<{ role: string; content: unknown }> = [
      { role: "system", content: prefixContent },
      ...(resolvedVolatile ? [{ role: "system", content: resolvedVolatile }] : []),
      ...out,
    ];

    const finalMessages = input.config.SYNESIS_YARN_ATTENTION_POSITIONING_ENABLED
      ? input.attentionPositioning.position(enriched).messages
      : enriched;
    return {
      messages: finalMessages,
      workingPhase: detectedPhase,
      workingFrameGoal: detectedGoal,
      promptProfileIds: partition.promptProfileIds,
      promptProfileHashes: partition.promptProfileHashes,
      prefixHash: partition.prefixHash,
      prefixChangeReasons: partition.prefixChangeReasons,
    };
  }

  return { enrichWithFrameAndManifest };
}
