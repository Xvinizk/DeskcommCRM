/**
 * Ação `add_tag` — merge idempotente de tags no LEAD do contexto (ou no
 * CONTATO, se o contexto não tiver lead). Emite o próprio evento
 * lead.tag_added/contact.tag_added com metadata.caused_by_rule — é a ação, e
 * não um handler reusado, então é ela quem carrega o anti-loop.
 */
import { originFromAutomationEvent } from "@/lib/atendimento/origem-automacao";
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import { mutateEntityTags } from "@/lib/tags/mutate-tags";

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const tags = Array.isArray(config.tags) ? config.tags.map(String) : [];
  if (!tags.length) return { type: "add_tag", status: "skipped", detail: { reason: "no_tags" } };

  const lead = ctx.context.lead as { id: string; contact_id?: string; tags?: string[] } | undefined;
  const contact = ctx.context.contact as { id: string; tags?: string[] } | undefined;
  const contactId = lead?.contact_id ?? contact?.id;
  if (!contactId && !lead?.id) return { type: "add_tag", status: "skipped", detail: { reason: "no_target" } };

  const serviceOrigin = contactId
    ? await originFromAutomationEvent(ctx, contactId)
    : null;

  try {
    const res = await mutateEntityTags(ctx.admin, {
      organizationId: ctx.organizationId,
      contactId: contactId ?? "",
      leadId: lead?.id,
      action: "add",
      tags,
      causedByRule: ctx.ruleId,
      requestId: `rule:${ctx.ruleId}`,
      serviceOrigin,
    });

    if (!res) return { type: "add_tag", status: "skipped", detail: { reason: "no_target" } };
    return { type: "add_tag", status: "success", detail: { added: res.addedTags } };
  } catch (err) {
    return { type: "add_tag", status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

registerAction({ type: "add_tag", execute });

