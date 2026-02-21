import { McpUseProvider, useWidget, type WidgetMetadata } from "mcp-use/react";
import { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import {
  ideaGraphPropsSchema,
  type IdeaGraphEdge,
  type IdeaGraphNode,
  type IdeaGraphProps,
} from "./idea-graph/types";

export const widgetMetadata: WidgetMetadata = {
  description:
    "Interactive 3D-style graph visualization of note concepts and their similarities",
  props: ideaGraphPropsSchema,
  exposeAsTool: false,
  metadata: {
    invoking: "Building graph...",
    invoked: "Graph ready",
  },
};

const SOURCE_COLORS: Record<IdeaGraphNode["source"], string> = {
  manual: "#0f766e",
  auto: "#2563eb",
  conversation: "#b45309",
};

const EDGE_COLORS: Record<IdeaGraphEdge["label"], string> = {
  supports: "#16a34a",
  contradicts: "#dc2626",
  follows_from: "#2563eb",
  expands_on: "#9333ea",
  related_to: "#64748b",
};

const VIEW_WIDTH = 1100;
const VIEW_HEIGHT = 700;
const CAMERA_DISTANCE = 520;
const GOLDEN_ANGLE = 2.3999632297;

type Vec3 = { x: number; y: number; z: number };

type ProjectedNode = {
  node: IdeaGraphNode;
  x: number;
  y: number;
  z: number;
  radius: number;
};

function truncate(text: string, maxLength: number) {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength).trim()}...`;
}

function build3DLayout(nodes: IdeaGraphNode[]) {
  const radius = 220;
  const layout = new Map<string, Vec3>();

  nodes.forEach((node, index) => {
    const y = 1 - (index / Math.max(nodes.length - 1, 1)) * 2;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = index * GOLDEN_ANGLE;
    layout.set(node.id, {
      x: Math.cos(theta) * ring * radius,
      y: y * radius,
      z: Math.sin(theta) * ring * radius,
    });
  });

  return layout;
}

function rotatePoint(point: Vec3, rotX: number, rotY: number): Vec3 {
  const cosY = Math.cos(rotY);
  const sinY = Math.sin(rotY);
  const x1 = point.x * cosY + point.z * sinY;
  const z1 = -point.x * sinY + point.z * cosY;

  const cosX = Math.cos(rotX);
  const sinX = Math.sin(rotX);
  const y2 = point.y * cosX - z1 * sinX;
  const z2 = point.y * sinX + z1 * cosX;

  return { x: x1, y: y2, z: z2 };
}

function project(point: Vec3, zoom: number) {
  const scale = (CAMERA_DISTANCE / (CAMERA_DISTANCE - point.z)) * zoom;
  return {
    x: VIEW_WIDTH / 2 + point.x * scale,
    y: VIEW_HEIGHT / 2 + point.y * scale,
    scale,
  };
}

export default function IdeaGraphWidget() {
  const { props, isPending } = useWidget<IdeaGraphProps>();
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | IdeaGraphNode["source"]>(
    "all"
  );
  const [activeTag, setActiveTag] = useState<string>("all");
  const [similarityFilter, setSimilarityFilter] = useState(0.3);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState({ x: -0.4, y: 0.5 });
  const draggingRef = useRef(false);
  const dragLastRef = useRef({ x: 0, y: 0 });
  const safeProps: IdeaGraphProps = isPending
    ? {
        nodes: [],
        edges: [],
        filters: {
          requested_limit: 0,
          min_similarity: 0.3,
          tag: null,
        },
      }
    : props;

  const normalizedQuery = query.trim().toLowerCase();
  const similarityThreshold = Math.max(
    similarityFilter,
    safeProps.filters.min_similarity
  );

  const allTags = useMemo(() => {
    const values = new Set<string>();
    for (const node of safeProps.nodes) {
      for (const tag of node.tags) {
        values.add(tag);
      }
    }
    return [...values].sort((a, b) => a.localeCompare(b));
  }, [safeProps.nodes]);

  const filteredNodes = useMemo(() => {
    return safeProps.nodes.filter((node) => {
      if (sourceFilter !== "all" && node.source !== sourceFilter) {
        return false;
      }
      if (activeTag !== "all" && !node.tags.includes(activeTag)) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      const searchText =
        `${node.title ?? ""} ${node.content} ${node.tags.join(" ")}`.toLowerCase();
      return searchText.includes(normalizedQuery);
    });
  }, [safeProps.nodes, sourceFilter, activeTag, normalizedQuery]);

  const visibleNodeIds = useMemo(
    () => new Set(filteredNodes.map((node) => node.id)),
    [filteredNodes]
  );

  const filteredEdges = useMemo(() => {
    return safeProps.edges.filter(
      (edge) =>
        edge.strength >= similarityThreshold &&
        visibleNodeIds.has(edge.source_id) &&
        visibleNodeIds.has(edge.target_id)
    );
  }, [safeProps.edges, similarityThreshold, visibleNodeIds]);

  const connectedToSelected = useMemo(() => {
    if (!selectedNodeId) {
      return new Set<string>();
    }
    const ids = new Set<string>([selectedNodeId]);
    for (const edge of filteredEdges) {
      if (edge.source_id === selectedNodeId) {
        ids.add(edge.target_id);
      }
      if (edge.target_id === selectedNodeId) {
        ids.add(edge.source_id);
      }
    }
    return ids;
  }, [selectedNodeId, filteredEdges]);

  const nodeById = useMemo(() => {
    return new Map(filteredNodes.map((node) => [node.id, node]));
  }, [filteredNodes]);

  const projectedNodes = useMemo(() => {
    const layout = build3DLayout(filteredNodes);
    const points: ProjectedNode[] = [];

    for (const node of filteredNodes) {
      const base = layout.get(node.id);
      if (!base) {
        continue;
      }
      const rotated = rotatePoint(base, rotation.x, rotation.y);
      const projected = project(rotated, zoom);
      points.push({
        node,
        x: projected.x,
        y: projected.y,
        z: rotated.z,
        radius: 4 + projected.scale * 7,
      });
    }

    return points.sort((a, b) => a.z - b.z);
  }, [filteredNodes, rotation.x, rotation.y, zoom]);

  const projectedById = useMemo(
    () => new Map(projectedNodes.map((p) => [p.node.id, p])),
    [projectedNodes]
  );

  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) : undefined;
  const selectedEdges = selectedNode
    ? filteredEdges.filter(
        (edge) =>
          edge.source_id === selectedNode.id || edge.target_id === selectedNode.id
      )
    : [];

  useEffect(() => {
    const interval = setInterval(() => {
      if (!draggingRef.current) {
        setRotation((prev) => ({ ...prev, y: prev.y + 0.006 }));
      }
    }, 16);
    return () => clearInterval(interval);
  }, []);

  if (isPending) {
    return (
      <McpUseProvider autoSize>
        <div style={{ padding: 16 }}>Loading interest graph...</div>
      </McpUseProvider>
    );
  }

  return (
    <McpUseProvider autoSize>
      <div
        style={{
          padding: 16,
          background:
            "radial-gradient(circle at 20% 10%, #e0f2fe 0%, #f8fafc 45%, #fefce8 100%)",
          borderRadius: 20,
          border: "1px solid #cbd5e1",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 22, color: "#0f172a" }}>
          Concept Similarity Graph (3D)
        </h2>
        <p style={{ margin: "6px 0 12px", color: "#334155", fontSize: 13 }}>
          Drag to rotate. Scroll to zoom. {filteredNodes.length} concepts and{" "}
          {filteredEdges.length} connections above {similarityThreshold.toFixed(2)}
          .
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 10,
            marginBottom: 12,
          }}
        >
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search concepts..."
            style={{
              padding: "8px 10px",
              borderRadius: 10,
              border: "1px solid #94a3b8",
              fontSize: 13,
            }}
          />
          <select
            value={sourceFilter}
            onChange={(event) =>
              setSourceFilter(event.target.value as "all" | IdeaGraphNode["source"])
            }
            style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #94a3b8" }}
          >
            <option value="all">All sources</option>
            <option value="manual">Manual</option>
            <option value="auto">Auto</option>
            <option value="conversation">Conversation</option>
          </select>
          <select
            value={activeTag}
            onChange={(event) => setActiveTag(event.target.value)}
            style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #94a3b8" }}
          >
            <option value="all">All tags</option>
            {allTags.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </select>
          <label style={{ fontSize: 12, color: "#334155", display: "grid", gap: 4 }}>
            Min similarity: {similarityThreshold.toFixed(2)}
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={similarityFilter}
              onChange={(event) =>
                setSimilarityFilter(Number.parseFloat(event.target.value))
              }
            />
          </label>
          <label style={{ fontSize: 12, color: "#334155", display: "grid", gap: 4 }}>
            Zoom: {zoom.toFixed(2)}x
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.01}
              value={zoom}
              onChange={(event) => setZoom(Number.parseFloat(event.target.value))}
            />
          </label>
        </div>

        <div
          style={{
            border: "1px solid #cbd5e1",
            borderRadius: 14,
            background: "linear-gradient(160deg, #0f172a 0%, #1e293b 100%)",
            overflow: "hidden",
            cursor: draggingRef.current ? "grabbing" : "grab",
          }}
        >
          <svg
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            style={{ width: "100%", display: "block", maxHeight: 560 }}
            role="img"
            aria-label="3D concept graph"
            onMouseDown={(event) => {
              draggingRef.current = true;
              dragLastRef.current = { x: event.clientX, y: event.clientY };
            }}
            onMouseMove={(event) => {
              if (!draggingRef.current) {
                return;
              }
              const dx = event.clientX - dragLastRef.current.x;
              const dy = event.clientY - dragLastRef.current.y;
              dragLastRef.current = { x: event.clientX, y: event.clientY };
              setRotation((prev) => ({
                x: Math.max(-1.5, Math.min(1.5, prev.x + dy * 0.008)),
                y: prev.y + dx * 0.008,
              }));
            }}
            onMouseUp={() => {
              draggingRef.current = false;
            }}
            onMouseLeave={() => {
              draggingRef.current = false;
            }}
            onWheel={(event) => {
              event.preventDefault();
              const delta = event.deltaY > 0 ? -0.06 : 0.06;
              setZoom((prev) => Math.max(0.5, Math.min(2, prev + delta)));
            }}
          >
            {filteredEdges.map((edge) => {
              const source = projectedById.get(edge.source_id);
              const target = projectedById.get(edge.target_id);
              if (!source || !target) {
                return null;
              }
              const faded =
                selectedNodeId &&
                !(
                  edge.source_id === selectedNodeId || edge.target_id === selectedNodeId
                );
              return (
                <line
                  key={edge.id}
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  stroke={EDGE_COLORS[edge.label]}
                  strokeWidth={0.8 + edge.strength * 2.2}
                  opacity={faded ? 0.08 : 0.12 + edge.strength * 0.45}
                />
              );
            })}

            {projectedNodes.map((point) => {
              const node = point.node;
              const isSelected = node.id === selectedNodeId;
              const isNeighbor =
                selectedNodeId !== null && connectedToSelected.has(node.id);
              return (
                <g
                  key={node.id}
                  onClick={() => {
                    setSelectedNodeId((prev) => (prev === node.id ? null : node.id));
                  }}
                >
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r={Math.max(3, point.radius + (isSelected ? 2.5 : 0))}
                    fill={SOURCE_COLORS[node.source]}
                    opacity={selectedNodeId ? (isNeighbor ? 0.95 : 0.2) : 0.85}
                    stroke={isSelected ? "#f8fafc" : "#e2e8f0"}
                    strokeWidth={isSelected ? 2.2 : 1}
                  />
                  {isSelected && (
                    <text
                      x={point.x}
                      y={point.y - point.radius - 8}
                      textAnchor="middle"
                      style={{
                        fontSize: 12,
                        fill: "#f8fafc",
                        fontWeight: 600,
                        pointerEvents: "none",
                      }}
                    >
                      {truncate(node.title ?? "Untitled", 26)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>

        <div
          style={{
            display: "grid",
            gap: 8,
            marginTop: 12,
            padding: 10,
            borderRadius: 12,
            background: "#ffffffde",
            border: "1px solid #cbd5e1",
          }}
        >
          <strong style={{ color: "#0f172a", fontSize: 14 }}>Selected concept</strong>
          {selectedNode ? (
            <>
              <div style={{ color: "#0f172a", fontWeight: 600 }}>
                {selectedNode.title ?? "Untitled"}
              </div>
              <div style={{ color: "#334155", fontSize: 13 }}>
                {truncate(selectedNode.content, 220)}
              </div>
              <div style={{ color: "#475569", fontSize: 12 }}>
                Tags: {selectedNode.tags.join(", ") || "none"}
              </div>
              <div style={{ color: "#475569", fontSize: 12 }}>
                Similar connections above threshold: {selectedEdges.length}
              </div>
            </>
          ) : (
            <div style={{ color: "#475569", fontSize: 13 }}>
              Click a concept to inspect details and highlight its connections.
            </div>
          )}
        </div>
      </div>
    </McpUseProvider>
  );
}
