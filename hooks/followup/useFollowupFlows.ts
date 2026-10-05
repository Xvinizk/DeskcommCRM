"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import type { FlowDeletionSummary } from "@/lib/followup/delete";

export type FollowupFlowStatus = "draft" | "active" | "disabled";

export interface FollowupFlowPointerRow {
  id: string;
  name: string;
  status: FollowupFlowStatus;
  active_version_id: string | null;
  handoff_policy: string;
  updated_at: string;
  archived_at?: string | null;
}

interface ListResponse {
  data: FollowupFlowPointerRow[];
}

interface SingleResponse {
  data: FollowupFlowPointerRow;
}

interface SummaryResponse {
  data: FlowDeletionSummary;
}

export const followupFlowsListQueryKey = ["followup", "flows", "list"] as const;

export function useFollowupFlows(opts?: { initialData?: FollowupFlowPointerRow[] }) {
  return useQuery({
    queryKey: followupFlowsListQueryKey,
    queryFn: async () => {
      try {
        const res = await apiClient.get<ListResponse>("/api/v1/ai/followup-flows");
        return res.data;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    initialData: opts?.initialData,
  });
}

export function useCreateFollowupFlow() {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["followup", "flows", "create"],
    mutationFn: async (name: string) => {
      const res = await apiClient.post<SingleResponse>("/api/v1/ai/followup-flows", { name });
      return res.data;
    },
    onSuccess: (created) => {
      qc.setQueryData<FollowupFlowPointerRow[]>(followupFlowsListQueryKey, (prev) =>
        prev ? [created, ...prev] : [created],
      );
      toast.success(t("Fluxo criado."));
    },
    onError: (err) => {
      showApiError(err);
    },
  });
}

export function useArchiveFollowupFlow() {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["followup", "flows", "archive"],
    mutationFn: async (id: string) => {
      const res = await apiClient.post<SingleResponse>(`/api/v1/ai/followup-flows/${id}/archive`, {});
      return res.data;
    },
    onSuccess: (updated) => {
      qc.setQueryData<FollowupFlowPointerRow[]>(followupFlowsListQueryKey, (prev) =>
        prev ? prev.map((f) => (f.id === updated.id ? { ...f, ...updated } : f)) : [updated],
      );
      toast.success(t("Fluxo arquivado."));
    },
    onError: (err) => {
      showApiError(err);
    },
  });
}

export function useRestoreFollowupFlow() {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["followup", "flows", "restore"],
    mutationFn: async (id: string) => {
      const res = await apiClient.post<SingleResponse>(`/api/v1/ai/followup-flows/${id}/restore`, {});
      return res.data;
    },
    onSuccess: (updated) => {
      qc.setQueryData<FollowupFlowPointerRow[]>(followupFlowsListQueryKey, (prev) =>
        prev ? prev.map((f) => (f.id === updated.id ? { ...f, ...updated } : f)) : [updated],
      );
      toast.success(t("Fluxo restaurado."));
    },
    onError: (err) => {
      showApiError(err);
    },
  });
}

export function useDuplicateFollowupFlow() {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["followup", "flows", "duplicate"],
    mutationFn: async (id: string) => {
      const res = await apiClient.post<SingleResponse>(`/api/v1/ai/followup-flows/${id}/duplicate`, {});
      return res.data;
    },
    onSuccess: (created) => {
      qc.setQueryData<FollowupFlowPointerRow[]>(followupFlowsListQueryKey, (prev) =>
        prev ? [created, ...prev] : [created],
      );
      toast.success(t("Fluxo duplicado com sucesso."));
    },
    onError: (err) => {
      showApiError(err);
    },
  });
}

export function usePermanentDeleteFollowupFlow() {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["followup", "flows", "permanent-delete"],
    mutationFn: async ({ id, confirmationName }: { id: string; confirmationName: string }) => {
      const res = await apiClient.delete<{ data: { id: string } }>(
        `/api/v1/ai/followup-flows/${id}/permanent`,
        { confirmation_name: confirmationName },
      );
      return res.data;
    },
    onSuccess: (deleted) => {
      qc.setQueryData<FollowupFlowPointerRow[]>(followupFlowsListQueryKey, (prev) =>
        prev ? prev.filter((f) => f.id !== deleted.id) : [],
      );
      toast.success(t("Fluxo excluído permanentemente."));
    },
    onError: (err) => {
      showApiError(err);
    },
  });
}

export function useFollowupFlowDeletionSummary(id: string, enabled = true) {
  return useQuery({
    queryKey: ["followup", "flows", "deletion-summary", id],
    queryFn: async () => {
      const res = await apiClient.get<SummaryResponse>(
        `/api/v1/ai/followup-flows/${id}/deletion-summary`,
      );
      return res.data;
    },
    enabled: Boolean(id) && enabled,
  });
}
