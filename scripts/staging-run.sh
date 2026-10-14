#!/usr/bin/env bash
# =============================================================================
# scripts/staging-run.sh — Execução de Comandos com Ambiente Isolado de Staging
# =============================================================================
# Executa comandos locais utilizando exclusivamente as variáveis de .env.staging,
# em processo/subshell isolado, sem exportar permanentemente variáveis para a
# shell interativa do operador.
#
# Utiliza o parser seguro nativo do Node 22+ (--env-file).
# NÃO utiliza 'export $(cat .env.staging)'.
#
# DEPENDÊNCIAS DE BANCO DE DADOS (ESTRATÉGIA B):
# Para eliminar a necessidade de instalar postgresql-client / psql no host da VPS,
# os subcomandos 'baseline' e 'psql' executam o cliente através de uma imagem
# efêmera oficial postgres:17-alpine via Docker, alimentada via stdin.
#
# IMPORTANTE SOBRE EXPANSÃO DE SHELL:
# Comandos como './scripts/staging-run.sh psql "$DATABASE_URL"' são INCORRETOS
# porque a shell externa do operador tenta expandir "$DATABASE_URL" ANTES de o
# wrapper ser executado (resultando em string vazia ou variável de outro ambiente).
#
# Para preservar a expansão correta até depois do ambiente de staging ser carregado,
# utilize:
#
# 1. Subcomando seguro dedicado (executa via postgres:17-alpine em container):
#    ./scripts/staging-run.sh baseline
#    ./scripts/staging-run.sh baseline supabase/baseline.sql
#
# 2. Subcomando psql dedicado (injeta DATABASE_URL via container postgres:17-alpine):
#    ./scripts/staging-run.sh psql -c "SELECT current_database(), current_user;"
#
# 3. Execução em subshell com aspas simples (evita expansão externa):
#    ./scripts/staging-run.sh bash -c 'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/baseline.sql'
#
# 4. Comandos Node/TSX consumindo o ambiente de staging:
#    ./scripts/staging-run.sh node -e 'console.log(process.env.APP_NAME)'
#    ./scripts/staging-run.sh ./node_modules/.bin/tsx scripts/bootstrap-owner.ts
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.staging"

# Abortar se .env.staging não existir
if [ ! -f "$ENV_FILE" ]; then
  echo "❌ ERRO: Arquivo de ambiente $ENV_FILE não encontrado!" >&2
  echo "   Crie o arquivo .env.staging antes de executar comandos locais de staging." >&2
  exit 1
fi

if [ $# -eq 0 ] || [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  echo "Uso:"
  echo "  $0 baseline [arquivo.sql]            # Aplica baseline/SQL no banco de staging via container postgres:17-alpine"
  echo "  $0 psql [argumentos_psql...]          # Executa psql conectado a DATABASE_URL de staging via container"
  echo "  $0 bash -c 'comando \$VARIAVEL'       # Executa em subshell preservando variáveis de staging"
  echo "  $0 <comando> [args...]               # Executa qualquer binário herdando as variáveis de staging"
  echo ""
  echo "Exemplos:"
  echo "  $0 baseline"
  echo "  $0 psql -c 'SELECT count(*) FROM organizations;'"
  echo "  $0 bash -c 'echo \"DB Host: \$DATABASE_URL\"'"
  exit 0
fi

# Roteamento de subcomandos
case "$1" in
  baseline)
    SQL_TARGET="${2:-$ROOT_DIR/supabase/baseline.sql}"
    if [ ! -f "$SQL_TARGET" ]; then
      echo "❌ ERRO: Arquivo SQL $SQL_TARGET não encontrado!" >&2
      exit 1
    fi
    echo "Executando aplicação de $SQL_TARGET no banco de staging via container postgres:17-alpine..."
    exec node --env-file="$ENV_FILE" -e '
      const { spawnSync } = require("child_process");
      const fs = require("fs");
      const dbUrl = process.env.DATABASE_URL;
      if (!dbUrl) {
        console.error("❌ ERRO: DATABASE_URL não definida em .env.staging!");
        process.exit(1);
      }
      const sqlFile = process.argv[1];
      const sqlContent = fs.readFileSync(sqlFile);
      const res = spawnSync("docker", [
        "run", "--rm", "-i",
        "-e", `DATABASE_URL=${dbUrl}`,
        "postgres:17-alpine",
        "psql", dbUrl, "-v", "ON_ERROR_STOP=1"
      ], {
        input: sqlContent,
        stdio: ["pipe", "inherit", "inherit"]
      });
      if (res.error) {
        console.error("❌ ERRO ao invocar docker/psql:", res.error.message);
        process.exit(1);
      }
      process.exit(res.status ?? 0);
    ' "$SQL_TARGET"
    ;;

  psql)
    shift
    exec node --env-file="$ENV_FILE" -e '
      const { spawnSync } = require("child_process");
      const dbUrl = process.env.DATABASE_URL;
      if (!dbUrl) {
        console.error("❌ ERRO: DATABASE_URL não definida em .env.staging!");
        process.exit(1);
      }
      const psqlArgs = process.argv.slice(1);
      const res = spawnSync("docker", [
        "run", "--rm", "-i",
        "-e", `DATABASE_URL=${dbUrl}`,
        "postgres:17-alpine",
        "psql", dbUrl, ...psqlArgs
      ], {
        stdio: "inherit"
      });
      if (res.error) {
        console.error("❌ ERRO ao invocar docker/psql:", res.error.message);
        process.exit(1);
      }
      process.exit(res.status ?? 0);
    ' "$@"
    ;;

  *)
    exec node --env-file="$ENV_FILE" -e '
      const { spawnSync } = require("child_process");
      const args = process.argv.slice(1);
      const cmd = args[0];
      const cmdArgs = args.slice(1);
      const res = spawnSync(cmd, cmdArgs, {
        stdio: "inherit",
        env: process.env
      });
      if (res.error) {
        console.error("❌ ERRO ao executar comando:", res.error.message);
        process.exit(1);
      }
      process.exit(res.status ?? 0);
    ' "$@"
    ;;
esac
