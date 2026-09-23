import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import { enrollFollowupFlow } from "./enroll";
import { LIVE_STATUSES } from "./cancel";
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

  // 1. Buscar pointers ativos e publicados da organização
  const { data: pointers, error: fetchErr } = await admin
    .from("followup_flow_pointers")
    .select("id, name, status, active_version_id, trigger_config")
    .eq("organization_id", entrada.organizationId)
    .eq("status", "active")
    .not("active_version_id", "is", null);

  if (fetchErr) {
    logger.error("[followup.keyword] erro ao carregar pointers ativos", {
      organization_id: entrada.organizationId,
      error: fetchErr.message,
    });
    return { disparou: false, motivo: "fetch_error" };
  }

  if (!pointers || pointers.length === 0) {
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

  // 3. Deduplicação: verificar se o contato já possui enrollment ativo
  const { data: activeEnrollments, error: checkErr } = await admin
    .from("followup_enrollments")
    .select("id, pointer_id, status")
    .eq("organization_id", entrada.organizationId)
    .eq("contact_id", entrada.contactId)
    .in("status", [...LIVE_STATUSES])
    .limit(1);

  if (checkErr) {
    logger.warn("[followup.keyword] erro ao verificar enrollment ativo existente", {
      organization_id: entrada.organizationId,
      contact_id: entrada.contactId,
      error: checkErr.message,
    });
  }

  if (activeEnrollments && activeEnrollments.length > 0) {
    logger.info("[followup.keyword] disparo ignorado por duplicidade: contato já em enrollment ativo", {
      organization_id: entrada.organizationId,
      contact_id: entrada.contactId,
      pointer_id: fluxoCasado.id,
      existing_enrollment_id: activeEnrollments[0]?.id,
      existing_pointer_id: activeEnrollments[0]?.pointer_id,
      palavra: palavraEncontrada,
    });
    return {
      disparou: false,
      pointerId: fluxoCasado.id,
      palavraCasada: palavraEncontrada,
      motivo: "duplicate_active_enrollment",
    };
  }

  // 4. Inscrição canônica reutilizando enrollFollowupFlow
  const enrollmentResult = await enrollFollowupFlow(admin, {
    organizationId: entrada.organizationId,
    pointerId: fluxoCasado.id,
    contactId: entrada.contactId,
    conversationId: entrada.conversationId,
    actorUserId: null,
    requestId: entrada.requestId ?? "keyword_trigger",
    origin: "keyword_trigger",
    triggerMetadata: {
      keyword: palavraEncontrada,
      message_id: entrada.messageId,
    },
  });

  if (!enrollmentResult.ok) {
    if (enrollmentResult.code === "conflict") {
      logger.info("[followup.keyword] enrollment ignorado por conflito de unicidade", {
        organization_id: entrada.organizationId,
        contact_id: entrada.contactId,
        pointer_id: fluxoCasado.id,
        palavra: palavraEncontrada,
      });
      return {
        disparou: false,
        pointerId: fluxoCasado.id,
        palavraCasada: palavraEncontrada,
        motivo: "conflict",
      };
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
