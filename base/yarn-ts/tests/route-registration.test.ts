import { describe, expect, it, vi } from "vitest";

vi.mock("../src/routes/platform-routes.js", () => ({
  registerPlatformRoutes: vi.fn(),
}));

vi.mock("../src/routes/openai-chat-completions-route.js", () => ({
  registerOpenAIChatCompletionsRoute: vi.fn(),
}));

vi.mock("../src/routes/claude-messages-route.js", () => ({
  registerClaudeMessagesRoute: vi.fn(),
}));

import { registerClaudeMessagesRoute } from "../src/routes/claude-messages-route.js";
import { registerOpenAIChatCompletionsRoute } from "../src/routes/openai-chat-completions-route.js";
import { registerPlatformRoutes } from "../src/routes/platform-routes.js";
import {
  registerConfiguredRoutes,
  type RouteDependencyGroups,
} from "../src/server/route-registration.js";

describe("registerConfiguredRoutes", () => {
  it("registers routes from grouped dependency facades", () => {
    const app = { route: vi.fn() };
    const config = { PORT: 0 };
    const authResolver = { resolve: vi.fn() };
    const fgaCheck = vi.fn();
    const userRateLimiter = { check: vi.fn() };
    const runOpenAIRequest = vi.fn();
    const openAiChatPipeline = { execute: vi.fn() };

    const groups: RouteDependencyGroups = {
      runtime: { app, config },
      auth: { authResolver, fgaCheck, userRateLimiter },
      protocol: { resolveRequestId: vi.fn() },
      session: {
        getSessionKey: vi.fn(),
        getSessionState: vi.fn(),
        casSessionSave: vi.fn(),
        sessions: new Map(),
      },
      workspace: {},
      reduction: {},
      tools: {},
      governance: {},
      planning: {},
      provider: { runOpenAIRequest, openAiChatPipeline },
      evidence: {},
      telemetry: {},
      adapter: {},
    };

    registerConfiguredRoutes(groups);

    expect(registerPlatformRoutes).toHaveBeenCalledTimes(1);
    expect(registerPlatformRoutes).toHaveBeenCalledWith(expect.objectContaining({
      app,
      config,
      authResolver,
      fgaCheck,
      userRateLimiter,
    }));

    expect(registerOpenAIChatCompletionsRoute).toHaveBeenCalledTimes(1);
    expect(registerOpenAIChatCompletionsRoute).toHaveBeenCalledWith(expect.objectContaining({
      app,
      config,
      authResolver,
      runOpenAIRequest,
      openAiChatPipeline,
    }));

    expect(registerClaudeMessagesRoute).toHaveBeenCalledTimes(1);
    expect(registerClaudeMessagesRoute).toHaveBeenCalledWith(expect.objectContaining({
      runtime: expect.objectContaining({ app, config }),
      auth: expect.objectContaining({ authResolver, fgaCheck, userRateLimiter }),
      provider: expect.objectContaining({ runOpenAIRequest }),
    }));
  });
});
