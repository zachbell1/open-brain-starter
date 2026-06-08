-- Open Brain Starter — Database Schema
-- Persistent semantic memory for Claude Code via Supabase + pgvector
--
-- Applied automatically by setup.sh, or paste into the Supabase SQL Editor.

-- 1. Enable pgvector extension
create extension if not exists vector with schema extensions;

-- 2. Create thoughts table
create table public.thoughts (
  id            bigint generated always as identity primary key,
  content       text not null,
  embedding     extensions.vector(1536),

  -- Structured metadata (extracted automatically by LLM)
  thought_type  text,
  topics        text[] default '{}',
  people        text[] default '{}',
  action_items  text[] default '{}',
  project       text,
  importance    smallint default 3
    constraint thoughts_importance_range check (importance between 1 and 5),

  -- Temporal tracking: when a newer thought replaces an older one
  supersedes_id bigint references public.thoughts(id) on delete set null
    constraint thoughts_no_self_supersede check (supersedes_id is null or supersedes_id <> id),

  -- Lateral links between related thoughts
  related_to    bigint[] default '{}',

  -- Trust progression: working (auto-capture) -> shared (explicit) -> verified (user-confirmed)
  trust_tier    text default 'shared'
    constraint thoughts_trust_tier_check check (trust_tier in ('working', 'shared', 'verified')),

  -- Source tracking
  source        text default 'mcp-client',
  source_id     text,

  -- Timestamps
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- 3. Indexes
create index thoughts_created_at_idx on public.thoughts (created_at desc);
create index thoughts_project_idx on public.thoughts (project);
create index thoughts_type_idx on public.thoughts (thought_type);
create index thoughts_topics_idx on public.thoughts using gin (topics);
create index thoughts_supersedes_idx on public.thoughts (supersedes_id) where supersedes_id is not null;
create index thoughts_related_to_idx on public.thoughts using gin (related_to);
create index thoughts_trust_tier_idx on public.thoughts (trust_tier);

-- HNSW vector index for fast approximate nearest-neighbor search.
-- match_thoughts (below) queries it via an `ORDER BY embedding <=> q LIMIT k`
-- candidate pool — the only shape pgvector's HNSW index accelerates.
-- Good to ~100K rows; at 10K+ consider bumping ef_construction to 128 if query
-- latency rises. Note: this pgvector build caps hnsw.ef_search at 1000.
create index thoughts_embedding_hnsw_idx
  on public.thoughts using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- 4. Semantic search function (with optional time-decay scoring)
--
-- Two query paths so the HNSW index is actually used as the store grows:
--   * Unfiltered (the common case): an inner CTE selects a candidate pool by pure
--     ANN distance (`ORDER BY embedding <=> q LIMIT overfetch`) — the only shape
--     pgvector's HNSW index accelerates — then the supersession join, threshold,
--     and optional decay re-rank run over that small pool.
--   * Filtered by project/trust_tier: keep the EXACT scan. Those filters shrink the
--     row set (already fast) and an ANN over-fetch could miss in-scope rows that
--     rank past the pool globally — so the exact path preserves recall.
--
-- Why it matters: a WHERE on the distance EXPRESSION (`1 - (emb <=> q) > thr`), a
-- self-join, or an expression ORDER BY all DEFEAT the HNSW index and force an exact
-- scan over every row. Fine at ~1K rows; it exceeds the statement timeout as the
-- store grows (measured in the full Open Brain at ~15.5K rows). ANN over-fetch +
-- re-rank scales.
--
-- TRADEOFFS (inherent to ANN over-fetch; bounded by the 500-deep pool):
--   * Completeness: match_threshold and supersession are applied AFTER the LIMIT,
--     so an unfiltered search only ranks the top ~overfetch candidates by raw
--     distance. With match_count default 10 that is a ~50x buffer; for an
--     exhaustive set past the pool, use a project/trust_tier filter (exact path).
--   * Decay ranking: the pool is chosen by raw distance, then re-scored. Because
--     the decay factor is bounded to [0.5, 1.0], a fresher row just outside the
--     pool can only outrank an in-pool row when in-pool similarities are already
--     low — negligible until the store passes ~overfetch rows (pool = full table
--     below that). Both are intentional: exact completeness/decay means scoring
--     every row, which is the full scan this fix removes.
--
-- VERIFY AFTER APPLY: EXPLAIN on the function CALL only shows "Function Scan"
-- (plpgsql internals are opaque), so confirm index use on the inner shape:
--   SET hnsw.ef_search = 715;
--   EXPLAIN ANALYZE SELECT th.* FROM thoughts th
--     ORDER BY th.embedding <=> '<probe>'::extensions.vector(1536) LIMIT 500;
-- Expect `Index Scan using thoughts_embedding_hnsw_idx` (a Seq Scan = stale stats:
-- run `ANALYZE thoughts`). Or enable auto_explain.log_nested_statements.
create or replace function match_thoughts(
  query_embedding extensions.vector(1536),
  match_threshold float default 0.5,
  match_count int default 10,
  filter_project text default null,
  include_superseded boolean default false,
  apply_decay boolean default false,
  filter_trust_tier text default null
)
returns table (
  id bigint,
  content text,
  thought_type text,
  topics text[],
  people text[],
  action_items text[],
  project text,
  importance smallint,
  source text,
  created_at timestamptz,
  similarity float,
  supersedes_id bigint,
  superseded_by bigint,
  related_to bigint[],
  trust_tier text
)
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  -- 500-deep candidate pool: >= match_count (never truncates a large request) and
  -- deep enough that the bounded [0.5, 1.0] decay factor cannot lift an outside row
  -- past it. (Exact decay would mean scoring every row — the full scan we avoid.)
  overfetch int := greatest(500, match_count);
  -- Widen ef_search toward the pool size for recall, clamped to this build's
  -- hnsw.ef_search ceiling (1..1000). Transaction-local (third arg = true).
  ef_target int := least(1000, ceil(overfetch / 0.7)::int);
begin
  if filter_project is null and filter_trust_tier is null then
    -- ---- HNSW fast path (unfiltered) ----
    perform set_config('hnsw.ef_search', ef_target::text, true);
    return query
    with ann as (
      -- A plain `ORDER BY embedding <=> q LIMIT k` keeps the HNSW index in the plan;
      -- only distance-EXPRESSION filters or expression sorts would defeat it.
      select th.*, (th.embedding <=> query_embedding) as dist
      from public.thoughts th
      order by th.embedding <=> query_embedding   -- uses thoughts_embedding_hnsw_idx
      limit overfetch
    )
    select
      t.id, t.content, t.thought_type, t.topics, t.people, t.action_items,
      t.project, t.importance, t.source, t.created_at,
      case when apply_decay then
        -- Decay formula: raw similarity * time penalty (older = lower, high importance = slower decay)
        (1 - t.dist) * least(1.0,
          greatest(0.5, 1.0 - (extract(epoch from (now() - t.created_at)) / 86400.0 / 365.0)
            * (1.0 - t.importance::float / 5.0))
          + case when s.id is null then 0.05 else 0.0 end
        )
      else
        1 - t.dist
      end as similarity,
      t.supersedes_id, s.id as superseded_by, t.related_to, t.trust_tier
    from ann t
    left join public.thoughts s on s.supersedes_id = t.id
    where 1 - t.dist > match_threshold
      and (include_superseded or s.id is null)
    order by
      case when apply_decay then
        (1 - t.dist) * least(1.0,
          greatest(0.5, 1.0 - (extract(epoch from (now() - t.created_at)) / 86400.0 / 365.0)
            * (1.0 - t.importance::float / 5.0))
          + case when s.id is null then 0.05 else 0.0 end
        )
      else
        1 - t.dist
      end desc
    limit match_count;
  else
    -- ---- Exact path (filtered) — small row set, recall-preserving ----
    return query
    select
      t.id, t.content, t.thought_type, t.topics, t.people, t.action_items,
      t.project, t.importance, t.source, t.created_at,
      case when apply_decay then
        (1 - (t.embedding <=> query_embedding)) * least(1.0,
          greatest(0.5, 1.0 - (extract(epoch from (now() - t.created_at)) / 86400.0 / 365.0)
            * (1.0 - t.importance::float / 5.0))
          + case when s.id is null then 0.05 else 0.0 end
        )
      else
        1 - (t.embedding <=> query_embedding)
      end as similarity,
      t.supersedes_id, s.id as superseded_by, t.related_to, t.trust_tier
    from public.thoughts t
    left join public.thoughts s on s.supersedes_id = t.id
    where 1 - (t.embedding <=> query_embedding) > match_threshold
      and (filter_project is null or t.project = filter_project)
      and (include_superseded or s.id is null)
      and (filter_trust_tier is null or t.trust_tier = filter_trust_tier)
    order by
      case when apply_decay then
        (1 - (t.embedding <=> query_embedding)) * least(1.0,
          greatest(0.5, 1.0 - (extract(epoch from (now() - t.created_at)) / 86400.0 / 365.0)
            * (1.0 - t.importance::float / 5.0))
          + case when s.id is null then 0.05 else 0.0 end
        )
      else
        1 - (t.embedding <=> query_embedding)
      end desc
    limit match_count;
  end if;
end;
$$;

-- 5. Lock down function access to service_role only
revoke execute on function match_thoughts(extensions.vector, float, int, text, boolean, boolean, text) from public, anon, authenticated;
grant execute on function match_thoughts(extensions.vector, float, int, text, boolean, boolean, text) to service_role;

-- 6. Row Level Security
alter table public.thoughts enable row level security;

create policy "Service role full access"
  on public.thoughts
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- Explicit deny for anon/authenticated roles.
-- Supabase exposes a public anon key by design. Without this policy,
-- beginners who add permissive policies to "fix" access will accidentally
-- expose their entire memory store.
create policy "Deny direct client access"
  on public.thoughts
  for all
  to anon, authenticated
  using (false)
  with check (false);
