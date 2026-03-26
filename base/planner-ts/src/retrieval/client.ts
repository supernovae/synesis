import type { UnifiedResult } from "./types.js";

export interface RetrievalRequest {
  query: string;
  top_k?: number;
}

export interface RetrievalClient {
  retrieve(request: RetrievalRequest): Promise<UnifiedResult[]>;
}

export class NullRetrievalClient implements RetrievalClient {
  async retrieve(_request: RetrievalRequest): Promise<UnifiedResult[]> {
    return [];
  }
}
