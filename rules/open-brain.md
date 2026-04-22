# Open Brain -- Persistent Memory

Open Brain gives you persistent semantic memory across Claude Code sessions.
It stores thoughts (decisions, insights, context) with auto-extracted metadata
and retrieves them by meaning, not just keywords.

## When to Capture

Call `mcp__open-brain__capture_thought` whenever:

- **Decisions made** -- architecture choices, tool selections, strategy picks
- **Key insights** -- debugging breakthroughs, pattern discoveries, research conclusions
- **Action items** -- things agreed on for outside this session
- **Project context** -- deployment details, environment changes, new repos
- **Problems solved** -- root cause + fix for non-trivial bugs

## When NOT to Capture

- Routine file edits or minor code changes
- Intermediate debugging steps that didn't lead anywhere
- Anything already stored (search first if unsure)
- Raw content from external sources (summarize instead)

Keep captures concise -- 100-500 chars is ideal. The metadata extractor works
best on focused, single-topic thoughts.

## How to Retrieve

**Use `deep_search`** for:
- Session-start context loading ("what's the state of project X")
- Complex or multi-topic queries
- When you need the most complete picture

**Use `search_thoughts`** for:
- Quick single-topic lookups
- Checking for duplicates before capturing
- Simple factual queries

**Use `list_thoughts`** for:
- Browsing recent captures by project or type
- Resuming work on a specific project

**Use `thought_stats`** for:
- High-level view of what's stored
- Understanding the shape of your knowledge base
