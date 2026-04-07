import { describe, expect, it } from "vitest";
import { TranscriptPruningService } from "../src/reduction/transcript-pruning.js";
import { buildRequestForensics } from "../src/telemetry/request-forensics.js";

function mkTurn(round: number): Array<{ role: string; content: string }> {
  return [
    { role: "assistant", content: `round ${round} analysis\n` + "detail ".repeat(80) },
    { role: "tool", content: `FAIL pkg/a line ${round}\n` + "stack ".repeat(120) },
  ];
}

function simulate(rounds: number, pruning: boolean): { cumulativeChars: number; finalChars: number } {
  const pruner = new TranscriptPruningService({
    enabled: pruning,
    keepTurns: 5,
    keepToolResults: 8,
    budgetChars: 4000,
    stubMaxChars: 120,
    assistantCondenseChars: 180,
  });
  const history: Array<{ role: string; content: unknown }> = [
    { role: "system", content: "You are Synesis Yarn." },
    { role: "user", content: "Build and test this project." },
  ];
  let cumulativeChars = 0;
  let prev: { requestId: string; serialized: string } | undefined;
  let finalChars = 0;

  for (let i = 0; i < rounds; i++) {
    history.push(...mkTurn(i));
    const pruned = pruner.prune(history as never).messages as Array<{ role: string; content: unknown }>;
    const request = buildRequestForensics({
      providerModel: "synesis-core",
      path: "/v1/chat/completions",
      requestId: `r${i}`,
      stream: false,
      messages: pruned as never,
      tools: [{ type: "function", function: { name: "Bash", parameters: { type: "object" } } }],
      toolChoice: "auto",
      providerOptions: {},
      previous: prev,
      capturePayload: false,
      maxPreviewChars: 0,
    });
    cumulativeChars += request.record.breakdown.totalChars;
    finalChars = request.record.breakdown.totalChars;
    prev = { requestId: `r${i}`, serialized: request.serialized };
  }

  return { cumulativeChars, finalChars };
}

describe("scripted request growth harness", () => {
  it("shows reduced growth at 10/20/40/80 rounds with pruning enabled", () => {
    const un10 = simulate(10, false);
    const un20 = simulate(20, false);
    const un40 = simulate(40, false);
    const un80 = simulate(80, false);
    const pr10 = simulate(10, true);
    const pr20 = simulate(20, true);
    const pr40 = simulate(40, true);
    const pr80 = simulate(80, true);

    // Unpruned cumulative cost should approach quadratic scaling.
    expect(un80.cumulativeChars / un40.cumulativeChars).toBeGreaterThan(1.8);

    // Pruned cumulative growth should be flatter than unpruned growth.
    expect(pr80.cumulativeChars / pr40.cumulativeChars).toBeLessThan(
      un80.cumulativeChars / un40.cumulativeChars,
    );

    // Pruned final request should be much smaller at larger horizons.
    expect(pr80.finalChars).toBeLessThan(un80.finalChars * 0.55);

    // Improvement should persist across checkpoints.
    expect(pr20.cumulativeChars).toBeLessThan(un20.cumulativeChars * 0.9);
    expect(pr40.cumulativeChars).toBeLessThan(un40.cumulativeChars * 0.85);
  });
});

