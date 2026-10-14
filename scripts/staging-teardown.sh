#!/usr/bin/env bash
# =============================================================================
# scripts/staging-teardown.sh — Teardown Seguro e Escopado do Staging
# =============================================================================
# Destrói os recursos locais do ambiente de staging baseando-se estritamente
# nas labels Docker do projeto deskcomm-staging.
#
# Regras de segurança:
# 1. Verifica e lista recursos pelo label com.docker.compose.project=deskcomm-staging
# 2. Aborta imediatamente se detectar qualquer recurso que não pertença ao projeto
# 3. Executa down -v exclusivamente através do helper scripts/staging-compose.sh
# 4. Valida no pós-down que nenhum recurso com a label permaneceu
# 5. NÃO toca em banco Supabase, registros DNS ou produção
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_HELPER="$ROOT_DIR/scripts/staging-compose.sh"
PROJECT_NAME="deskcomm-staging"

echo "=================================================================="
echo "   INICIANDO TEARDOWN SEGURO DO PROJETO STAGING ($PROJECT_NAME)"
echo "=================================================================="

# 1. Validar presença do helper de composição
if [ ! -f "$COMPOSE_HELPER" ]; then
  echo "❌ ERRO: Helper $COMPOSE_HELPER não encontrado!" >&2
  exit 1
fi

# 2. Listar e auditar containers escopados pela label de projeto
echo "--- [1/4] Auditando containers do projeto $PROJECT_NAME ---"
CONTAINERS="$(docker ps -a --filter "label=com.docker.compose.project=${PROJECT_NAME}" --format '{{.Names}}')"
if [ -n "$CONTAINERS" ]; then
  echo "Containers identificados para remoção:"
  while IFS= read -r c; do
    [ -z "$c" ] && continue
    echo "  - container: $c"
    if [[ "$c" != "${PROJECT_NAME}-"* ]] && [[ "$c" != "${PROJECT_NAME}_"* ]]; then
      echo "❌ ALERTA DE SEGURANÇA: Container $c não possui prefixo $PROJECT_NAME! Abortando teardown." >&2
      exit 1
    fi
  done <<< "$CONTAINERS"
else
  echo "Nenhum container ativo ou parado encontrado para o projeto $PROJECT_NAME."
fi

# 3. Listar e auditar volumes escopados pela label de projeto
echo "--- [2/4] Auditando volumes do projeto $PROJECT_NAME ---"
VOLUMES="$(docker volume ls --filter "label=com.docker.compose.project=${PROJECT_NAME}" --format '{{.Name}}')"
if [ -n "$VOLUMES" ]; then
  echo "Volumes identificados para remoção:"
  while IFS= read -r v; do
    [ -z "$v" ] && continue
    echo "  - volume: $v"
    if [[ "$v" != "${PROJECT_NAME}_"* ]]; then
      echo "❌ ALERTA DE SEGURANÇA: Volume $v possui label do projeto mas nome inconsistente! Abortando teardown." >&2
      exit 1
    fi
  done <<< "$VOLUMES"
else
  echo "Nenhum volume persistente encontrado para o projeto $PROJECT_NAME."
fi

# 4. Listar e auditar redes escopadas pela label de projeto
echo "--- [3/4] Auditando networks do projeto $PROJECT_NAME ---"
NETWORKS="$(docker network ls --filter "label=com.docker.compose.project=${PROJECT_NAME}" --format '{{.Name}}')"
if [ -n "$NETWORKS" ]; then
  echo "Networks identificadas para remoção:"
  while IFS= read -r n; do
    [ -z "$n" ] && continue
    echo "  - network: $n"
    if [[ "$n" != "${PROJECT_NAME}_"* ]]; then
      echo "❌ ALERTA DE SEGURANÇA: Network $n possui label do projeto mas nome inconsistente! Abortando teardown." >&2
      exit 1
    fi
  done <<< "$NETWORKS"
else
  echo "Nenhuma rede encontrada para o projeto $PROJECT_NAME."
fi

# 5. Executar remoção completa via staging-compose.sh
echo "--- [4/4] Executando down -v via staging-compose.sh ---"
"$COMPOSE_HELPER" down -v --remove-orphans

# 6. Validação pós-down: comprovar que nenhum resíduo permaneceu
REMAINING_CONTAINERS="$(docker ps -a -q --filter "label=com.docker.compose.project=${PROJECT_NAME}")"
REMAINING_VOLUMES="$(docker volume ls -q --filter "label=com.docker.compose.project=${PROJECT_NAME}")"
REMAINING_NETWORKS="$(docker network ls -q --filter "label=com.docker.compose.project=${PROJECT_NAME}")"

if [ -n "$REMAINING_CONTAINERS" ] || [ -n "$REMAINING_VOLUMES" ] || [ -n "$REMAINING_NETWORKS" ]; then
  echo "❌ ERRO: Restaram recursos residuais após o teardown:" >&2
  [ -n "$REMAINING_CONTAINERS" ] && echo "  Containers: $REMAINING_CONTAINERS" >&2
  [ -n "$REMAINING_VOLUMES" ] && echo "  Volumes: $REMAINING_VOLUMES" >&2
  [ -n "$REMAINING_NETWORKS" ] && echo "  Networks: $REMAINING_NETWORKS" >&2
  exit 1
fi

echo "=================================================================="
echo "✓ TEARDOWN CONCLUÍDO COM SUCESSO."
echo "  Todos os recursos do projeto $PROJECT_NAME foram limpos."
echo "  Supabase staging, DNS e ambiente de produção NÃO foram tocados."
echo "=================================================================="
