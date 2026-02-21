export interface Note {
  id: string;
  title: string | null;
  content: string;
  tags: string[];
  source: "manual" | "auto" | "conversation";
  created_at: string;
  updated_at: string;
}

export type ConnectionLabel =
  | "supports"
  | "contradicts"
  | "follows_from"
  | "expands_on"
  | "related_to";

export interface Connection {
  id: string;
  source_id: string;
  target_id: string;
  label: ConnectionLabel;
  strength: number;
  reasoning: string | null;
  created_at: string;
}

export interface SimilarNote {
  id: string;
  title: string | null;
  content: string;
  tags: string[];
  similarity: number;
}

export interface GraphNode {
  id: string;
  title: string | null;
  content: string;
  tags: string[];
  depth: number;
  connection_label: ConnectionLabel;
  connection_strength: number;
}

export interface ConnectionAssessment {
  note_id: string;
  label: ConnectionLabel;
  strength: number;
  reasoning: string;
}
