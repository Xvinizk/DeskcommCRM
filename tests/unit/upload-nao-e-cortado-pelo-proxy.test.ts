import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";

/**
 * O proxy (proxy.ts) roda nas rotas de API e o Next 16 guarda só os primeiros
 * `proxyClientMaxBodySize` bytes do corpo (default 10MB) — o resto some sem
 * erro. Foi assim que vídeos de 10–50MB chegavam cortados ao upload do Flow
 * Builder e eram recusados como "corrompidos". Se alguém tirar ou baixar o
 * limite, este teste quebra antes do deploy.
 */
describe("next.config: limite de corpo do proxy cobre o teto de mídia", () => {
  it("proxyClientMaxBodySize >= MAX_MEDIA_BYTES + folga do multipart", () => {
    const src = readFileSync(resolve(__dirname, "../../next.config.ts"), "utf8");
    const m = src.match(/proxyClientMaxBodySize:\s*"(\d+)mb"/i);
    expect(m, "experimental.proxyClientMaxBodySize ausente em next.config.ts").not.toBeNull();
    const bytes = Number(m![1]) * 1024 * 1024;
    expect(bytes).toBeGreaterThanOrEqual(MAX_MEDIA_BYTES + 1_048_576);
  });
});
