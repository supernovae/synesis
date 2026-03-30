/**
 * Transcript trust pipeline — wraps user/tool/client-assistant messages
 * in TrustPacketV1 JSON envelopes and runs the injection scanner.
 *
 * Designed as a single-pass transform over the OpenAI-shaped message array
 * before it enters openAIMessagesToModelMessages. No extra LLM calls.
 */

import {
  makeUntrusted,
  serializeStableJson,
  scanText,
  scanWebContent,
  sanitize,
  scanResultToPayload,
  emitSecurityEvent,
  TRUST_POLICY_COMPACT,
  type ScanResult,
  type SecurityIngestConfig,
  type TrustPacketV1,
} from "@synesis/context-trust";
import type { AppConfig } from "../config.js";

export interface TrustPipelineResult {
  messages: Array<{ role: string; content: unknown }>;
  blocked: boolean;
  /** Internal-only detail for logs/telemetry; never expose to clients. */
  blockDetail?: string;
  scanResults: ScanResult[];
}

interface TrustPipelineContext {
  requestId: string;
  sessionKey: string;
  userId: string;
  orgId: string;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } =>
        typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text",
      )
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

function wrapInPacket(packet: TrustPacketV1): string {
  return serializeStableJson(packet);
}

export function applyTrustPackets(
  messages: Array<{ role: string; content: unknown }>,
  config: AppConfig,
  ctx: TrustPipelineContext,
  ingestConfig: SecurityIngestConfig,
  logger?: { warn: (msg: string, ...args: unknown[]) => void },
): TrustPipelineResult {
  const trustEnabled = config.SYNESIS_YARN_TRUST_PACKET_ENABLED;
  const scanEnabled = config.SYNESIS_YARN_INJECTION_SCAN_ENABLED;
  const scanAction = config.SYNESIS_YARN_INJECTION_SCAN_ACTION;
  const ingestEnabled = config.SYNESIS_YARN_SECURITY_INGEST_ENABLED;

  const scanResults: ScanResult[] = [];
  const out: Array<{ role: string; content: unknown }> = [];
  let blocked = false;
  let blockDetail: string | undefined;

  let trustPolicyInjected = false;

  for (const msg of messages) {
    const role = msg.role;
    const raw = textContent(msg.content);

    if (role === "system") {
      if (trustEnabled && !trustPolicyInjected) {
        out.push({ role: "system", content: `${TRUST_POLICY_COMPACT}\n\n${raw}` });
        trustPolicyInjected = true;
      } else {
        out.push(msg);
      }
      continue;
    }

    if (role === "user" || role === "tool") {
      const sourceType = role === "user" ? "user_message" as const : "tool_result" as const;

      if (scanEnabled && raw) {
        const result = role === "tool"
          ? scanWebContent(raw, sourceType)
          : scanText(raw, sourceType);

        if (result.detected) {
          scanResults.push(result);

          if (ingestEnabled) {
            const payload = scanResultToPayload(result, {
              service: "yarn",
              requestId: ctx.requestId,
              sessionId: ctx.sessionKey,
              userId: ctx.userId,
              orgId: ctx.orgId,
              actionTaken: scanAction,
            });
            emitSecurityEvent(payload, ingestConfig, logger);
          }

          if (scanAction === "block") {
            blocked = true;
            blockDetail = `Injection detected: ${result.event_type} (confidence=${result.confidence.toFixed(2)})`;
            break;
          }
        }
      }

      if (trustEnabled && raw) {
        const { text: sanitized, applied, imperativeLikelihood } = sanitize(raw);
        const packet = makeUntrusted(sanitized, sourceType, {
          sourceId: ctx.sessionKey,
          contentPurpose: role === "tool" ? "data" : "data",
          sanitization: applied,
          imperativeLikelihood,
        });
        out.push({ ...msg, content: wrapInPacket(packet) });
      } else {
        out.push(msg);
      }
      continue;
    }

    if (role === "assistant") {
      // Pass assistant messages through unchanged. Wrapping them in trust
      // packets causes the upstream model to mimic the JSON envelope format
      // in its own output, corrupting multi-turn conversations.
      out.push(msg);
      continue;
    }

    out.push(msg);
  }

  return { messages: out, blocked, blockDetail, scanResults };
}
