"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type {
  CreateScheduledMessageInput,
  PatchScheduledMessageInput,
  ScheduledMessageRow,
} from "@/lib/schemas/scheduled-messages";

export function useScheduledMessages(conversationId: string | null) {
  return useQuery({
    queryKey: ["scheduled_messages", conversationId],
    queryFn: async () => {
      if (!conversationId) return [];
      const res = await apiClient.get<{ data: ScheduledMessageRow[] }>(
        `/api/v1/conversations/${conversationId}/scheduled-messages`
      );
      return res.data ?? [];
    },
    enabled: Boolean(conversationId),
    refetchInterval: 30_000,
  });
}

export function useCreateScheduledMessage() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({
      conversationId,
      data,
    }: {
      conversationId: string;
      data: CreateScheduledMessageInput;
    }) => {
      const res = await apiClient.post<{ data: ScheduledMessageRow }>(
        `/api/v1/conversations/${conversationId}/scheduled-messages`,
        data
      );
      return res.data;
    },
    onSuccess: (_res, args) => {
      qc.invalidateQueries({ queryKey: ["scheduled_messages", args.conversationId] });
    },
    onError: showApiError,
  });
}

export function useUpdateScheduledMessage() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({
      conversationId,
      messageId,
      data,
    }: {
      conversationId: string;
      messageId: string;
      data: PatchScheduledMessageInput;
    }) => {
      const res = await apiClient.patch<{ data: ScheduledMessageRow }>(
        `/api/v1/conversations/${conversationId}/scheduled-messages/${messageId}`,
        data
      );
      return res.data;
    },
    onSuccess: (_res, args) => {
      qc.invalidateQueries({ queryKey: ["scheduled_messages", args.conversationId] });
    },
    onError: showApiError,
  });
}

export function useCancelScheduledMessage() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({
      conversationId,
      messageId,
    }: {
      conversationId: string;
      messageId: string;
    }) => {
      const res = await apiClient.delete<{ data: ScheduledMessageRow }>(
        `/api/v1/conversations/${conversationId}/scheduled-messages/${messageId}`
      );
      return res.data;
    },
    onSuccess: (_res, args) => {
      qc.invalidateQueries({ queryKey: ["scheduled_messages", args.conversationId] });
    },
    onError: showApiError,
  });
}
