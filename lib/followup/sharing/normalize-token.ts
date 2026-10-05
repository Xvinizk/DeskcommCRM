/**
 * Normaliza um link compartilhado ou token de fluxo.
 *
 * Suporta:
 * - URL completa: https://dominio.com/fluxos/compartilhado/TOKEN
 * - Path relativo: /fluxos/compartilhado/TOKEN
 * - Token direto: VV0qTl07-nnmZaDHVU4KQPJf9HsAdHfz
 */
export function normalizeSharedFlowToken(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Se contém barra ou formato de URL
  if (trimmed.includes("/") || trimmed.includes("://")) {
    try {
      const urlString = trimmed.startsWith("/") ? `http://localhost${trimmed}` : trimmed;
      const url = new URL(urlString);
      const match = url.pathname.match(/\/fluxos\/compartilhado\/([a-zA-Z0-9_-]+)/);
      if (match && match[1] && match[1].length >= 10) {
        return match[1];
      }
    } catch {
      // Se falhar o parse URL padrão, tenta regex na string inteira
      const match = trimmed.match(/fluxos\/compartilhado\/([a-zA-Z0-9_-]+)/);
      if (match && match[1] && match[1].length >= 10) {
        return match[1];
      }
      return null;
    }
  }

  // Se for apenas o token direto
  if (/^[a-zA-Z0-9_-]{10,128}$/.test(trimmed)) {
    return trimmed;
  }

  return null;
}
