import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

import { enrollFollowupFlow } from "./enroll";
import { flowGraphSchema } from "./graph-schema";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const POINTER = "33333333-3333-4333-8333-333333333333";
const CONTACT = "44444444-4444-4444-8444-444444444444";
const VERSION = "55555555-5555-4555-8555-555555555555";

const GRAPH = flowGraphSchema.parse({
  nodes: [
    { id: "t1", type: "trigger", label: "t1", position: { x: 0, y: 0 }, config: {} },
    { id: "e1", type: "end", label: "e1", position: { x: 0, y: 0 }, config: { outcome: "exhausted" } },
  ],
  edges: [{ id: "edge1", source: "t1", target: "e1", priority: 0, condition: { type: "always" } }],
});

type Row = Record<string, unknown>;

function fakeDb(pointer: Row, extraTables: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {
    followup_flow_pointers: [pointer],
    contacts: [{ id: CONTACT, organization_id: ORG }],
    followup_flow_versions: [{ id: VERSION, organization_id: ORG, graph: GRAPH }],
    followup_enrollments: [],
    ai_agents: [],
    ai_agent_versions: [],
    conversations: [],
    ...extraTables,
  };
  return {
    rpc: async (): Promise<{ data: unknown; error: unknown }> => ({ data: { organization_id: ORG, contact_id: CONTACT, conversation_id: "conv-1", service_revision: 1, demanda_id: null, demanda_revision: null, status: "open", demanda_fechada_em: null }, error: null }),
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const inFilters: Array<[string, unknown[]]> = [];
      let mode: "select" | "insert" = "select";
      let payload: Row | undefined;
      const b = {
        select() {
          return b;
        },
        insert(obj: Row) {
          mode = "insert";
          payload = obj;
          expect(obj).not.toHaveProperty("next_eval_at");
          return b;
        },
        eq(col: string, val: unknown) {
          filters.push([col, val]);
          return b;
        },
        in(col: string, vals: unknown[]) {
          inFilters.push([col, vals]);
          return b;
        },
        order() {
          return b;
        },
        limit() {
          return b;
        },
        async maybeSingle() {
          const list = tables[table]!.filter(
            (row) =>
              filters.every(([k, v]) => row[k] === v) &&
              inFilters.every(([k, vals]) => vals.includes(row[k])),
          );
          return { data: list[0] ?? null, error: null };
        },
        async single() {
          if (mode === "insert") {
            const row = { id: randomUUID(), ...payload };
            tables[table]!.push(row);
            return { data: row, error: null };
          }
          const list = tables[table]!.filter(
            (row) =>
              filters.every(([k, v]) => row[k] === v) &&
              inFilters.every(([k, vals]) => vals.includes(row[k])),
          );
          return { data: list[0] ?? null, error: null };
        },
      };
      return b;
    },
  };
}

describe("enrollFollowupFlow", () => {
  it("inscreve contato em fluxo ativo publicado", async () => {
    const db = fakeDb({
      id: POINTER,
      organization_id: ORG,
      status: "active",
      active_version_id: VERSION,
    });
    const result = await enrollFollowupFlow(db as never, {
      organizationId: ORG,
      pointerId: POINTER,
      contactId: CONTACT,
      actorUserId: null,
      requestId: "r1",
    });
    expect(result.ok).toBe(true);
  });

  it("recusa fluxo que não está publicado", async () => {
    const db = fakeDb({
      id: POINTER,
      organization_id: ORG,
      status: "draft",
      active_version_id: null,
    });
    const result = await enrollFollowupFlow(db as never, {
      organizationId: ORG,
      pointerId: POINTER,
      contactId: CONTACT,
      actorUserId: null,
      requestId: "r1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("flow_not_active");
  });

  it("inscreve com conversation_id válido resolvendo channel_session_id da conversa", async () => {
    const convId = "66666666-6666-4666-8666-666666666666";
    const sessionId = "77777777-7777-4777-8777-777777777777";
    const db = fakeDb(
      {
        id: POINTER,
        organization_id: ORG,
        status: "active",
        active_version_id: VERSION,
      },
      {
        conversations: [
          {
            id: convId,
            organization_id: ORG,
            contact_id: CONTACT,
            channel_session_id: sessionId,
          },
        ],
      },
    );
    const result = await enrollFollowupFlow(db as never, {
      organizationId: ORG,
      pointerId: POINTER,
      contactId: CONTACT,
      conversationId: convId,
      actorUserId: null,
      requestId: "r1",
    });
    expect(result.ok).toBe(true);
  });

  it("recusa conversation_id que pertence a outro contato (400 invalid_request)", async () => {
    const convId = "66666666-6666-4666-8666-666666666666";
    const db = fakeDb(
      {
        id: POINTER,
        organization_id: ORG,
        status: "active",
        active_version_id: VERSION,
      },
      {
        conversations: [
          {
            id: convId,
            organization_id: ORG,
            contact_id: "88888888-8888-4888-8888-888888888888", // outro contato
            channel_session_id: "77777777-7777-4777-8777-777777777777",
          },
        ],
      },
    );
    const result = await enrollFollowupFlow(db as never, {
      organizationId: ORG,
      pointerId: POINTER,
      contactId: CONTACT,
      conversationId: convId,
      actorUserId: null,
      requestId: "r1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid_request");
      expect(result.status).toBe(400);
    }
  });

  it("service_channel_not_found na criação de boundary retorna 422 controlado em vez de 500", async () => {
    const db = fakeDb({
      id: POINTER,
      organization_id: ORG,
      status: "active",
      active_version_id: VERSION,
    });
    // Simula RPC fn_service_begin lançando erro de canal inexistente
    db.rpc = async () => ({
      data: null,
      error: { message: "service_channel_not_found", code: "P0002" },
    });
    const result = await enrollFollowupFlow(db as never, {
      organizationId: ORG,
      pointerId: POINTER,
      contactId: CONTACT,
      actorUserId: null,
      requestId: "r1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("service_channel_not_found");
      expect(result.status).toBe(422);
    }
  });
});

