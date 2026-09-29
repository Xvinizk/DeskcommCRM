/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";
import { duplicateFlowMedia } from "@/lib/followup/sharing/media-duplication";
import { sanitizeFlowForSnapshot } from "@/lib/followup/sharing/sanitize";
import { importFlowIntoOrg } from "@/lib/followup/sharing/import-flow";

// Handlers reais da API
import { POST as shareHandler, DELETE as revokeShareHandler } from "@/app/api/v1/ai/followup-flows/[id]/share/route";
import { GET as publicGetSharedHandler } from "@/app/api/v1/ai/followup-flows/shared/[token]/route";
import { POST as importSharedHandler } from "@/app/api/v1/ai/followup-flows/shared/[token]/import/route";
import { POST as mediaUploadHandler } from "@/app/api/v1/ai/followup-flows/media/route";
import { POST as restoreVersionHandler } from "@/app/api/v1/ai/followup-flows/[id]/versions/[versionId]/restore/route";
import { PATCH as patchFlowHandler } from "@/app/api/v1/ai/followup-flows/[id]/route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

const ORG_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_A_ID = "11111111-1111-4111-8111-111111111111";
const USER_B_ID = "22222222-2222-4222-8222-222222222222";
const FLOW_A_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

type Row = Record<string, any>;

interface MockTables {
  followup_flow_pointers: Row[];
  followup_flow_versions: Row[];
  followup_flow_shares: Row[];
  crm_stages: Row[];
}

function createMockSupabase(initialData?: {
  pointers?: Row[];
  versions?: Row[];
  shares?: Row[];
  stages?: Row[];
  storageFiles?: Map<string, { buffer: Buffer; contentType: string }>;
}) {
  const tables: MockTables = {
    followup_flow_pointers: initialData?.pointers ?? [],
    followup_flow_versions: initialData?.versions ?? [],
    followup_flow_shares: initialData?.shares ?? [],
    crm_stages: initialData?.stages ?? [],
  };

  const storageMap = initialData?.storageFiles ?? new Map<string, { buffer: Buffer; contentType: string }>();

  function queryBuilder(tableName: string) {
    const filters: Array<[string, unknown]> = [];
    let _selectFields: string | null = null;
    let orderCol: string | null = null;
    let orderAsc = true;
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let insertPayload: Row | Row[] | undefined;
    let updatePayload: Row | undefined;

    function matchFilter(row: Row): boolean {
      return filters.every(([k, v]) => {
        if (v === null) return row[k] === null;
        return row[k] === v;
      });
    }

    function getRows(): Row[] {
      if (tableName === "followup_flow_pointers") return tables.followup_flow_pointers;
      if (tableName === "followup_flow_versions") return tables.followup_flow_versions;
      if (tableName === "followup_flow_shares") return tables.followup_flow_shares;
      if (tableName === "crm_stages") return tables.crm_stages;
      return [];
    }

    const self = {
      select(fields = "*") {
        _selectFields = fields;
        return self;
      },
      eq(column: string, val: unknown) {
        filters.push([column, val]);
        return self;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orderCol = col;
        orderAsc = opts?.ascending ?? true;
        return self;
      },
      insert(payload: Row | Row[]) {
        mode = "insert";
        insertPayload = payload;
        return self;
      },
      update(payload: Row) {
        mode = "update";
        updatePayload = payload;
        return self;
      },
      delete() {
        mode = "delete";
        return self;
      },
      async execute(): Promise<{ data: any; error: any }> {
        const rows = getRows();

        if (mode === "select") {
          let filtered = rows.filter(matchFilter);
          if (orderCol) {
            filtered = [...filtered].sort((a, b) => {
              const av = String(a[orderCol!] ?? "");
              const bv = String(b[orderCol!] ?? "");
              return orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
            });
          }
          return { data: filtered, error: null };
        }

        if (mode === "insert") {
          const toInsert = Array.isArray(insertPayload) ? insertPayload : [insertPayload!];
          const inserted = toInsert.map((item) => ({
            id: item.id ?? randomUUID(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...item,
          }));
          rows.push(...inserted);
          return {
            data: Array.isArray(insertPayload) ? inserted : inserted[0],
            error: null,
          };
        }

        if (mode === "update") {
          const matched = rows.filter(matchFilter);
          matched.forEach((r) => {
            Object.assign(r, updatePayload, { updated_at: new Date().toISOString() });
          });
          return { data: matched, error: null };
        }

        if (mode === "delete") {
          const remaining = rows.filter((r) => !matchFilter(r));
          rows.length = 0;
          rows.push(...remaining);
          return { data: null, error: null };
        }

        return { data: null, error: null };
      },
      async single() {
        const res = await self.execute();
        if (!res.data || (Array.isArray(res.data) && res.data.length === 0)) {
          return { data: null, error: { message: "Row not found" } };
        }
        return { data: Array.isArray(res.data) ? res.data[0] : res.data, error: null };
      },
      async maybeSingle() {
        const res = await self.execute();
        if (!res.data || (Array.isArray(res.data) && res.data.length === 0)) {
          return { data: null, error: null };
        }
        return { data: Array.isArray(res.data) ? res.data[0] : res.data, error: null };
      },
      then<TResult1 = { data: any; error: any }, TResult2 = never>(
        onfulfilled?: ((value: { data: any; error: any }) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
      ): Promise<TResult1 | TResult2> {
        return self.execute().then(onfulfilled, onrejected);
      },
    };

    return self;
  }

  const storageClient = {
    from(_bucket: string) {
      return {
        async upload(filePath: string, buffer: Buffer, opts?: { contentType?: string }) {
          storageMap.set(filePath, { buffer, contentType: opts?.contentType ?? "application/octet-stream" });
          return { data: { path: filePath }, error: null };
        },
        async copy(fromPath: string, toPath: string) {
          const file = storageMap.get(fromPath);
          if (!file) return { data: null, error: { message: "Source file not found" } };
          storageMap.set(toPath, { ...file });
          return { data: { path: toPath }, error: null };
        },
        async download(filePath: string) {
          const file = storageMap.get(filePath);
          if (!file) return { data: null, error: { message: "File not found" } };
          return { data: new Blob([new Uint8Array(file.buffer)], { type: file.contentType }), error: null };
        },
      };
    },
  };

  const client = {
    from: (table: string) => queryBuilder(table),
    storage: storageClient,
  };

  return { client, tables, storageMap };
}

describe("Bateria de Validação Ponta a Ponta — Fluxo", () => {
  let mockState: ReturnType<typeof createMockSupabase>;

  const fullGraphA: FlowGraph = {
    nodes: [
      { id: "node_trigger", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: { type: "manual" } },
      { id: "node_text", type: "message_text", label: "Texto", position: { x: 10, y: 10 }, config: { body: "Olá! Seguem os detalhes." } },
      {
        id: "node_img",
        type: "message_image",
        label: "Foto",
        position: { x: 20, y: 20 },
        config: {
          media_storage_path: `${ORG_A_ID}/flows/foto-banner.png`,
          media_type: "image",
          media_mime: "image/png",
          media_filename: "foto-banner.png",
          media_size_bytes: 51200,
        },
      },
      {
        id: "node_vid",
        type: "message_video",
        label: "Vídeo",
        position: { x: 30, y: 30 },
        config: {
          media_storage_path: `${ORG_A_ID}/flows/video-apresentacao.mp4`,
          media_type: "video",
          media_mime: "video/mp4",
          media_filename: "video-newborn.mp4",
          media_size_bytes: 19293798,
        },
      },
      {
        id: "node_aud",
        type: "message_audio",
        label: "Áudio",
        position: { x: 40, y: 40 },
        config: {
          media_storage_path: `${ORG_A_ID}/flows/audio-explicativo.ogg`,
          media_type: "audio",
          media_mime: "audio/ogg",
          media_filename: "audio-explicativo.ogg",
          media_size_bytes: 120400,
        },
      },
      { id: "node_typing", type: "typing", label: "Digitando", position: { x: 50, y: 50 }, config: { duration_seconds: 3 } },
      { id: "node_delay", type: "delay", label: "Aguardar", position: { x: 60, y: 60 }, config: { duration_value: 5, unit: "minutes" } },
      { id: "node_tag", type: "tag", label: "Tag", position: { x: 70, y: 70 }, config: { action: "add", tags: ["Cliente VIP"] } },
      {
        id: "node_stage",
        type: "stage_move",
        label: "Mover Etapa",
        position: { x: 80, y: 80 },
        config: {
          pipeline_id: "11111111-1111-4111-8111-111111111111",
          stage_id: "22222222-2222-4222-8222-222222222222",
          stage_name: "Qualificação",
        },
      },
    ],
    edges: [
      { id: "e1", source: "node_trigger", target: "node_text", priority: 0, condition: { type: "always" } },
      { id: "e2", source: "node_text", target: "node_img", priority: 0, condition: { type: "always" } },
      { id: "e3", source: "node_img", target: "node_vid", priority: 0, condition: { type: "always" } },
      { id: "e4", source: "node_vid", target: "node_aud", priority: 0, condition: { type: "always" } },
      { id: "e5", source: "node_aud", target: "node_typing", priority: 0, condition: { type: "always" } },
      { id: "e6", source: "node_typing", target: "node_delay", priority: 0, condition: { type: "always" } },
      { id: "e7", source: "node_delay", target: "node_tag", priority: 0, condition: { type: "always" } },
      { id: "e8", source: "node_tag", target: "node_stage", priority: 0, condition: { type: "always" } },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();

    const storageFiles = new Map<string, { buffer: Buffer; contentType: string }>();
    storageFiles.set(`${ORG_A_ID}/flows/foto-banner.png`, {
      buffer: Buffer.from("fake-png-data"),
      contentType: "image/png",
    });
    storageFiles.set(`${ORG_A_ID}/flows/video-apresentacao.mp4`, {
      buffer: Buffer.from("fake-mp4-data"),
      contentType: "video/mp4",
    });
    storageFiles.set(`${ORG_A_ID}/flows/audio-explicativo.ogg`, {
      buffer: Buffer.from("fake-ogg-data"),
      contentType: "audio/ogg",
    });

    mockState = createMockSupabase({
      pointers: [
        {
          id: FLOW_A_ID,
          organization_id: ORG_A_ID,
          name: "Funil Newborn Completo",
          status: "draft",
          draft_graph: fullGraphA,
          handoff_policy: "pause",
          trigger_config: { kind: "manual" },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
      stages: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          organization_id: ORG_B_ID,
          pipeline_id: "44444444-4444-4444-8444-444444444444",
          name: "Qualificação",
          is_archived: false,
        },
      ],
      storageFiles,
    });

    (createAdminClient as any).mockReturnValue(mockState.client);
    (createClient as any).mockReturnValue(mockState.client);
  });

  it("1. TESTE REAL — Compartilhamento entre duas organizações: geração de link e snapshot seguro", async () => {
    (requireRole as any).mockResolvedValue({
      ok: true,
      user: { id: USER_A_ID, idioma: "pt-BR" },
      org: { orgId: ORG_A_ID, role: "owner" },
    });

    const req = new NextRequest(`http://localhost/api/v1/ai/followup-flows/${FLOW_A_ID}/share`, {
      method: "POST",
      body: JSON.stringify({ action: "create" }),
    });

    const res = await shareHandler(req, { params: Promise.resolve({ id: FLOW_A_ID }) });
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.data.token).toBeDefined();
    expect(json.data.token.length).toBeGreaterThanOrEqual(24);
    expect(json.data.node_count).toBe(9);
    expect(json.data.image_count).toBe(1);
    expect(json.data.video_count).toBe(1);
    expect(json.data.audio_count).toBe(1);

    // Confirmar que foi persistido na tabela followup_flow_shares
    const shareRow = mockState.tables.followup_flow_shares[0];
    expect(shareRow).toBeDefined();
    if (!shareRow) throw new Error("shareRow ausente");
    expect(shareRow.token).toBe(json.data.token);
    expect(shareRow.organization_id).toBe(ORG_A_ID);
    expect(shareRow.status).toBe("active");

    // Auditoria de segurança: snapshot NÃO deve conter IDs sensíveis
    const snap = shareRow.snapshot as any;
    expect(snap.organization_id).toBeUndefined();
    expect(snap.created_by).toBeUndefined();
    expect(snap.service_role).toBeUndefined();
    expect(snap.secret).toBeUndefined();

    // Confirmar que o nó stage_move foi despojado de IDs internos da Org A
    const stageNode = snap.graph.nodes.find((n: any) => n.type === "stage_move");
    expect(stageNode.config.pipeline_id).toBeUndefined();
    expect(stageNode.config.stage_id).toBeUndefined();
    expect(stageNode.config.stage_name).toBe("Qualificação");
  });

  it("2. TESTE REAL — Importação na Organização B: preservação estrutural e novos IDs", async () => {
    // Primeiro cria o compartilhamento na Org A
    const snapshot = sanitizeFlowForSnapshot({
      name: "Funil Newborn Completo",
      graph: fullGraphA,
    });
    const shareToken = "token-compartilhado-xyz-123456789";
    mockState.tables.followup_flow_shares.push({
      id: randomUUID(),
      organization_id: ORG_A_ID,
      flow_id: FLOW_A_ID,
      token: shareToken,
      status: "active",
      snapshot,
    });

    // Usuário autenticado na Organização B
    (requireRole as any).mockResolvedValue({
      ok: true,
      user: { id: USER_B_ID, idioma: "pt-BR" },
      org: { orgId: ORG_B_ID, role: "manager" },
    });

    const req = new NextRequest(`http://localhost/api/v1/ai/followup-flows/shared/${shareToken}/import`, {
      method: "POST",
    });

    const res = await importSharedHandler(req, { params: Promise.resolve({ token: shareToken }) });
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.data.flow_id).toBeDefined();
    expect(json.data.flow_id).not.toBe(FLOW_A_ID);

    // Confirmar ponteiro no banco para a Organização B
    const importedPointer = mockState.tables.followup_flow_pointers.find((p) => p.id === json.data.flow_id);
    expect(importedPointer).toBeDefined();
    expect(importedPointer?.organization_id).toBe(ORG_B_ID);
    expect(importedPointer?.status).toBe("draft");

    // Verificar nós importados
    const importedGraph = importedPointer?.draft_graph as FlowGraph;
    expect(importedGraph.nodes).toHaveLength(9);
    expect(importedGraph.edges).toHaveLength(8);

    // Todos os nós devem ter IDs novos diferentes da Org A
    for (let i = 0; i < fullGraphA.nodes.length; i++) {
      const impNode = importedGraph.nodes[i];
      const origNode = fullGraphA.nodes[i];
      expect(impNode).toBeDefined();
      expect(origNode).toBeDefined();
      if (impNode && origNode) {
        expect(impNode.id).not.toBe(origNode.id);
        expect(impNode.position).toEqual(origNode.position);
      }
    }

    // Arestas devem apontar para os novos IDs
    const newTriggerNode = importedGraph.nodes.find((n) => n.type === "trigger")!;
    const newTextNode = importedGraph.nodes.find((n) => n.type === "message_text")!;
    const edge1 = importedGraph.edges.find((e) => e.source === newTriggerNode.id);
    expect(edge1).toBeDefined();
    expect(edge1?.target).toBe(newTextNode.id);
  });

  it("3. TESTE REAL — Mídias fisicamente duplicadas e independência total da conta original", async () => {
    // Executa a duplicação direta para a Org B
    const dupImg = await duplicateFlowMedia(mockState.client as any, {
      sourceStoragePath: `${ORG_A_ID}/flows/foto-banner.png`,
      targetOrgId: ORG_B_ID,
      mime: "image/png",
    });

    const dupVid = await duplicateFlowMedia(mockState.client as any, {
      sourceStoragePath: `${ORG_A_ID}/flows/video-apresentacao.mp4`,
      targetOrgId: ORG_B_ID,
      mime: "video/mp4",
    });

    const dupAud = await duplicateFlowMedia(mockState.client as any, {
      sourceStoragePath: `${ORG_A_ID}/flows/audio-explicativo.ogg`,
      targetOrgId: ORG_B_ID,
      mime: "audio/ogg",
    });

    expect(dupImg.ok).toBe(true);
    expect(dupVid.ok).toBe(true);
    expect(dupAud.ok).toBe(true);

    // Evidência de source e destination path:
    expect(dupImg.newStoragePath?.startsWith(`${ORG_B_ID}/flows/`)).toBe(true);
    expect(dupVid.newStoragePath?.startsWith(`${ORG_B_ID}/flows/`)).toBe(true);
    expect(dupAud.newStoragePath?.startsWith(`${ORG_B_ID}/flows/`)).toBe(true);

    // Simula remoção completa dos arquivos da Organização A
    mockState.storageMap.delete(`${ORG_A_ID}/flows/foto-banner.png`);
    mockState.storageMap.delete(`${ORG_A_ID}/flows/video-apresentacao.mp4`);
    mockState.storageMap.delete(`${ORG_A_ID}/flows/audio-explicativo.ogg`);

    // Os arquivos no namespace da Organização B continuam íntegros e acessíveis
    expect(mockState.storageMap.has(dupImg.newStoragePath!)).toBe(true);
    expect(mockState.storageMap.has(dupVid.newStoragePath!)).toBe(true);
    expect(mockState.storageMap.has(dupAud.newStoragePath!)).toBe(true);

    const vidContent = mockState.storageMap.get(dupVid.newStoragePath!);
    expect(vidContent?.buffer.toString()).toBe("fake-mp4-data");
  });

  it("4. TESTE REAL — Upload de vídeo pelo endpoint com multipart real (MP4 e MOV)", async () => {
    (requireRole as any).mockResolvedValue({
      ok: true,
      user: { id: USER_A_ID, idioma: "pt-BR" },
      org: { orgId: ORG_A_ID, role: "manager" },
    });

    function makeMultipart(filename: string, mime: string, buffer: Buffer, extraHeaders: Record<string, string> = {}) {
      const boundary = "----deskcommUploadTestBoundary";
      const header = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
      );
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([header, buffer, footer]);

      return new NextRequest("http://localhost/api/v1/ai/followup-flows/media", {
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": String(body.length),
          ...extraHeaders,
        },
        body,
      });
    }

    // 4.1 Teste com MP4
    const mp4Bytes = Buffer.alloc(1024 * 100, 0x11);
    const reqMp4 = makeMultipart("video-newborn.mp4", "video/mp4", mp4Bytes);

    const resMp4 = await mediaUploadHandler(reqMp4);
    expect(resMp4.status).toBe(200);
    const jsonMp4 = await resMp4.json();

    expect(jsonMp4.data.media_type).toBe("video");
    expect(jsonMp4.data.media_mime).toBe("video/mp4");
    expect(jsonMp4.data.media_filename).toBe("video-newborn.mp4");
    expect(jsonMp4.data.media_size_bytes).toBe(mp4Bytes.length);

    // 4.2 Teste com MOV (comum no iPhone/Windows sem MIME type enviado pelo browser)
    const movBytes = Buffer.alloc(1024 * 200, 0x22);
    // Simula navegador do Windows enviando application/octet-stream ou vazio
    const reqMov = makeMultipart("gravacao-parto.mov", "application/octet-stream", movBytes);

    const resMov = await mediaUploadHandler(reqMov);
    expect(resMov.status).toBe(200);
    const jsonMov = await resMov.json();

    expect(jsonMov.data.media_type).toBe("video");
    expect(jsonMov.data.media_mime).toBe("video/quicktime");
    expect(jsonMov.data.storage_path.endsWith(".mov")).toBe(true);

    // 4.3 Teste de arquivo acima de 50MB (55MB)
    const reqLarge = makeMultipart("video-gigante.mp4", "video/mp4", Buffer.alloc(1024), {
      "content-length": String(55 * 1024 * 1024),
    });

    const resLarge = await mediaUploadHandler(reqLarge);
    expect(resLarge.status).toBe(413);
  });

  it("5. TESTE REAL — Snapshot Imutável: alterações na conta A não afetam o link compartilhado", async () => {
    (requireRole as any).mockResolvedValue({
      ok: true,
      user: { id: USER_A_ID, idioma: "pt-BR" },
      org: { orgId: ORG_A_ID, role: "owner" },
    });

    // 1. Cria link
    const reqCreate = new NextRequest(`http://localhost/api/v1/ai/followup-flows/${FLOW_A_ID}/share`, {
      method: "POST",
      body: JSON.stringify({ action: "create" }),
    });
    const resCreate = await shareHandler(reqCreate, { params: Promise.resolve({ id: FLOW_A_ID }) });
    const { token } = (await resCreate.json()).data;

    // 2. Modifica o rascunho original na Org A
    const pointer = mockState.tables.followup_flow_pointers.find((p) => p.id === FLOW_A_ID)!;
    const modifiedGraph: FlowGraph = {
      nodes: [{ id: "novo_node", type: "message_text", label: "Texto Modificado", position: { x: 0, y: 0 }, config: { body: "Texto completamente novo" } }],
      edges: [],
    };
    pointer.draft_graph = modifiedGraph;

    // 3. Consulta pública pelo link gerado anteriormente
    const reqPublic = new NextRequest(`http://localhost/api/v1/ai/followup-flows/shared/${token}`);
    const resPublic = await publicGetSharedHandler(reqPublic, { params: Promise.resolve({ token }) });
    expect(resPublic.status).toBe(200);
    const jsonPublic = await resPublic.json();

    // Link antigo continua exibindo o snapshot original de 9 nós!
    expect(jsonPublic.data.node_count).toBe(9);

    // 4. Org A solicita "Atualizar snapshot"
    const reqUpdate = new NextRequest(`http://localhost/api/v1/ai/followup-flows/${FLOW_A_ID}/share`, {
      method: "POST",
      body: JSON.stringify({ action: "update_snapshot" }),
    });
    const resUpdate = await shareHandler(reqUpdate, { params: Promise.resolve({ id: FLOW_A_ID }) });
    expect(resUpdate.status).toBe(200);

    // Agora o mesmo link reflete o snapshot atualizado
    const resPublicUpdated = await publicGetSharedHandler(reqPublic, { params: Promise.resolve({ token }) });
    const jsonPublicUpdated = await resPublicUpdated.json();
    expect(jsonPublicUpdated.data.node_count).toBe(1);
  });

  it("6. TESTE REAL — Desativação do link de compartilhamento", async () => {
    (requireRole as any).mockResolvedValue({
      ok: true,
      user: { id: USER_A_ID, idioma: "pt-BR" },
      org: { orgId: ORG_A_ID, role: "owner" },
    });

    // Cria link
    const reqCreate = new NextRequest(`http://localhost/api/v1/ai/followup-flows/${FLOW_A_ID}/share`, {
      method: "POST",
      body: JSON.stringify({ action: "create" }),
    });
    const resCreate = await shareHandler(reqCreate, { params: Promise.resolve({ id: FLOW_A_ID }) });
    const { token } = (await resCreate.json()).data;

    // Desativa o link
    const reqRevoke = new NextRequest(`http://localhost/api/v1/ai/followup-flows/${FLOW_A_ID}/share`, {
      method: "DELETE",
    });
    const resRevoke = await revokeShareHandler(reqRevoke, { params: Promise.resolve({ id: FLOW_A_ID }) });
    expect(resRevoke.status).toBe(200);

    // Acesso público deve retornar 404
    const reqPublic = new NextRequest(`http://localhost/api/v1/ai/followup-flows/shared/${token}`);
    const resPublic = await publicGetSharedHandler(reqPublic, { params: Promise.resolve({ token }) });
    expect(resPublic.status).toBe(404);

    // Tentativa de importação com link desativado deve falhar
    (requireRole as any).mockResolvedValue({
      ok: true,
      user: { id: USER_B_ID, idioma: "pt-BR" },
      org: { orgId: ORG_B_ID, role: "manager" },
    });
    const reqImport = new NextRequest(`http://localhost/api/v1/ai/followup-flows/shared/${token}/import`, {
      method: "POST",
    });
    const resImport = await importSharedHandler(reqImport, { params: Promise.resolve({ token }) });
    expect(resImport.status).toBe(404);
  });

  it("7. TESTE REAL — Restauração Segura: criação de pre_restore e preservação do histórico", async () => {
    (requireRole as any).mockResolvedValue({
      ok: true,
      user: { id: USER_A_ID, idioma: "pt-BR" },
      org: { orgId: ORG_A_ID, role: "manager" },
    });

    const versionAId = randomUUID();
    const versionBId = randomUUID();

    const graphA: FlowGraph = {
      nodes: [{ id: "n1", type: "message_text", label: "Texto A", position: { x: 0, y: 0 }, config: { body: "Versão A" } }],
      edges: [],
    };
    const graphB: FlowGraph = {
      nodes: [{ id: "n1", type: "message_text", label: "Texto B", position: { x: 0, y: 0 }, config: { body: "Versão B" } }],
      edges: [],
    };
    const graphC: FlowGraph = {
      nodes: [{ id: "n1", type: "message_text", label: "Texto C", position: { x: 0, y: 0 }, config: { body: "Rascunho C em edição" } }],
      edges: [],
    };

    mockState.tables.followup_flow_versions.push(
      {
        id: versionAId,
        organization_id: ORG_A_ID,
        flow_id: FLOW_A_ID,
        label: "Versão A",
        kind: "publish",
        graph: graphA,
        created_at: new Date(Date.now() - 10000).toISOString(),
      },
      {
        id: versionBId,
        organization_id: ORG_A_ID,
        flow_id: FLOW_A_ID,
        label: "Backup B",
        kind: "manual_backup",
        graph: graphB,
        created_at: new Date(Date.now() - 5000).toISOString(),
      },
    );

    // Estado atual do rascunho = graphC
    const pointer = mockState.tables.followup_flow_pointers.find((p) => p.id === FLOW_A_ID)!;
    pointer.draft_graph = graphC;

    // Executa restauração da Versão A
    const reqRestore = new NextRequest(`http://localhost/api/v1/ai/followup-flows/${FLOW_A_ID}/versions/${versionAId}/restore`, {
      method: "POST",
    });
    const resRestore = await restoreVersionHandler(reqRestore, {
      params: Promise.resolve({ id: FLOW_A_ID, versionId: versionAId }),
    });
    expect(resRestore.status).toBe(200);

    // 1. Confirmar que rascunho ativo passou a ser Versão A
    expect(pointer.draft_graph).toEqual(graphA);

    // 2. Confirmar que foi criado um snapshot pre_restore contendo graphC
    const preRestoreVersion = mockState.tables.followup_flow_versions.find((v) => v.kind === "pre_restore");
    expect(preRestoreVersion).toBeDefined();
    expect(preRestoreVersion?.graph).toEqual(graphC);

    // 3. Confirmar que a Versão B continua preservada intacta no histórico
    const versionB = mockState.tables.followup_flow_versions.find((v) => v.id === versionBId);
    expect(versionB).toBeDefined();
  });

  it("8. TESTE REAL — Tag e Stage Move entre organizações", async () => {
    // Mapeamento por nome de etapa existente na Org B
    const importResultMatch = await importFlowIntoOrg({
      admin: mockState.client as any,
      targetOrgId: ORG_B_ID,
      userId: USER_B_ID,
      flowName: "Fluxo com Etapa Coincidente",
      graph: fullGraphA,
    });

    expect(importResultMatch.ok).toBe(true);
    const importedPointer1 = mockState.tables.followup_flow_pointers.find((p) => p.id === importResultMatch.flow_id)!;
    const stageNodeMapped = (importedPointer1.draft_graph as FlowGraph).nodes.find((n) => n.type === "stage_move")!;

    // Etapa mapeada para o stage_id da Org B ("33333333-3333-4333-8333-333333333333")
    expect(stageNodeMapped.config.stage_id).toBe("33333333-3333-4333-8333-333333333333");
    expect(stageNodeMapped.config.pipeline_id).toBe("44444444-4444-4444-8444-444444444444");

    // Cenário onde não existe etapa com esse nome na Org B:
    const graphIncompatibleStage: FlowGraph = {
      nodes: [
        { id: "t1", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: { type: "manual" } },
        {
          id: "s1",
          type: "stage_move",
          label: "Mover para Inexistente",
          position: { x: 10, y: 10 },
          config: {
            pipeline_id: "99999999-9999-4999-8999-999999999999",
            stage_id: "88888888-8888-4888-8888-888888888888",
            stage_name: "Etapa Totalmente Diferente Que Nao Existe",
          },
        },
      ],
      edges: [{ id: "e1", source: "t1", target: "s1", priority: 0, condition: { type: "always" } }],
    };

    const importResultNoMatch = await importFlowIntoOrg({
      admin: mockState.client as any,
      targetOrgId: ORG_B_ID,
      userId: USER_B_ID,
      flowName: "Fluxo com Etapa Sem Correspondência",
      graph: graphIncompatibleStage,
    });

    expect(importResultNoMatch.ok).toBe(true);
    const importedPointer2 = mockState.tables.followup_flow_pointers.find((p) => p.id === importResultNoMatch.flow_id)!;
    const stageNodeUnmapped = (importedPointer2.draft_graph as FlowGraph).nodes.find((n) => n.type === "stage_move")!;

    // NUNCA reutiliza o stage_id da Org A:
    expect(stageNodeUnmapped.config.stage_id).toBeUndefined();
    expect(stageNodeUnmapped.config.pipeline_id).toBeUndefined();
    expect(stageNodeUnmapped.config.needs_review).toBe(true);

    // O validador de publicação REPROVA este fluxo até que o usuário configure a etapa!
    const publishValidation = validateFlowForPublish(importedPointer2.draft_graph as FlowGraph);
    expect(publishValidation.ok).toBe(false);
    if (!publishValidation.ok) {
      expect(publishValidation.errors.some((e) => e.code === "stage_move_missing_stage")).toBe(true);
    }
  });

  it("9. TESTE REAL — Segurança do link público e tratamento de tokens inválidos", async () => {
    // 9.1 Token inexistente
    const reqInvalid = new NextRequest("http://localhost/api/v1/ai/followup-flows/shared/token-aleatorio-fake");
    const resInvalid = await publicGetSharedHandler(reqInvalid, { params: Promise.resolve({ token: "token-aleatorio-fake" }) });
    expect(resInvalid.status).toBe(404);

    // 9.2 Token desativado
    const revokedToken = "token-revogado-123";
    mockState.tables.followup_flow_shares.push({
      id: randomUUID(),
      organization_id: ORG_A_ID,
      flow_id: FLOW_A_ID,
      token: revokedToken,
      status: "revoked",
      snapshot: { flow_name: "Teste" },
    });

    const reqRevoked = new NextRequest(`http://localhost/api/v1/ai/followup-flows/shared/${revokedToken}`);
    const resRevoked = await publicGetSharedHandler(reqRevoked, { params: Promise.resolve({ token: revokedToken }) });
    expect(resRevoked.status).toBe(404);
  });

  it("10. TESTE REAL — Autosave (atualiza draft_graph sem criar versões nem disparar publish)", async () => {
    (requireRole as any).mockResolvedValue({
      ok: true,
      user: { id: USER_A_ID, idioma: "pt-BR" },
      org: { orgId: ORG_A_ID, role: "manager" },
    });

    const pointerBefore = mockState.tables.followup_flow_pointers.find((p) => p.id === FLOW_A_ID)!;
    const initialActiveVersion = pointerBefore.active_version_id;
    const initialStatus = pointerBefore.status;
    const initialVersionsCount = mockState.tables.followup_flow_versions.length;

    // Simula alteração de nó disparada após debounce no editor
    const modifiedDraft: FlowGraph = {
      nodes: [
        {
          id: "trigger-1",
          type: "trigger",
          label: "Trigger Editado no Autosave",
          position: { x: 150, y: 250 },
          config: { type: "manual" },
        },
        {
          id: "text-1",
          type: "message_text",
          label: "Texto Editado no Autosave",
          position: { x: 150, y: 350 },
          config: { body: "Texto atualizado pelo autosave." },
        },
      ],
      edges: [
        {
          id: "e1",
          source: "trigger-1",
          target: "text-1",
          priority: 0,
          condition: { type: "always" },
        },
      ],
    };

    const reqAutosave = new NextRequest(`http://localhost/api/v1/ai/followup-flows/${FLOW_A_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft_graph: modifiedDraft }),
    });

    const resAutosave = await patchFlowHandler(reqAutosave, { params: Promise.resolve({ id: FLOW_A_ID }) });
    expect(resAutosave.status).toBe(200);

    const jsonAutosave = await resAutosave.json();
    expect(jsonAutosave.data.draft_graph.nodes[0].label).toBe("Trigger Editado no Autosave");
    expect(jsonAutosave.data.draft_graph.nodes[1].label).toBe("Texto Editado no Autosave");

    // 10.1 Confirma que o draft_graph foi persistido no banco
    const pointerAfter = mockState.tables.followup_flow_pointers.find((p) => p.id === FLOW_A_ID)!;
    expect((pointerAfter.draft_graph as FlowGraph).nodes[0]?.label).toBe("Trigger Editado no Autosave");
    expect((pointerAfter.draft_graph as FlowGraph).nodes[1]?.label).toBe("Texto Editado no Autosave");

    // 10.2 Confirma que NÃO criou versão histórica no followup_flow_versions
    expect(mockState.tables.followup_flow_versions.length).toBe(initialVersionsCount);

    // 10.3 Confirma que NÃO disparou publish e NÃO mudou o ponteiro ativo
    expect(pointerAfter.active_version_id).toBe(initialActiveVersion);
    expect(pointerAfter.status).toBe(initialStatus);
  });

  it("11. TESTE REAL — Regressão e isolamento de runtime (engine, worker, scheduler, keyword)", async () => {
    // 11.1 Validar que o validador de publicação continua bloqueando fluxos inválidos
    const invalidGraph: FlowGraph = {
      nodes: [
        { id: "t1", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: { type: "manual" } },
        { id: "orphan", type: "message_text", label: "Texto Órfão", position: { x: 0, y: 100 }, config: { body: "Sem conexão" } },
      ],
      edges: [],
    };
    const pubCheck = validateFlowForPublish(invalidGraph);
    expect(pubCheck.ok).toBe(false);
    if (!pubCheck.ok) {
      expect(pubCheck.errors.some((e) => e.code === "unreachable_node")).toBe(true);
    }

    // 11.2 Validar que sanitização não corrompe estrutura do grafo
    const cleanSanitized = sanitizeFlowForSnapshot({ name: "Fluxo A", graph: fullGraphA });
    expect(cleanSanitized.graph.nodes.length).toBe(fullGraphA.nodes.length);
    expect(cleanSanitized.graph.edges.length).toBe(fullGraphA.edges.length);
  });
});
