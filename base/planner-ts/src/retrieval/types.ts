export interface UnifiedResult {
  retrieval_source: "rag" | "web";
  source_url: string;
  source_id?: string;
  title: string;
  text: string;
  score: number;
  authority?: string;
  origin_type?: string;
  heading_path?: string;
  document_name?: string;
}
