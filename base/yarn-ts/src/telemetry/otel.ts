/**
 * Optional OpenTelemetry bootstrap for TS Yarn.
 *
 * Activated when SYNESIS_YARN_OTEL_ENABLED=true and OTEL_EXPORTER_OTLP_ENDPOINT
 * is set. Uses the OTLP/gRPC exporter and auto-discovers Fastify/HTTP spans
 * through the Node.js auto-instrumentation conventions.
 *
 * When disabled, `getTracer()` returns the no-op tracer so call-sites can
 * instrument unconditionally without runtime cost.
 */

import type { AppConfig } from "../config.js";

let tracerInstance: OtelTracer | null = null;

export interface OtelTracer {
  startSpan(name: string, attrs?: Record<string, string | number | boolean>): OtelSpan;
}

export interface OtelSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(code: "ok" | "error", message?: string): void;
  end(): void;
}

const noopSpan: OtelSpan = {
  setAttribute() {},
  setStatus() {},
  end() {},
};

const noopTracer: OtelTracer = {
  startSpan() {
    return noopSpan;
  },
};

export function getTracer(): OtelTracer {
  return tracerInstance ?? noopTracer;
}

export async function initOtel(config: AppConfig): Promise<void> {
  if (!config.SYNESIS_YARN_OTEL_ENABLED || !config.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return;
  }

  try {
    const { NodeTracerProvider } = await import("@opentelemetry/sdk-trace-node");
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    const { BatchSpanProcessor } = await import("@opentelemetry/sdk-trace-base");
    const { Resource } = await import("@opentelemetry/resources");
    const { ATTR_SERVICE_NAME } = await import("@opentelemetry/semantic-conventions");

    const resource = new Resource({
      [ATTR_SERVICE_NAME]: config.OTEL_SERVICE_NAME,
    });

    const exporter = new OTLPTraceExporter({
      url: config.OTEL_EXPORTER_OTLP_ENDPOINT,
    });

    const provider = new NodeTracerProvider({ resource });
    provider.addSpanProcessor(new BatchSpanProcessor(exporter));
    provider.register();

    const otelApi = await import("@opentelemetry/api");
    const tracer = provider.getTracer(config.OTEL_SERVICE_NAME);

    tracerInstance = {
      startSpan(name: string, attrs?: Record<string, string | number | boolean>): OtelSpan {
        const span = tracer.startSpan(name);
        if (attrs) {
          for (const [k, v] of Object.entries(attrs)) {
            span.setAttribute(k, v);
          }
        }
        return {
          setAttribute(key: string, value: string | number | boolean) {
            span.setAttribute(key, value);
          },
          setStatus(code: "ok" | "error", message?: string) {
            span.setStatus({
              code: code === "ok" ? otelApi.SpanStatusCode.OK : otelApi.SpanStatusCode.ERROR,
              message,
            });
          },
          end() {
            span.end();
          },
        };
      },
    };
  } catch (err) {
    console.warn("[otel] Failed to initialize OpenTelemetry — tracing disabled:", err);
  }
}
