import OpenAI from "openai";
import { EMBEDDING_MODEL } from "../constants.js";

let client: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (client) {
    return client;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY environment variable.");
  }

  client = new OpenAI({ apiKey });
  return client;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const openai = getOpenAI();
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });

  return response.data[0]?.embedding ?? [];
}
