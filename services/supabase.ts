import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  Connection,
  ConnectionLabel,
  GraphNode,
  Note,
  SimilarNote,
} from "../types.js";

let supabase: SupabaseClient | null = null;

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
  const { data, error } = await db.rpc("match_notes", {
    query_embedding: JSON.stringify(embedding),
    match_threshold: 0.3,
    match_count: limit,
    filter_tags: tags && tags.length > 0 ? tags : null,
  });

  if (error) {
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
