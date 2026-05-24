import { normalizeOpenAIStreamFinishReason } from "../tool-collapse/stream-stop-normalizer.js";

export interface PendingOpenAIToolCall {
  index: number;
  id: string;
  name: string;
  args: string;
}

export class OpenAIStreamState {
  private finishReason = "stop";
  private readonly pendingToolCalls: PendingOpenAIToolCall[] = [];
  private readonly pendingTextDeltas: string[] = [];

  appendTextDelta(text: string): void {
    if (text) this.pendingTextDeltas.push(text);
  }

  hasPendingText(): boolean {
    return this.pendingTextDeltas.length > 0;
  }

  drainText(): string {
    const text = this.pendingTextDeltas.join("");
    this.pendingTextDeltas.length = 0;
    return text;
  }

  startToolInput(toolCallId: string, toolName: string): PendingOpenAIToolCall {
    const pending = {
      index: this.pendingToolCalls.length,
      id: toolCallId,
      name: toolName,
      args: "",
    };
    this.pendingToolCalls.push(pending);
    return pending;
  }

  markToolCallFinish(): void {
    this.finishReason = "tool_calls";
  }

  markLengthFinish(): void {
    this.finishReason = "length";
  }

  markError(): void {
    this.finishReason = "error";
  }

  findToolCall(toolCallId: string): PendingOpenAIToolCall | undefined {
    return this.pendingToolCalls.find((pending) => pending.id === toolCallId);
  }

  removeToolCall(toolCallId: string): boolean {
    const idx = this.pendingToolCalls.findIndex((pending) => pending.id === toolCallId);
    if (idx < 0) return false;
    this.pendingToolCalls.splice(idx, 1);
    return true;
  }

  appendToolInputDelta(toolCallId: string, delta: string): boolean {
    const pending = this.findToolCall(toolCallId);
    if (!pending) return false;
    pending.args += delta;
    return true;
  }

  nextToolCallIndex(): number {
    return this.pendingToolCalls.length;
  }

  toolNames(): string[] {
    return this.pendingToolCalls.map((pending) => pending.name);
  }

  rawFinishReason(): string {
    return this.finishReason;
  }

  normalizedFinishReason(emittedToolCalls: number): string {
    this.finishReason = normalizeOpenAIStreamFinishReason(this.finishReason, emittedToolCalls);
    return this.finishReason;
  }
}
