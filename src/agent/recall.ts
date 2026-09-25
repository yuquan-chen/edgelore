// edgelore · Host-facing read facade.
//
// recall() packages the existing retrievalContext result for host adapters.
// It does not call a chat model, create graph objects, or own the answer step.

import type { MemoryGraph } from "../model/store.js";
import type {
  RetrievalReadConfig,
  RetrievedClaim,
  RetrievedEvidence,
  RetrievedSlot,
} from "./runtime.js";
import { retrievalContext } from "./runtime.js";
import type { Scope } from "../model/types.js";

/** Source identity boundary currently supported by the retrieval runtime. */
export interface RecallScope extends Scope {
  sessionIds?: readonly string[];
}

export interface RecallOptions {
  scope?: RecallScope;
  /** Retrieval budgets and optional embedding plumbing. */
  retrieval?: RetrievalReadConfig;
}

/** Structured, bounded recall output. This is a response value, never a graph node. */
export interface MemoryCapsule {
  query: string;
  scope?: RecallScope;
  claims: RetrievedClaim[];
  slots: RetrievedSlot[];
  evidence: RetrievedEvidence[];
  context: string[];
}

/**
 * Recall relevant memory for a host Agent.
 *
 * Uses the complete retrievalContext path: hybrid retrieval, graph expansion,
 * Slot grouping, provenance-aware Episode recovery, and bounded context output.
 * No chat LLM call is made; an embedding call may occur when vector retrieval
 * plumbing is explicitly supplied.
 */
export async function recall(
  graph: MemoryGraph,
  query: string,
  options: RecallOptions = {},
): Promise<MemoryCapsule> {
  const sessionIds = options.scope?.sessionIds ?? options.retrieval?.scopeSessionIds;
  const { sessionIds: _sessionIds, ...identityScope } = options.scope ?? {};
  const hasIdentityScope = options.scope !== undefined &&
    (Object.keys(identityScope).length === 0 ||
      identityScope.owner_id !== undefined ||
      identityScope.project_id !== undefined ||
      identityScope.phase_id !== undefined);
  const result = await retrievalContext(graph, query, {
    ...options.retrieval,
    mode: options.retrieval?.mode ?? "hybrid",
    ...(hasIdentityScope ? { scope: identityScope } : {}),
    ...(sessionIds ? { scopeSessionIds: sessionIds } : {}),
  });

  return {
    query,
    ...(options.scope
      ? { scope: { ...identityScope, ...(sessionIds ? { sessionIds: [...sessionIds] } : {}) } }
      : sessionIds
        ? { scope: { sessionIds: [...sessionIds] } }
        : {}),
    claims: result.claims,
    slots: result.slots,
    evidence: result.evidence,
    context: result.lines,
  };
}
