import { z } from "zod";

const sourceSchema = z.enum(["manual", "auto", "conversation"]);
const edgeLabelSchema = z.enum([
  "supports",
  "contradicts",
  "follows_from",
  "expands_on",
  "related_to",
]);

export const ideaGraphPropsSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      title: z.string().nullable(),
      content: z.string(),
      tags: z.array(z.string()),
      source: sourceSchema,
      created_at: z.string(),
    })
  ),
  edges: z.array(
    z.object({
      id: z.string(),
      source_id: z.string(),
      target_id: z.string(),
      label: edgeLabelSchema,
      strength: z.number(),
      reasoning: z.string().nullable(),
      created_at: z.string(),
    })
  ),
  filters: z.object({
    requested_limit: z.number(),
    min_similarity: z.number(),
    tag: z.string().nullable(),
  }),
});

export type IdeaGraphProps = z.infer<typeof ideaGraphPropsSchema>;
export type IdeaGraphNode = IdeaGraphProps["nodes"][number];
export type IdeaGraphEdge = IdeaGraphProps["edges"][number];
