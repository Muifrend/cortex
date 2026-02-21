import { error, object, text, type MCPServer } from "mcp-use/server";
import {
  DailyDigestSchema,
  DeleteNoteSchema,
  GetRelatedSchema,
  ListTagsSchema,
  SaveNoteSchema,
  SearchNotesSchema,
  SummarizeTopicSchema,
} from "../schemas/index.js";
import { AUTO_CONNECT_TOP_K } from "../constants.js";
import type { ConnectionLabel } from "../types.js";
import { assessConnections } from "../services/connections.js";
import { generateEmbedding } from "../services/embeddings.js";
import {
  deleteNote,
  getDeepConnections,
  getDirectConnections,
  getNoteById,
  getRecentNotes,
  insertConnection,
  insertNote,
  listAllTags,
  searchByEmbedding,
} from "../services/supabase.js";

export function registerCortexTools(server: MCPServer): void {
  server.tool(
    {
      name: "cortex_save_note",
      description:
        "Save a note, generate embeddings, and auto-connect it to related notes in the knowledge graph",
      schema: SaveNoteSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ title, content, tags, source }) => {
      try {
        const textToEmbed = title ? `${title}\n${content}` : content;
        const embedding = await generateEmbedding(textToEmbed);
        const note = await insertNote(
          title ?? null,
          content,
          tags,
          source,
          embedding
        );

        const similar = await searchByEmbedding(embedding, AUTO_CONNECT_TOP_K);
        const candidates = similar.filter((candidate) => candidate.id !== note.id);

        const connectionsCreated: Array<{
          target_id: string;
          target_title: string | null;
          label: ConnectionLabel;
          strength: number;
          reasoning: string;
        }> = [];

        if (candidates.length > 0) {
          const assessments = await assessConnections(
            { title: title ?? null, content, tags },
            candidates
          );

          for (const assessment of assessments) {
            try {
              await insertConnection(
                note.id,
                assessment.note_id,
                assessment.label,
                assessment.strength,
                assessment.reasoning
              );
              const target = candidates.find((c) => c.id === assessment.note_id);
              connectionsCreated.push({
                target_id: assessment.note_id,
                target_title: target?.title ?? null,
                label: assessment.label,
                strength: assessment.strength,
                reasoning: assessment.reasoning,
              });
            } catch (connectionErr) {
              console.error("Failed to insert connection:", connectionErr);
            }
          }
        }

        return object({
          note: {
            id: note.id,
            title: note.title,
            content: note.content,
            tags: note.tags,
            source: note.source,
            created_at: note.created_at,
          },
          connections: connectionsCreated,
          message:
            connectionsCreated.length > 0
              ? `Saved note and created ${connectionsCreated.length} connection(s).`
              : "Saved note. No strong connections found.",
        });
      } catch (err) {
        return error(
          `Error saving note: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  server.tool(
    {
      name: "cortex_search_notes",
      description: "Semantic search over notes with optional tag filtering",
      schema: SearchNotesSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ query, limit, tags }) => {
      try {
        const embedding = await generateEmbedding(query);
        const results = await searchByEmbedding(embedding, limit, tags);

        if (results.length === 0) {
          return text(`No notes found matching "${query}".`);
        }

        return object({
          query,
          count: results.length,
          results: results.map((result) => ({
            id: result.id,
            title: result.title,
            content: result.content,
            tags: result.tags,
            similarity: Math.round(result.similarity * 100) / 100,
          })),
        });
      } catch (err) {
        return error(
          `Search error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  server.tool(
    {
      name: "cortex_get_related",
      description: "Traverse the note graph and return directly or deeply related notes",
      schema: GetRelatedSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ note_id, depth, min_strength }) => {
      try {
        const rootNote = await getNoteById(note_id);
        if (!rootNote) {
          return error(`Note ${note_id} not found.`);
        }

        const related =
          depth === 1
            ? await getDirectConnections(note_id, min_strength)
            : await getDeepConnections(note_id, depth, min_strength);

        return object({
          root: {
            id: rootNote.id,
            title: rootNote.title,
            content: rootNote.content,
            tags: rootNote.tags,
          },
          depth,
          min_strength,
          connections_count: related.length,
          connections: related.map((item) => ({
            id: item.id,
            title: item.title,
            content: item.content,
            tags: item.tags,
            relationship: item.connection_label,
            strength: item.connection_strength,
            depth: item.depth,
          })),
        });
      } catch (err) {
        return error(
          `Error getting related notes: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  server.tool(
    {
      name: "cortex_summarize_topic",
      description: "Collect top semantically related notes for topic synthesis",
      schema: SummarizeTopicSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ topic, limit }) => {
      try {
        const embedding = await generateEmbedding(topic);
        const notes = await searchByEmbedding(embedding, limit);

        if (notes.length === 0) {
          return text(`No notes found for topic "${topic}".`);
        }

        return object({
          topic,
          notes_found: notes.length,
          notes: notes.map((note) => ({
            id: note.id,
            title: note.title,
            content: note.content,
            tags: note.tags,
            similarity: Math.round(note.similarity * 100) / 100,
          })),
          instruction:
            "Synthesize these notes into a coherent summary and flag contradictions, tensions, and open questions.",
        });
      } catch (err) {
        return error(
          `Error summarizing topic: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  server.tool(
    {
      name: "cortex_daily_digest",
      description: "Return recent notes and top tag themes for a digest period",
      schema: DailyDigestSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ days, limit }) => {
      try {
        const notes = await getRecentNotes(days, limit);
        if (notes.length === 0) {
          return text(`No notes in the past ${days} days.`);
        }

        const tagCounts: Record<string, number> = {};
        for (const note of notes) {
          for (const tag of note.tags) {
            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
          }
        }

        return object({
          period: `Last ${days} days`,
          total_notes: notes.length,
          top_themes: Object.entries(tagCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([tag, count]) => ({ tag, count })),
          notes: notes.map((note) => ({
            id: note.id,
            title: note.title,
            content: note.content,
            tags: note.tags,
            created_at: note.created_at,
          })),
        });
      } catch (err) {
        return error(
          `Error building daily digest: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  server.tool(
    {
      name: "cortex_delete_note",
      description: "Delete a note and all associated graph connections",
      schema: DeleteNoteSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ note_id }) => {
      try {
        const note = await getNoteById(note_id);
        if (!note) {
          return error(`Note ${note_id} not found.`);
        }

        await deleteNote(note_id);
        return object({
          deleted: true,
          note_id,
          title: note.title,
          message: `Deleted note "${note.title ?? "Untitled"}" and related connections.`,
        });
      } catch (err) {
        return error(
          `Error deleting note: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  server.tool(
    {
      name: "cortex_list_tags",
      description: "List all tags in the knowledge base sorted by usage frequency",
      schema: ListTagsSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ limit }) => {
      try {
        const tags = await listAllTags(limit);
        return object({
          total_tags: tags.length,
          tags,
        });
      } catch (err) {
        return error(
          `Error listing tags: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );
}
