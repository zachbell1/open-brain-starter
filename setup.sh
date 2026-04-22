#!/bin/bash
set -euo pipefail

# Open Brain Starter — Setup Script
# Walks you from zero to working persistent memory in Claude Code.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[+]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[x]${NC} $1"; exit 1; }

# ── Step 0: Prerequisites ────────────────────────────────────────────

info "Checking prerequisites..."

command -v supabase >/dev/null 2>&1 || error "Supabase CLI not found. Install: https://supabase.com/docs/guides/cli/getting-started"

if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    warn "Created .env from .env.example. You'll need to fill in your keys."
  else
    error "No .env or .env.example found. Are you in the open-brain-starter directory?"
  fi
fi

# Source env
set -a
source .env
set +a

# ── Step 1: Validate keys ────────────────────────────────────────────

info "Validating configuration..."

if [ -z "${SUPABASE_URL:-}" ] || [[ "$SUPABASE_URL" == *"your-project-ref"* ]]; then
  error "SUPABASE_URL not set in .env"
fi
if [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ] || [[ "$SUPABASE_SERVICE_ROLE_KEY" == *"your-supabase"* ]]; then
  error "SUPABASE_SERVICE_ROLE_KEY not set in .env"
fi
if [ -z "${OPENAI_API_KEY:-}" ] || [[ "$OPENAI_API_KEY" == *"your-openai"* ]]; then
  error "OPENAI_API_KEY not set in .env"
fi

# Generate BRAIN_ACCESS_KEY if still placeholder
if [ -z "${BRAIN_ACCESS_KEY:-}" ] || [[ "$BRAIN_ACCESS_KEY" == *"your-64"* ]]; then
  BRAIN_ACCESS_KEY=$(openssl rand -hex 32)
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s|BRAIN_ACCESS_KEY=.*|BRAIN_ACCESS_KEY=$BRAIN_ACCESS_KEY|" .env
  else
    sed -i "s|BRAIN_ACCESS_KEY=.*|BRAIN_ACCESS_KEY=$BRAIN_ACCESS_KEY|" .env
  fi
  info "Generated BRAIN_ACCESS_KEY: ${BRAIN_ACCESS_KEY:0:8}..."
fi

# ── Step 2: Extract project ref ──────────────────────────────────────

PROJECT_REF=$(echo "$SUPABASE_URL" | sed 's|https://||' | sed 's|\.supabase\.co.*||')
info "Supabase project: $PROJECT_REF"

# ── Step 3: Apply schema ─────────────────────────────────────────────

info "Applying database schema..."
warn "This will create the 'thoughts' table and 'match_thoughts' function."

read -p "Continue? [y/N] " -n 1 -r
echo
[[ $REPLY =~ ^[Yy]$ ]] || error "Aborted."

# Link to the project (must succeed — otherwise db push targets the wrong project)
supabase link --project-ref "$PROJECT_REF" || error "Failed to link Supabase project $PROJECT_REF. Check your SUPABASE_URL and CLI login."

supabase db push --include-all
info "Schema applied."

# ── Step 4: Set edge function secrets ─────────────────────────────────

info "Setting edge function secrets..."
supabase secrets set \
  OPENAI_API_KEY="$OPENAI_API_KEY" \
  BRAIN_ACCESS_KEY="$BRAIN_ACCESS_KEY" \
  --project-ref "$PROJECT_REF"

info "Secrets configured."

# ── Step 5: Deploy edge function ──────────────────────────────────────

info "Deploying open-brain-mcp edge function..."
GODEBUG=http2client=0 supabase functions deploy open-brain-mcp \
  --no-verify-jwt \
  --project-ref "$PROJECT_REF"

info "Edge function deployed."

# ── Step 6: Smoke test ────────────────────────────────────────────────

info "Running smoke test..."

MCP_URL="https://$PROJECT_REF.supabase.co/functions/v1/open-brain-mcp"

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$MCP_URL" \
  -H "Content-Type: application/json" \
  -H "x-brain-key: $BRAIN_ACCESS_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list",
    "params": {}
  }')

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ] && echo "$BODY" | grep -q "search_thoughts"; then
  info "Smoke test passed — MCP server is live with all tools."
else
  error "Smoke test failed (HTTP $HTTP_CODE). Check your secrets and deployment."
fi

# ── Step 7: Configure Claude Code ─────────────────────────────────────

info "Generating Claude Code MCP config..."

CLAUDE_CONFIG_DIR="$HOME/.claude"
CLAUDE_JSON="$CLAUDE_CONFIG_DIR/.claude.json"

echo ""
echo "Add this to your Claude Code MCP configuration (~/.claude.json):"
echo ""
echo "  \"open-brain\": {"
echo "    \"type\": \"http\","
echo "    \"url\": \"$MCP_URL\","
echo "    \"headers\": {"
echo "      \"x-brain-key\": \"$BRAIN_ACCESS_KEY\""
echo "    }"
echo "  }"
echo ""

# ── Step 8: Install behavioral rules ──────────────────────────────────

RULES_DIR="$CLAUDE_CONFIG_DIR/rules"
if [ -d "$RULES_DIR" ]; then
  read -p "Copy behavioral rules to $RULES_DIR/open-brain.md? [y/N] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    cp rules/open-brain.md "$RULES_DIR/open-brain.md"
    info "Rules installed. Claude will now proactively use Open Brain."
  fi
else
  warn "No ~/.claude/rules/ directory found. Copy rules/open-brain.md there manually."
fi

# ── Done ──────────────────────────────────────────────────────────────

echo ""
info "Setup complete."
echo ""
echo "  MCP endpoint: $MCP_URL"
echo "  Tools: search_thoughts, deep_search, list_thoughts, thought_stats, capture_thought"
echo ""
echo "  Next: Start a Claude Code session and try:"
echo '    "Remember that we deploy to production via Cloud Run"'
echo "  Claude will capture it to Open Brain automatically."
echo ""
