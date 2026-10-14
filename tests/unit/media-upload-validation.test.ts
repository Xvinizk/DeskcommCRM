import { describe, expect, it } from "vitest";

import { validateMp4BufferIntegrity, validateOutboundMedia } from "@/lib/messaging/media/upload-validation";

describe("validateOutboundMedia", () => {
  it("classifica mimes suportados no kind certo", () => {
    expect(validateOutboundMedia("image/jpeg", 1000)).toEqual({ ok: true, kind: "image" });
    expect(validateOutboundMedia("image/webp", 1000)).toEqual({ ok: true, kind: "image" });
    expect(validateOutboundMedia("video/mp4", 1000)).toEqual({ ok: true, kind: "video" });
    expect(validateOutboundMedia("audio/ogg; codecs=opus", 1000)).toEqual({ ok: true, kind: "audio" });
    expect(validateOutboundMedia("audio/webm", 1000)).toEqual({ ok: true, kind: "audio" });
    expect(validateOutboundMedia("application/pdf", 1000)).toEqual({ ok: true, kind: "document" });
    expect(validateOutboundMedia("text/csv", 1000)).toEqual({ ok: true, kind: "document" });
  });
  it("rejeita mime não suportado", () => {
    const r = validateOutboundMedia("application/x-msdownload", 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsupported_media_type");
  });
  it("rejeita acima de 50MB", () => {
    const r = validateOutboundMedia("image/jpeg", 51 * 1024 * 1024);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("payload_too_large");
  });
  it("rejeita arquivo vazio", () => {
    const r = validateOutboundMedia("image/jpeg", 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("validation_failed");
  });
});

describe("validateMp4BufferIntegrity", () => {
  it("aceita buffer MP4 integro com atomo mdat correspondente ao tamanho", () => {
    // ftyp (16 bytes) + mdat (32 bytes)
    const buf = Buffer.alloc(48);
    buf.writeUInt32BE(16, 0);
    buf.write("ftyp", 4);
    buf.writeUInt32BE(32, 16);
    buf.write("mdat", 20);
    expect(validateMp4BufferIntegrity(buf)).toEqual({ ok: true });
  });

  it("rejeita buffer MP4 truncado quando mdat declara tamanho maior que o buffer", () => {
    // ftyp (16 bytes) + mdat que declara 5000 bytes mas so tem 16 bytes no buffer
    const buf = Buffer.alloc(32);
    buf.writeUInt32BE(16, 0);
    buf.write("ftyp", 4);
    buf.writeUInt32BE(5000, 16);
    buf.write("mdat", 20);
    const result = validateMp4BufferIntegrity(buf);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Arquivo de vídeo truncado");
    }
  });

  it("rejeita buffer MP4 truncado com mdat em tamanho 64-bit (size=1)", () => {
    // ftyp (16 bytes) + mdat com 64-bit size declarando 25MB num buffer de 40 bytes
    const buf = Buffer.alloc(40);
    buf.writeUInt32BE(16, 0);
    buf.write("ftyp", 4);
    buf.writeUInt32BE(1, 16); // size = 1 indicates 64-bit size
    buf.write("mdat", 20);
    buf.writeBigUInt64BE(BigInt(25000000), 24);
    const result = validateMp4BufferIntegrity(buf);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Arquivo de vídeo truncado");
    }
  });
});

