import {
  openAIDoneLine,
  openAIFinalChunk,
  openAIReasoningDeltaChunk,
  openAITextDeltaChunk,
  openAIToolCallDeltaChunk,
  type OpenAIChunkBase,
  type OpenAIToolCallDelta,
} from "./openai-sse-writer.js";

export interface OpenAIStreamResponseWriterOptions {
  raw: NodeJS.WritableStream & { destroyed?: boolean };
  requestId: string;
  model: string;
  write?: (raw: NodeJS.WritableStream & { destroyed?: boolean }, data: string) => boolean;
}

export class OpenAIStreamResponseWriter {
  constructor(private readonly options: OpenAIStreamResponseWriterOptions) {}

  chunkBase(created = Math.floor(Date.now() / 1000)): OpenAIChunkBase {
    return {
      id: this.options.requestId,
      created,
      model: this.options.model,
    };
  }

  writeTextDelta(text: string): boolean {
    if (!text) return false;
    return this.write(openAITextDeltaChunk(this.chunkBase(), text));
  }

  writeReasoningDelta(text: string): boolean {
    if (!text) return false;
    return this.write(openAIReasoningDeltaChunk(this.chunkBase(), text));
  }

  writeToolCallDelta(toolCall: OpenAIToolCallDelta, created?: number): boolean {
    return this.write(openAIToolCallDeltaChunk(this.chunkBase(created), toolCall));
  }

  writeFinalChunk(finishReason: string, usage?: unknown): boolean {
    return this.write(openAIFinalChunk(this.chunkBase(), finishReason, usage));
  }

  writeDoneLine(): boolean {
    return this.write(openAIDoneLine());
  }

  private write(data: string): boolean {
    if (this.options.write) {
      return this.options.write(this.options.raw, data);
    }
    try {
      if (this.options.raw.destroyed) return false;
      this.options.raw.write(data);
      return true;
    } catch {
      return false;
    }
  }
}
