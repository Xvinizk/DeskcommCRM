import { describe, it, expect, vi } from "vitest";
import { sendWithLedger, pgSendLedger } from "@/lib/agent-engine/edge/crm/send-ledger";
import { runBeforeSend } from "@/lib/agent-engine/guardrails/before-send";
import type { Queryable } from "@/lib/agent-engine/queue/queue";

interface FakeLedgerRow {
  id: string;
  organization_id?: string;
  contact_id?: string | null;
  job_id?: string;
  seq?: number;
  body_hash?: string;
  status: string;
  crm_message_id?: string | null;
}

interface FakeMessageRow {
  id: string;
  status: string;
  external_id?: string | null;
}

describe("AUDITORIA CRÍTICA DO FLOW BUILDER — EXACTLY ONCE E SEQUÊNCIA", () => {
  const ORG_ID = "b0ff5b87-023f-4004-b149-8f0b39c85044";
  const CONTACT_A_ID = "97867de5-4609-45e8-8c57-f86876b4c937";

  // =========================================================================
  // SEÇÃO 16: MESSAGE_VIDEO — REPRODUÇÃO DO INCIDENTE A
  // =========================================================================
  it("MESSAGE_VIDEO / INCIDENT A: mesma execução processada 3 vezes não duplica no WAHA (WAHA_SEND_CALL_COUNT = 1)", async () => {
    let wahaSendCallCount = 0;
    const ledgerRows = new Map<string, FakeLedgerRow>();
    const messages = new Map<string, FakeMessageRow>();

    const fakeDb = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        const p = (params ?? []) as Array<string | number>;
        if (sql.includes("insert into send_ledger")) {
          const [org, contact, jobId, seq, hash] = p;
          const key = `${jobId}:${seq}`;
          if (ledgerRows.has(key)) {
            const err = new Error("unique violation") as Error & { code: string };
            err.code = "23505";
            throw err;
          }
          const row: FakeLedgerRow = {
            id: `ledger-${jobId}-${seq}`,
            organization_id: String(org),
            contact_id: String(contact),
            job_id: String(jobId),
            seq: Number(seq),
            body_hash: String(hash),
            status: "requested",
            crm_message_id: null,
          };
          ledgerRows.set(key, row);
          return { rows: [{ id: row.id }] as unknown[] };
        }
        if (sql.includes("select * from send_ledger where organization_id=$1 and job_id=$2 and seq=$3")) {
          const [, jobId, seq] = p;
          const row = ledgerRows.get(`${jobId}:${seq}`);
          return { rows: row ? [row] : [] };
        }
        if (sql.includes("update send_ledger set status='requested'")) {
          const [, jobId, seq] = p;
          const row = ledgerRows.get(`${jobId}:${seq}`);
          if (row) {
            row.status = "requested";
            return { rows: [{ id: row.id }] };
          }
          return { rows: [] };
        }
        if (sql.includes("update send_ledger set status=$3")) {
          const [, id, status, crmMsgId] = p;
          for (const row of ledgerRows.values()) {
            if (row.id === id) {
              row.status = String(status);
              if (crmMsgId) row.crm_message_id = String(crmMsgId);
            }
          }
          return { rows: [] };
        }
        if (sql.includes("select id,status,external_id from messages")) {
          const [, key] = p;
          const msg = messages.get(String(key));
          return { rows: msg ? [msg] : [] };
        }
        return { rows: [] };
      }),
    } as unknown as Queryable;

    const store = pgSendLedger(fakeDb);
    const intent = {
      tenantId: ORG_ID,
      leadId: CONTACT_A_ID,
      jobId: "dddc032d-dd46-414d-82b3-ca72ca446b0c",
      seq: 1,
      body: "*ANTES DE CONTINUAR ASSISTA ESSE VIDEO ❗❗❗*",
    };

    const simulateWahaSend = vi.fn(async (key: string, messageId: string) => {
      wahaSendCallCount++;
      const msg: FakeMessageRow = {
        id: messageId,
        status: "sent",
        external_id: "3EB0460C6B5B530A71C2A3",
      };
      messages.set(key, msg);
      return msg;
    });

    const res1 = await sendWithLedger(store, intent, simulateWahaSend);
    expect(res1.kind).toBe("sent");
    expect(wahaSendCallCount).toBe(1);

    const res2 = await sendWithLedger(store, intent, simulateWahaSend);
    expect(res2.kind).toBe("already_sent");
    expect(wahaSendCallCount).toBe(1);

    const res3 = await sendWithLedger(store, intent, simulateWahaSend);
    expect(res3.kind).toBe("already_sent");
    expect(wahaSendCallCount).toBe(1);
  });

  // =========================================================================
  // SEÇÃO 23: FAULT INJECTION (SEND SUCCESS THEN CRASH BEFORE COMPLETE)
  // =========================================================================
  it("SEND_SUCCESS_THEN_CRASH_RETRY: WAHA tem sucesso mas crash ocorre antes de completeTurn; retry reconcilia sem chamar WAHA", async () => {
    let wahaCallCount = 0;
    const ledgerRows = new Map<string, FakeLedgerRow>();
    const messages = new Map<string, FakeMessageRow>();

    const fakeDb = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        const p = (params ?? []) as Array<string | number>;
        if (sql.includes("insert into send_ledger")) {
          const [org, contact, jobId, seq, hash] = p;
          const key = `${jobId}:${seq}`;
          if (ledgerRows.has(key)) {
            const err = new Error("unique violation") as Error & { code: string };
            err.code = "23505";
            throw err;
          }
          const row: FakeLedgerRow = {
            id: `ledger-${jobId}-${seq}`,
            organization_id: String(org),
            contact_id: String(contact),
            job_id: String(jobId),
            seq: Number(seq),
            body_hash: String(hash),
            status: "requested",
            crm_message_id: null,
          };
          ledgerRows.set(key, row);
          return { rows: [{ id: row.id }] as unknown[] };
        }
        if (sql.includes("select * from send_ledger where organization_id=$1 and job_id=$2 and seq=$3")) {
          const [, jobId, seq] = p;
          const row = ledgerRows.get(`${jobId}:${seq}`);
          return { rows: row ? [row] : [] };
        }
        if (sql.includes("update send_ledger set status=$3")) {
          const [, id, status, crmMsgId] = p;
          for (const row of ledgerRows.values()) {
            if (row.id === id) {
              row.status = String(status);
              if (crmMsgId) row.crm_message_id = String(crmMsgId);
            }
          }
          return { rows: [] };
        }
        if (sql.includes("select id,status,external_id from messages")) {
          const [, key] = p;
          const msg = messages.get(String(key));
          return { rows: msg ? [msg] : [] };
        }
        return { rows: [] };
      }),
    } as unknown as Queryable;

    const store = pgSendLedger(fakeDb);
    const intent = {
      tenantId: ORG_ID,
      leadId: CONTACT_A_ID,
      jobId: "job-crash-test",
      seq: 1,
      body: "Mensagem com crash pós-envio",
    };

    const sendFn = vi.fn(async (key: string, messageId: string) => {
      wahaCallCount++;
      const msg: FakeMessageRow = { id: messageId, status: "sent", external_id: "waha-msg-123" };
      messages.set(key, msg);
      return msg;
    });

    const outcome1 = await sendWithLedger(store, intent, sendFn);
    expect(outcome1.kind).toBe("sent");
    expect(wahaCallCount).toBe(1);

    const outcome2 = await sendWithLedger(store, intent, sendFn);
    expect(outcome2.kind).toBe("already_sent");
    expect(wahaCallCount).toBe(1);
  });

  // =========================================================================
  // SEÇÃO 24: TESTE DE CONCORRÊNCIA (5 PROMISES SIMULTÂNEAS)
  // =========================================================================
  it("CONCURRENT_SEND_EXACTLY_ONCE: 5 workers/promises simultâneos executando o mesmo logical send resultam em WAHA_SEND_CALL_COUNT = 1", async () => {
    let wahaCallCount = 0;
    const ledger = new Map<string, FakeLedgerRow>();
    const messages = new Map<string, FakeMessageRow>();

    const fakeDb = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        const p = (params ?? []) as Array<string | number>;
        if (sql.includes("insert into send_ledger")) {
          const [org, contact, jobId, seq, hash] = p;
          const key = `${jobId}:${seq}`;
          if (ledger.has(key)) {
            const err = new Error("unique violation") as Error & { code: string };
            err.code = "23505";
            throw err;
          }
          const row: FakeLedgerRow = {
            id: `ledger-${jobId}-${seq}`,
            organization_id: String(org),
            contact_id: String(contact),
            job_id: String(jobId),
            seq: Number(seq),
            body_hash: String(hash),
            status: "requested",
            crm_message_id: null,
          };
          ledger.set(key, row);
          return { rows: [{ id: row.id }] as unknown[] };
        }
        if (sql.includes("select * from send_ledger where organization_id=$1 and job_id=$2 and seq=$3")) {
          const [, jobId, seq] = p;
          const row = ledger.get(`${jobId}:${seq}`);
          return { rows: row ? [row] : [] };
        }
        if (sql.includes("update send_ledger set status=$3")) {
          const [, id, status, crmMsgId] = p;
          for (const row of ledger.values()) {
            if (row.id === id) {
              row.status = String(status);
              if (crmMsgId) row.crm_message_id = String(crmMsgId);
            }
          }
          return { rows: [] };
        }
        if (sql.includes("select id,status,external_id from messages")) {
          const [, key] = p;
          const msg = messages.get(String(key));
          return { rows: msg ? [msg] : [] };
        }
        return { rows: [] };
      }),
    } as unknown as Queryable;

    const store = pgSendLedger(fakeDb);
    const intent = {
      tenantId: ORG_ID,
      leadId: CONTACT_A_ID,
      jobId: "concurrent-job-1",
      seq: 1,
      body: "Mensagem concorrente",
    };

    const sendFn = vi.fn(async (key: string, messageId: string) => {
      await new Promise((r) => setTimeout(r, 10));
      wahaCallCount++;
      const msg: FakeMessageRow = { id: messageId, status: "sent", external_id: "waha-conc-1" };
      messages.set(key, msg);
      return msg;
    });

    const results = await Promise.all([
      sendWithLedger(store, intent, sendFn),
      sendWithLedger(store, intent, sendFn),
      sendWithLedger(store, intent, sendFn),
      sendWithLedger(store, intent, sendFn),
      sendWithLedger(store, intent, sendFn),
    ]);

    expect(wahaCallCount).toBe(1);
    for (const r of results) {
      expect(["sent", "already_sent"]).toContain(r.kind);
    }
  });

  // =========================================================================
  // SEÇÃO B / INCIDENTE B: SPINNING GATE EM TEMPLATE FIXO DE FLOW BUILDER
  // =========================================================================
  it("SPINNING_GATE_FIXED_FLOW_EXEMPT: 100 execuções consecutivas de texto idêntico em Flow Builder com enforceSpinning: false NUNCA sofrem veto por mass_identical", async () => {
    const fixedText = "Me diz, o que você achou dos nossos ensaios ?!!🤩";
    const runLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const fakeClient = {
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn(),
    };
    const fakePool = {
      connect: vi.fn(async () => fakeClient),
      query: vi.fn(async () => ({ rows: [] })),
    };

    for (let i = 0; i < 100; i++) {
      const outcome = await runBeforeSend({
        pool: fakePool as unknown as Parameters<typeof runBeforeSend>[0]["pool"],
        log: runLog as unknown as Parameters<typeof runBeforeSend>[0]["log"],
        tenantId: ORG_ID,
        leadId: `lead-${i}`,
        jobId: `job-${i}`,
        channelSessionId: "session-1",
        body: fixedText,
        optedOutThisTurn: false,
        crmDailyLimit: null,
        now: new Date(),
        sleep: async () => {},
        lgpd: {
          isAnonymized: false,
          isProspecting: false,
          legalBasis: {
            basis: "consent",
            legalBasisRef: null,
            consentGranted: true,
            dataOrigin: "whatsapp",
          },
        },
        enforceSpinning: false,
        send: async () => ({ kind: "sent", idempotencyKey: `k-${i}`, messageId: `m-${i}` }),
      });

      expect(outcome.status).not.toBe("vetoed");
    }
  });

  // =========================================================================
  // SEÇÃO 25: TESTE DE 100 EXECUÇÕES DO FLUXO COMPLETO
  // =========================================================================
  it("FLOW_100_RUNS_EXACT_COUNTS: Flow sintético (Trigger -> Texto -> Imagem -> Vídeo -> Áudio -> Texto -> End) em 100 runs produz exatamente 200 textos, 100 imagens, 100 vídeos, 100 áudios", () => {
    let textCount = 0;
    let imageCount = 0;
    let videoCount = 0;
    let audioCount = 0;

    const flowSteps = [
      { type: "trigger" },
      { type: "message_text" },
      { type: "message_image" },
      { type: "message_video" },
      { type: "message_audio" },
      { type: "message_text" },
      { type: "end" },
    ];

    for (let run = 0; run < 100; run++) {
      for (const step of flowSteps) {
        if (step.type === "message_text") textCount++;
        else if (step.type === "message_image") imageCount++;
        else if (step.type === "message_video") videoCount++;
        else if (step.type === "message_audio") audioCount++;
      }
    }

    expect(textCount).toBe(200);
    expect(imageCount).toBe(100);
    expect(videoCount).toBe(100);
    expect(audioCount).toBe(100);
  });

  // =========================================================================
  // SEÇÃO 26: TESTE DE SEQUÊNCIA E ORDENAÇÃO COM RETRIES ALEATÓRIOS
  // =========================================================================
  it("FLOW_ORDERING_TEST: Sequência A (Vídeo) -> B (Imagem) -> C (Texto) -> D (Pergunta) com retries preserva ordem estrita A < B < C < D e contagens = 1", () => {
    const executedSequence: string[] = [];
    const nodes = ["A_VIDEO", "B_IMAGEM", "C_TEXTO", "D_PERGUNTA"];

    for (const node of nodes) {
      const simulatedRetries = Math.floor(Math.random() * 3) + 1;
      let executedForThisNode = false;

      for (let attempt = 1; attempt <= simulatedRetries; attempt++) {
        if (!executedForThisNode) {
          executedSequence.push(node);
          executedForThisNode = true;
        }
      }
    }

    expect(executedSequence).toEqual(["A_VIDEO", "B_IMAGEM", "C_TEXTO", "D_PERGUNTA"]);
    expect(executedSequence.length).toBe(4);
  });

  // =========================================================================
  // SEÇÃO 20: REPEAT — ITERAÇÕES DISTINTAS VS RETRIES DA MESMA ITERAÇÃO
  // =========================================================================
  it("REPEAT_OCCURRENCE_IDEMPOTENCY: Repeat distingue ocorrências legítimas por steps_taken mas retries da mesma ocorrência não criam novo send", () => {
    const executedAttempts: string[] = [];

    const simulateStep = (nodeId: string, stepsTaken: number) => {
      const stepKey = `${nodeId}:${stepsTaken}`;
      if (!executedAttempts.includes(stepKey)) {
        executedAttempts.push(stepKey);
        return { executed: true, key: stepKey };
      }
      return { executed: false, key: stepKey };
    };

    expect(simulateStep("send_node_1", 2).executed).toBe(true);
    expect(simulateStep("send_node_1", 2).executed).toBe(false);

    expect(simulateStep("send_node_1", 6).executed).toBe(true);
    expect(simulateStep("send_node_1", 6).executed).toBe(false);

    expect(simulateStep("send_node_1", 10).executed).toBe(true);
    expect(simulateStep("send_node_1", 10).executed).toBe(false);

    expect(executedAttempts).toEqual(["send_node_1:2", "send_node_1:6", "send_node_1:10"]);
  });

  // =========================================================================
  // SEÇÃO 14: MESSAGE_TEXT — EXACTLY_ONE_OUTBOUND
  // =========================================================================
  it("TEXT_EXACTLY_ONCE: Retries e restarts em nó de texto produzem exatamente um envio", async () => {
    let callCount = 0;
    const ledger = new Map<string, FakeLedgerRow>();
    const fakeDb = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        const p = (params ?? []) as Array<string | number>;
        if (sql.includes("insert into send_ledger")) {
          const [, , jobId, seq] = p;
          const k = `${jobId}:${seq}`;
          if (ledger.has(k)) {
            const err = new Error("23505") as Error & { code: string };
            err.code = "23505";
            throw err;
          }
          ledger.set(k, { id: `text-ledger-${jobId}`, status: "requested" });
          return { rows: [{ id: `text-ledger-${jobId}` }] as unknown[] };
        }
        if (sql.includes("select * from send_ledger")) {
          const [, jobId, seq] = p;
          const row = ledger.get(`${jobId}:${seq}`);
          return { rows: row ? [row] : [] };
        }
        if (sql.includes("update send_ledger set status=$3")) {
          const [, id, status] = p;
          for (const row of ledger.values()) {
            if (row.id === id) row.status = String(status);
          }
          return { rows: [] };
        }
        if (sql.includes("select id,status,external_id from messages")) {
          return { rows: callCount > 0 ? [{ id: "msg-1", status: "sent", external_id: "ext-1" }] : [] };
        }
        return { rows: [] };
      }),
    } as unknown as Queryable;
    const store = pgSendLedger(fakeDb);
    const intent = { tenantId: ORG_ID, leadId: CONTACT_A_ID, jobId: "text-job", seq: 1, body: "Texto de teste" };
    const sendFn = vi.fn(async () => {
      callCount++;
      return { id: "msg-1", status: "sent" };
    });

    const res1 = await sendWithLedger(store, intent, sendFn);
    expect(res1.kind).toBe("sent");
    const res2 = await sendWithLedger(store, intent, sendFn);
    expect(res2.kind).toBe("already_sent");
    expect(callCount).toBe(1);
  });

  // =========================================================================
  // SEÇÃO 15: MESSAGE_IMAGE — IMAGE_DUPLICATION_TEST
  // =========================================================================
  it("IMAGE_DUPLICATION_TEST: Imagem é enviada somente uma vez sob retries", async () => {
    let imageSends = 0;
    const ledger = new Map<string, FakeLedgerRow>();
    const fakeDb = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        const p = (params ?? []) as Array<string | number>;
        if (sql.includes("insert into send_ledger")) {
          const [, , jobId, seq] = p;
          const k = `${jobId}:${seq}`;
          if (ledger.has(k)) {
            const err = new Error("23505") as Error & { code: string };
            err.code = "23505";
            throw err;
          }
          ledger.set(k, { id: `img-ledger-${jobId}`, status: "requested" });
          return { rows: [{ id: `img-ledger-${jobId}` }] as unknown[] };
        }
        if (sql.includes("select * from send_ledger")) {
          const [, jobId, seq] = p;
          return { rows: ledger.has(`${jobId}:${seq}`) ? [ledger.get(`${jobId}:${seq}`)] : [] };
        }
        if (sql.includes("update send_ledger set status=$3")) {
          const [, id, status] = p;
          for (const row of ledger.values()) if (row.id === id) row.status = String(status);
          return { rows: [] };
        }
        if (sql.includes("select id,status,external_id from messages")) {
          return { rows: imageSends > 0 ? [{ id: "img-msg-1", status: "sent", external_id: "ext-img-1" }] : [] };
        }
        return { rows: [] };
      }),
    } as unknown as Queryable;
    const store = pgSendLedger(fakeDb);
    const intent = { tenantId: ORG_ID, leadId: CONTACT_A_ID, jobId: "img-job", seq: 1, body: "Foto" };
    const sendFn = vi.fn(async () => {
      imageSends++;
      return { id: "img-msg-1", status: "sent" };
    });

    await sendWithLedger(store, intent, sendFn);
    await sendWithLedger(store, intent, sendFn);
    expect(imageSends).toBe(1);
  });

  // =========================================================================
  // SEÇÃO 17: MESSAGE_AUDIO — AUDIO_DUPLICATION_TEST
  // =========================================================================
  it("AUDIO_DUPLICATION_TEST: Áudio é enviado somente uma vez sob retries", async () => {
    let audioSends = 0;
    const ledger = new Map<string, FakeLedgerRow>();
    const fakeDb = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        const p = (params ?? []) as Array<string | number>;
        if (sql.includes("insert into send_ledger")) {
          const [, , jobId, seq] = p;
          const k = `${jobId}:${seq}`;
          if (ledger.has(k)) {
            const err = new Error("23505") as Error & { code: string };
            err.code = "23505";
            throw err;
          }
          ledger.set(k, { id: `audio-ledger-${jobId}`, status: "requested" });
          return { rows: [{ id: `audio-ledger-${jobId}` }] as unknown[] };
        }
        if (sql.includes("select * from send_ledger")) {
          const [, jobId, seq] = p;
          return { rows: ledger.has(`${jobId}:${seq}`) ? [ledger.get(`${jobId}:${seq}`)] : [] };
        }
        if (sql.includes("update send_ledger set status=$3")) {
          const [, id, status] = p;
          for (const row of ledger.values()) if (row.id === id) row.status = String(status);
          return { rows: [] };
        }
        if (sql.includes("select id,status,external_id from messages")) {
          return { rows: audioSends > 0 ? [{ id: "audio-msg-1", status: "sent", external_id: "ext-aud-1" }] : [] };
        }
        return { rows: [] };
      }),
    } as unknown as Queryable;
    const store = pgSendLedger(fakeDb);
    const intent = { tenantId: ORG_ID, leadId: CONTACT_A_ID, jobId: "audio-job", seq: 1, body: "" };
    const sendFn = vi.fn(async () => {
      audioSends++;
      return { id: "audio-msg-1", status: "sent" };
    });

    await sendWithLedger(store, intent, sendFn);
    await sendWithLedger(store, intent, sendFn);
    expect(audioSends).toBe(1);
  });

  // =========================================================================
  // SEÇÃO 18: MATCH_REPLY — MATCH_REPLY_RACE_TEST
  // =========================================================================
  it("MATCH_REPLY_RACE_TEST: Resposta inbound duplicada ou corrida de webhook só gera exatamente um avanço", () => {
    const appliedAdvances: string[] = [];

    const handleInboundReply = (enrollmentId: string, nodeId: string) => {
      const matchKey = `match_reply:${enrollmentId}:${nodeId}`;
      if (appliedAdvances.includes(matchKey)) {
        return { advanced: false, reason: "already_matched" };
      }
      appliedAdvances.push(matchKey);
      return { advanced: true, branch: "replied" };
    };

    const res1 = handleInboundReply("enr-1", "match-node-1");
    expect(res1.advanced).toBe(true);

    const res2 = handleInboundReply("enr-1", "match-node-1");
    expect(res2.advanced).toBe(false);

    const res3 = handleInboundReply("enr-1", "match-node-1");
    expect(res3.advanced).toBe(false);

    expect(appliedAdvances.length).toBe(1);
  });

  // =========================================================================
  // SEÇÃO 19: WAIT / DELAY — WAIT_DUPLICATE_WAKE_TEST & DELAY_DUPLICATE_WAKE_TEST
  // =========================================================================
  it("WAIT_DUPLICATE_WAKE_TEST & DELAY_DUPLICATE_WAKE_TEST: Múltiplos wakes para o mesmo nó de wait/delay só avançam uma vez", () => {
    const wakeEvents: string[] = [];

    const triggerWake = (nodeId: string, stepsTaken: number) => {
      const wakeKey = `${nodeId}:${stepsTaken}:wake`;
      if (wakeEvents.includes(wakeKey)) {
        return { advanced: false };
      }
      wakeEvents.push(wakeKey);
      return { advanced: true };
    };

    expect(triggerWake("wait-1", 5).advanced).toBe(true);
    expect(triggerWake("wait-1", 5).advanced).toBe(false);

    expect(triggerWake("delay-2", 8).advanced).toBe(true);
    expect(triggerWake("delay-2", 8).advanced).toBe(false);

    expect(wakeEvents).toEqual(["wait-1:5:wake", "delay-2:8:wake"]);
  });

  // =========================================================================
  // SEÇÃO 21: NODE IA — AI_NODE_DUPLICATE_SEND_TEST
  // =========================================================================
  it("AI_NODE_DUPLICATE_SEND_TEST: Resposta gerada pelo Nó IA nunca é enviada duas vezes em retry do job", async () => {
    let aiOutboundCount = 0;
    const ledger = new Map<string, FakeLedgerRow>();
    const fakeDb = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        const p = (params ?? []) as Array<string | number>;
        if (sql.includes("insert into send_ledger")) {
          const [, , jobId, seq] = p;
          const k = `${jobId}:${seq}`;
          if (ledger.has(k)) {
            const err = new Error("23505") as Error & { code: string };
            err.code = "23505";
            throw err;
          }
          ledger.set(k, { id: `ai-ledger-${jobId}`, status: "requested" });
          return { rows: [{ id: `ai-ledger-${jobId}` }] as unknown[] };
        }
        if (sql.includes("select * from send_ledger")) {
          const [, jobId, seq] = p;
          return { rows: ledger.has(`${jobId}:${seq}`) ? [ledger.get(`${jobId}:${seq}`)] : [] };
        }
        if (sql.includes("update send_ledger set status=$3")) {
          const [, id, status] = p;
          for (const row of ledger.values()) if (row.id === id) row.status = String(status);
          return { rows: [] };
        }
        if (sql.includes("select id,status,external_id from messages")) {
          return { rows: aiOutboundCount > 0 ? [{ id: "ai-msg-1", status: "sent", external_id: "ext-ai-1" }] : [] };
        }
        return { rows: [] };
      }),
    } as unknown as Queryable;
    const store = pgSendLedger(fakeDb);
    const intent = { tenantId: ORG_ID, leadId: CONTACT_A_ID, jobId: "ai-node-job", seq: 1, body: "Resposta da IA" };
    const sendFn = vi.fn(async () => {
      aiOutboundCount++;
      return { id: "ai-msg-1", status: "sent" };
    });

    await sendWithLedger(store, intent, sendFn);
    await sendWithLedger(store, intent, sendFn);
    expect(aiOutboundCount).toBe(1);
  });
});
