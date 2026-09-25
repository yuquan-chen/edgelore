// edgelore · Conversation evidence lane.
//
// Semantic statements are deliberately concise and governed; they should not
// also be forced to serve as a lossless transcript archive. Exact assistant
// payloads (URLs, colors, numbered mappings, code, recipes) and incidental
// user wording therefore live in immutable core:message evidence chunks.
// Retrieval may quote these chunks, while conflict/update semantics continue
// to operate only on core:statement nodes.

import type { GraphStore } from "../model/store.js";
import type { EpisodeRecord, GraphNode, Scope } from "../model/types.js";

export const EVIDENCE_CHUNK_CHARS = 900;
export const EVIDENCE_CHUNK_OVERLAP = 120;

export interface EvidenceTurn {
  role: string;
  content: string;
}

export interface EvidenceContext {
  created_by: string;
  source_ref: string;
  createdAt?: string;
  scope?: Scope;
}

/** Store the lossless source once, outside the semantic node/edge graph. */
export function archiveConversationEpisode(
  graph: GraphStore,
  turns: readonly EvidenceTurn[],
  ctx: EvidenceContext,
): EpisodeRecord {
  return graph.putEpisode({
    id: ctx.source_ref,
    turns,
    created_by: ctx.created_by,
    created_at: ctx.createdAt,
    scope: ctx.scope,
    attributes: { kind: "conversation", verbatim: true },
  });
}

function chunksOf(text: string): Array<{ value: string; start: number; end: number }> {
  const out: Array<{ value: string; start: number; end: number }> = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + EVIDENCE_CHUNK_CHARS);
    if (end < text.length) {
      const boundary = Math.max(
        text.lastIndexOf("\n", end),
        text.lastIndexOf(". ", end),
        text.lastIndexOf(" ", end),
      );
      if (boundary > start + Math.floor(EVIDENCE_CHUNK_CHARS / 2)) end = boundary + 1;
    }
    const value = text.slice(start, end).trim();
    if (value.length > 0) out.push({ value, start, end });
    if (end >= text.length) break;
    start = Math.max(start + 1, end - EVIDENCE_CHUNK_OVERLAP);
  }
  return out;
}

/** Archive exact user/assistant turns as deduplicated, immutable evidence. */
export function archiveConversationEvidence(
  graph: GraphStore,
  turns: readonly EvidenceTurn[],
  ctx: EvidenceContext,
): GraphNode[] {
  const existing = new Set(
    graph
      .queryNodes({ type: "core:message" })
      .filter((node) => node.source_refs.includes(ctx.source_ref))
      .map((node) => node.key)
      .filter((key): key is string => typeof key === "string"),
  );
  const written: GraphNode[] = [];
  turns.forEach((turn, turnIndex) => {
    if ((turn.role !== "user" && turn.role !== "assistant") || !turn.content.trim()) return;
    chunksOf(turn.content).forEach((chunk, chunkIndex) => {
      const key = `${ctx.source_ref}:turn:${turnIndex}:chunk:${chunkIndex}`;
      if (existing.has(key)) return;
      written.push(
        graph.addNode({
          type: "core:message",
          key,
          value: chunk.value,
          state: "accepted",
          created_by: ctx.created_by,
          created_at: ctx.createdAt,
          source_refs: [ctx.source_ref],
          scope: ctx.scope,
          attributes: {
            role: turn.role,
            turn_index: turnIndex,
            chunk_index: chunkIndex,
            chunk_start: chunk.start,
            chunk_end: chunk.end,
            verbatim: true,
          },
          tags: ["conversation-evidence"],
        }),
      );
      existing.add(key);
    });
  });
  return written;
}

/** Canonical text for lexical/vector indexing of one evidence chunk. */
export function conversationEvidenceText(node: GraphNode): string {
  const role = node.attributes?.role === "assistant" ? "assistant" : "user";
  return `${role} verbatim conversation evidence: ${String(node.value ?? "")}`;
}
