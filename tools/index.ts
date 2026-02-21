import { error, object, text, widget, type MCPServer } from "mcp-use/server";
import {
  DailyDigestSchema,
  DeleteNoteSchema,
  GetRelatedSchema,
  ListTagsSchema,
  SaveNoteSchema,
  SearchNotesSchema,
  SummarizeTopicSchema,
  VisualizeInterestsSchema,
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
  getInterestGraph,
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
      const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
      let note;
      let embedding: number[];
      try {
        const textToEmbed = title ? `${title}\n${content}` : content;
        embedding = await generateEmbedding(textToEmbed);
        note = await insertNote(title ?? null, content, tags, source, embedding);
      } catch (err) {
        return error(
          `Error saving note: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      const connectionsCreated: Array<{
        target_id: string;
        target_title: string | null;
        label: ConnectionLabel;
        strength: number;
        reasoning: string;
      }> = [];
      let connectionInsertFailures = 0;
      let warning: string | null = null;

      try {
        const similar = await searchByEmbedding(embedding, AUTO_CONNECT_TOP_K);
        const candidates = similar.filter((candidate) => candidate.id !== note.id);

        if (candidates.length > 0) {
          let assessments: Array<{
            note_id: string;
            label: ConnectionLabel;
            strength: number;
            reasoning: string;
          }> = [];

          try {
            assessments = await assessConnections(
              { title: title ?? null, content, tags },
              candidates
            );
          } catch (assessmentErr) {
            warning = `Note saved. LLM connection assessment failed, using similarity fallback: ${
              assessmentErr instanceof Error
                ? assessmentErr.message
                : String(assessmentErr)
            }`;
            assessments = candidates
              .filter((candidate) => candidate.similarity >= 0.4)
              .slice(0, 3)
              .map((candidate) => ({
                note_id: candidate.id,
                label: "related_to" as const,
                strength: clamp01(candidate.similarity),
                reasoning:
                  "Fallback edge created from embedding similarity when LLM assessment was unavailable.",
              }));
          }

          // If the model returns an empty/invalid set, keep graph connectivity by
          // adding similarity-based edges for the strongest neighbors.
          if (assessments.length === 0) {
            assessments = candidates
              .filter((candidate) => candidate.similarity >= 0.5)
              .slice(0, 2)
              .map((candidate) => ({
                note_id: candidate.id,
                label: "related_to" as const,
                strength: clamp01(candidate.similarity),
                reasoning:
                  "Auto-connected from high embedding similarity (no explicit LLM relationship found).",
              }));
          }

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
              connectionInsertFailures += 1;
              console.error("Failed to insert connection:", connectionErr);
            }
          }
        }
      } catch (err) {
        warning = `Note saved, but semantic connection analysis could not be completed: ${
          err instanceof Error ? err.message : String(err)
        }`;
        console.error("Post-save enrichment failed:", err);
      }

      if (connectionInsertFailures > 0) {
        const failureMessage = `Failed to persist ${connectionInsertFailures} connection(s). Check server logs for details.`;
        warning = warning ? `${warning} ${failureMessage}` : failureMessage;
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
        warning,
        message:
          connectionsCreated.length > 0
            ? `Saved note and created ${connectionsCreated.length} connection(s).`
            : "Saved note. No strong connections found.",
      });
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
      name: "cortex_visualize_interests",
      description:
        "Visualize your note network as an interactive graph of interests and relationships",
      schema: VisualizeInterestsSchema,
      widget: {
        name: "idea-graph",
        invoking: "Building your interest graph...",
        invoked: "Interest graph ready",
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ limit, min_similarity, min_strength, tag }) => {
      try {
        const similarityThreshold = min_similarity ?? min_strength ?? 0.3;
        const { nodes, edges } = await getInterestGraph(
          limit,
          similarityThreshold,
          tag
        );

        return widget({
          props: {
            nodes: nodes.map((node) => ({
              id: node.id,
              title: node.title,
              content: node.content,
              tags: node.tags,
              source: node.source,
              created_at: node.created_at,
            })),
            edges: edges.map((edge) => ({
              id: edge.id,
              source_id: edge.source_id,
              target_id: edge.target_id,
              label: edge.label,
              strength: edge.strength,
              reasoning: edge.reasoning,
              created_at: edge.created_at,
            })),
            filters: {
              requested_limit: limit,
              min_similarity: similarityThreshold,
              tag: tag ?? null,
            },
          },
          output: text(
            `Loaded ${nodes.length} concepts and ${edges.length} connections above similarity ${similarityThreshold.toFixed(2)}.`
          ),
        });
      } catch (err) {
        return error(
          `Error visualizing interests: ${err instanceof Error ? err.message : String(err)}`
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
