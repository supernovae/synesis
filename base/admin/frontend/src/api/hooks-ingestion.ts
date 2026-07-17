import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import client from "./client";
import type {
  IngestionSource,
  IngestionItem,
  IngestionRun,
  IngestionStats,
  StagedIngestionDocument,
} from "../types";

type GetConfig = Parameters<typeof client.get>[1];
type WriteConfig = Parameters<typeof client.post>[2];

function unwrap<T>(request: Promise<{ data: T }>): Promise<T> {
  return request.then((r) => r.data);
}

function apiGet<T>(url: string, config?: GetConfig) {
  return unwrap(client.get<T>(url, config));
}

function apiPost<T>(url: string, data?: unknown, config?: WriteConfig) {
  return unwrap(client.post<T>(url, data, config));
}

function apiPatch<T>(url: string, data?: unknown, config?: WriteConfig) {
  return unwrap(client.patch<T>(url, data, config));
}

function apiDelete<T>(url: string, config?: GetConfig) {
  return unwrap(client.delete<T>(url, config));
}
// --- Ingestion Queue ---

export function useIngestionStats() {
  return useQuery<IngestionStats>({
    queryKey: ["ingestion", "stats"],
    queryFn: () => apiGet("/ingestion/stats"),
    refetchInterval: 10_000,
  });
}

export interface HandlerMetadata {
  handler_type: string;
  label: string;
  source_type: string;
  uri_pattern: string;
  uri_hint: string;
  config_hints: Record<string, unknown>;
  artifact_kind: string;
}

export function useIngestionHandlers() {
  return useQuery<{ handlers: HandlerMetadata[] }>({
    queryKey: ["ingestion", "handlers"],
    queryFn: () => apiGet("/ingestion/handlers"),
    staleTime: 5 * 60_000,
  });
}

export interface SchemaSyncEntry {
  collection: string;
  schema_version: number;
  expected_version: number;
  upgrade_pending: boolean;
  last_reset_at: string | null;
  last_reported_by: string | null;
  updated_at: string | null;
}

export interface SchemaSyncResponse {
  expected_version: number;
  upgrade_pending: boolean;
  syncs: SchemaSyncEntry[];
}

export function useSchemaSync() {
  return useQuery<SchemaSyncResponse>({
    queryKey: ["ingestion", "schema-sync"],
    queryFn: () => apiGet("/ingestion/schema-sync"),
    refetchInterval: 30_000,
  });
}

export function useResetContentGraphCatalog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { confirm: string; reset_queue?: boolean }) =>
      apiPost("/ingestion/graph/reset-catalog", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion"] });
      qc.invalidateQueries({ queryKey: ["rag"] });
    },
  });
}

export function useIngestionSources() {
  return useQuery<{ sources: IngestionSource[] }>({
    queryKey: ["ingestion", "sources"],
    queryFn: () => apiGet("/ingestion/sources"),
    refetchInterval: 30_000,
  });
}

export function useCreateIngestionSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string;
      handler: string;
      domain?: string | undefined;
      authority?: string | undefined;
      origin_type?: string | undefined;
      config?: Record<string, unknown>;
      tags?: string[] | undefined;
      visibility_scope?: string;
      org_id?: string | undefined;
      tenant_id?: string | undefined;
      acl_mode?: string;
      acl_groups?: string | undefined;
    }) => apiPost("/ingestion/sources", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion"] });
    },
  });
}

export function useIngestionItems(params?: {
  status?: string | undefined;
  handler?: string | undefined;
  domain?: string | undefined;
  source_id?: number;
  page?: number;
  page_size?: number;
}) {
  return useQuery<{ items: IngestionItem[]; total: number; page: number; page_size: number }>({
    queryKey: ["ingestion", "items", params],
    queryFn: () => apiGet("/ingestion/items", { params }),
    refetchInterval: 15_000,
  });
}

export function useAddIngestionItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      uri: string;
      handler?: string | undefined;
      title?: string;
      domain?: string | undefined;
      authority?: string;
      origin_type?: string;
      tags?: string[] | undefined;
      priority?: number;
      config?: Record<string, unknown>;
    }) => apiPost("/ingestion/items", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion"] });
    },
  });
}

export function useAddIngestionItemsBulk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      items: Array<{
        uri: string;
        handler?: string;
        title?: string;
        domain?: string;
        authority?: string;
        tags?: string[];
        priority?: number;
        config?: Record<string, unknown>;
      }>;
    }) => apiPost("/ingestion/items/bulk", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion"] });
    },
  });
}

export function useDeleteIngestionItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiDelete(`/ingestion/items/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion"] });
    },
  });
}

export function useRetryIngestionItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiPost(`/ingestion/items/${id}/retry`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion"] });
    },
  });
}

export function usePatchIngestionItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      itemId: number;
      title?: string;
      handler?: string | undefined;
      domain?: string | undefined;
      authority?: string;
      origin_type?: string;
      tags?: string[] | undefined;
      priority?: number;
      config?: Record<string, unknown>;
      source_id?: number;
      status?: string | undefined;
    }) => {
      const { itemId, ...body } = data;
      return apiPatch(`/ingestion/items/${itemId}`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion"] });
    },
  });
}

export function useRequeueIngestionItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { itemId: number; reset_retries?: boolean }) =>
      apiPost(`/ingestion/items/${data.itemId}/requeue?reset_retries=${data.reset_retries ?? false}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion"] });
    },
  });
}

export interface DiscoveryResult {
  url: string;
  handler: string;
  title: string;
  domain: string;
  tags: string[];
  config: Record<string, unknown>;
  risk_flags: string[];
  recommended_mode: "active" | "batch";
  notes: string;
  deterministic?: boolean;
  recommendation_reasons?: string[];
  suggested_corpus_class?: string;
  required_missing_fields?: string[];
}

export interface BootstrapValidationItem {
  index: number;
  uri: string;
  handler: string | null;
  title: string;
  domain: string;
  tags: string[] | null;
  synesis_meta: Record<string, unknown>;
  errors: string[];
  warnings: string[];
}

export interface BootstrapValidationResult {
  ok: boolean;
  error?: string;
  total_items: number;
  total_errors: number;
  total_warnings: number;
  items: BootstrapValidationItem[];
}

export interface MetadataGuide {
  corpus_class: string[];
  constraint_kind: string[];
  authority: string[];
  origin_type: string[];
  visibility_scope: string[];
  acl_mode: string[];
  artifact_kind_examples: string[];
  content_profile_examples: string[];
}

export function useBatchPreflight() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { status_filter?: string; limit?: number; use_llm?: boolean; dry_run?: boolean }) =>
      apiPost<{ processed: number; flagged: number; errors: number; previews?: DiscoveryResult[] }>("/ingestion/discover/batch", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion"] });
    },
  });
}

export function useDiscoverUrl() {
  return useMutation({
    mutationFn: (data: { url: string; hints?: string; use_llm?: boolean; model_id?: string }) =>
      apiPost<DiscoveryResult>("/ingestion/discover", data),
  });
}

export function useDiscoverPreview() {
  return useMutation({
    mutationFn: (data: { url: string; hints?: string }) =>
      apiPost<DiscoveryResult>("/ingestion/discover/preview", data),
  });
}

export function useBootstrapValidate() {
  return useMutation({
    mutationFn: (data: { file: File }) => {
      const form = new FormData();
      form.append("file", data.file);
      return apiPost<BootstrapValidationResult>("/ingestion/bootstrap/validate", form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
    },
  });
}

export function useMetadataGuide() {
  return useQuery<MetadataGuide>({
    queryKey: ["ingestion", "metadata-guide"],
    queryFn: () => apiGet("/ingestion/bootstrap/metadata-guide"),
    staleTime: 10 * 60_000,
  });
}

export function useRerunStagedItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { itemId: number; phase: "all" | "fetch" | "normalize" | "enrich"; reset_retries?: boolean }) =>
      apiPost(`/ingestion/staged/items/${data.itemId}/rerun`, {
          phase: data.phase,
          reset_retries: data.reset_retries ?? true,
        }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion"] });
    },
  });
}

export function useRecoverStaleIngestionLeases() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { stale_minutes: number }) =>
      apiPost("/ingestion/staged/leases/recover", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion"] });
    },
  });
}

export function useStagedItemDocuments(itemId: number | null) {
  return useQuery<{ documents: StagedIngestionDocument[] }>({
    queryKey: ["ingestion", "staged-documents", itemId],
    queryFn: () => apiGet(`/ingestion/staged/items/${itemId}/documents`),
    enabled: typeof itemId === "number" && itemId > 0,
    refetchInterval: 15_000,
  });
}

export function useEditStagedDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      documentId: number;
      title?: string;
      domain?: string;
      authority?: string;
      origin_type?: string;
      tags?: string[];
      config_snapshot?: Record<string, unknown>;
    }) =>
      apiPatch(`/ingestion/staged/documents/${data.documentId}`, {
          title: data.title,
          domain: data.domain,
          authority: data.authority,
          origin_type: data.origin_type,
          tags: data.tags,
          config_snapshot: data.config_snapshot,
        }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion"] });
      qc.invalidateQueries({ queryKey: ["ingestion", "staged-documents"] });
    },
  });
}

export function useIngestionRuns() {
  return useQuery<{ runs: IngestionRun[] }>({
    queryKey: ["ingestion", "runs"],
    queryFn: () => apiGet("/ingestion/runs"),
    refetchInterval: 15_000,
  });
}

export function useDeleteIngestionRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: number) => apiDelete(`/ingestion/runs/${runId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion", "runs"] });
    },
  });
}

export function usePurgeIngestionRuns() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { status?: string | undefined; keep_latest?: number }) =>
      apiDelete("/ingestion/runs", {
          params: {
            status: data.status || undefined,
            keep_latest: data.keep_latest ?? 0,
          },
        }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion", "runs"] });
    },
  });
}

export function useBootstrapIngestion() {
  const qc = useQueryClient();
  return useMutation<{ added?: number; skipped?: number }, Error, { file: File; status_override?: string }>({
    mutationFn: (data: { file: File; status_override?: string }) => {
      const form = new FormData();
      form.append("file", data.file);
      const params = data.status_override ? `?status_override=${data.status_override}` : "";
      return apiPost(`/ingestion/bootstrap${params}`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion"] });
    },
  });
}
