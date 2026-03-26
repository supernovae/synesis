import type { GraphState } from "./state/types.js";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import {
  criticNode,
  entryPipelineNode,
  finalScrubberNode,
  plannerNode,
  respondNode,
  routerNode,
  writerNode
} from "./pipeline.js";
import { planGate } from "./nodes/plan-gate.js";

type GraphEnvelope = { data: GraphState };

const EnvelopeAnnotation = Annotation.Root({
  data: Annotation<GraphState>({
    reducer: (_left: GraphState, right: GraphState) => right,
    default: () => ({})
  })
});

const compiledGraph = new StateGraph(EnvelopeAnnotation)
  .addNode("entry_pipeline", async (state: GraphEnvelope) => ({ data: await entryPipelineNode(state.data) }))
  .addNode("planner", async (state: GraphEnvelope) => ({ data: await plannerNode(state.data) }))
  .addNode("plan_gate", async (state: GraphEnvelope) => ({ data: planGate(state.data) }))
  .addNode("router", async (state: GraphEnvelope) => ({ data: await routerNode(state.data) }))
  .addNode("writer", async (state: GraphEnvelope) => ({ data: await writerNode(state.data) }))
  .addNode("critic", async (state: GraphEnvelope) => ({ data: await criticNode(state.data) }))
  .addNode("final_scrubber", async (state: GraphEnvelope) => ({ data: await finalScrubberNode(state.data) }))
  .addNode("respond", async (state: GraphEnvelope) => ({ data: await respondNode(state.data) }))
  .addEdge(START, "entry_pipeline")
  .addEdge("entry_pipeline", "planner")
  .addEdge("planner", "plan_gate")
  .addConditionalEdges(
    "plan_gate",
    (state: GraphEnvelope) => (state.data.next_node === "respond" ? "respond" : "router"),
    {
      respond: "respond",
      router: "router"
    }
  )
  .addEdge("router", "writer")
  .addConditionalEdges(
    "writer",
    (state: GraphEnvelope) => (state.data.next_node === "respond" ? "respond" : "critic"),
    {
      respond: "respond",
      critic: "critic"
    }
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
    {
      router: "router",
      writer: "writer",
      final_scrubber: "final_scrubber",
      respond: "respond"
    }
  )
  .addEdge("final_scrubber", "respond")
  .addEdge("respond", END)
  .compile();

export async function invokeGraph(state: GraphState): Promise<GraphState> {
  const result = await compiledGraph.invoke({ data: state });
  return (result as GraphEnvelope).data ?? state;
}
