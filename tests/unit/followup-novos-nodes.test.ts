import { describe, expect, it } from "vitest";
import {
  messageTextConfigSchema,
  messageImageConfigSchema,
  messageVideoConfigSchema,
  messageAudioConfigSchema,
  typingConfigSchema,
  delayConfigSchema,
  tagConfigSchema,
  stageMoveConfigSchema,
  type FlowEdge,
  type FlowNode,
} from "@/lib/followup/graph-schema";
import { processNode, type EnrollmentRow, type LeadFacts } from "@/lib/followup/node-handlers";

const clock = () => new Date("2026-09-22T12:00:00.000Z");

function fakeEnrollment(overrides: Partial<EnrollmentRow> = {}): EnrollmentRow {
  return {
    id: "enr-test-1",
    organization_id: "org-test-1",
    pointer_id: "ptr-1",
    version_id: "ver-1",
    contact_id: "contact-1",
    conversation_id: "conv-1",
    current_node_id: "node-1",
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

function fakeLead(overrides: Partial<LeadFacts> = {}): LeadFacts {
  return {
    lead_stage: null,
    tags: [],
    steps_taken: 1,
    last_outcome: null,
    ...overrides,
  };
}

describe("Novos Nodes — Schemas & Validação (Fase 1)", () => {
  it("valida schema de message_text", () => {
    expect(messageTextConfigSchema.safeParse({ body: "Olá! Tudo bem?" }).success).toBe(true);
    expect(messageTextConfigSchema.safeParse({ body: "" }).success).toBe(false);
  });

  it("valida schema de message_image", () => {
    expect(
      messageImageConfigSchema.safeParse({
        media_url: "https://example.com/foto.png",
        caption: "Veja nossa foto",
      }).success,
    ).toBe(true);
    expect(messageImageConfigSchema.safeParse({ media_url: "" }).success).toBe(false);
  });

  it("valida schema de message_video", () => {
    expect(
      messageVideoConfigSchema.safeParse({
        media_url: "https://example.com/video.mp4",
      }).success,
    ).toBe(true);
    expect(messageVideoConfigSchema.safeParse({ media_url: "" }).success).toBe(false);
  });

  it("valida schema de message_audio", () => {
    expect(
      messageAudioConfigSchema.safeParse({
        media_url: "https://example.com/audio.mp3",
      }).success,
    ).toBe(true);
    expect(messageAudioConfigSchema.safeParse({ media_url: "" }).success).toBe(false);
  });

  it("valida schema de typing", () => {
    expect(typingConfigSchema.safeParse({ duration_seconds: 5 }).success).toBe(true);
    expect(typingConfigSchema.safeParse({ duration_seconds: 0 }).success).toBe(false);
  });

  it("valida schema de delay", () => {
    expect(
      delayConfigSchema.safeParse({
        duration_value: 10,
        unit: "minutes",
        immune_to_reply: true,
      }).success,
    ).toBe(true);
    expect(
      delayConfigSchema.safeParse({
        duration_value: 2,
        unit: "hours",
      }).success,
    ).toBe(true);
    expect(
      delayConfigSchema.safeParse({
        duration_value: 0,
        unit: "days",
      }).success,
    ).toBe(false);
  });

  it("valida schema de tag", () => {
    expect(
      tagConfigSchema.safeParse({
        action: "add",
        tags: ["cliente_vip", "interessado"],
      }).success,
    ).toBe(true);
    expect(
      tagConfigSchema.safeParse({
        action: "remove",
        tags: [],
      }).success,
    ).toBe(false);
  });

  it("valida schema de stage_move", () => {
    const validUuid = "11111111-1111-4111-8111-111111111111";
    expect(
      stageMoveConfigSchema.safeParse({
        pipeline_id: validUuid,
        stage_id: validUuid,
      }).success,
    ).toBe(true);
    expect(
      stageMoveConfigSchema.safeParse({
        pipeline_id: validUuid,
        stage_id: "not-a-uuid",
      }).success,
    ).toBe(false);
  });
});

describe("Novos Nodes — Execução via processNode", () => {
  const edges: FlowEdge[] = [
    {
      id: "edge-1",
      source: "node-1",
      target: "node-2",
      priority: 0,
      condition: { type: "always" },
    },
  ];

  it("message_text enfileira envio e depois avança", () => {
    const node: FlowNode = {
      id: "node-1",
      type: "message_text",
      label: "Texto 1",
      position: { x: 0, y: 0 },
      config: { body: "Olá {{nome}}" },
    };

    // 1º tick: enfileira
    const r1 = processNode({
      node,
      edges,
      enrollment: fakeEnrollment(),
      lead: fakeLead(),
      clock,
      actionEnqueued: false,
      actionCompleted: false,
    });
    expect(r1.kind).toBe("enqueue_turn");
    if (r1.kind === "enqueue_turn") {
      expect(r1.purpose).toBe("send_message");
      expect(r1.fixed_body).toBe("Olá {{nome}}");
    }

    // Tick em voo: recheck
    const r2 = processNode({
      node,
      edges,
      enrollment: fakeEnrollment(),
      lead: fakeLead(),
      clock,
      actionEnqueued: true,
      actionCompleted: false,
      actionRecheckCount: 0,
    });
    expect(r2.kind).toBe("recheck");

    // Tick com envio concluído: avança
    const r3 = processNode({
      node,
      edges,
      enrollment: fakeEnrollment(),
      lead: fakeLead(),
      clock,
      actionEnqueued: true,
      actionCompleted: true,
    });
    expect(r3.kind).toBe("advance");
    if (r3.kind === "advance") {
      expect(r3.next_node_id).toBe("node-2");
    }
  });

  it("typing aguarda duration_seconds e depois avança", () => {
    const node: FlowNode = {
      id: "node-1",
      type: "typing",
      label: "Digitando",
      position: { x: 0, y: 0 },
      config: { duration_seconds: 4 },
    };

    // 1º tick: wait
    const r1 = processNode({
      node,
      edges,
      enrollment: fakeEnrollment(),
      lead: fakeLead(),
      clock,
      waitElapsed: false,
    });
    expect(r1.kind).toBe("wait");
    if (r1.kind === "wait") {
      expect(r1.next_eval_at.getTime() - clock().getTime()).toBe(4000);
    }

    // 2º tick: prazo decorrido -> avança
    const r2 = processNode({
      node,
      edges,
      enrollment: fakeEnrollment(),
      lead: fakeLead(),
      clock,
      waitElapsed: true,
    });
    expect(r2.kind).toBe("advance");
    if (r2.kind === "advance") {
      expect(r2.next_node_id).toBe("node-2");
    }
  });

  it("delay calcula tempo correto para minutos, horas e dias", () => {
    const nodeMin: FlowNode = {
      id: "node-1",
      type: "delay",
      label: "Espera 15 min",
      position: { x: 0, y: 0 },
      config: { duration_value: 15, unit: "minutes", immune_to_reply: false },
    };

    const rMin = processNode({
      node: nodeMin,
      edges,
      enrollment: fakeEnrollment(),
      lead: fakeLead(),
      clock,
      waitElapsed: false,
    });
    expect(rMin.kind).toBe("wait");
    if (rMin.kind === "wait") {
      expect(rMin.next_eval_at.getTime() - clock().getTime()).toBe(15 * 60 * 1000);
      expect(rMin.wake_status).toBeUndefined();
    }

    const nodeImune: FlowNode = {
      id: "node-1",
      type: "delay",
      label: "Espera 2 dias imune",
      position: { x: 0, y: 0 },
      config: { duration_value: 2, unit: "days", immune_to_reply: true },
    };

    const rImune = processNode({
      node: nodeImune,
      edges,
      enrollment: fakeEnrollment(),
      lead: fakeLead(),
      clock,
      waitElapsed: false,
    });
    expect(rImune.kind).toBe("wait");
    if (rImune.kind === "wait") {
      expect(rImune.next_eval_at.getTime() - clock().getTime()).toBe(2 * 24 * 60 * 60 * 1000);
      expect(rImune.wake_status).toBe("dormente");
    }
  });

  it("tag e stage_move avançam imediatamente pela aresta always", () => {
    const nodeTag: FlowNode = {
      id: "node-1",
      type: "tag",
      label: "Aplicar Tag",
      position: { x: 0, y: 0 },
      config: { action: "add", tags: ["vip"] },
    };
    const rTag = processNode({
      node: nodeTag,
      edges,
      enrollment: fakeEnrollment(),
      lead: fakeLead(),
      clock,
    });
    expect(rTag.kind).toBe("advance");
    if (rTag.kind === "advance") {
      expect(rTag.next_node_id).toBe("node-2");
    }

    const nodeStage: FlowNode = {
      id: "node-1",
      type: "stage_move",
      label: "Mover Etapa",
      position: { x: 0, y: 0 },
      config: {
        pipeline_id: "11111111-1111-4111-8111-111111111111",
        stage_id: "22222222-2222-4222-8222-222222222222",
      },
    };
    const rStage = processNode({
      node: nodeStage,
      edges,
      enrollment: fakeEnrollment(),
      lead: fakeLead(),
      clock,
    });
    expect(rStage.kind).toBe("advance");
    if (rStage.kind === "advance") {
      expect(rStage.next_node_id).toBe("node-2");
    }
  });
});
