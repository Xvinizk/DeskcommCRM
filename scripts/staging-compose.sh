#!/usr/bin/env bash
# =============================================================================
# scripts/staging-compose.sh — Helper Fixo do Docker Compose para Staging
# =============================================================================
# Garante que TODO comando do Docker Compose no ambiente de staging utilize
# estritamente o projeto deskcomm-staging, o arquivo .env.staging e o override
# docker-compose.staging.yml.
#
# Exemplos de uso:
#   ./scripts/staging-compose.sh ps
#   ./scripts/staging-compose.sh up -d app
#   ./scripts/staging-compose.sh exec app node -v
#   ./scripts/staging-compose.sh logs -f worker
#   ./scripts/staging-compose.sh down
#
# Inspeção segura da configuração (sem vazamento de secrets):
#   ./scripts/staging-compose.sh config-safe
#   ./scripts/staging-compose.sh config --services
#   ./scripts/staging-compose.sh config --volumes
#   ./scripts/staging-compose.sh config --images
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PROJECT_NAME="deskcomm-staging"
ENV_FILE="$ROOT_DIR/.env.staging"
BASE="$ROOT_DIR/docker-compose.prod.yml"
OVERRIDE="$ROOT_DIR/docker-compose.staging.yml"

# Abortar se .env.staging não existir
if [ ! -f "$ENV_FILE" ]; then
  echo "❌ ERRO: Arquivo de ambiente $ENV_FILE não encontrado!" >&2
  echo "   Copie .env.staging.example para .env.staging e preencha as credenciais antes de continuar." >&2
  exit 1
fi

# Abortar se base não existir
if [ ! -f "$BASE" ]; then
  echo "❌ ERRO: Arquivo base $BASE não encontrado!" >&2
  exit 1
fi

# Abortar se override não existir
if [ ! -f "$OVERRIDE" ]; then
  echo "❌ ERRO: Arquivo de override $OVERRIDE não encontrado!" >&2
  exit 1
fi

# Subcomando seguro para inspeção de configuração sem expor secrets
if [ "${1:-}" = "config-safe" ] || [ "${1:-}" = "safe-config" ]; then
  echo "=== ESTRUTURA RESOLVIDA DO DOCKER COMPOSE (STAGING) — SECRETS REDIGIDOS ==="
  docker compose \
    -p "$PROJECT_NAME" \
    --env-file "$ENV_FILE" \
    -f "$BASE" \
    -f "$OVERRIDE" \
    config --format json | node -e '
      const chunks = [];
      process.stdin.on("data", c => chunks.push(c));
      process.stdin.on("end", () => {
        try {
          const cfg = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          console.log("Projeto:", cfg.name);
          console.log("\nServiços ativos:");
          Object.keys(cfg.services || {}).forEach(s => {
            const srv = cfg.services[s];
            const ports = (srv.ports || []).map(p => `${p.published || p.target}:${p.target}/${p.protocol || "tcp"}`).join(", ") || "nenhuma (rede interna)";
            console.log(`  - ${s}:`);
            console.log(`      imagem: ${srv.image || "(build local)"}`);
            console.log(`      portas host: ${ports}`);
            console.log(`      container_name: ${srv.container_name || "(automático deskcomm-staging-*)"}`);
          });
          console.log("\nVolumes persistentes:");
          Object.keys(cfg.volumes || {}).forEach(v => {
            const vol = cfg.volumes[v];
            console.log(`  - ${v} -> ${vol.name || "(gerado pelo compose)"}`);
          });
          console.log("\nRedes:");
          Object.keys(cfg.networks || {}).forEach(n => {
            const net = cfg.networks[n];
            console.log(`  - ${n} -> ${net.name || "(gerado pelo compose)"} (driver: ${net.driver || "default"})`);
          });
          console.log("\n✓ Auditoria: Todas as variáveis de environment e secrets foram redigidas com sucesso.");
        } catch (e) {
          console.error("Erro ao analisar configuração JSON:", e.message);
          process.exit(1);
        }
      });
    '
  exit 0
fi

# Alerta de segurança se o operador executar "config" cru sem argumentos
if [ "${1:-}" = "config" ] && [ $# -eq 1 ]; then
  echo "⚠ AVISO DE SEGURANÇA: 'docker compose config' bruto despeja variáveis de ambiente e secrets no terminal." >&2
  echo "   Para inspeção segura sem secrets, utilize:" >&2
  echo "     $0 config-safe" >&2
  echo "     $0 config --services" >&2
  echo "     $0 config --volumes" >&2
  echo "     $0 config --images" >&2
  echo "" >&2
  echo "   Executando inspeção segura automatizada (config-safe):" >&2
  exec "$0" config-safe
fi

# Execução padrão repassando argumentos ao Docker Compose
exec docker compose \
  -p "$PROJECT_NAME" \
  --env-file "$ENV_FILE" \
  -f "$BASE" \
  -f "$OVERRIDE" \
  "$@"
