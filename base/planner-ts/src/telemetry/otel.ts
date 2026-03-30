import type { AppConfig } from "../config.js";

let tracerInstance: OtelTracer | null = null;

export interface OtelTracer {
  startSpan(name: string, attrs?: Record<string, string | number | boolean>): OtelSpan;
}

export interface OtelSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(code: "ok" | "error", message?: string): void;
  traceparent(): string | undefined;
  end(): void;
}

const noopSpan: OtelSpan = {
  setAttribute() {},
  setStatus() {},
  traceparent() { return undefined; },
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
  if (!config.SYNESIS_PLANNER_TS_OTEL_ENABLED || !config.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return;
  }

  try {
    const { NodeTracerProvider } = await import("@opentelemetry/sdk-trace-node");
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    const { BatchSpanProcessor } = await import("@opentelemetry/sdk-trace-base");
    const { Resource } = await import("@opentelemetry/resources");
    const { ATTR_SERVICE_NAME } = await import("@opentelemetry/semantic-conventions");
    const otelApi = await import("@opentelemetry/api");

    const resource = new Resource({
      [ATTR_SERVICE_NAME]: config.OTEL_SERVICE_NAME,
    });
    const exporter = new OTLPTraceExporter({
      url: config.OTEL_EXPORTER_OTLP_ENDPOINT,
    });

    const provider = new NodeTracerProvider({ resource });
    provider.addSpanProcessor(new BatchSpanProcessor(exporter));
    provider.register();

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
          traceparent() {
            const ctx = span.spanContext();
            if (!ctx?.traceId || !ctx?.spanId) return undefined;
            const flags = Number(ctx.traceFlags ?? 0).toString(16).padStart(2, "0");
            return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
          },
          end() {
            span.end();
          },
        };
      },
    };
  } catch (err) {
    console.warn("[otel] planner-ts OpenTelemetry init failed; tracing disabled", err);
  }
}
