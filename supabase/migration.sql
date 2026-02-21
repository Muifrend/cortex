-- ============================================================
-- CORTEX — Supabase Schema Migration
-- Run this in the Supabase SQL Editor (supabase.com/dashboard)
-- ============================================================

-- 1. Enable pgvector
create extension if not exists vector;

-- 2. Notes table
create table if not exists notes (
  id uuid primary key default gen_random_uuid(),
  title text,
  content text not null,
  tags text[] default '{}',
  source text default 'manual' check (source in ('manual', 'auto', 'conversation')),
  embedding vector(1536),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 3. Connections table (knowledge graph edges)
create table if not exists connections (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references notes(id) on delete cascade,
  target_id uuid references notes(id) on delete cascade,
  label text not null check (label in ('supports', 'contradicts', 'follows_from', 'expands_on', 'related_to')),
  strength float default 1.0 check (strength >= 0 and strength <= 1),
  reasoning text,
  created_at timestamptz default now(),
  unique(source_id, target_id, label)
);

-- 4. Indexes
create index if not exists notes_embedding_idx on notes
  using hnsw (embedding vector_cosine_ops);

create index if not exists notes_tags_idx on notes using gin (tags);
create index if not exists notes_created_idx on notes (created_at desc);
create index if not exists connections_source_idx on connections (source_id);
create index if not exists connections_target_idx on connections (target_id);

-- Cleanup legacy owner-scoping columns/indexes if they exist.
drop index if exists notes_user_id_idx;
alter table notes drop column if exists user_id;

-- 5. Auto-update updated_at
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists notes_updated_at on notes;
create trigger notes_updated_at
  before update on notes
  for each row execute function update_updated_at();

-- ============================================================
-- RPC Functions
-- ============================================================

-- Cleanup legacy overloaded RPCs from older schema versions (user-scoped variant)
drop function if exists public.match_notes(vector, double precision, integer, text[]);
drop function if exists public.match_notes(vector, double precision, integer, text[], uuid);
drop function if exists public.get_connections(uuid, double precision, uuid);
drop function if exists public.get_connections_deep(uuid, integer, double precision, uuid);
drop function if exists public.list_tags(integer, uuid);

-- 6. Semantic search with optional tag filter
create or replace function match_notes(
  query_embedding vector(1536),
  match_threshold float default 0.3,
  match_count int default 5,
  filter_tags text[] default null
)
returns table (
  id uuid,
  title text,
  content text,
  tags text[],
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    n.id,
    n.title,
    n.content,
    n.tags,
    (1 - (n.embedding <=> query_embedding))::float as similarity
  from notes n
  where
    n.embedding is not null
    and (1 - (n.embedding <=> query_embedding)) > match_threshold
    and (filter_tags is null or n.tags @> filter_tags)
  order by n.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- 7. Direct connections (depth 1)
create or replace function get_connections(
  root_note_id uuid,
  min_strength float default 0.3
)
returns table (
  id uuid,
  title text,
  content text,
  tags text[],
  depth int,
  connection_label text,
  connection_strength float
)
language plpgsql
as $$
begin
  return query
  -- Outgoing connections
  select
    n.id, n.title, n.content, n.tags,
    1 as depth,
    c.label as connection_label,
    c.strength as connection_strength
  from connections c
  join notes n on n.id = c.target_id
  where c.source_id = root_note_id
    and c.strength >= min_strength
  union
  -- Incoming connections
  select
    n.id, n.title, n.content, n.tags,
    1 as depth,
    c.label as connection_label,
    c.strength as connection_strength
  from connections c
  join notes n on n.id = c.source_id
  where c.target_id = root_note_id
    and c.strength >= min_strength;
end;
$$;

-- 8. Deep connections (multi-hop traversal)
create or replace function get_connections_deep(
  root_note_id uuid,
  max_depth int default 2,
  min_strength float default 0.3
)
returns table (
  id uuid,
  title text,
  content text,
  tags text[],
  depth int,
  connection_label text,
  connection_strength float
)
language plpgsql
as $$
begin
  return query
  with recursive graph as (
    -- Base case: direct connections
    select
      n.id, n.title, n.content, n.tags,
      1 as depth,
      c.label as connection_label,
      c.strength as connection_strength
    from connections c
    join notes n on n.id = c.target_id
    where c.source_id = root_note_id
      and c.strength >= min_strength

    union

    select
      n.id, n.title, n.content, n.tags,
      1 as depth,
      c.label as connection_label,
      c.strength as connection_strength
    from connections c
    join notes n on n.id = c.source_id
    where c.target_id = root_note_id
      and c.strength >= min_strength

    union

    -- Recursive case
    select
      n.id, n.title, n.content, n.tags,
      g.depth + 1,
      c.label,
      c.strength
    from graph g
    join connections c on (c.source_id = g.id or c.target_id = g.id)
    join notes n on n.id = case
      when c.source_id = g.id then c.target_id
      else c.source_id
    end
    where g.depth < max_depth
      and c.strength >= min_strength
      and n.id != root_note_id
  )
  select distinct on (graph.id)
    graph.id, graph.title, graph.content, graph.tags,
    graph.depth, graph.connection_label, graph.connection_strength
  from graph
  order by graph.id, graph.depth asc;
end;
$$;

-- 9. List all tags with counts
create or replace function list_tags(max_tags int default 50)
returns table (tag text, count bigint)
language plpgsql
as $$
begin
  return query
  select unnest(n.tags) as tag, count(*) as count
  from notes n
  group by tag
  order by count desc
  limit max_tags;
end;
$$;
