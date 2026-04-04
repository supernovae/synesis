import { trace, type Span } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { McpTsConfig } from "./config.js";

let initialized = false;
let serviceName = "synesis-mcp-ts";

export function initOtel(config: McpTsConfig): void {
  if (initialized) return;
  serviceName = config.OTEL_SERVICE_NAME;
  const endpoint = config.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) {
    initialized = true;
    return;
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
  });

  const exporter = new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` });
  const provider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  provider.register();

  initialized = true;
}

export function getTracer() {
  return trace.getTracer(serviceName);
}

export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attrs?: Record<string, string>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, async (span) => {
    try {
      if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
          span.setAttribute(k, v);
        }
      }
      return await fn(span);
    } finally {
      span.end();
    }
  });
}
