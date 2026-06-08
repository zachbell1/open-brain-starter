# Architecture

## Overview

Open Brain Starter gives Claude Code persistent semantic memory by connecting three components via a single Supabase edge function:

```
                        +--------------------------+
Claude Code session --> | open-brain-mcp           |
  (MCP JSON-RPC 2.0)   | (Supabase Edge Function) |
                        +-------+----------+-------+
                                |          |
                     +----------+    +-----+--------+
                     |               |              |
              +------v------+  +----v----+  +------v-------+
              | PostgreSQL  |  | OpenAI  |  | OpenAI       |
              | + pgvector  |  | embed   |  | GPT-4o-mini  |
              | (thoughts)  |  | API     |  | (metadata)   |
              +-------------+  +---------+  +--------------+
```

## Request Flow

### Capture (`capture_thought`)

1. Claude calls `capture_thought` with a content string
2. Edge function fires two requests in parallel:
   - **Embedding**: OpenAI `text-embedding-3-small` generates a 1536-dim vector
   - **Metadata**: GPT-4o-mini extracts type, topics, people, action_items, project, importance
3. **Density check**: The 5 nearest neighbors are retrieved. If the average similarity exceeds 0.9, the thought is rejected as a near-duplicate (unless `supersedes_id` is provided)
4. The thought is inserted into the `thoughts` table with all extracted fields
5. Response confirms storage with a summary of extracted metadata

### Search (`search_thoughts`)

1. Claude calls `search_thoughts` with a natural language query
2. Edge function generates an embedding for the query
3. Calls the `match_thoughts` RPC function which:
   - **Unfiltered searches** select a bounded candidate pool
     (`ORDER BY embedding <=> query LIMIT overfetch`) and re-rank just that pool by
     threshold, supersession, and optional decay. The candidate scan is
     HNSW-index-eligible — the planner serves it from the index for small fetches
     or large tables; either way the supersession self-join and threshold now run
     over ≤overfetch rows instead of the whole table, which is what removes the timeout
   - **Project / trust-tier filtered searches** run an exact scan over the smaller
     filtered set, which preserves recall
   - Optionally applies time-decay scoring (older thoughts score lower, high-importance thoughts decay slower)
4. Returns matching thoughts ranked by similarity

### Deep Search (`deep_search`)

Runs two parallel `match_thoughts` calls with different parameters:

| Strategy | Threshold | Count | Post-filter |
|----------|-----------|-------|-------------|
| Factual | 0.25 | 15 | None (tight threshold does the work) |
| Broad | 0.15 | 30 | Recent (last 14 days) OR high importance (>= 4) |

Results from both strategies are merged by ID (highest similarity wins), deduplicated, and sorted by similarity.

This catches thoughts that a single-strategy search would miss: the factual path finds the best semantic matches, while the broad path surfaces recent context and high-importance thoughts that might fall below the tight threshold. The OR filter on the broad path is intentional -- it casts a wide net for recency and importance independently, then lets the merge + limit trim to the best results.

## Database Design

### `thoughts` Table

Core storage for all captured thoughts. Each row contains the raw content, its vector embedding, and structured metadata extracted at capture time.

Key design choices:
- **`embedding extensions.vector(1536)`** -- schema-qualified for Supabase's extension layout
- **`supersedes_id`** -- self-referential FK for temporal chains. When thought B supersedes thought A, `B.supersedes_id = A.id`. Search excludes superseded thoughts by default.
- **`related_to bigint[]`** -- lateral links stored as an array (no FK enforcement on arrays in Postgres). Application-level responsibility to clean stale IDs.
- **`trust_tier`** -- CHECK constraint enforces the enum. Default is `shared` for MCP captures.
- **`importance`** -- constrained 1-5. Used in the decay formula: higher importance = slower decay.

### `match_thoughts` RPC Function

Postgres function that performs vector similarity search with optional features:

- **Bounded candidate selection**: unfiltered searches take a top-N pool via
  `ORDER BY embedding <=> query LIMIT overfetch` (HNSW-index-eligible) and re-rank
  it; filtered searches scan the smaller filtered set exactly. The old shape —
  `WHERE 1 - (emb <=> q) > threshold` + a self-join + an expression `ORDER BY` —
  could not use the index *and* ran the self-join over every row, so it scanned the
  whole table (fine at ~1K rows, ~8s at ~15K). Bounding the pool is the fix; the
  HNSW index is an additional accelerator the planner engages as the table grows.
  (Measured on 20K synthetic rows: ~0.1s end-to-end via a bounded seq-scan top-N,
  ~8ms when the index is forced — pgvector under-costs HNSW, so the planner may not
  pick it until the table is larger.)
- **Cosine similarity**: `1 - (embedding <=> query_embedding)` using pgvector's distance operator
- **Supersession filtering**: LEFT JOIN to find thoughts that have been superseded; exclude them by default
- **Time decay**: When `apply_decay = true`, raw similarity is multiplied by a penalty factor:
  ```
  similarity * min(1.0, max(0.5, 1.0 - (age_in_years * (1.0 - importance/5.0)) + non_superseded_bonus))
  ```
  - Age penalty: older thoughts score lower
  - Importance scaling: high-importance thoughts decay slower (importance 5 = no decay)
  - Non-superseded bonus: +0.05 for thoughts that haven't been replaced

### HNSW Index

Approximate nearest-neighbor index on the embedding column:
- **m = 16**: connections per node (higher = better recall, more memory)
- **ef_construction = 64**: build-time search depth (higher = better index quality, slower build)
- **ef_search**: set per-query (transaction-local) by `match_thoughts`; this pgvector build caps it at 1000
- `match_thoughts` uses this index for unfiltered searches (see above). Good to ~100K rows. At 10K+ rows, consider bumping `ef_construction` to 128 if query latency increases.

### Security Model

```
             +-- service_role: FULL ACCESS (via RLS policy + function grant)
             |
thoughts <---+-- anon: DENIED (explicit deny policy + no function grant)
             |
             +-- authenticated: DENIED (explicit deny policy + no function grant)
```

- **RLS**: Two policies -- service_role gets full access, anon/authenticated get explicit deny
- **Function**: `security invoker` + `revoke execute from public, anon, authenticated`
- **Access key**: The edge function checks `x-brain-key` header before processing any request

This three-layer defense means even if a user accidentally exposes their Supabase anon key, no data is accessible.

## MCP Protocol

The edge function implements MCP JSON-RPC 2.0 directly (~60 lines, no SDK dependency):

- **`initialize`** -- returns server info and capabilities
- **`ping`** -- health check
- **`tools/list`** -- returns the 5 tool definitions
- **`tools/call`** -- dispatches to the appropriate handler

Transport is stateless HTTP (no sessions). Each request is a single JSON-RPC call over POST. The function is deployed with `--no-verify-jwt` since authentication is handled by the `x-brain-key` header instead of Supabase Auth.

## Metadata Extraction

GPT-4o-mini receives the raw thought content and returns structured JSON:

```json
{
  "thought_type": "decision",
  "topics": ["supabase", "pgvector"],
  "people": [],
  "action_items": [],
  "project": "open-brain",
  "importance": 4
}
```

The extraction prompt is generic -- it infers the project name from context rather than matching against a hardcoded list. This means project names emerge organically from your work.

If extraction fails (network error, malformed response), the thought is still stored with safe defaults (type: idea, importance: 3, empty arrays).

## Scaling Notes

- **Under 1K thoughts**: Everything works out of the box. No maintenance needed.
- **1K-10K thoughts**: HNSW index handles search efficiently. Monitor query latency.
- **10K+ thoughts**: Consider bumping `ef_construction` to 128. Start thinking about memory consolidation (merging semantically similar thoughts).
- **50K+ thoughts**: Consider a graph layer for multi-hop queries. The full Open Brain repo has consolidation scripts and interference monitoring for this scale.
