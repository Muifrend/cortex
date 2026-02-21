import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  Connection,
  ConnectionLabel,
  GraphNode,
  InterestGraphEdge,
  InterestGraphNode,
  Note,
  SimilarNote,
} from "../types.js";

let supabase: SupabaseClient | null = null;

function parseEmbedding(raw: unknown): number[] {
  if (Array.isArray(raw)) {
    return raw.filter((n): n is number => typeof n === "number");
  }

  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((n): n is number => typeof n === "number")
        : [];
    } catch {
      return [];
    }
  }

  return [];
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  if (magA === 0 || magB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function getSupabase(): SupabaseClient {
  if (supabase) {
    return supabase;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables."
    );
  }

  supabase = createClient(url, key);
  return supabase;
}

export async function insertNote(
  title: string | null,
  content: string,
  tags: string[],
  source: "manual" | "auto" | "conversation",
  embedding: number[]
): Promise<Note> {
  const db = getSupabase();
  const { data, error } = await db
    .from("notes")
    .insert({
      title,
      content,
      tags,
      source,
      embedding: JSON.stringify(embedding),
    })
    .select("id, title, content, tags, source, created_at, updated_at")
    .single();

  if (error) {
    throw new Error(`Failed to insert note: ${error.message}`);
  }

  return data as Note;
}

export async function deleteNote(noteId: string): Promise<void> {
  const db = getSupabase();
  const { error } = await db.from("notes").delete().eq("id", noteId);

  if (error) {
    throw new Error(`Failed to delete note: ${error.message}`);
  }
}

export async function getNoteById(noteId: string): Promise<Note | null> {
  const db = getSupabase();
  const { data, error } = await db
    .from("notes")
    .select("id, title, content, tags, source, created_at, updated_at")
    .eq("id", noteId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch note: ${error.message}`);
  }

  return (data as Note | null) ?? null;
}

export async function searchByEmbedding(
  embedding: number[],
  limit: number,
  tags?: string[]
): Promise<SimilarNote[]> {
  const db = getSupabase();

  // Canonical signature from current migration:
  // match_notes(query_embedding, match_threshold, match_count, filter_tags)
  const { data, error } = await db.rpc("match_notes", {
    query_embedding: JSON.stringify(embedding),
    match_threshold: 0.3,
    match_count: limit,
    filter_tags: tags && tags.length > 0 ? tags : null,
  });

  if (
    error?.message?.includes(
      "Could not choose the best candidate function between"
    )
  ) {
    throw new Error(
      "Semantic search RPC overload ambiguity for match_notes. Apply supabase/migration.sql to remove legacy overloads."
    );
  }

  if (error) {
    // Temporary safe fallback for stale DB RPCs that still reference n.user_id.
    // This avoids hard failure and removes runtime dependency on that column.
    if (error.message.includes("column n.user_id does not exist")) {
      const notesRes = await db
        .from("notes")
        .select("id, title, content, tags, embedding")
        .not("embedding", "is", null);

      if (notesRes.error) {
        throw new Error(`Semantic search failed: ${notesRes.error.message}`);
      }

      const tagFilter = tags && tags.length > 0 ? tags : null;
      const scored = (notesRes.data ?? [])
        .map((row) => {
          const noteEmbedding = parseEmbedding(
            (row as { embedding?: unknown }).embedding
          );
          const similarity = cosineSimilarity(embedding, noteEmbedding);
          return {
            id: row.id as string,
            title: (row as { title: string | null }).title,
            content: row.content as string,
            tags: (row.tags as string[]) ?? [],
            similarity,
          };
        })
        .filter((row) => row.similarity > 0.3)
        .filter((row) =>
          tagFilter ? tagFilter.every((t) => row.tags.includes(t)) : true
        )
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);

      return scored;
    }

    throw new Error(`Semantic search failed: ${error.message}`);
  }

  return (data ?? []) as SimilarNote[];
}

export async function insertConnection(
  sourceId: string,
  targetId: string,
  label: ConnectionLabel,
  strength: number,
  reasoning: string | null
): Promise<Connection> {
  const db = getSupabase();
  const { data, error } = await db
    .from("connections")
    .upsert(
      {
        source_id: sourceId,
        target_id: targetId,
        label,
        strength,
        reasoning,
      },
      { onConflict: "source_id,target_id,label" }
    )
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to insert connection: ${error.message}`);
  }

  return data as Connection;
}

export async function getDirectConnections(
  noteId: string,
  minStrength: number
): Promise<GraphNode[]> {
  const db = getSupabase();
  const { data, error } = await db.rpc("get_connections", {
    root_note_id: noteId,
    min_strength: minStrength,
  });

  if (error) {
    throw new Error(`Failed to get direct connections: ${error.message}`);
  }

  return (data ?? []) as GraphNode[];
}

export async function getDeepConnections(
  noteId: string,
  depth: number,
  minStrength: number
): Promise<GraphNode[]> {
  const db = getSupabase();
  const { data, error } = await db.rpc("get_connections_deep", {
    root_note_id: noteId,
    max_depth: depth,
    min_strength: minStrength,
  });

  if (error) {
    throw new Error(`Failed to get deep connections: ${error.message}`);
  }

  return (data ?? []) as GraphNode[];
}

export async function listAllTags(
  limit: number
): Promise<Array<{ tag: string; count: number }>> {
  const db = getSupabase();
  const { data, error } = await db.rpc("list_tags", { max_tags: limit });

  if (error) {
    throw new Error(`Failed to list tags: ${error.message}`);
  }

  return ((data ?? []) as Array<{ tag: string; count: number | string }>).map(
    (row) => ({
      tag: row.tag,
      count:
        typeof row.count === "number"
          ? row.count
          : Number.parseInt(String(row.count), 10) || 0,
    })
  );
}

export async function getRecentNotes(
  days: number,
  limit: number
): Promise<Note[]> {
  const db = getSupabase();
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await db
    .from("notes")
    .select("id, title, content, tags, source, created_at, updated_at")
    .gte("created_at", since.toISOString())
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to get recent notes: ${error.message}`);
  }

  return (data ?? []) as Note[];
}

export async function getInterestGraph(
  limit: number,
  minStrength: number,
  tag?: string
): Promise<{ nodes: InterestGraphNode[]; edges: InterestGraphEdge[] }> {
  const db = getSupabase();
  let notesQuery = db
    .from("notes")
    .select("id, title, content, tags, source, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (tag) {
    notesQuery = notesQuery.contains("tags", [tag]);
  }

  const notesRes = await notesQuery;
  if (notesRes.error) {
    throw new Error(`Failed to fetch graph notes: ${notesRes.error.message}`);
  }

  const nodes = (notesRes.data ?? []) as InterestGraphNode[];
  if (nodes.length === 0) {
    return { nodes: [], edges: [] };
  }

  const nodeIds = nodes.map((node) => node.id);
  const edgesRes = await db
    .from("connections")
    .select("id, source_id, target_id, label, strength, reasoning, created_at")
    .in("source_id", nodeIds)
    .in("target_id", nodeIds)
    .gte("strength", minStrength);

  if (edgesRes.error) {
    throw new Error(`Failed to fetch graph connections: ${edgesRes.error.message}`);
  }

  return {
    nodes,
    edges: (edgesRes.data ?? []) as InterestGraphEdge[],
  };
}
