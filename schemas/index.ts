import { z } from "zod";

export const SaveNoteSchema = z
  .object({
    title: z.string().max(200).optional().describe("Short title for the note"),
    content: z
      .string()
      .min(1)
      .max(10000)
      .describe(
        "The note content: an idea, insight, decision, or any thought worth remembering"
      ),
    tags: z
      .array(z.string().max(50))
      .max(10)
      .default([])
      .describe(
        "Tags for this note, for example ['strategy', 'launch', 'decision']"
      ),
    source: z
      .enum(["manual", "auto", "conversation"])
      .default("manual")
      .describe("Where this note originated from"),
  })
  .strict();

export const SearchNotesSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(500)
      .describe(
        "Natural language query for semantic note search, not keyword-only matching"
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe("Maximum number of notes to return"),
    tags: z
      .array(z.string())
      .optional()
      .describe("Optional filter requiring all provided tags"),
  })
  .strict();

export const GetRelatedSchema = z
  .object({
    note_id: z
      .string()
      .uuid()
      .describe("UUID of the note to traverse from"),
    depth: z
      .number()
      .int()
      .min(1)
      .max(3)
      .default(1)
      .describe("Traversal depth: 1 for direct, up to 3 hops"),
    min_strength: z
      .number()
      .min(0)
      .max(1)
      .default(0.3)
      .describe("Minimum connection strength to include"),
  })
  .strict();

export const SummarizeTopicSchema = z
  .object({
    topic: z
      .string()
      .min(1)
      .max(500)
      .describe("Topic to summarize from related notes"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(10)
      .describe("Maximum number of notes to include"),
  })
  .strict();

export const DailyDigestSchema = z
  .object({
    days: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(7)
      .describe("How many recent days to include in digest"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(10)
      .describe("Maximum number of notes to include"),
  })
  .strict();

export const DeleteNoteSchema = z
  .object({
    note_id: z.string().uuid().describe("UUID of the note to delete"),
  })
  .strict();

export const ListTagsSchema = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .describe("Maximum number of tags to return"),
  })
  .strict();
