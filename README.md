# Open Brain Starter

Persistent semantic memory for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Thoughts captured during sessions are automatically embedded, tagged, and retrievable by meaning across future sessions.

## What It Does

- **Captures** decisions, insights, context, and action items during Claude Code sessions
- **Auto-extracts** metadata (topics, people, importance, type) via GPT-4o-mini
- **Retrieves** by semantic similarity -- find things by meaning, not keywords
- **Tracks temporal supersession** -- newer thoughts replace outdated ones
- **Blocks near-duplicates** -- density gate rejects thoughts too similar to existing ones
- **Trust tiers** -- working (auto-capture) -> shared (explicit) -> verified (user-confirmed)

## Architecture

```
Claude Code session
  |  MCP (streamable HTTP)
  v
Supabase Edge Function (open-brain-mcp)
  |  Supabase JS client
  v
PostgreSQL + pgvector (thoughts table, match_thoughts RPC)
  |
  +-- OpenAI text-embedding-3-small (1536-dim vectors)
  +-- GPT-4o-mini (metadata extraction)
```

Your thoughts live in a `thoughts` table with vector embeddings. A `match_thoughts` RPC function handles semantic search with optional time-decay scoring. All 5 tools are exposed via a single MCP JSON-RPC 2.0 endpoint.

For a deeper dive, see [docs/architecture.md](docs/architecture.md).

## Prerequisites

- [Supabase](https://supabase.com) account (free tier works)
- [Supabase CLI](https://supabase.com/docs/guides/cli/getting-started) (v2.80+)
- [OpenAI API key](https://platform.openai.com/api-keys) (for embeddings + metadata extraction)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)

## Quick Start

```bash
# 1. Clone this repo
git clone https://github.com/zachbell1/open-brain-starter.git
cd open-brain-starter

# 2. Create a Supabase project at https://supabase.com/dashboard
#    Copy your project URL and service role key from Settings > API

# 3. Configure
cp .env.example .env
# Edit .env: add your Supabase URL, service role key, and OpenAI API key
# (the setup script generates the BRAIN_ACCESS_KEY for you)

# 4. Run setup
chmod +x setup.sh
./setup.sh
```

The setup script will:
1. Validate your configuration
2. Generate a 64-char hex access key
3. Link to your Supabase project
4. Apply the database schema (pgvector + thoughts table + match_thoughts RPC)
5. Set edge function secrets
6. Deploy the MCP edge function
7. Run a smoke test (tools/list)
8. Print the MCP config to add to Claude Code
9. Optionally install behavioral rules to `~/.claude/rules/`

## Manual Setup

If you prefer to set things up step by step:

1. **Create a Supabase project** at https://supabase.com/dashboard
2. **Apply the schema** -- paste `schema.sql` into the SQL Editor, or run:
   ```bash
   supabase link --project-ref <your-ref>
   supabase db push --include-all
   ```
3. **Generate an access key:**
   ```bash
   openssl rand -hex 32
   ```
4. **Set secrets:**
   ```bash
   supabase secrets set OPENAI_API_KEY=sk-... BRAIN_ACCESS_KEY=<your-key> --project-ref <your-ref>
   ```
5. **Deploy the edge function:**
   ```bash
   GODEBUG=http2client=0 supabase functions deploy open-brain-mcp --no-verify-jwt --project-ref <your-ref>
   ```
6. **Configure Claude Code** -- add to `~/.claude.json` under `mcpServers`:
   ```json
   "open-brain": {
     "type": "http",
     "url": "https://<your-ref>.supabase.co/functions/v1/open-brain-mcp",
     "headers": {
       "x-brain-key": "<your-access-key>"
     }
   }
   ```
7. **Install behavioral rules** -- copy `rules/open-brain.md` to `~/.claude/rules/`

## MCP Tools

| Tool | Description | When to use |
|------|-------------|-------------|
| `search_thoughts` | Semantic search via vector similarity | Quick single-topic lookups |
| `deep_search` | Multi-strategy: factual + recent + important | Session-start context loading, complex queries |
| `list_thoughts` | Browse recent thoughts with filters | Resuming work on a project |
| `thought_stats` | Counts, top topics, project breakdown | Understanding what's stored |
| `capture_thought` | Save a thought with auto-extracted metadata | Persisting decisions, insights, context |

## Behavioral Rules

The file `rules/open-brain.md` tells Claude **when** to capture and **how** to retrieve. Without it, Claude won't proactively use the memory system -- you'd have to ask it to save things manually.

The setup script offers to install it to `~/.claude/rules/`. You can also merge the contents into an existing CLAUDE.md.

## Cost

At typical usage (10-30 captures/day):

| Service | Monthly Cost |
|---------|-------------|
| Supabase | Free tier (500MB storage, unlimited API) |
| OpenAI embeddings (text-embedding-3-small) | ~$0.01 |
| GPT-4o-mini metadata extraction | ~$0.02 |
| **Total** | **~$0.03/month** |

## Schema

The `thoughts` table stores:

| Column | Type | Description |
|--------|------|-------------|
| `content` | text | The raw thought |
| `embedding` | vector(1536) | OpenAI text-embedding-3-small |
| `thought_type` | text | idea, decision, reference, action_item, reflection, learning |
| `topics` | text[] | 1-5 auto-extracted topic tags |
| `people` | text[] | Mentioned people/orgs |
| `action_items` | text[] | Extracted action items |
| `project` | text | Inferred project name |
| `importance` | smallint | 1-5 scale (constrained) |
| `supersedes_id` | bigint | FK to the thought this one replaces |
| `related_to` | bigint[] | Lateral links to related thoughts |
| `trust_tier` | text | working / shared / verified |

### Security

- **Row Level Security** enabled with explicit deny for `anon` and `authenticated` roles
- **match_thoughts** function uses `security invoker` -- RLS applies to all callers
- **Function execute** restricted to `service_role` only
- **Access key** required on every MCP request (`x-brain-key` header)

## Upgrading

Future schema changes ship as numbered migration files in `supabase/migrations/`. Apply them:

```bash
supabase link --project-ref <your-ref>
supabase db push --include-all
```

## What's Not Included

This is the starter version. The full [Open Brain](https://github.com/zachbell1/open-brain) includes additional features that become useful at scale:

- **Conflict detection** -- LLM-based classification of near-duplicate thoughts (duplicate/contradicts/extends/unrelated)
- **Memory consolidation** -- batch merging of related thoughts to reduce density
- **Retrieval frequency tracking** -- decay scoring based on access patterns
- **Interference monitoring** -- budget tracking for semantic degradation
- **Sub-project resolution** -- hierarchical project taxonomy
- **Cross-layer propagation** -- syncing between Open Brain, Obsidian vault, and MEMORY.md

These are documented in the full repo if you outgrow the starter.

## Credits

Based on [Open Brain](https://github.com/zachbell1/open-brain), inspired by [Nate B Jones](https://promptkit.natebjones.com) and the Claude Code community.

## License

MIT
