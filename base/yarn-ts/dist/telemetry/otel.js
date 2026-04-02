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
let tracerInstance = null;
const noopSpan = {
    setAttribute() { },
    setStatus() { },
    end() { },
};
const noopTracer = {
    startSpan() {
        return noopSpan;
    },
};
export function getTracer() {
    return tracerInstance ?? noopTracer;
}
/**
 * Run a synchronous function inside a traced span. The span is ended
 * automatically when the function returns (or throws).
 */
export function withSpan(name, attrs, fn) {
    const span = getTracer().startSpan(name, attrs);
    try {
        const result = fn(span);
        span.setStatus("ok");
        return result;
    }
    catch (err) {
        span.setStatus("error", err instanceof Error ? err.message : "unknown");
        throw err;
    }
    finally {
        span.end();
    }
}
/**
 * Run an async function inside a traced span. The span is ended
 * automatically when the promise resolves or rejects.
 */
export async function withSpanAsync(name, attrs, fn) {
    const span = getTracer().startSpan(name, attrs);
    try {
        const result = await fn(span);
        span.setStatus("ok");
        return result;
    }
    catch (err) {
        span.setStatus("error", err instanceof Error ? err.message : "unknown");
        throw err;
    }
    finally {
        span.end();
    }
}
export async function initOtel(config) {
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
            startSpan(name, attrs) {
                const span = tracer.startSpan(name);
                if (attrs) {
                    for (const [k, v] of Object.entries(attrs)) {
                        span.setAttribute(k, v);
                    }
                }
                return {
                    setAttribute(key, value) {
                        span.setAttribute(key, value);
                    },
                    setStatus(code, message) {
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
    }
    catch (err) {
        console.warn("[otel] Failed to initialize OpenTelemetry — tracing disabled:", err);
    }
}
