import type { SupabaseClient } from "@supabase/supabase-js";
import { mutateEntityTags } from "@/lib/tags/mutate-tags";
import { moveLeadHandler } from "@/app/api/v1/leads/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";

import type { ReplySaveTo } from "./graph-schema";
import { latestRepeatIndex, type EnrollmentEventRef } from "./node-handlers";

const MAX_CHARS = 2_000;

export function recorteDaResposta(body: string): string {
  const t = body.trim();
  return t.length <= MAX_CHARS ? t : t.slice(0, MAX_CHARS);
}

export function interpolarDestino(saveTo: ReplySaveTo, events: EnrollmentEventRef[]): ReplySaveTo {
  if (saveTo.kind !== "lead_custom") return saveTo;
  const volta = latestRepeatIndex(events);
  if (!volta) return saveTo;
  return {
    kind: "lead_custom",
    key: saveTo.key.replaceAll("{{volta}}", String(volta.index)),
  };
}

export type PersistirRespostaInput = {
  organization_id: string;
  contact_id: string;
  save_to: ReplySaveTo;
  value: string;
};

export async function persistirRespostaFollowupSupabase(
  admin: SupabaseClient,
  input: PersistirRespostaInput,
): Promise<void> {
  const value = recorteDaResposta(input.value);
  if (value.length === 0) return;

  if (input.save_to.kind === "contact_name") {
    const { error } = await admin
      .from("contacts")
      .update({ name: value, updated_at: new Date().toISOString() })
      .eq("organization_id", input.organization_id)
      .eq("id", input.contact_id);
    if (error) throw new Error(error.message);
    return;
  }

  const { data: lead, error: selErr } = await admin
    .from("crm_leads")
    .select("id, custom_fields")
    .eq("organization_id", input.organization_id)
    .eq("contact_id", input.contact_id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (selErr) throw new Error(selErr.message);
  if (!lead) return;

  const prev =
    lead.custom_fields && typeof lead.custom_fields === "object" && !Array.isArray(lead.custom_fields)
      ? (lead.custom_fields as Record<string, unknown>)
      : {};
  const { error } = await admin
    .from("crm_leads")
    .update({
      custom_fields: { ...prev, [input.save_to.key]: value },
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", input.organization_id)
    .eq("id", lead.id);
  if (error) throw new Error(error.message);
}

export async function persistirRespostaFollowupPg(
  query: (sql: string, params: unknown[]) => Promise<unknown>,
  input: PersistirRespostaInput,
): Promise<void> {
  const value = recorteDaResposta(input.value);
  if (value.length === 0) return;

  if (input.save_to.kind === "contact_name") {
    await query(
      `update contacts set name = $3, updated_at = now()
       where organization_id = $1 and id = $2`,
      [input.organization_id, input.contact_id, value],
    );
    return;
  }

  await query(
    `update crm_leads
        set custom_fields = coalesce(custom_fields, '{}'::jsonb) || jsonb_build_object($3::text, to_jsonb($4::text)),
            updated_at = now()
      where id = (
        select id from crm_leads
         where organization_id = $1 and contact_id = $2
         order by updated_at desc
         limit 1
      )`,
    [input.organization_id, input.contact_id, input.save_to.key, value],
  );
}

export async function aplicarTagsFollowupSupabase(
  admin: SupabaseClient,
  input: {
    organization_id: string;
    contact_id: string;
    action: "add" | "remove";
    tags: string[];
    enrollment_id?: string;
    node_id?: string;
  },
): Promise<void> {
  const requestId = input.enrollment_id
    ? `flow:${input.enrollment_id}:${input.node_id ?? "tag"}`
    : `flow:${input.contact_id}:tag`;

  const res = await mutateEntityTags(admin, {
    organizationId: input.organization_id,
    contactId: input.contact_id,
    action: input.action,
    tags: input.tags,
    causedByEnrollment: input.enrollment_id,
    requestId,
  });

  if (!res) {
    throw new Error(`tag_target_not_found: contato ${input.contact_id} não encontrado para aplicar tags`);
  }
}

export async function moverEtapaFollowupSupabase(
  admin: SupabaseClient,
  input: {
    organization_id: string;
    contact_id: string;
    stage_id: string;
    lost_reason?: string | null;
    enrollment_id?: string;
    node_id?: string;
  },
): Promise<void> {
  const { data: lead, error: selErr } = await admin
    .from("crm_leads")
    .select("id, pipeline_id, stage_id, lost_reason")
    .eq("organization_id", input.organization_id)
    .eq("contact_id", input.contact_id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (selErr) throw new Error(`moverEtapaFollowupSupabase select lead failed: ${selErr.message}`);
  if (!lead) {
    throw new Error(`lead_not_found_for_contact: contato ${input.contact_id} não possui lead ativo para mover etapa`);
  }

  // Idempotente: se já está na etapa de destino, não faz nada
  if (lead.stage_id === input.stage_id) return;

  const requestId = input.enrollment_id
    ? `flow:${input.enrollment_id}:${input.node_id ?? input.stage_id}`
    : `flow:${input.contact_id}:${input.stage_id}`;

  const handlerCtx: HandlerCtx = {
    organization_id: input.organization_id,
    actor: {
      type: "webhook_source",
      id: input.enrollment_id ? `flow:${input.enrollment_id}` : "flow-engine",
    },
    requestId,
    serviceOrigin: {
      kind: "event",
      event_id: requestId,
      organization_id: input.organization_id,
      contact_id: input.contact_id,
    },
  };

  await moveLeadHandler(admin, handlerCtx, lead.id, {
    to_stage_id: input.stage_id,
    lost_reason: input.lost_reason,
    reason: "Movido automaticamente pelo fluxo de acompanhamento",
  });
}

// Aliases canônicos explícitos compartilhados entre App e Worker
export const aplicarTagsFollowupCanonica = aplicarTagsFollowupSupabase;
export const moverEtapaFollowupCanonica = moverEtapaFollowupSupabase;

