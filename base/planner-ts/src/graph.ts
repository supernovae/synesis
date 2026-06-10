import type { GraphState } from "./state/types.js";
import type { StreamDelta } from "./llm/client.js";
import {
  criticNode,
  entryPipelineNode,
  finalScrubberNode,
  plannerNode,
  respondNode,
  routerNode,
  writerNode,
  writerNodeStreaming,
} from "./pipeline.js";
import { planGate } from "./nodes/plan-gate.js";

type GraphEnvelope = { data: GraphState };
type GraphNodeName =
  | "entry_pipeline"
  | "planner"
  | "plan_gate"
  | "router"
  | "writer"
  | "critic"
  | "final_scrubber"
  | "respond";

export interface NodeTransitionEvent {
  node: string;
  state: GraphState;
}

export interface GraphLifecycleCallbacks {
  onNodeStart?: (node: GraphNodeName, state: GraphState) => void | Promise<void>;
  onNodeDone?: (node: GraphNodeName, state: GraphState) => void | Promise<void>;
}

function nodeTimeoutMs(): number {
  const raw = Number(process.env.SYNESIS_PLANNER_TS_NODE_TIMEOUT_MS ?? 60000);
  if (!Number.isFinite(raw) || raw <= 0) return 60000;
  return raw;
}

function nodeTimeoutMsFor(nodeName: string): number {
  if (nodeName === "writer") {
    const writerRaw = Number(process.env.SYNESIS_PLANNER_TS_WRITER_NODE_TIMEOUT_MS ?? 180000);
    if (Number.isFinite(writerRaw) && writerRaw > 0) return writerRaw;
  }
  return nodeTimeoutMs();
}

async function runNodeWithTimeout(
  nodeName: string,
  envelope: GraphEnvelope,
  fn: () => Promise<GraphEnvelope>,
): Promise<GraphEnvelope> {
  const timeoutMs = nodeTimeoutMsFor(nodeName);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<GraphEnvelope>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          data: {
            ...envelope.data,
            error: `Node '${nodeName}' timed out after ${timeoutMs}ms`,
            next_node: "respond",
          },
        });
      }, timeoutMs);
    });
    return await Promise.race([fn(), timeoutPromise]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      data: {
        ...envelope.data,
        error: `Node '${nodeName}' failed: ${message}`,
        next_node: "respond",
      },
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const defaultWriter = async (state: GraphEnvelope): Promise<GraphEnvelope> => ({
  data: await writerNode(state.data),
});

async function runGraphNode(
  nodeName: GraphNodeName,
  envelope: GraphEnvelope,
  writerFn: (state: GraphEnvelope) => Promise<GraphEnvelope>,
): Promise<GraphEnvelope> {
  switch (nodeName) {
    case "entry_pipeline":
      return runNodeWithTimeout(nodeName, envelope, async () => ({ data: await entryPipelineNode(envelope.data) }));
    case "planner":
      return runNodeWithTimeout(nodeName, envelope, async () => ({ data: await plannerNode(envelope.data) }));
    case "plan_gate":
      return runNodeWithTimeout(nodeName, envelope, async () => ({ data: planGate(envelope.data) }));
    case "router":
      return runNodeWithTimeout(nodeName, envelope, async () => ({ data: await routerNode(envelope.data) }));
    case "writer":
      return runNodeWithTimeout(nodeName, envelope, async () => writerFn(envelope));
    case "critic":
      return runNodeWithTimeout(nodeName, envelope, async () => ({ data: await criticNode(envelope.data) }));
    case "final_scrubber":
      return runNodeWithTimeout(nodeName, envelope, async () => ({ data: await finalScrubberNode(envelope.data) }));
    case "respond":
      return runNodeWithTimeout(nodeName, envelope, async () => ({ data: await respondNode(envelope.data) }));
  }
}

function nextGraphNode(nodeName: GraphNodeName, state: GraphState): GraphNodeName | null {
  switch (nodeName) {
    case "entry_pipeline":
      if (state.next_node === "writer") return "writer";
      if (state.next_node === "respond") return "respond";
      return "planner";
    case "planner":
      return "plan_gate";
    case "plan_gate":
      if (state.next_node === "respond") return "respond";
      if (state.next_node === "planner") return "planner";
      return "router";
    case "router":
      return state.next_node === "respond" ? "respond" : "writer";
    case "writer":
      if (state.next_node === "respond") return "respond";
      return (state.execution_policy ?? {}).critic_background ? "final_scrubber" : "critic";
    case "critic":
      if (state.next_node === "router") return "router";
      if (state.next_node === "writer") return "writer";
      if (state.next_node === "respond") return "respond";
      return "final_scrubber";
    case "final_scrubber":
      return "respond";
    case "respond":
      return null;
  }
}

async function* executeGraph(
  state: GraphState,
  writerFn: (state: GraphEnvelope) => Promise<GraphEnvelope>,
  callbacks: GraphLifecycleCallbacks = {},
): AsyncGenerator<NodeTransitionEvent> {
  let nodeName: GraphNodeName | null = "entry_pipeline";
  let envelope: GraphEnvelope = { data: state };
  const maxSteps = 64;

  for (let step = 0; nodeName && step < maxSteps; step += 1) {
    await callbacks.onNodeStart?.(nodeName, envelope.data);
    envelope = await runGraphNode(nodeName, envelope, writerFn);
    await callbacks.onNodeDone?.(nodeName, envelope.data);
    yield { node: nodeName, state: envelope.data };
    nodeName = nextGraphNode(nodeName, envelope.data);
  }

  if (nodeName) {
    yield {
      node: "respond",
      state: {
        ...envelope.data,
        error: `Planner graph exceeded ${maxSteps} node transitions`,
        next_node: "respond",
      },
    };
  }
}

export async function invokeGraph(state: GraphState): Promise<GraphState> {
  let lastState = state;
  for await (const event of executeGraph(state, defaultWriter)) {
    lastState = event.state;
  }
  return lastState;
}

/**
 * Stream the graph execution, yielding a NodeTransitionEvent after each node
 * completes. When the writer node runs, token deltas are forwarded via
 * `onWriterDelta` so the caller can SSE-stream them to the client.
 */
export async function* streamGraph(
  state: GraphState,
  onWriterDelta: (delta: StreamDelta) => void,
  callbacks: GraphLifecycleCallbacks = {},
): AsyncGenerator<NodeTransitionEvent> {
  const streamingWriter = async (envelope: GraphEnvelope): Promise<GraphEnvelope> => ({
    data: await writerNodeStreaming(envelope.data, onWriterDelta),
  });

  let lastState = state;
  for await (const event of executeGraph(state, streamingWriter, callbacks)) {
    lastState = event.state;
    yield event;
  }

  if (!lastState.next_node || lastState.next_node !== "respond") {
    process.stderr.write(JSON.stringify({
      level: 40,
      msg: "streamGraph: forcing synthetic respond terminal; next_node was not respond",
      next_node: lastState.next_node ?? null,
      time: Date.now(),
    }) + "\n");
    yield {
      node: "respond",
      state: { ...lastState, next_node: "respond" },
    };
  }
}
