import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-brain-key, mcp-session-id, accept",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

// ── Tool definitions ─────────────────────────────────────────────────

const TOOLS = [
  {
    name: "search_thoughts",
    description:
      "Semantic search across stored thoughts. Finds thoughts by meaning, not just keywords.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language search query" },
        limit: { type: "number", description: "Max results (default 10)" },
        threshold: { type: "number", description: "Min similarity 0-1 (default 0.3)" },
        project: { type: "string", description: "Filter by project name" },
        include_superseded: {
          type: "boolean",
          description: "Include thoughts that have been superseded by newer ones (default false)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "deep_search",
    description:
      "Advanced search using 2 parallel strategies (semantic with tight threshold, broad with recency/importance post-filtering). Use for complex queries or session-start context loading.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language search query" },
        limit: { type: "number", description: "Max results to return after merge (default 10)" },
        project: { type: "string", description: "Filter by project name" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_thoughts",
    description: "List recent thoughts with optional filters by type, project, or date range.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (default 20)" },
        project: { type: "string", description: "Filter by project" },
        thought_type: { type: "string", description: "Filter by type" },
        days: { type: "number", description: "Look back N days (default 30)" },
      },
    },
  },
  {
    name: "thought_stats",
    description:
      "Get statistics about stored thoughts: counts, top topics, top people, breakdown by project and type.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "capture_thought",
    description: "Save a new thought directly into Open Brain from any MCP client.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The thought to capture" },
        source: { type: "string", description: "Source identifier (default: mcp-client)" },
        supersedes_id: {
          type: "number",
          description: "ID of an older thought this one replaces/corrects",
        },
        related_to: {
          type: "array",
          items: { type: "number" },
          description: "Array of thought IDs this thought is related to",
        },
        trust_tier: {
          type: "string",
          enum: ["working", "shared", "verified"],
          description: "Trust level: working (auto-capture), shared (explicit capture), verified (user-confirmed)",
        },
      },
      required: ["content"],
    },
  },
];

// ── Tool dispatcher ──────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
async function dispatchTool(toolName: string, rawArgs: Record<string, unknown>, supabase: any, openaiKey: string) {
  const args = { ...rawArgs };

  if (args.limit !== undefined) {
    args.limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
  }
  if (args.threshold !== undefined) {
    args.threshold = Math.max(0, Math.min(1, Number(args.threshold) || 0.3));
  }
  if (args.days !== undefined) {
    args.days = Math.max(1, Math.min(365, Number(args.days) || 30));
  }

  switch (toolName) {
    case "search_thoughts": {
      if (!args.query || typeof args.query !== "string") {
        throw new Error("query is required and must be a string");
      }
      if ((args.query as string).length > 10000) {
        throw new Error("query too long (max 10000 chars)");
      }
      return await searchThoughts(supabase, openaiKey, args);
    }
    case "list_thoughts":
      return await listThoughts(supabase, args);
    case "thought_stats":
      return await thoughtStats(supabase);
    case "deep_search": {
      if (!args.query || typeof args.query !== "string") {
        throw new Error("query is required and must be a string");
      }
      if ((args.query as string).length > 10000) {
        throw new Error("query too long (max 10000 chars)");
      }
      return await deepSearch(supabase, openaiKey, args);
    }
    case "capture_thought": {
      if (!args.content || typeof args.content !== "string") {
        throw new Error("content is required and must be a string");
      }
      if ((args.content as string).length > 50000) {
        throw new Error("content too long (max 50000 chars)");
      }
      return await captureThought(supabase, openaiKey, args);
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// ── MCP JSON-RPC 2.0 handler ─────────────────────────────────────────

function jsonRpcResponse(id: number | string, result: unknown) {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id, result }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

function jsonRpcError(id: number | string | null, code: number, message: string) {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

// deno-lint-ignore no-explicit-any
async function handleMcpRequest(body: any, supabase: any, openaiKey: string): Promise<Response> {
  const { id, method, params } = body;

  if (id === undefined || id === null) {
    return new Response(null, { status: 202, headers: corsHeaders });
  }

  switch (method) {
    case "initialize":
      return jsonRpcResponse(id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "open-brain", version: "1.0.0" },
      });

    case "ping":
      return jsonRpcResponse(id, {});

    case "tools/list":
      return jsonRpcResponse(id, { tools: TOOLS });

    case "tools/call": {
      const toolName = params?.name;
      const args = params?.arguments || {};
      try {
        const result = await dispatchTool(toolName, args, supabase, openaiKey);
        return jsonRpcResponse(id, result);
      } catch (err) {
        return jsonRpcResponse(id, {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        });
      }
    }

    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ── Main request handler ─────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method === "GET" || req.method === "DELETE") {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Stateless server — sessions not supported" } }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const accessKey =
    req.headers.get("x-brain-key") ||
    new URL(req.url).searchParams.get("key");
  const expectedKey = Deno.env.get("BRAIN_ACCESS_KEY");

  if (!accessKey || accessKey !== expectedKey) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  try {
    const body = await req.json();

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const openaiKey = Deno.env.get("OPENAI_API_KEY")!;

    if (body.jsonrpc === "2.0") {
      return await handleMcpRequest(body, supabase, openaiKey);
    }

    return jsonResponse({ error: "Expected MCP JSON-RPC 2.0 request" }, 400);
  } catch (err) {
    console.error("MCP Error:", err);
    return jsonResponse(
      { error: err instanceof Error ? err.message : "Internal error" },
      500,
    );
  }
});

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── Embedding + Metadata ─────────────────────────────────────────────

async function generateEmbedding(
  text: string,
  apiKey: string,
): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Embedding error: ${JSON.stringify(data)}`);
  return data.data[0].embedding;
}

interface ThoughtMetadata {
  thought_type: string;
  topics: string[];
  people: string[];
  action_items: string[];
  project: string | null;
  importance: number;
}

async function extractMetadata(
  content: string,
  apiKey: string,
): Promise<ThoughtMetadata> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a metadata extraction system for a personal knowledge base. Given a raw thought, extract structured metadata as JSON.

Classify into exactly one type: idea, decision, reference, action_item, reflection, learning

Extract:
- topics: 1-5 topic tags (lowercase, hyphenated)
- people: people or organizations mentioned (lowercase, hyphenated)
- action_items: any action items (empty array if none)
- project: infer the most relevant project name from context, or null if unclear
- importance: 1-5 scale (1=trivial, 3=useful context, 5=critical)

Return JSON: {"thought_type":"...","topics":[],"people":[],"action_items":[],"project":null,"importance":3}`,
        },
        { role: "user", content },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Metadata error: ${JSON.stringify(data)}`);
  try {
    return JSON.parse(data.choices[0].message.content);
  } catch {
    return {
      thought_type: "idea",
      topics: [],
      people: [],
      action_items: [],
      project: null,
      importance: 3,
    };
  }
}

// ── Tool implementations ─────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
async function searchThoughts(supabase: any, openaiKey: string, args: any) {
  const embedding = await generateEmbedding(args.query, openaiKey);
  const { data, error } = await supabase.rpc("match_thoughts", {
    query_embedding: embedding,
    match_threshold: args.threshold ?? 0.3,
    match_count: args.limit ?? 10,
    filter_project: args.project ?? null,
    include_superseded: args.include_superseded ?? false,
  });

  if (error) throw new Error(`Search error: ${error.message}`);

  return {
    content: [
      { type: "text", text: JSON.stringify(data ?? [], null, 2) },
    ],
  };
}

// deno-lint-ignore no-explicit-any
async function deepSearch(supabase: any, openaiKey: string, args: any) {
  const limit = args.limit ?? 10;
  const project = args.project ?? null;

  const embedding = await generateEmbedding(args.query, openaiKey);
  const recentCutoff = new Date(Date.now() - 14 * 86400000).toISOString();

  const [factualResult, broadResult] = await Promise.all([
    supabase.rpc("match_thoughts", {
      query_embedding: embedding,
      match_threshold: 0.25,
      match_count: 15,
      filter_project: project,
      include_superseded: false,
      apply_decay: true,
    }),
    supabase.rpc("match_thoughts", {
      query_embedding: embedding,
      match_threshold: 0.15,
      match_count: 30,
      filter_project: project,
      include_superseded: false,
      apply_decay: true,
    }),
  ]);

  if (factualResult.error) throw new Error(`Factual search error: ${factualResult.error.message}`);
  if (broadResult.error) throw new Error(`Broad search error: ${broadResult.error.message}`);

  // deno-lint-ignore no-explicit-any
  const recentFiltered = (broadResult.data ?? []).filter((t: any) => t.created_at >= recentCutoff);
  // deno-lint-ignore no-explicit-any
  const importantFiltered = (broadResult.data ?? []).filter((t: any) => t.importance >= 4);

  const seen = new Set<number>();
  // deno-lint-ignore no-explicit-any
  const merged: any[] = [];

  // deno-lint-ignore no-explicit-any
  const addResults = (results: any[], strategy: string) => {
    for (const thought of results) {
      if (!seen.has(thought.id)) {
        seen.add(thought.id);
        merged.push({ ...thought, _strategy: strategy });
      } else {
        const existing = merged.find((m) => m.id === thought.id);
        if (existing && thought.similarity > existing.similarity) {
          existing.similarity = thought.similarity;
        }
      }
    }
  };

  addResults(factualResult.data ?? [], "factual");
  addResults(recentFiltered, "recent");
  addResults(importantFiltered, "important");

  merged.sort((a, b) => b.similarity - a.similarity);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          result_count: merged.length,
          results: merged.slice(0, limit),
        }, null, 2),
      },
    ],
  };
}

// deno-lint-ignore no-explicit-any
async function listThoughts(supabase: any, args: any) {
  const days = args.days ?? 30;
  const since = new Date(Date.now() - days * 86400000).toISOString();

  let query = supabase
    .from("thoughts")
    .select(
      "id, content, thought_type, topics, people, action_items, project, importance, source, created_at, related_to, trust_tier",
    )
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(args.limit ?? 20);

  if (args.project) query = query.eq("project", args.project);
  if (args.thought_type) query = query.eq("thought_type", args.thought_type);

  const { data, error } = await query;
  if (error) throw new Error(`List error: ${error.message}`);

  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

// deno-lint-ignore no-explicit-any
async function thoughtStats(supabase: any) {
  const { count: total, error: countError } = await supabase
    .from("thoughts")
    .select("id", { count: "exact", head: true });

  if (countError) throw new Error(`Stats count error: ${countError.message}`);

  // deno-lint-ignore no-explicit-any
  const thoughts: any[] = [];
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("thoughts")
      .select("thought_type, project, topics, people, source")
      .order("id")
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`Stats error: ${error.message}`);
    thoughts.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }

  const byType: Record<string, number> = {};
  const byProject: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const topicCounts: Record<string, number> = {};
  const peopleCounts: Record<string, number> = {};

  for (const t of thoughts) {
    byType[t.thought_type] = (byType[t.thought_type] || 0) + 1;
    if (t.project) byProject[t.project] = (byProject[t.project] || 0) + 1;
    bySource[t.source] = (bySource[t.source] || 0) + 1;
    for (const topic of t.topics || []) {
      topicCounts[topic] = (topicCounts[topic] || 0) + 1;
    }
    for (const person of t.people || []) {
      peopleCounts[person] = (peopleCounts[person] || 0) + 1;
    }
  }

  const sortDesc = (obj: Record<string, number>) =>
    Object.entries(obj)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            total,
            by_type: byType,
            by_project: byProject,
            by_source: bySource,
            top_topics: sortDesc(topicCounts),
            top_people: sortDesc(peopleCounts),
          },
          null,
          2,
        ),
      },
    ],
  };
}

// deno-lint-ignore no-explicit-any
async function captureThought(supabase: any, openaiKey: string, args: any) {
  const content = args.content;
  const source = args.source || "mcp-client";

  const [embedding, metadata] = await Promise.all([
    generateEmbedding(content, openaiKey),
    extractMetadata(content, openaiKey),
  ]);

  // Density check: find nearest neighbors to detect near-duplicates
  const { data: neighbors, error: densityError } = await supabase.rpc(
    "match_thoughts",
    {
      query_embedding: embedding,
      match_threshold: 0.0,
      match_count: 5,
      filter_project: metadata.project,
      include_superseded: false,
      apply_decay: false,
    },
  );

  if (!densityError && Array.isArray(neighbors) && neighbors.length > 0) {
    const scores = neighbors.map((n: { similarity: number }) => n.similarity);
    const avg = scores.reduce((sum: number, s: number) => sum + s, 0) / scores.length;
    const duplicateList = neighbors
      .map((n: { id: number; similarity: number }) => `${n.id} (${n.similarity.toFixed(3)})`)
      .join(", ");

    if (avg > 0.9 && !args.supersedes_id) {
      return {
        content: [
          {
            type: "text",
            text: `Not stored. Dense near-duplicate neighborhood detected (avg similarity ${avg.toFixed(3)}). Nearest matches: ${duplicateList}. Use supersedes_id to replace one of these thoughts, or rephrase to add genuinely new information.`,
          },
        ],
      };
    }
  }

  // Build the row
  const row: Record<string, unknown> = {
    content,
    embedding,
    thought_type: metadata.thought_type,
    topics: metadata.topics,
    people: metadata.people,
    action_items: metadata.action_items,
    project: metadata.project,
    importance: metadata.importance,
    source,
    source_id: `${source}:${Date.now()}`,
    trust_tier: args.trust_tier || "shared",
  };
  if (args.supersedes_id) {
    row.supersedes_id = Number(args.supersedes_id);
  }
  if (args.related_to && Array.isArray(args.related_to)) {
    row.related_to = args.related_to.map(Number);
  }

  const { error } = await supabase.from("thoughts").insert(row);
  if (error) throw new Error(`Capture error: ${error.message}`);

  return {
    content: [
      {
        type: "text",
        text: `Stored. Type: ${metadata.thought_type} | Topics: ${metadata.topics.join(", ") || "none"} | Importance: ${metadata.importance}/5${args.trust_tier ? ` | Tier: ${args.trust_tier}` : ""}`,
      },
    ],
  };
}
