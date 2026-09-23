import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/audit";
import type { ServiceOrigin } from "@/lib/atendimento/origem";

export interface MutateTagsInput {
  organizationId: string;
  contactId: string;
  leadId?: string | null;
  action: "add" | "remove";
  tags: string[];
  requestId?: string;
  causedByRule?: string;
  causedByEnrollment?: string;
  serviceOrigin?: ServiceOrigin | null;
  metadata?: Record<string, unknown>;
}

export interface MutateTagsResult {
  targetTable: "crm_leads" | "contacts";
  targetId: string;
  previousTags: string[];
  newTags: string[];
  addedTags: string[];
  removedTags: string[];
}

/**
 * Mutação canônica de tags em leads ou contatos.
 *
 * Reutilizada por:
 * - Ação de automação: `lib/automation/actions/add-tag.ts`
 * - Motor de fluxos: `lib/followup/persistir-resposta.ts` (node `tag`)
 *
 * Preserva:
 * - Isolamento multi-tenant rígido
 * - Priorização de lead com fallback automático para contato
 * - Emissão de eventos no barramento (`lead.tag_added`, `lead.tag_removed`, `contact.tag_added`, `contact.tag_removed`)
 * - Trilha de auditoria oficial (`lead.updated` ou `contact.updated`)
 * - Metadados de causalidade e anti-loop (`caused_by_rule`, `caused_by_enrollment`)
 */
export async function mutateEntityTags(
  admin: SupabaseClient,
  input: MutateTagsInput,
): Promise<MutateTagsResult | null> {
  const tagsToApply = Array.from(
    new Set((input.tags || []).map((t) => String(t).trim()).filter(Boolean)),
  );
  if (tagsToApply.length === 0) return null;

  // 1. Tenta encontrar o lead prioritário (ou pelo leadId ou pelo contactId)
  let lead: { id: string; contact_id: string | null; tags: string[] | null } | null = null;
  if (input.leadId) {
    const { data, error } = await admin
      .from("crm_leads")
      .select("id, contact_id, tags")
      .eq("organization_id", input.organizationId)
      .eq("id", input.leadId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    lead = data;
  } else if (input.contactId) {
    const { data, error } = await admin
      .from("crm_leads")
      .select("id, contact_id, tags")
      .eq("organization_id", input.organizationId)
      .eq("contact_id", input.contactId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    lead = data;
  }

  // 2. Define o alvo (crm_leads ou contacts)
  let targetTable: "crm_leads" | "contacts";
  let targetId: string;
  let targetEventKind: "crm_lead" | "contact";
  let prevTags: string[];

  if (lead) {
    targetTable = "crm_leads";
    targetId = lead.id;
    targetEventKind = "crm_lead";
    prevTags = Array.isArray(lead.tags) ? lead.tags : [];
  } else {
    // Fallback: Contato
    const { data: contact, error: contactErr } = await admin
      .from("contacts")
      .select("id, tags")
      .eq("organization_id", input.organizationId)
      .eq("id", input.contactId)
      .maybeSingle();
    if (contactErr) throw new Error(contactErr.message);
    if (!contact) return null;

    targetTable = "contacts";
    targetId = contact.id;
    targetEventKind = "contact";
    prevTags = Array.isArray(contact.tags) ? contact.tags : [];
  }

  let newTags: string[];
  let addedTags: string[] = [];
  let removedTags: string[] = [];

  if (input.action === "add") {
    addedTags = tagsToApply.filter((t) => !prevTags.includes(t));
    if (addedTags.length === 0) {
      return {
        targetTable,
        targetId,
        previousTags: prevTags,
        newTags: prevTags,
        addedTags: [],
        removedTags: [],
      };
    }
    newTags = Array.from(new Set([...prevTags, ...addedTags]));
  } else {
    const toRemoveSet = new Set(tagsToApply);
    removedTags = prevTags.filter((t) => toRemoveSet.has(t));
    if (removedTags.length === 0) {
      return {
        targetTable,
        targetId,
        previousTags: prevTags,
        newTags: prevTags,
        addedTags: [],
        removedTags: [],
      };
    }
    newTags = prevTags.filter((t) => !toRemoveSet.has(t));
  }

  const nowIso = new Date().toISOString();

  // 3. Atualização no banco
  const { error: updErr } = await admin
    .from(targetTable)
    .update({
      tags: newTags,
      updated_at: nowIso,
    })
    .eq("organization_id", input.organizationId)
    .eq("id", targetId);

  if (updErr) {
    throw new Error(updErr.message);
  }

  // 4. Metadados para eventos e auditoria
  const meta: Record<string, unknown> = {
    ...(input.metadata ?? {}),
  };
  if (input.causedByRule) meta.caused_by_rule = input.causedByRule;
  if (input.causedByEnrollment) meta.caused_by_enrollment = input.causedByEnrollment;

  // 5. Emissão de evento
  if (input.action === "add" && addedTags.length > 0) {
    const eventType = targetEventKind === "crm_lead" ? "lead.tag_added" : "contact.tag_added";
    await admin.rpc("emit_event", {
      p_event_type: eventType,
      p_entity_kind: targetEventKind,
      p_entity_id: targetId,
      p_payload: {
        added_tags: addedTags,
        tags: newTags,
        service_origin: input.serviceOrigin ?? null,
      },
      p_metadata: {
        ...(input.requestId ? { request_id: input.requestId } : {}),
        ...meta,
      },
      p_organization_id: input.organizationId,
    });
  } else if (input.action === "remove" && removedTags.length > 0) {
    const eventType = targetEventKind === "crm_lead" ? "lead.tag_removed" : "contact.tag_removed";
    await admin.rpc("emit_event", {
      p_event_type: eventType,
      p_entity_kind: targetEventKind,
      p_entity_id: targetId,
      p_payload: {
        removed_tags: removedTags,
        tags: newTags,
        service_origin: input.serviceOrigin ?? null,
      },
      p_metadata: {
        ...(input.requestId ? { request_id: input.requestId } : {}),
        ...meta,
      },
      p_organization_id: input.organizationId,
    });
  }

  // 6. Registro de Auditoria
  const auditAction = targetEventKind === "crm_lead" ? "lead.updated" : "contact.updated";
  await audit({
    action: auditAction,
    organizationId: input.organizationId,
    resourceType: targetEventKind,
    resourceId: targetId,
    requestId: input.requestId ?? null,
    metadata: {
      fields: ["tags"],
      ...(addedTags.length > 0 ? { added_tags: addedTags } : {}),
      ...(removedTags.length > 0 ? { removed_tags: removedTags } : {}),
      ...meta,
    },
  });

  return {
    targetTable,
    targetId,
    previousTags: prevTags,
    newTags,
    addedTags,
    removedTags,
  };
}
