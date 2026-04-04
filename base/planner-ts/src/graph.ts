/**
 * LangGraph topology: START → entry_pipeline → planner|writer|respond → … → respond → END.
 * All branches must reach `respond` (timeouts and errors set next_node respond). Streaming uses
 * streamGraph(), which yields a synthetic respond if the compiled run stops with next_node !== respond.
 */
import type { GraphState } from "./state/types.js";
import type { StreamDelta } from "./llm/client.js";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
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

export interface NodeTransitionEvent {
  node: string;
  state: GraphState;
}

const EnvelopeAnnotation = Annotation.Root({
  data: Annotation<GraphState>({
    reducer: (_left: GraphState, right: GraphState) => right,
    default: () => ({})
  })
});

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

function buildGraph(writerFn: (state: GraphEnvelope) => Promise<GraphEnvelope>) {
  return new StateGraph(EnvelopeAnnotation)
    .addNode("entry_pipeline", async (state: GraphEnvelope) => runNodeWithTimeout(
      "entry_pipeline",
      state,
      async () => ({ data: await entryPipelineNode(state.data) }),
    ))
    .addNode("planner", async (state: GraphEnvelope) => runNodeWithTimeout(
      "planner",
      state,
      async () => ({ data: await plannerNode(state.data) }),
    ))
    .addNode("plan_gate", async (state: GraphEnvelope) => runNodeWithTimeout(
      "plan_gate",
      state,
      async () => ({ data: planGate(state.data) }),
    ))
    .addNode("router", async (state: GraphEnvelope) => runNodeWithTimeout(
      "router",
      state,
      async () => ({ data: await routerNode(state.data) }),
    ))
    .addNode("writer", async (state: GraphEnvelope) => runNodeWithTimeout("writer", state, async () => writerFn(state)))
    .addNode("critic", async (state: GraphEnvelope) => runNodeWithTimeout(
      "critic",
      state,
      async () => ({ data: await criticNode(state.data) }),
    ))
    .addNode("final_scrubber", async (state: GraphEnvelope) => runNodeWithTimeout(
      "final_scrubber",
      state,
      async () => ({ data: await finalScrubberNode(state.data) }),
    ))
    .addNode("respond", async (state: GraphEnvelope) => runNodeWithTimeout(
      "respond",
      state,
      async () => ({ data: await respondNode(state.data) }),
    ))
    .addEdge(START, "entry_pipeline")
    .addConditionalEdges(
      "entry_pipeline",
      (state: GraphEnvelope) => {
        const next = state.data.next_node;
        if (next === "writer") return "writer";
        if (next === "respond") return "respond";
        return "planner";
      },
      { planner: "planner", writer: "writer", respond: "respond" }
    )
    .addEdge("planner", "plan_gate")
    .addConditionalEdges(
      "plan_gate",
      (state: GraphEnvelope) => (state.data.next_node === "respond" ? "respond" : "router"),
      { respond: "respond", router: "router" }
    )
    .addEdge("router", "writer")
    .addConditionalEdges(
      "writer",
      (state: GraphEnvelope) => {
        if (state.data.next_node === "respond") return "respond";
        const background = Boolean((state.data.execution_policy ?? {}).critic_background);
        return background ? "final_scrubber" : "critic";
      },
      { respond: "respond", critic: "critic", final_scrubber: "final_scrubber" }
    )
    .addConditionalEdges(
      "critic",
      (state: GraphEnvelope) => {
        const next = state.data.next_node;
        if (next === "router") return "router";
        if (next === "writer") return "writer";
        if (next === "respond") return "respond";
        return "final_scrubber";
      },
      { router: "router", writer: "writer", final_scrubber: "final_scrubber", respond: "respond" }
    )
    .addEdge("final_scrubber", "respond")
    .addEdge("respond", END)
    .compile();
}

const defaultWriter = async (state: GraphEnvelope): Promise<GraphEnvelope> => ({
  data: await writerNode(state.data),
});

const compiledGraph = buildGraph(defaultWriter);

export async function invokeGraph(state: GraphState): Promise<GraphState> {
  const result = await compiledGraph.invoke({ data: state });
  return (result as GraphEnvelope).data ?? state;
}

/**
 * Stream the graph execution, yielding a NodeTransitionEvent after each node
 * completes. When the writer node runs, token deltas are forwarded via
 * `onWriterDelta` so the caller can SSE-stream them to the client.
 *
 * Uses LangGraph's `.stream({ streamMode: "updates" })` which yields
 * `{ [nodeName]: envelopeState }` on each node completion.
 */
export async function* streamGraph(
  state: GraphState,
  onWriterDelta: (delta: StreamDelta) => void,
): AsyncGenerator<NodeTransitionEvent> {
  const streamingWriter = async (envelope: GraphEnvelope): Promise<GraphEnvelope> => ({
    data: await writerNodeStreaming(envelope.data, onWriterDelta),
  });

  const graph = buildGraph(streamingWriter);

  const stream = await graph.stream(
    { data: state },
    { streamMode: "updates" },
  );

  let lastState = state;

  for await (const chunk of stream) {
    const record = chunk as Record<string, unknown>;
    for (const [nodeName, value] of Object.entries(record)) {
      const envelope = value as GraphEnvelope;
      if (envelope?.data) {
        lastState = envelope.data;
        yield { node: nodeName, state: lastState };
      }
    }
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
