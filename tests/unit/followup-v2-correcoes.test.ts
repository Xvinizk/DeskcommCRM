import { describe, expect, it, vi, beforeEach } from "vitest";
import { mutateEntityTags } from "@/lib/tags/mutate-tags";
import type { SupabaseClient } from "@supabase/supabase-js";
import { defaultMimeForType } from "@/app/api/v1/messages/_handler";
import {
  avancarEnrollmentAtivo,
  type AdminClient,
  type TickDeps,
  type EnrollmentPatch,
} from "@/lib/followup/engine";
import type { FlowGraph, FlowNode, FlowEdge } from "@/lib/followup/graph-schema";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";
import { audit } from "@/lib/audit";

type EnrollmentEventParam = Parameters<AdminClient["insertEnrollmentEvent"]>[0];

vi.mock("@/lib/audit", () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}));

describe("Follow Builder V2 - Correções Obrigatórias", () => {
  // ─── 1. TAG (mutateEntityTags: add, remove, lead/contact fallback, events, audit) ───
  describe("1. TAG - mutateEntityTags canônico", () => {
    let mockSupabase: {
      from: ReturnType<typeof vi.fn>;
      rpc: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      vi.clearAllMocks();
      mockSupabase = {
        from: vi.fn(),
        rpc: vi.fn().mockResolvedValue({ data: "event-1", error: null }),
      };
    });

    it("adiciona tag ao lead, emite lead.tag_added e grava audit correspondente", async () => {
      const existingLead = {
        id: "lead-1",
        contact_id: "contact-1",
        tags: ["vip"],
      };

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "crm_leads") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockReturnValue({
                      maybeSingle: vi.fn().mockResolvedValue({ data: existingLead, error: null }),
                    }),
                  }),
                }),
              }),
            }),
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({ error: null }),
              }),
            }),
          };
        }
        return {};
      });

      const result = await mutateEntityTags(mockSupabase as unknown as SupabaseClient, {
        organizationId: "org-1",
        contactId: "contact-1",
        action: "add",
        tags: ["cliente_novo", "vip"], // 'vip' already present, 'cliente_novo' is added
        requestId: "req-1",
      });

      expect(result).not.toBeNull();
      expect(result!.targetTable).toBe("crm_leads");
      expect(result!.addedTags).toEqual(["cliente_novo"]);
      expect(result!.removedTags).toEqual([]);
      expect(result!.newTags).toEqual(["vip", "cliente_novo"]);

      // Emite evento via emit_event
      expect(mockSupabase.rpc).toHaveBeenCalledWith(
        "emit_event",
        expect.objectContaining({
          p_event_type: "lead.tag_added",
          p_entity_id: "lead-1",
          p_payload: expect.objectContaining({
            added_tags: ["cliente_novo"],
          }),
        }),
      );

      // Audit para lead
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "lead.updated",
          organizationId: "org-1",
          resourceId: "lead-1",
          metadata: expect.objectContaining({
            added_tags: ["cliente_novo"],
          }),
        }),
      );
    });

    it("remove tag do lead, emite lead.tag_removed e grava audit de remoção", async () => {
      const existingLead = {
        id: "lead-1",
        contact_id: "contact-1",
        tags: ["vip", "em_atendimento"],
      };

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "crm_leads") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockReturnValue({
                      maybeSingle: vi.fn().mockResolvedValue({ data: existingLead, error: null }),
                    }),
                  }),
                }),
              }),
            }),
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({ error: null }),
              }),
            }),
          };
        }
        return {};
      });

      const result = await mutateEntityTags(mockSupabase as unknown as SupabaseClient, {
        organizationId: "org-1",
        contactId: "contact-1",
        action: "remove",
        tags: ["vip"],
        requestId: "req-2",
      });

      expect(result).not.toBeNull();
      expect(result!.targetTable).toBe("crm_leads");
      expect(result!.removedTags).toEqual(["vip"]);
      expect(result!.newTags).toEqual(["em_atendimento"]);

      // Emite lead.tag_removed
      expect(mockSupabase.rpc).toHaveBeenCalledWith(
        "emit_event",
        expect.objectContaining({
          p_event_type: "lead.tag_removed",
          p_entity_id: "lead-1",
          p_payload: expect.objectContaining({
            removed_tags: ["vip"],
          }),
        }),
      );

      // Audit para remoção de lead
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "lead.updated",
          organizationId: "org-1",
          resourceId: "lead-1",
          metadata: expect.objectContaining({
            removed_tags: ["vip"],
          }),
        }),
      );
    });

    it("quando lead não existe, faz fallback para contact: adiciona tag, emite contact.tag_added e audit", async () => {
      const existingContact = {
        id: "contact-1",
        tags: ["inativo"],
      };

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "crm_leads") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockReturnValue({
                      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "contacts") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: existingContact, error: null }),
                }),
              }),
            }),
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({ error: null }),
              }),
            }),
          };
        }
        return {};
      });

      const result = await mutateEntityTags(mockSupabase as unknown as SupabaseClient, {
        organizationId: "org-1",
        contactId: "contact-1",
        action: "add",
        tags: ["reativado"],
      });

      expect(result).not.toBeNull();
      expect(result!.targetTable).toBe("contacts");
      expect(result!.addedTags).toEqual(["reativado"]);

      // Emite contact.tag_added
      expect(mockSupabase.rpc).toHaveBeenCalledWith(
        "emit_event",
        expect.objectContaining({
          p_event_type: "contact.tag_added",
          p_entity_id: "contact-1",
        }),
      );

      // Audit para contact
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "contact.updated",
          organizationId: "org-1",
          resourceId: "contact-1",
        }),
      );
    });

    it("quando lead não existe, faz fallback para contact: remove tag, emite contact.tag_removed e audit", async () => {
      const existingContact = {
        id: "contact-1",
        tags: ["inativo", "remover_esta"],
      };

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "crm_leads") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockReturnValue({
                      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "contacts") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: existingContact, error: null }),
                }),
              }),
            }),
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({ error: null }),
              }),
            }),
          };
        }
        return {};
      });

      const result = await mutateEntityTags(mockSupabase as unknown as SupabaseClient, {
        organizationId: "org-1",
        contactId: "contact-1",
        action: "remove",
        tags: ["remover_esta"],
      });

      expect(result).not.toBeNull();
      expect(result!.targetTable).toBe("contacts");
      expect(result!.removedTags).toEqual(["remover_esta"]);

      // Emite contact.tag_removed
      expect(mockSupabase.rpc).toHaveBeenCalledWith(
        "emit_event",
        expect.objectContaining({
          p_event_type: "contact.tag_removed",
          p_entity_id: "contact-1",
        }),
      );
    });
  });

  // ─── 2. STAGE_MOVE - Erros de regra de negócio nunca avançam o fluxo ───
  describe("2. STAGE_MOVE - Tratamento de falha de movimentação de etapa", () => {
    function fakeEnrollment(overrides: Partial<EnrollmentRow> = {}): EnrollmentRow {
      return {
        id: "enr-stage-1",
        organization_id: "org-1",
        pointer_id: "ptr-1",
        version_id: "ver-1",
        contact_id: "contact-1",
        conversation_id: "conv-1",
        current_node_id: "stage-node-1",
        status: "active",
        next_eval_at: null,
        claimed_until: null,
        attempts: 0,
        max_attempts: 3,
        last_error: null,
        steps_taken: 2,
        outcome: null,
        cancel_reason: null,
        started_at: "2026-09-22T10:00:00.000Z",
        completed_at: null,
        updated_at: "2026-09-22T10:00:00.000Z",
        ...overrides,
      };
    }

    const stageGraph: FlowGraph = {
      nodes: [
        {
          id: "stage-node-1",
          type: "stage_move",
          config: { stage_id: "stage-qualificado" },
        } as FlowNode,
        {
          id: "next-node",
          type: "message_text",
          config: { body: "Etapa movida com sucesso!" },
        } as FlowNode,
      ],
      edges: [
        {
          id: "e1",
          source: "stage-node-1",
          target: "next-node",
          priority: 0,
          condition: { type: "always" },
        } as FlowEdge,
      ],
    };

    it("se updateLeadStage falhar por regra de negócio, o fluxo NÃO avança e registra o erro", async () => {
      const enrollment = fakeEnrollment();
      const enrollmentUpdates: EnrollmentPatch[] = [];
      const enrollmentEvents: EnrollmentEventParam[] = [];

      const mockDb: AdminClient = {
        claimDueEnrollments: vi.fn(),
        loadFlowGraph: vi.fn().mockResolvedValue(stageGraph),
        loadLeadFacts: vi.fn().mockResolvedValue({
          lead_stage: "stage-inicial",
          tags: [],
        }),
        loadEnrollmentEvents: vi.fn().mockResolvedValue([]),
        loadLastInboundBody: vi.fn().mockResolvedValue(null),
        insertEnrollmentEvent: vi.fn().mockImplementation((ev) => {
          enrollmentEvents.push(ev);
          return Promise.resolve({ inserted: true });
        }),
        updateEnrollment: vi.fn().mockImplementation((_id, _org, patch) => {
          enrollmentUpdates.push(patch);
          return Promise.resolve();
        }),
        loadFlowPointerName: vi.fn().mockResolvedValue("Fluxo Teste"),
        insertDeadInboxItem: vi.fn().mockResolvedValue(undefined),
        persistirRespostaFollowup: vi.fn(),
        updateLeadStage: vi.fn().mockRejectedValue(new Error("lost_reason obrigatório para etapa de perda")),
      };

      const deps: TickDeps = {
        db: mockDb,
        clock: () => new Date("2026-09-22T12:00:00.000Z"),
        enqueueJob: vi.fn(),
      };

      await avancarEnrollmentAtivo(deps, enrollment);

      // O evento 'node_advanced' NÃO deve ter sido gravado
      const advancedEvent = enrollmentEvents.find((e) => e.event_type === "node_advanced");
      expect(advancedEvent).toBeUndefined();

      // Enrollment não deve ter avançado para 'next-node'
      expect(enrollmentUpdates.length).toBeGreaterThan(0);
      const lastPatch = enrollmentUpdates[enrollmentUpdates.length - 1]!;
      expect(lastPatch.current_node_id).toBeUndefined(); // Não trocou de nó!
      expect(lastPatch.attempts).toBe(1);
      expect(lastPatch.last_error).toContain("lost_reason obrigatório");
    });

    it("se updateLeadStage tiver sucesso, o fluxo avança normalmente para o próximo nó", async () => {
      const enrollment = fakeEnrollment();
      const enrollmentUpdates: EnrollmentPatch[] = [];
      const enrollmentEvents: EnrollmentEventParam[] = [];

      const mockDb: AdminClient = {
        claimDueEnrollments: vi.fn(),
        loadFlowGraph: vi.fn().mockResolvedValue(stageGraph),
        loadLeadFacts: vi.fn().mockResolvedValue({
          lead_stage: "stage-inicial",
          tags: [],
        }),
        loadEnrollmentEvents: vi.fn().mockResolvedValue([]),
        loadLastInboundBody: vi.fn().mockResolvedValue(null),
        insertEnrollmentEvent: vi.fn().mockImplementation((ev) => {
          enrollmentEvents.push(ev);
          return Promise.resolve({ inserted: true });
        }),
        updateEnrollment: vi.fn().mockImplementation((_id, _org, patch) => {
          enrollmentUpdates.push(patch);
          return Promise.resolve();
        }),
        loadFlowPointerName: vi.fn().mockResolvedValue("Fluxo Teste"),
        insertDeadInboxItem: vi.fn().mockResolvedValue(undefined),
        persistirRespostaFollowup: vi.fn(),
        updateLeadStage: vi.fn().mockResolvedValue(undefined),
      };

      const deps: TickDeps = {
        db: mockDb,
        clock: () => new Date("2026-09-22T12:00:00.000Z"),
        enqueueJob: vi.fn(),
      };

      await avancarEnrollmentAtivo(deps, enrollment);

      // Evento gravado
      const advancedEvent = enrollmentEvents.find((e) => e.event_type === "node_advanced");
      expect(advancedEvent).toBeDefined();

      // Enrollment avançou para next-node
      const advancePatch = enrollmentUpdates.find((p) => p.current_node_id === "next-node");
      expect(advancePatch).toBeDefined();
    });
  });

  // ─── 3. MÍDIA - MIME defaults & assertSafeOutboundUrl ───
  describe("3. MÍDIA - Validação de segurança e MIME", () => {
    it("devolve MIME correto por tipo de mídia", () => {
      expect(defaultMimeForType("image")).toBe("image/jpeg");
      expect(defaultMimeForType("video")).toBe("video/mp4");
      expect(defaultMimeForType("audio")).toBe("audio/ogg; codecs=opus");
      expect(defaultMimeForType("unknown")).toBe("application/octet-stream");
    });
  });

  // ─── 4. TYPING - Idempotência e wokeEarly ───
  describe("4. TYPING - Presença WAHA assíncrona, idempotente e saída antecipada", () => {
    function fakeEnrollment(overrides: Partial<EnrollmentRow> = {}): EnrollmentRow {
      return {
        id: "enr-typing-1",
        organization_id: "org-1",
        pointer_id: "ptr-1",
        version_id: "ver-1",
        contact_id: "contact-1",
        conversation_id: "conv-1",
        current_node_id: "typing-1",
        status: "active",
        next_eval_at: null,
        claimed_until: null,
        attempts: 0,
        max_attempts: 3,
        last_error: null,
        steps_taken: 1,
        outcome: null,
        cancel_reason: null,
        started_at: "2026-09-22T10:00:00.000Z",
        completed_at: null,
        updated_at: "2026-09-22T10:00:00.000Z",
        ...overrides,
      };
    }

    const typingGraph: FlowGraph = {
      nodes: [
        {
          id: "typing-1",
          type: "typing",
          config: { duration_seconds: 4 },
        } as FlowNode,
        {
          id: "msg-after-typing",
          type: "message_text",
          config: { body: "Mensagem após digitando" },
        } as FlowNode,
      ],
      edges: [
        {
          id: "e1",
          source: "typing-1",
          target: "msg-after-typing",
          priority: 0,
          condition: { type: "always" },
        } as FlowEdge,
      ],
    };

    it("ao entrar no nó typing, sinaliza presence 'typing' com idempotência", async () => {
      const enrollment = fakeEnrollment();
      const signalPresenceMock = vi.fn().mockResolvedValue(undefined);
      const enrollmentEvents: EnrollmentEventParam[] = [];

      const mockDb: AdminClient = {
        claimDueEnrollments: vi.fn(),
        loadFlowGraph: vi.fn().mockResolvedValue(typingGraph),
        loadLeadFacts: vi.fn().mockResolvedValue({ lead_stage: null, tags: [] }),
        loadEnrollmentEvents: vi.fn().mockResolvedValue([]),
        loadLastInboundBody: vi.fn().mockResolvedValue(null),
        insertEnrollmentEvent: vi.fn().mockImplementation((ev) => {
          enrollmentEvents.push(ev);
          return Promise.resolve({ inserted: true });
        }),
        updateEnrollment: vi.fn().mockResolvedValue(undefined),
        loadFlowPointerName: vi.fn().mockResolvedValue("Fluxo"),
        insertDeadInboxItem: vi.fn().mockResolvedValue(undefined),
        persistirRespostaFollowup: vi.fn(),
        signalPresence: signalPresenceMock,
      };

      const deps: TickDeps = {
        db: mockDb,
        clock: () => new Date("2026-09-22T12:00:00.000Z"),
        enqueueJob: vi.fn(),
      };

      await avancarEnrollmentAtivo(deps, enrollment);

      // Sinalizou presença 'typing'
      expect(signalPresenceMock).toHaveBeenCalledTimes(1);
      expect(signalPresenceMock).toHaveBeenCalledWith({
        organization_id: "org-1",
        contact_id: "contact-1",
        conversation_id: "conv-1",
        presence: "typing",
      });

      // Gravou evento typing_started com chave de idempotência explícita
      const typingEvent = enrollmentEvents.find((e) => e.event_type === "typing_started");
      expect(typingEvent).toBeDefined();
      expect(typingEvent?.idempotency_key).toBe("typing-1:1:typing_started");
    });

    it("retries durante a espera NÃO duplicam o sinal de presença 'typing'", async () => {
      const enrollment = fakeEnrollment();
      const signalPresenceMock = vi.fn().mockResolvedValue(undefined);

      // Simula que typing_started JÁ FOI inserido na primeira tentativa
      const mockDb: AdminClient = {
        claimDueEnrollments: vi.fn(),
        loadFlowGraph: vi.fn().mockResolvedValue(typingGraph),
        loadLeadFacts: vi.fn().mockResolvedValue({ lead_stage: null, tags: [] }),
        loadEnrollmentEvents: vi.fn().mockResolvedValue([
          {
            node_id: "typing-1",
            idempotency_key: "typing-1:1",
            event_type: "wait_started",
            payload: {},
          },
        ]),
        loadLastInboundBody: vi.fn().mockResolvedValue(null),
        insertEnrollmentEvent: vi.fn().mockImplementation((ev) => {
          if (ev.event_type === "typing_started") {
            return Promise.resolve({ inserted: false }); // Já inserido! Replay!
          }
          return Promise.resolve({ inserted: false });
        }),
        updateEnrollment: vi.fn().mockResolvedValue(undefined),
        loadFlowPointerName: vi.fn().mockResolvedValue("Fluxo"),
        insertDeadInboxItem: vi.fn().mockResolvedValue(undefined),
        persistirRespostaFollowup: vi.fn(),
        signalPresence: signalPresenceMock,
      };

      const deps: TickDeps = {
        db: mockDb,
        clock: () => new Date("2026-09-22T12:00:01.000Z"), // ainda dentro dos 4s
        enqueueJob: vi.fn(),
      };

      await avancarEnrollmentAtivo(deps, enrollment);

      // signalPresence NÃO deve ser chamado novamente!
      expect(signalPresenceMock).not.toHaveBeenCalled();
    });

    it("quando o tempo expira, sinaliza 'paused' e avança o fluxo", async () => {
      const enrollment = fakeEnrollment();
      const signalPresenceMock = vi.fn().mockResolvedValue(undefined);
      const enrollmentEvents: EnrollmentEventParam[] = [];

      // O evento wait_started já existe nos eventos passados (gravado em steps_taken = 0)
      const pastEvents = [
        {
          node_id: "typing-1",
          idempotency_key: "typing-1:0",
          event_type: "wait_started",
          payload: {},
        },
      ];

      const mockDb: AdminClient = {
        claimDueEnrollments: vi.fn(),
        loadFlowGraph: vi.fn().mockResolvedValue(typingGraph),
        loadLeadFacts: vi.fn().mockResolvedValue({ lead_stage: null, tags: [] }),
        loadEnrollmentEvents: vi.fn().mockResolvedValue(pastEvents),
        loadLastInboundBody: vi.fn().mockResolvedValue(null),
        insertEnrollmentEvent: vi.fn().mockImplementation((ev) => {
          enrollmentEvents.push(ev);
          return Promise.resolve({ inserted: true });
        }),
        updateEnrollment: vi.fn().mockResolvedValue(undefined),
        loadFlowPointerName: vi.fn().mockResolvedValue("Fluxo"),
        insertDeadInboxItem: vi.fn().mockResolvedValue(undefined),
        persistirRespostaFollowup: vi.fn(),
        signalPresence: signalPresenceMock,
      };

      const deps: TickDeps = {
        db: mockDb,
        clock: () => new Date("2026-09-22T12:00:05.000Z"), // 5s depois (duration 4s expirou)
        enqueueJob: vi.fn(),
      };

      await avancarEnrollmentAtivo(deps, enrollment);

      // Sinalizou 'paused'
      expect(signalPresenceMock).toHaveBeenCalledWith({
        organization_id: "org-1",
        contact_id: "contact-1",
        conversation_id: "conv-1",
        presence: "paused",
      });

      // Gravou typing_stopped
      const stoppedEvent = enrollmentEvents.find((e) => e.event_type === "typing_stopped");
      expect(stoppedEvent).toBeDefined();
      expect(stoppedEvent?.idempotency_key).toBe("typing-1:1:typing_stopped");
    });

    it("se o contato responder antes do fim (wokeEarly), envia 'paused', não reinicia typing e avança", async () => {
      const enrollment = fakeEnrollment();
      const signalPresenceMock = vi.fn().mockResolvedValue(undefined);
      const enrollmentEvents: EnrollmentEventParam[] = [];
      const enrollmentUpdates: EnrollmentPatch[] = [];

      // wake event já existe
      const pastEvents = [
        {
          node_id: "typing-1",
          idempotency_key: "typing-1:1",
          event_type: "wait_started",
          payload: {},
        },
        {
          node_id: "typing-1",
          idempotency_key: "typing-1:1:wake",
          event_type: "inbound_woke_wait",
          payload: {},
        },
      ];

      const mockDb: AdminClient = {
        claimDueEnrollments: vi.fn(),
        loadFlowGraph: vi.fn().mockResolvedValue(typingGraph),
        loadLeadFacts: vi.fn().mockResolvedValue({ lead_stage: null, tags: [] }),
        loadEnrollmentEvents: vi.fn().mockResolvedValue(pastEvents),
        loadLastInboundBody: vi.fn().mockResolvedValue("Oi, já estou aqui!"),
        insertEnrollmentEvent: vi.fn().mockImplementation((ev) => {
          enrollmentEvents.push(ev);
          return Promise.resolve({ inserted: true });
        }),
        updateEnrollment: vi.fn().mockImplementation((_id, _org, patch) => {
          enrollmentUpdates.push(patch);
          return Promise.resolve();
        }),
        loadFlowPointerName: vi.fn().mockResolvedValue("Fluxo"),
        insertDeadInboxItem: vi.fn().mockResolvedValue(undefined),
        persistirRespostaFollowup: vi.fn(),
        signalPresence: signalPresenceMock,
      };

      const deps: TickDeps = {
        db: mockDb,
        clock: () => new Date("2026-09-22T12:00:01.000Z"), // apenas 1s decorrido (não expirou naturalmente)
        enqueueJob: vi.fn(),
      };

      await avancarEnrollmentAtivo(deps, enrollment);

      // Enviou 'paused'
      expect(signalPresenceMock).toHaveBeenCalledWith({
        organization_id: "org-1",
        contact_id: "contact-1",
        conversation_id: "conv-1",
        presence: "paused",
      });

      // Avançou para o nó seguinte
      const advancePatch = enrollmentUpdates.find((p) => p.current_node_id === "msg-after-typing");
      expect(advancePatch).toBeDefined();
    });
  });
});
