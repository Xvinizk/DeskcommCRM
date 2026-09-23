import { describe, expect, it, vi } from "vitest";
import { enrollFollowupFlow } from "@/lib/followup/enroll";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const CONTACT_ID = "33333333-3333-4333-8333-333333333333";
const POINTER_ID = "44444444-4444-4444-8444-444444444444";
const VERSION_ID = "55555555-5555-4555-8555-555555555555";
const CONVERSATION_ID = "66666666-6666-4666-8666-666666666666";
const USER_ID = "77777777-7777-4777-8777-777777777777";

const GRAPH_COM_TRIGGER = {
  nodes: [
    { id: "trg-1", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: { type: "manual" } },
    { id: "end-1", type: "end", label: "Fim", position: { x: 100, y: 0 }, config: { outcome: "converted" } },
  ],
  edges: [
    { id: "e1", source: "trg-1", target: "end-1", condition: { type: "always" } },
  ],
};

describe("Disparo Manual e Resolução de Conflito de Follow-up", () => {
  it("inicia follow-up manualmente quando não há enrollment ativo", async () => {
    let insertedEnrollment: Record<string, unknown> | null = null;
    let insertedEvent: Record<string, unknown> | null = null;

    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "followup_flow_pointers") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({
                    data: { id: POINTER_ID, name: "Fluxo Boas-Vindas", status: "active", active_version_id: VERSION_ID },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "contacts") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: { id: CONTACT_ID }, error: null }),
                }),
              }),
            }),
          };
        }
        if (table === "followup_enrollments") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  in: () => ({
                    order: () => ({
                      limit: () => Promise.resolve({ data: [], error: null }), // Nenhum ativo
                    }),
                  }),
                }),
              }),
            }),
            insert: (values: Record<string, unknown>) => ({
              select: () => ({
                single: () => {
                  insertedEnrollment = { id: "enr-novo", ...values };
                  return Promise.resolve({ data: insertedEnrollment, error: null });
                },
              }),
            }),
          };
        }
        if (table === "followup_flow_versions") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({
                    data: { graph: GRAPH_COM_TRIGGER },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "followup_enrollment_events") {
          return {
            insert: (event: Record<string, unknown>) => {
              insertedEvent = event;
              return Promise.resolve({ error: null });
            },
          };
        }
        if (table === "ai_agent_versions") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => Promise.resolve({ data: [], error: null }),
              }),
            }),
          };
        }
        if (table === "conversations") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({
                    data: { id: CONVERSATION_ID, contact_id: CONTACT_ID, channel_session_id: null },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      }),
      rpc: vi.fn(() => Promise.resolve({
        data: {
          organization_id: ORG_A,
          contact_id: CONTACT_ID,
          conversation_id: CONVERSATION_ID,
          service_revision: 1,
          demanda_id: null,
          demanda_revision: null,
        },
        error: null,
      })),
    };

    const res = await enrollFollowupFlow(mockAdmin as never, {
      organizationId: ORG_A,
      pointerId: POINTER_ID,
      contactId: CONTACT_ID,
      conversationId: CONVERSATION_ID,
      actorUserId: USER_ID,
      origin: "manual_trigger",
      requestId: "req-1",
    });

    expect(res.ok).toBe(true);
    expect(insertedEnrollment).toBeDefined();
    expect(insertedEnrollment?.["conversation_id"]).toBe(CONVERSATION_ID);
    expect(insertedEnrollment?.["status"]).toBe("active");
    expect(insertedEvent).toBeDefined();
    expect(insertedEvent?.["event_type"]).toBe("enrolled_manual");
  });

  it("conflito: detecta enrollment ativo existente e retorna 409 com nome do fluxo", async () => {
    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "followup_flow_pointers") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({
                    data: { id: POINTER_ID, name: "Novo Fluxo", status: "active", active_version_id: VERSION_ID },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "contacts") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: { id: CONTACT_ID }, error: null }),
                }),
              }),
            }),
          };
        }
        if (table === "followup_enrollments") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  in: () => ({
                    order: () => ({
                      limit: () => Promise.resolve({
                        data: [
                          {
                            id: "enr-existente",
                            pointer_id: "ptr-antigo",
                            status: "active",
                            followup_flow_pointers: { name: "Fluxo Anterior" },
                          },
                        ],
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      }),
    };

    const res = await enrollFollowupFlow(mockAdmin as never, {
      organizationId: ORG_A,
      pointerId: POINTER_ID,
      contactId: CONTACT_ID,
      conversationId: CONVERSATION_ID,
      actorUserId: USER_ID,
      replaceActive: false,
      requestId: "req-2",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
      expect(res.code).toBe("conflict");
      expect(res.activeEnrollment?.flowName).toBe("Fluxo Anterior");
      expect(res.activeEnrollment?.id).toBe("enr-existente");
    }
  });

  it("substituição: cancela canonicamente o fluxo anterior com motivo manual_replacement quando replaceActive=true", async () => {
    let cancelamentoEfetuado = false;
    let novoEnrollmentCriado = false;

    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "followup_flow_pointers") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({
                    data: { id: POINTER_ID, name: "Novo Fluxo", status: "active", active_version_id: VERSION_ID },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "contacts") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: { id: CONTACT_ID }, error: null }),
                }),
              }),
            }),
          };
        }
        if (table === "followup_enrollments") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({
                    data: { id: "enr-antigo", status: "active", current_node_id: "node-1" },
                    error: null,
                  }),
                  in: () => ({
                    order: () => ({
                      limit: () => Promise.resolve({
                        data: [
                          {
                            id: "enr-antigo",
                            pointer_id: "ptr-antigo",
                            status: "active",
                            followup_flow_pointers: { name: "Fluxo Anterior" },
                          },
                        ],
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            }),
            update: (patch: Record<string, unknown>) => ({
              eq: () => ({
                eq: () => ({
                  select: () => ({
                    single: () => {
                      if (patch["cancel_reason"] === "manual_replacement") {
                        cancelamentoEfetuado = true;
                      }
                      return Promise.resolve({ data: { id: "enr-antigo", status: "cancelled" }, error: null });
                    },
                  }),
                }),
              }),
            }),
            insert: (values: Record<string, unknown>) => ({
              select: () => ({
                single: () => {
                  novoEnrollmentCriado = true;
                  return Promise.resolve({ data: { id: "enr-novo", ...values }, error: null });
                },
              }),
            }),
          };
        }
        if (table === "followup_flow_versions") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({
                    data: { graph: GRAPH_COM_TRIGGER },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "followup_enrollment_events") {
          return {
            insert: () => Promise.resolve({ error: null }),
          };
        }
        if (table === "ai_agent_versions") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => Promise.resolve({ data: [], error: null }),
              }),
            }),
          };
        }
        if (table === "conversations") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({
                    data: { id: CONVERSATION_ID, contact_id: CONTACT_ID, channel_session_id: null },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      }),
      rpc: vi.fn(() => Promise.resolve({
        data: {
          organization_id: ORG_A,
          contact_id: CONTACT_ID,
          conversation_id: CONVERSATION_ID,
          service_revision: 1,
          demanda_id: null,
          demanda_revision: null,
        },
        error: null,
      })),
    };

    const res = await enrollFollowupFlow(mockAdmin as never, {
      organizationId: ORG_A,
      pointerId: POINTER_ID,
      contactId: CONTACT_ID,
      conversationId: CONVERSATION_ID,
      actorUserId: USER_ID,
      replaceActive: true,
      requestId: "req-3",
    });

    expect(cancelamentoEfetuado).toBe(true);
    expect(novoEnrollmentCriado).toBe(true);
    expect(res.ok).toBe(true);
  });

  it("fail-closed: falha no cancelamento do anterior impede início do novo fluxo", async () => {
    let novoEnrollmentTentado = false;

    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "followup_flow_pointers") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({
                    data: { id: POINTER_ID, name: "Novo Fluxo", status: "active", active_version_id: VERSION_ID },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "contacts") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: { id: CONTACT_ID }, error: null }),
                }),
              }),
            }),
          };
        }
        if (table === "followup_enrollments") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({
                    data: { id: "enr-antigo", status: "active", current_node_id: "node-1" },
                    error: null,
                  }),
                  in: () => ({
                    order: () => ({
                      limit: () => Promise.resolve({
                        data: [
                          {
                            id: "enr-antigo",
                            pointer_id: "ptr-antigo",
                            status: "active",
                          },
                        ],
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            }),
            update: () => ({
              eq: () => ({
                eq: () => ({
                  select: () => ({
                    single: () => Promise.resolve({ data: null, error: { message: "database_locked" } }),
                  }),
                }),
              }),
            }),
            insert: () => {
              novoEnrollmentTentado = true;
              return { select: () => ({ single: () => Promise.resolve({ data: {}, error: null }) }) };
            },
          };
        }
        return {};
      }),
    };

    const res = await enrollFollowupFlow(mockAdmin as never, {
      organizationId: ORG_A,
      pointerId: POINTER_ID,
      contactId: CONTACT_ID,
      replaceActive: true,
      actorUserId: USER_ID,
      requestId: "req-4",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("replacement_failed");
    }
    expect(novoEnrollmentTentado).toBe(false);
  });
});
