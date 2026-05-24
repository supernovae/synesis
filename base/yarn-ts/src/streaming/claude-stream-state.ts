import { normalizeClaudeStreamStopReason } from "../tool-collapse/stream-stop-normalizer.js";

export interface PendingClaudeToolInput {
  toolName: string;
  toolCallId: string;
  chunks: string[];
}

export class ClaudeStreamState {
  private blockIndex = 0;
  private inTextBlock = false;
  private textBlockOpen = false;
  private stopReason = "end_turn";
  private emittedToolCalls = 0;
  private readonly pendingTextDeltas: string[] = [];
  private readonly toolBuffer = new Map<string, PendingClaudeToolInput>();

  currentBlockIndex(): number {
    return this.blockIndex;
  }

  advanceBlock(): number {
    const index = this.blockIndex;
    this.blockIndex += 1;
    this.inTextBlock = false;
    this.textBlockOpen = false;
    return index;
  }

  markTextBlockOpen(): void {
    this.inTextBlock = true;
    this.textBlockOpen = true;
  }

  isInTextBlock(): boolean {
    return this.inTextBlock;
  }

  isTextBlockOpen(): boolean {
    return this.textBlockOpen;
  }

  closeTextBlock(): number | null {
    if (!this.textBlockOpen) return null;
    return this.advanceBlock();
  }

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

  startToolInput(toolCallId: string, toolName: string): PendingClaudeToolInput {
    const pending = { toolName, toolCallId, chunks: [] };
    this.toolBuffer.set(toolCallId, pending);
    this.stopReason = "tool_use";
    return pending;
  }

  getToolInput(toolCallId: string): PendingClaudeToolInput | undefined {
    return this.toolBuffer.get(toolCallId);
  }

  appendToolInputDelta(toolCallId: string, delta: string): boolean {
    const pending = this.toolBuffer.get(toolCallId);
    if (!pending) return false;
    pending.chunks.push(delta);
    return true;
  }

  removeToolInput(toolCallId: string): boolean {
    return this.toolBuffer.delete(toolCallId);
  }

  pendingToolInputCount(): number {
    return this.toolBuffer.size;
  }

  markToolUse(): void {
    this.stopReason = "tool_use";
  }

  markEndTurn(): void {
    this.stopReason = "end_turn";
  }

  markFinishFromProvider(finishReason: unknown): void {
    if (finishReason === "length") {
      this.stopReason = "max_tokens";
    } else if (finishReason === "stop" && this.toolBuffer.size > 0) {
      this.stopReason = "end_turn";
    }
  }

  recordEmittedToolCall(): number {
    this.emittedToolCalls += 1;
    return this.emittedToolCalls;
  }

  rawStopReason(): string {
    return this.stopReason;
  }

  normalizedStopReason(): string {
    this.stopReason = normalizeClaudeStreamStopReason(this.stopReason, this.emittedToolCalls);
    return this.stopReason;
  }
}
