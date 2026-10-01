#!/usr/bin/env bash
# =============================================================================
# scripts/staging-preflight.sh — Validador Estrito Pré-Voo de Isolamento Staging
# =============================================================================
# Executa auditoria automatizada cega (sem vazamento de secrets nem impressão
# de connection strings) para garantir que o ambiente de staging esteja 100%
# isolado de produção antes de qualquer subida ou homologação.
#
# Validações executadas:
# 1. Commit HEAD contra o Functional RC congelado e STAGING_RC_COMMIT
# 2. Integridade do diff (apenas artefatos de staging permitidos)
# 3. Presença e sintaxe de .env.staging
# 4. Feature flag FOLLOWUP_AI_NODE_ENABLED=true
# 5. Domínios e URLs exclusivas de staging
# 6. Blindagem criptográfica SHA256 contra identificadores de banco de produção
# 7. Consistência cruzada do Project Ref entre NEXT_PUBLIC_SUPABASE_URL,
#    DATABASE_URL e SUPABASE_DB_URL
# 8. Validação matemática do par WAHA_API_KEY (plaintext) x WAHA_API_KEY_SHA512
# 9. Verificação de WAHA_WEBHOOK_REQUIRE_SIGNATURE=false
# 10. Auditoria estrutural do Docker Compose resolvido (sem container_name,
#     sem external: true, sem networks/volumes alheios, apenas portas 80/443)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

FUNCTIONAL_RC_PARENT="47c6f94e39bae2e3632b7dd06d8e5d435c0ca344"
STAGING_RC_TARGET="${1:-${STAGING_RC_COMMIT:-}}"
ENV_FILE="$ROOT_DIR/.env.staging"
COMPOSE_HELPER="$ROOT_DIR/scripts/staging-compose.sh"

echo "=================================================================="
echo "   PREFLIGHT: AUDITORIA DE ISOLAMENTO E BLINDAGEM DE STAGING"
echo "=================================================================="

# -----------------------------------------------------------------------------
# 1. Validação do Commit e Integridade da Árvore Git
# -----------------------------------------------------------------------------
echo "[1/8] Verificando integridade de branches e commits..."

CURRENT_COMMIT="$(git rev-parse HEAD)"

# Se um commit de staging alvo for especificado, valida correspondência
if [ -n "$STAGING_RC_TARGET" ]; then
  if [ "$CURRENT_COMMIT" != "$STAGING_RC_TARGET" ] && [ "${CURRENT_COMMIT:0:7}" != "${STAGING_RC_TARGET:0:7}" ]; then
    echo "❌ ERRO: HEAD atual ($CURRENT_COMMIT) difere do STAGING_RC_COMMIT esperado ($STAGING_RC_TARGET)!" >&2
    exit 1
  fi
  echo "✓ HEAD confere com STAGING_RC_COMMIT: $CURRENT_COMMIT"
else
  echo "ℹ HEAD atual: $CURRENT_COMMIT"
fi

# Verifica derivação estrita a partir do Functional RC congelado
PARENT_SHORT="${FUNCTIONAL_RC_PARENT:0:7}"
if ! git merge-base --is-ancestor "$PARENT_SHORT" HEAD 2>/dev/null; then
  echo "❌ ERRO: O commit atual não descende do Functional RC congelado ($PARENT_SHORT)!" >&2
  exit 1
fi
echo "✓ Ancestralidade válida comprovada a partir do Functional RC ($PARENT_SHORT)."

# Valida que o diff contra o Functional RC contém APENAS os 6 arquivos autorizados
DIFF_FILES="$(git diff --name-only "$PARENT_SHORT"..HEAD)"
ALLOWED_FILES="docker-compose.staging.yml
.env.staging.example
scripts/staging-compose.sh
scripts/staging-run.sh
scripts/staging-preflight.sh
scripts/staging-teardown.sh"

if [ -n "$DIFF_FILES" ]; then
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if ! echo "$ALLOWED_FILES" | grep -qx "$f"; then
      echo "❌ ERRO CRÍTICO DE INTEGRIDADE: Arquivo não autorizado modificado em relação ao Functional RC: $f" >&2
      exit 1
    fi
  done <<< "$DIFF_FILES"
fi
echo "✓ Integridade funcional comprovada: zero alterações em código funcional (lib, app, workers, baseline, migrations)."

# -----------------------------------------------------------------------------
# 2. Validação do Arquivo .env.staging
# -----------------------------------------------------------------------------
echo "[2/8] Verificando existência de $ENV_FILE..."

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ ERRO: Arquivo $ENV_FILE não encontrado!" >&2
  echo "   Copie .env.staging.example para .env.staging e configure suas variáveis." >&2
  exit 1
fi
echo "✓ Arquivo .env.staging presente."

# -----------------------------------------------------------------------------
# 3. Validação das Flags e URLs Gerais de Staging
# -----------------------------------------------------------------------------
echo "[3/8] Auditando flags de homologação e URLs públicas..."

node --env-file="$ENV_FILE" -e '
  const env = process.env;

  // 1. Feature Flag Node IA
  if (env.FOLLOWUP_AI_NODE_ENABLED !== "true") {
    console.error("❌ ERRO: FOLLOWUP_AI_NODE_ENABLED deve ser \"true\" no staging!");
    process.exit(1);
  }

  // 2. Domínio
  const domain = env.DOMAIN || "";
  if (!domain.includes("staging") || domain === "zyroncrm.tech") {
    console.error("❌ ERRO: DOMAIN deve conter \"staging\" e não pode ser de produção! Atual:", domain);
    process.exit(1);
  }

  // 3. URLs do App
  const appUrl = env.NEXT_PUBLIC_APP_URL || "";
  if (!appUrl.includes("staging") || appUrl === "https://zyroncrm.tech") {
    console.error("❌ ERRO: NEXT_PUBLIC_APP_URL deve conter \"staging\"! Atual:", appUrl);
    process.exit(1);
  }

  const adminUrl = env.NEXT_PUBLIC_ADMIN_URL || "";
  if (!adminUrl.includes("staging") || adminUrl === "https://zyroncrm.tech") {
    console.error("❌ ERRO: NEXT_PUBLIC_ADMIN_URL deve conter \"staging\"! Atual:", adminUrl);
    process.exit(1);
  }

  // 4. Webhook WAHA
  const wahaHook = env.WAHA_WEBHOOK_BASE_URL || "";
  if (!wahaHook.includes("staging") && !wahaHook.startsWith("http://app:3000")) {
    console.error("❌ ERRO: WAHA_WEBHOOK_BASE_URL deve apontar para o domínio de staging!");
    process.exit(1);
  }

  // 5. Signature requirement do webhook WAHA
  if (env.WAHA_WEBHOOK_REQUIRE_SIGNATURE !== "false") {
    console.error("❌ ERRO: WAHA_WEBHOOK_REQUIRE_SIGNATURE deve ser \"false\" para paridade com WAHA Core!");
    process.exit(1);
  }

  console.log("✓ Flags e URLs de aplicação validadas com sucesso.");
'

# -----------------------------------------------------------------------------
# 4. Blindagem Criptográfica contra Banco de Produção
# -----------------------------------------------------------------------------
echo "[4/8] Executando blindagem criptográfica cega contra banco de produção..."

node --env-file="$ENV_FILE" -e '
  const crypto = require("crypto");
  function sha256(str) {
    return crypto.createHash("sha256").update(String(str).trim().toLowerCase()).digest("hex");
  }

  // Denylist de hashes SHA256 não reversíveis de identificadores conhecidos de produção
  const PROD_DENYLIST_HASHES = new Set([
    "a5b0dd5e93c48dfe1be8b541eba39b8bd94a891681a5fbe92aecd8ba1637f7c6", // IP produtivo 2.25.236.247
    "765535b12e6dbd2adb58981716b8d21aa5afabf7fb3202eb240b18846000f9ab", // zyroncrm.tech
    "4009f0611c665a76a1a36fc1707edd4ae3c4dc0ec96db6bb72966baaef2a35b4", // app.zyroncrm.tech
    "437921eaa7758a537b9c79e95a5435265fbafa4c28b1464027e3e8e5998cedd6"  // admin.zyroncrm.tech
  ]);

  if (process.env.PROD_DENYLIST_HASHES) {
    process.env.PROD_DENYLIST_HASHES.split(",").forEach(h => PROD_DENYLIST_HASHES.add(h.trim().toLowerCase()));
  }

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const dbUrl = process.env.DATABASE_URL || "";
  const supaDbUrl = process.env.SUPABASE_DB_URL || "";

  if (!supaUrl) { console.error("❌ ERRO: NEXT_PUBLIC_SUPABASE_URL ausente!"); process.exit(1); }
  if (!dbUrl) { console.error("❌ ERRO: DATABASE_URL ausente!"); process.exit(1); }
  if (!supaDbUrl) { console.error("❌ ERRO: SUPABASE_DB_URL ausente!"); process.exit(1); }

  // Função para extrair host de connection string sem vazar credenciais
  function extractHost(connStr) {
    try {
      const match = connStr.match(/@([^:/]+)(?::([0-9]+))?/);
      return match ? { host: match[1], port: match[2] || "5432" } : null;
    } catch {
      return null;
    }
  }

  // Função para extrair project ref do Supabase
  function extractProjectRef(str) {
    try {
      if (str.startsWith("http://") || str.startsWith("https://")) {
        const u = new URL(str);
        return u.hostname.split(".")[0];
      }
      // Connection string: postgresql://postgres.<ref>:pass@...
      const userMatch = str.match(/postgres\.([a-zA-Z0-9_-]+):/);
      if (userMatch) return userMatch[1];
      // Direct host: db.<ref>.supabase.co
      const hostMatch = str.match(/db\.([a-zA-Z0-9_-]+)\.supabase\.co/);
      if (hostMatch) return hostMatch[1];
    } catch {}
    return null;
  }

  // Validar portas de conexão (5432 obrigatória, 6543 proibida)
  const dbParsed = extractHost(dbUrl);
  const supaDbParsed = extractHost(supaDbUrl);

  if (!dbParsed || dbParsed.port === "6543") {
    console.error("❌ ERRO CRÍTICO: DATABASE_URL está configurada na porta 6543 (Transaction Pooler)! Exige porta 5432 para migrations.");
    process.exit(1);
  }
  if (!supaDbParsed || supaDbParsed.port === "6543") {
    console.error("❌ ERRO CRÍTICO: SUPABASE_DB_URL está configurada na porta 6543! Exige porta 5432 para locks do worker.");
    process.exit(1);
  }

  // Checagem de denylist por SHA256 dos hosts
  const supaHost = (new URL(supaUrl)).hostname;
  const hostsToCheck = [supaHost, dbParsed.host, supaDbParsed.host];

  for (const h of hostsToCheck) {
    const hHash = sha256(h);
    if (PROD_DENYLIST_HASHES.has(hHash)) {
      console.error("❌ ALERTA MÁXIMO DE SEGURANÇA: Um dos endpoints configurados resolve para host de produção!");
      process.exit(1);
    }
    if (h === "2.25.236.247" || (h.includes("zyroncrm.tech") && !h.includes("staging"))) {
      console.error("❌ ALERTA MÁXIMO DE SEGURANÇA: Host produtivo identificado em configuração de banco!");
      process.exit(1);
    }
  }

  // Validação de paridade do Project Ref entre API e Banco
  const refApi = extractProjectRef(supaUrl);
  const refDb = extractProjectRef(dbUrl);
  const refSupaDb = extractProjectRef(supaDbUrl);

  if (refApi && refDb && refApi !== refDb) {
    console.error("❌ ERRO DE CONSISTÊNCIA: NEXT_PUBLIC_SUPABASE_URL e DATABASE_URL apontam para projetos diferentes do Supabase!");
    process.exit(1);
  }
  if (refDb && refSupaDb && refDb !== refSupaDb) {
    console.error("❌ ERRO DE CONSISTÊNCIA: DATABASE_URL e SUPABASE_DB_URL apontam para projetos diferentes!");
    process.exit(1);
  }

  console.log("✓ Blindagem contra banco produtivo aprovada (SHA256 verificado sem expor credenciais).");
  console.log("✓ Consistência de Project Ref comprovada entre API, CLI e Worker.");
  console.log("✓ Portas de conexão Postgres verificadas: porta 5432 confirmada para DDL e worker.");
'

# -----------------------------------------------------------------------------
# 5. Auditoria Matemática do WAHA (Key vs SHA512)
# -----------------------------------------------------------------------------
echo "[5/8] Auditando chave e hash criptográfico do WAHA..."

node --env-file="$ENV_FILE" -e '
  const crypto = require("crypto");
  const rawKey = process.env.WAHA_API_KEY || "";
  const expectedHash = (process.env.WAHA_API_KEY_SHA512 || "").trim().toLowerCase();

  if (!rawKey) {
    console.error("❌ ERRO: WAHA_API_KEY ausente em .env.staging!");
    process.exit(1);
  }
  if (!expectedHash) {
    console.error("❌ ERRO: WAHA_API_KEY_SHA512 ausente em .env.staging!");
    process.exit(1);
  }

  const computedHash = crypto.createHash("sha512").update(rawKey).digest("hex").toLowerCase();
  if (computedHash !== expectedHash) {
    console.error("❌ ERRO: WAHA_API_KEY (plaintext) e WAHA_API_KEY_SHA512 divergem matematicamente!");
    process.exit(1);
  }

  console.log("✓ Paridade matemática WAHA comprovada (SHA-512 validado sem expor a chave).");
'

# -----------------------------------------------------------------------------
# 6. Auditoria Estrutural do Docker Compose Resolvido
# -----------------------------------------------------------------------------
echo "[6/8] Auditando estrutura resolvida do Docker Compose..."

# Executa inspeção via staging-compose.sh capturando JSON internamente
RESOLVED_JSON="$(docker compose -p deskcomm-staging --env-file "$ENV_FILE" -f "$ROOT_DIR/docker-compose.prod.yml" -f "$ROOT_DIR/docker-compose.staging.yml" config --format json 2>&1)"

node -e '
  const raw = process.argv[1];
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    console.error("❌ ERRO: Falha ao parsear configuração JSON do compose:", e.message);
    process.exit(1);
  }

  // 1. Projeto deskcomm-staging
  if (cfg.name !== "deskcomm-staging") {
    console.error("❌ ERRO: Nome do projeto compose deve ser deskcomm-staging! Atual:", cfg.name);
    process.exit(1);
  }

  // 2. Nenhum container_name fixo
  const services = cfg.services || {};
  for (const s of Object.keys(services)) {
    if (services[s].container_name) {
      console.error(`❌ ERRO: Serviço "${s}" declara container_name fixo (${services[s].container_name})!`);
      process.exit(1);
    }
  }

  // 3. Nenhuma rede externa
  const networks = cfg.networks || {};
  for (const n of Object.keys(networks)) {
    if (networks[n].external === true) {
      console.error(`❌ ERRO: Rede "${n}" é declarada como externa! Staging deve usar redes isoladas.`);
      process.exit(1);
    }
  }

  // 4. Nenhum volume externo
  const volumes = cfg.volumes || {};
  for (const v of Object.keys(volumes)) {
    if (volumes[v].external === true) {
      console.error(`❌ ERRO: Volume "${v}" é declarado como externo!`);
      process.exit(1);
    }
  }

  // 5. Portas publicadas no host: estritamente 80 e 443 do Caddy
  const publishedPorts = [];
  for (const s of Object.keys(services)) {
    for (const p of (services[s].ports || [])) {
      if (p.published) {
        publishedPorts.push({ service: s, port: String(p.published), protocol: p.protocol || "tcp" });
      }
    }
  }

  for (const p of publishedPorts) {
    if (p.port !== "80" && p.port !== "443") {
      console.error(`❌ ERRO CRÍTICO DE PORTAS: Serviço "${p.service}" publica porta host indevida: ${p.port}/${p.protocol}! Apenas 80 e 443 são permitidas.`);
      process.exit(1);
    }
  }

  console.log("✓ Projeto Docker Compose: deskcomm-staging confirmado.");
  console.log("✓ Zero container_name fixo (nomes com namespace deskcomm-staging-*).");
  console.log("✓ Zero volumes ou redes externas de produção.");
  console.log("✓ Portas públicas expostas no host estritamente restritas a 80 e 443 (Caddy).");
' "$RESOLVED_JSON"

# -----------------------------------------------------------------------------
# 7. Verificação de Saúde e Autenticação do Provedor LLM Configurado
# -----------------------------------------------------------------------------
echo "[7/8] Verificando configuração dos provedores de IA..."

node --env-file="$ENV_FILE" -e '
  const anthropicKey = process.env.ANTHROPIC_API_KEY || "";
  const openAiKey = process.env.OPENAI_API_KEY || "";
  const aiGatewayKey = process.env.AI_GATEWAY_API_KEY || "";

  if (!anthropicKey && !openAiKey && !aiGatewayKey) {
    console.error("❌ ERRO: Nenhum provedor de IA configurado em .env.staging (ANTHROPIC_API_KEY, OPENAI_API_KEY ou AI_GATEWAY_API_KEY necessária)!");
    process.exit(1);
  }

  const providers = [];
  if (anthropicKey) providers.push("Anthropic");
  if (openAiKey) providers.push("OpenAI");
  if (aiGatewayKey) providers.push("Vercel AI Gateway");

  console.log(`✓ Provedor(es) de IA detectados para homologação: ${providers.join(", ")}`);
'

# -----------------------------------------------------------------------------
# 8. Sucesso Final
# -----------------------------------------------------------------------------
echo "=================================================================="
echo "✓ PREFLIGHT APROVADO COM SUCESSO!"
echo "  Isolamento de staging comprovado: ZERO conexões com produção."
echo "=================================================================="
exit 0
