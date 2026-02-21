import OpenAI from "openai";
import type { ConnectionAssessment, SimilarNote } from "../types.js";

const VALID_LABELS = new Set([
  "supports",
  "contradicts",
  "follows_from",
  "expands_on",
  "related_to",
]);

let client: OpenAI | null = null;

function getOpenAI(): OpenAI | null {
  if (client) {
    return client;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  client = new OpenAI({ apiKey });
  return client;
}

function safeJsonArray(raw: string): unknown[] {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const start = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(trimmed.slice(start, end + 1));
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  }
}

export async function assessConnections(
  newNote: { title: string | null; content: string; tags: string[] },
  candidates: SimilarNote[]
): Promise<ConnectionAssessment[]> {
  const openai = getOpenAI();
  if (!openai || candidates.length === 0) {
    return [];
  }

  const candidateList = candidates
    .map(
      (c, i) =>
        `[${i + 1}] (id: ${c.id}) "${c.title ?? "Untitled"}": ${c.content.slice(0, 300)}`
    )
    .join("\n");

  const prompt = `Assess meaningful graph relationships between a new note and candidate notes.

New note:
Title: "${newNote.title ?? "Untitled"}"
Content: ${newNote.content}
Tags: ${newNote.tags.join(", ")}

Candidates:
${candidateList}

Return ONLY a JSON array. Include only genuinely meaningful relationships:
[
  {
    "note_id": "<candidate id>",
    "label": "supports|contradicts|follows_from|expands_on|related_to",
    "strength": 0.0-1.0,
    "reasoning": "one short sentence"
  }
]
`;

  try {
    const response = await openai.chat.completions.create({
      model: process.env.CONNECTION_ASSESSMENT_MODEL || "gpt-4.1-mini",
      temperature: 0.1,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.choices[0]?.message?.content ?? "[]";
    const parsed = safeJsonArray(text);

    return parsed
      .map((item) => item as Partial<ConnectionAssessment>)
      .filter(
        (item): item is ConnectionAssessment =>
          typeof item.note_id === "string" &&
          typeof item.reasoning === "string" &&
          typeof item.strength === "number" &&
          item.strength >= 0 &&
          item.strength <= 1 &&
          typeof item.label === "string" &&
          VALID_LABELS.has(item.label)
      );
  } catch (err) {
    console.error("Connection assessment failed:", err);
    return [];
  }
}
