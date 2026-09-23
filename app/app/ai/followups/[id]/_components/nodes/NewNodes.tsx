"use client";

import type { NodeProps } from "@xyflow/react";
import type { RFNode } from "@/lib/followup/graph-mappers";
import type { NodeType } from "@/lib/followup/graph-schema";
import { useT } from "@/hooks/i18n/useT";
import { NODE_VISUALS, describeNodeConfig } from "./nodeVisuals";
import { NodeCard } from "./NodeCard";

function createFlowNode(type: NodeType) {
  return function FlowNodeComponent({ id, data, selected }: NodeProps<RFNode>) {
    const t = useT();
    return (
      <NodeCard
        id={id}
        visual={NODE_VISUALS[type]}
        label={data.label}
        subtitle={describeNodeConfig(type, data.config, t)}
        selected={selected}
        errors={data.errors}
      />
    );
  };
}

export const MessageTextNode = createFlowNode("message_text");
export const MessageImageNode = createFlowNode("message_image");
export const MessageVideoNode = createFlowNode("message_video");
export const MessageAudioNode = createFlowNode("message_audio");
export const TypingNode = createFlowNode("typing");
export const DelayNode = createFlowNode("delay");
export const TagNode = createFlowNode("tag");
export const StageMoveNode = createFlowNode("stage_move");
