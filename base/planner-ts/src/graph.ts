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

function buildGraph(writerFn: (state: GraphEnvelope) => Promise<GraphEnvelope>) {
  return new StateGraph(EnvelopeAnnotation)
    .addNode("entry_pipeline", async (state: GraphEnvelope) => ({ data: await entryPipelineNode(state.data) }))
    .addNode("planner", async (state: GraphEnvelope) => ({ data: await plannerNode(state.data) }))
    .addNode("plan_gate", async (state: GraphEnvelope) => ({ data: planGate(state.data) }))
    .addNode("router", async (state: GraphEnvelope) => ({ data: await routerNode(state.data) }))
    .addNode("writer", writerFn)
    .addNode("critic", async (state: GraphEnvelope) => ({ data: await criticNode(state.data) }))
    .addNode("final_scrubber", async (state: GraphEnvelope) => ({ data: await finalScrubberNode(state.data) }))
    .addNode("respond", async (state: GraphEnvelope) => ({ data: await respondNode(state.data) }))
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
    yield { node: "respond", state: lastState };
  }
}
