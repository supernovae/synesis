import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildOpenWebUIEventUrl,
  buildStatusEvent,
  describeStatusPhase,
  emitOpenWebUIEvent,
  openWebUIContextFromConfig,
} from "../src/streaming/status-events.js";
import { loadConfig } from "../src/config.js";

describe("status event helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds visible Open WebUI status events by default", () => {
    const event = buildStatusEvent("Querying graph context...");
    expect(event).toEqual({
      type: "status",
      data: {
        description: "Querying graph context...",
        done: false,
        hidden: false,
      },
    });
  });

  it("maps phases to user-visible descriptions", () => {
    expect(describeStatusPhase("planning")).toBe("Building execution plan...");
    expect(describeStatusPhase("web_search")).toBe("Searching the web...");
    expect(describeStatusPhase("complete")).toBe("Done");
  });

  it("constructs the Open WebUI message event endpoint URL safely", () => {
    expect(buildOpenWebUIEventUrl("http://open-webui:8080/", "chat 1", "msg/2")).toBe(
      "http://open-webui:8080/api/v1/chats/chat%201/messages/msg%2F2/event",
    );
  });

  it("no-ops when event metadata is missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const posted = await emitOpenWebUIEvent(
      { openWebUI: { baseUrl: "http://open-webui:8080", token: "secret", chatId: "chat-1" } },
      buildStatusEvent("Preparing request..."),
    );
    expect(posted).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not fail the caller when Open WebUI post fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network down"));
    const posted = await emitOpenWebUIEvent(
      {
        logger: { debug: vi.fn(), warn: vi.fn() },
        openWebUI: {
          baseUrl: "http://open-webui:8080",
          token: "secret-token",
          chatId: "chat-1",
          messageId: "message-1",
          timeoutMs: 50,
        },
      },
      buildStatusEvent("Preparing request..."),
    );
    expect(posted).toBe(false);
  });

  it("derives event context only when URL, token, chat id, and message id are present", () => {
    const missing = openWebUIContextFromConfig({
      config: loadConfig({ SYNESIS_PLANNER_TS_OPENWEBUI_BASE_URL: "http://open-webui:8080" }),
      chatId: "chat-1",
      messageId: "message-1",
    });
    expect(missing).toBeUndefined();

    const present = openWebUIContextFromConfig({
      config: loadConfig({
        SYNESIS_PLANNER_TS_OPENWEBUI_BASE_URL: "http://open-webui:8080",
        SYNESIS_PLANNER_TS_OPENWEBUI_EVENT_TOKEN: "secret-token",
      }),
      chatId: "chat-1",
      messageId: "message-1",
    });
    expect(present?.baseUrl).toBe("http://open-webui:8080");
    expect(present?.token).toBe("secret-token");
  });
});
