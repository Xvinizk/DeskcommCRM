import { describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  mutateEntityTags: vi.fn(),
  moveLeadHandler: vi.fn(),
}));

vi.mock("@/lib/tags/mutate-tags", () => ({
  mutateEntityTags: (...args: unknown[]) => spies.mutateEntityTags(...args),
}));

vi.mock("@/app/api/v1/leads/_handler", () => ({
  moveLeadHandler: (...args: unknown[]) => spies.moveLeadHandler(...args),
}));

import {
  aplicarTagsFollowupCanonica,
  moverEtapaFollowupCanonica,
} from "@/lib/followup/persistir-resposta";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";
import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";

describe("Follow-up Canonical Domain Pipelines", () => {
  const fakeAdmin = {
    from: vi.fn(),
  } as unknown as SupabaseClient;

  it("aplicarTagsFollowupCanonica delega para mutateEntityTags preservando tenant, causalidade e requestId", async () => {
    spies.mutateEntityTags.mockReset();
    spies.mutateEntityTags.mockResolvedValueOnce({
      targetTable: "crm_leads",
      targetId: "lead-1",
      previousTags: [],
      newTags: ["vip"],
      addedTags: ["vip"],
      removedTags: [],
    });

    await aplicarTagsFollowupCanonica(fakeAdmin, {
      organization_id: "org-1",
      contact_id: "contact-1",
      action: "add",
      tags: ["vip"],
      enrollment_id: "enr-123",
      node_id: "node-tag-1",
    });

    expect(spies.mutateEntityTags).toHaveBeenCalledTimes(1);
    expect(spies.mutateEntityTags).toHaveBeenCalledWith(fakeAdmin, {
      organizationId: "org-1",
      contactId: "contact-1",
      action: "add",
      tags: ["vip"],
      causedByEnrollment: "enr-123",
      requestId: "flow:enr-123:node-tag-1",
    });
  });

  it("moverEtapaFollowupCanonica delega para moveLeadHandler preservando tenant, timeline e regras", async () => {
    spies.moveLeadHandler.mockReset();
    spies.moveLeadHandler.mockResolvedValueOnce({ id: "lead-1", stage_id: "stage-2" });

    const selectMock = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: { id: "lead-1", pipeline_id: "pipe-1", stage_id: "stage-1" },
                error: null,
              }),
            }),
          }),
        }),
      }),
    });

    const admin = {
      from: vi.fn().mockReturnValue({
        select: selectMock,
      }),
    } as unknown as SupabaseClient;

    await moverEtapaFollowupCanonica(admin, {
      organization_id: "org-1",
      contact_id: "contact-1",
      stage_id: "stage-2",
      enrollment_id: "enr-123",
      node_id: "node-move-1",
    });

    expect(spies.moveLeadHandler).toHaveBeenCalledTimes(1);
    const [clientArg, ctxArg, leadIdArg, inputArg] = spies.moveLeadHandler.mock.calls[0]!;

    expect(clientArg).toBe(admin);
    expect(leadIdArg).toBe("lead-1");
    expect(ctxArg).toMatchObject({
      organization_id: "org-1",
      actor: {
        type: "webhook_source",
        id: "flow:enr-123",
      },
      requestId: "flow:enr-123:node-move-1",
      serviceOrigin: {
        kind: "event",
        event_id: "flow:enr-123:node-move-1",
        organization_id: "org-1",
        contact_id: "contact-1",
      },
    });
    expect(inputArg).toMatchObject({
      to_stage_id: "stage-2",
      reason: "Movido automaticamente pelo fluxo de acompanhamento",
    });
  });

  it("moverEtapaFollowupCanonica é idempotente quando o lead já está na etapa de destino", async () => {
    spies.moveLeadHandler.mockReset();

    const selectMock = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: { id: "lead-1", pipeline_id: "pipe-1", stage_id: "stage-2" }, // Já está em stage-2
                error: null,
              }),
            }),
          }),
        }),
      }),
    });

    const admin = {
      from: vi.fn().mockReturnValue({
        select: selectMock,
      }),
    } as unknown as SupabaseClient;

    await moverEtapaFollowupCanonica(admin, {
      organization_id: "org-1",
      contact_id: "contact-1",
      stage_id: "stage-2",
      enrollment_id: "enr-123",
      node_id: "node-move-1",
    });

    expect(spies.moveLeadHandler).not.toHaveBeenCalled();
  });

  it("createPgAdminClient reutiliza as funções canônicas em vez de raw SQL", async () => {
    spies.mutateEntityTags.mockReset();
    spies.mutateEntityTags.mockResolvedValueOnce({
      targetTable: "crm_leads",
      targetId: "lead-1",
      previousTags: [],
      newTags: ["vip"],
      addedTags: ["vip"],
      removedTags: [],
    });
    spies.moveLeadHandler.mockReset();
    spies.moveLeadHandler.mockResolvedValueOnce({ id: "lead-1", stage_id: "stage-2" });

    const selectMock = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: { id: "lead-1", pipeline_id: "pipe-1", stage_id: "stage-1" },
                error: null,
              }),
            }),
          }),
        }),
      }),
    });

    const mockAdmin = {
      from: vi.fn().mockReturnValue({
        select: selectMock,
      }),
    } as unknown as SupabaseClient;

    const mockPool = {
      query: vi.fn(),
    } as unknown as pg.Pool;

    const client = createPgAdminClient(mockPool, mockAdmin);

    // 1. Testa tag
    await client.updateLeadTags?.({
      organization_id: "org-1",
      contact_id: "contact-1",
      action: "add",
      tags: ["vip"],
      enrollment_id: "enr-123",
      node_id: "node-tag-1",
    });

    expect(spies.mutateEntityTags).toHaveBeenCalledTimes(1);
    expect(mockPool.query).not.toHaveBeenCalledWith(
      expect.stringMatching(/update crm_leads\s+set tags/i),
      expect.anything(),
    );

    // 2. Testa stage move
    await client.updateLeadStage?.({
      organization_id: "org-1",
      contact_id: "contact-1",
      stage_id: "stage-2",
      enrollment_id: "enr-123",
      node_id: "node-move-1",
    });

    expect(spies.moveLeadHandler).toHaveBeenCalledTimes(1);
    expect(mockPool.query).not.toHaveBeenCalledWith(
      expect.stringMatching(/update crm_leads\s+set stage_id/i),
      expect.anything(),
    );
  });
});
