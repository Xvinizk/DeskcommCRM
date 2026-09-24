import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import { enrollFollowupFlow } from "./enroll";
import type { ModoDeComparacao } from "./vocabulario";

export interface RegraPalavraChave {
  keywords?: string[];
  match_mode?: ModoDeComparacao;
  case_sensitive?: boolean;
}

export interface ResultadoCasamentoPalavraChave {
  casou: boolean;
  palavraCasada?: string;
}

/**
 * Função pura de correspondência de palavra-chave.
 * Aplica trim, case sensitivity e os modos exact, contains e starts_with.
 */
export function casarPalavraChave(
  textoEntrada: string | null | undefined,
  regra: RegraPalavraChave,
): ResultadoCasamentoPalavraChave {
  if (!textoEntrada || typeof textoEntrada !== "string") {
    return { casou: false };
  }

  const rawTrimmed = textoEntrada.trim();
  if (!rawTrimmed) {
    return { casou: false };
  }

  const keywords = Array.isArray(regra.keywords) ? regra.keywords : [];
  if (keywords.length === 0) {
    return { casou: false };
  }

  const caseSensitive = Boolean(regra.case_sensitive);
  const modo = regra.match_mode ?? "exact";

  const textoComparar = caseSensitive
    ? rawTrimmed
    : rawTrimmed.toLocaleLowerCase("pt-BR");

  for (const kw of keywords) {
    if (typeof kw !== "string") continue;
    const kwTrimmed = kw.trim();
    if (!kwTrimmed) continue;

    const kwComparar = caseSensitive
      ? kwTrimmed
      : kwTrimmed.toLocaleLowerCase("pt-BR");

    let match = false;
    switch (modo) {
      case "exact":
        match = textoComparar === kwComparar;
        break;
      case "starts_with":
        match = textoComparar.startsWith(kwComparar);
        break;
      case "contains":
        match = textoComparar.includes(kwComparar);
        break;
    }

    if (match) {
      return { casou: true, palavraCasada: kwTrimmed };
    }
  }

  return { casou: false };
}

export interface EntradaGatilhoPalavraChave {
  organizationId: string;
  contactId: string;
  conversationId: string;
  messageId: string | null;
  texto: string | null;
  requestId?: string;
}

export interface ResultadoExecucaoGatilhoPalavraChave {
  disparou: boolean;
  enrollmentId?: string;
  pointerId?: string;
  palavraCasada?: string;
  motivo?: string;
}

/**
 * Avalia os fluxos ativos da organização com gatilho de palavra-chave
 * contra a mensagem recebida e inicia o follow-up correspondente.
 */
export async function avaliarGatilhoPalavraChave(
  admin: SupabaseClient,
  entrada: EntradaGatilhoPalavraChave,
): Promise<ResultadoExecucaoGatilhoPalavraChave> {
  if (!entrada.texto || !entrada.texto.trim()) {
    return { disparou: false, motivo: "texto_vazio" };
  }

  type QueryBuilder = {
    eq?: (col: string, val: unknown) => QueryBuilder;
    not?: (col: string, op: string, val: unknown) => QueryBuilder;
    then?: (resolve: (val: unknown) => void) => void;
  };

  type IdempotencyTable = {
    insert?: (row: Record<string, unknown>) => Promise<{ error: { code?: string; message: string } | null }>;
    delete?: () => QueryBuilder;
    update?: (patch: Record<string, unknown>) => QueryBuilder;
  };

  // 1. Buscar pointers ativos e publicados da organização
  let query: QueryBuilder = admin
    .from("followup_flow_pointers")
    .select("id, name, status, active_version_id, trigger_config") as unknown as QueryBuilder;

  if (typeof query?.eq === "function") {
    query = query.eq("organization_id", entrada.organizationId);
  }
  if (typeof query?.eq === "function") {
    query = query.eq("status", "active");
  }
  if (typeof query?.not === "function") {
    query = query.not("active_version_id", "is", null);
  }

  const { data: rawPointers, error: fetchErr } = ((await (query as unknown as Promise<unknown>)) as {
    data?: Array<{
      id: string;
      name: string;
      status: string;
      active_version_id: string | null;
      trigger_config: unknown;
    }> | null;
    error?: { message: string } | null;
  }) ?? {};

  if (fetchErr) {
    logger.error("[followup.keyword] erro ao carregar pointers ativos", {
      organization_id: entrada.organizationId,
      error: fetchErr.message,
    });
    return { disparou: false, motivo: "fetch_error" };
  }

  const pointers = (rawPointers ?? []).filter(
    (p) =>
      p &&
      p.active_version_id != null &&
      (p.status === undefined || p.status === "active"),
  );

  if (pointers.length === 0) {
    return { disparou: false, motivo: "sem_fluxos_ativos" };
  }

  // 2. Filtrar fluxos com trigger kind === 'keyword' e encontrar o primeiro que casa
  let fluxoCasado: (typeof pointers)[number] | null = null;
  let palavraEncontrada: string | undefined;

  for (const pointer of pointers) {
    const rawTc = pointer.trigger_config as Record<string, unknown> | null;
    if (!rawTc || rawTc.kind !== "keyword") continue;

    // Normalizar keywords e opções quer estejam na raiz ou em params
    const params = (rawTc.params as Record<string, unknown> | undefined) ?? {};
    const keywords = (rawTc.keywords as string[] | undefined) ?? (params.keywords as string[] | undefined);
    const matchMode = (rawTc.match_mode as ModoDeComparacao | undefined) ?? (params.match_mode as ModoDeComparacao | undefined);
    const caseSensitive = (rawTc.case_sensitive as boolean | undefined) ?? (params.case_sensitive as boolean | undefined);

    const casamento = casarPalavraChave(entrada.texto, {
      keywords,
      match_mode: matchMode,
      case_sensitive: caseSensitive,
    });

    if (casamento.casou) {
      fluxoCasado = pointer;
      palavraEncontrada = casamento.palavraCasada;
      break;
    }
  }

  if (!fluxoCasado || !palavraEncontrada) {
    return { disparou: false, motivo: "nenhuma_palavra_casada" };
  }

  // 3. Idempotência atômica por message_id para impedir reprocessamento e corrida
  if (entrada.messageId) {
    const table = admin.from("idempotency_keys") as unknown as IdempotencyTable;
    if (typeof table?.insert === "function") {
      const { error: reserveErr } = await table.insert({
        organization_id: entrada.organizationId,
        endpoint: "followup_keyword",
        key: entrada.messageId,
        request_hash: "\\x00",
        status_code: null,
        response_body: null,
      });

      if (reserveErr) {
        if (reserveErr.code === "23505") {
          logger.info("[followup.keyword] disparo ignorado: message_id já processado", {
            organization_id: entrada.organizationId,
            message_id: entrada.messageId,
            keyword: palavraEncontrada,
          });
          return {
            disparou: false,
            pointerId: fluxoCasado.id,
            palavraCasada: palavraEncontrada,
            motivo: "message_already_processed",
          };
        }
        logger.warn("[followup.keyword] aviso ao registrar idempotência na chave", {
          organization_id: entrada.organizationId,
          message_id: entrada.messageId,
          error: reserveErr.message,
        });
      }
    }
  }

  // 4. Inscrição canônica reutilizando enrollFollowupFlow com replaceActive: true
  const enrollmentResult = await enrollFollowupFlow(admin, {
    organizationId: entrada.organizationId,
    pointerId: fluxoCasado.id,
    contactId: entrada.contactId,
    conversationId: entrada.conversationId,
    actorUserId: null,
    requestId: entrada.requestId ?? "keyword_trigger",
    origin: "keyword_trigger",
    replaceActive: true,
    triggerMetadata: {
      keyword: palavraEncontrada,
      message_id: entrada.messageId,
    },
  });

  if (!enrollmentResult.ok) {
    if (entrada.messageId) {
      const table = admin.from("idempotency_keys") as unknown as IdempotencyTable;
      if (typeof table?.delete === "function") {
        let q = table.delete();
        if (typeof q?.eq === "function") q = q.eq("organization_id", entrada.organizationId);
        if (typeof q?.eq === "function") q = q.eq("endpoint", "followup_keyword");
        if (typeof q?.eq === "function") q = q.eq("key", entrada.messageId);
        await (q as unknown as Promise<unknown>);
      }
    }

    logger.warn("[followup.keyword] enrollFollowupFlow falhou", {
      organization_id: entrada.organizationId,
      contact_id: entrada.contactId,
      pointer_id: fluxoCasado.id,
      code: enrollmentResult.code,
      message: enrollmentResult.message,
    });
    return {
      disparou: false,
      pointerId: fluxoCasado.id,
      palavraCasada: palavraEncontrada,
      motivo: enrollmentResult.code,
    };
  }

  if (entrada.messageId) {
    const table = admin.from("idempotency_keys") as unknown as IdempotencyTable;
    if (typeof table?.update === "function") {
      let q = table.update({
        status_code: 200,
        response_body: {
          disparou: true,
          enrollment_id: (enrollmentResult.enrollment as { id?: string })?.id,
          pointer_id: fluxoCasado.id,
          palavra_casada: palavraEncontrada,
        },
      });
      if (typeof q?.eq === "function") q = q.eq("organization_id", entrada.organizationId);
      if (typeof q?.eq === "function") q = q.eq("endpoint", "followup_keyword");
      if (typeof q?.eq === "function") q = q.eq("key", entrada.messageId);
      await (q as unknown as Promise<unknown>);
    }
  }

  const enrollmentId = String(enrollmentResult.enrollment.id ?? "");
  logger.info("[followup.keyword] contato inscrito com sucesso via palavra-chave", {
    organization_id: entrada.organizationId,
    contact_id: entrada.contactId,
    pointer_id: fluxoCasado.id,
    flow_name: fluxoCasado.name,
    enrollment_id: enrollmentId,
    palavra: palavraEncontrada,
  });

  return {
    disparou: true,
    enrollmentId,
    pointerId: fluxoCasado.id,
    palavraCasada: palavraEncontrada,
  };
}
