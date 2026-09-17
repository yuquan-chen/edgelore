// edgelore · M1 — Constraint expression engine.
//
// A whitelisted (D09) AST evaluator. The ExpressionNode shape is reserved in
// M0 (src/model/types.ts); this module gives it semantics. The result is one
// of four states, kept deliberately small (narrow state + wide metadata):
//
//   satisfied     — the rule body evaluates to true
//   violated      — the rule body evaluates to false
//   indeterminate — data needed to decide is missing (NOT a bug; recoverable)
//   error         — the expression is malformed / operator not whitelisted /
//                   type-mismatched (an authoring bug; unrecoverable)
//
// Missing data propagates upward: if an aggregation has no values yet, the
// whole comparison it feeds becomes indeterminate rather than violated. Error
// dominates — a malformed sub-tree fails the whole expression.

import type { ExpressionNode } from "../model/types.js";

/** The four evaluation outcomes for a constraint body. */
export type EvaluationResult = "satisfied" | "violated" | "indeterminate" | "error";

/**
 * Resolution context handed to the engine. The engine is graph-agnostic: it
 * never touches the graph. `resolveRef` maps a binding name (e.g. "x1") to the
 * list of numeric values that dimension currently has. Returning `null` means
 * the name is not a declared binding (error); `[]` means no data yet
 * (indeterminate).
 */
export interface EvalContext {
  resolveRef: (name: string) => number[] | null;
}

// D09 whitelist — the closed operator contract. Anything outside this set is
// rejected with `error`.
const ARITHMETIC = new Set(["+", "-", "*", "/"]);
const COMPARISON = new Set(["<", "<=", ">", ">=", "==", "!="]);
const LOGICAL = new Set(["and", "or"]);
const AGGREGATION = new Set(["sum", "avg", "min", "max", "count"]);
const NOT_OP = "not";

type Arg = ExpressionNode | { ref: string } | number;

/** Internal numeric outcome: a concrete number, missing data, or a bug. */
type NumResult =
  { status: "value"; value: number } | { status: "indeterminate" } | { status: "error" };

/**
 * Evaluate a constraint body AST against the context. The top level MUST be a
 * boolean expression (comparison / logical / not); if it resolves to a number,
 * that is an authoring error.
 *
 * @param expr the constraint body AST
 * @param ctx resolution context (binding name -> values)
 * @returns one of the four evaluation states
 */
export function evaluate(expr: ExpressionNode, ctx: EvalContext): EvaluationResult {
  return evalBool(expr, ctx);
}

function isRef(arg: Arg): arg is { ref: string } {
  return typeof arg === "object" && arg !== null && "ref" in arg;
}

// --- boolean layer ---------------------------------------------------------

function evalBool(node: ExpressionNode, ctx: EvalContext): EvaluationResult {
  const op = node.op;

  if (op === NOT_OP) {
    if (node.args.length !== 1) return "error";
    const child = asBoolArg(node.args[0], ctx);
    if (child === "error" || child === "indeterminate") return child;
    return child === "satisfied" ? "violated" : "satisfied";
  }

  if (LOGICAL.has(op)) {
    if (node.args.length !== 2) return "error";
    const left = asBoolArg(node.args[0], ctx);
    const right = asBoolArg(node.args[1], ctx);
    if (left === "error" || right === "error") return "error";
    if (left === "indeterminate" || right === "indeterminate") return "indeterminate";
    const l = left === "satisfied";
    const r = right === "satisfied";
    const result = op === "and" ? l && r : l || r;
    return result ? "satisfied" : "violated";
  }

  if (COMPARISON.has(op)) {
    if (node.args.length !== 2) return "error";
    const a = evalNumArg(node.args[0], ctx);
    const b = evalNumArg(node.args[1], ctx);
    if (a.status === "error" || b.status === "error") return "error";
    if (a.status === "indeterminate" || b.status === "indeterminate") return "indeterminate";
    return compare(op, a.value, b.value) ? "satisfied" : "violated";
  }

  // Unknown operator, or a non-boolean operator used where a boolean is
  // expected (e.g. an arithmetic root) — an authoring error.
  return "error";
}

function asBoolArg(arg: Arg, ctx: EvalContext): EvaluationResult {
  if (typeof arg === "number" || isRef(arg)) return "error";
  return evalBool(arg, ctx);
}

// --- numeric layer ---------------------------------------------------------

function evalNumArg(arg: Arg, ctx: EvalContext): NumResult {
  if (typeof arg === "number") return { status: "value", value: arg };
  if (isRef(arg)) return { status: "error" }; // bare ref is only valid inside aggregation
  return evalNum(arg, ctx);
}

function evalNum(node: ExpressionNode, ctx: EvalContext): NumResult {
  const op = node.op;

  if (AGGREGATION.has(op)) {
    if (node.args.length !== 1) return { status: "error" };
    const arg = node.args[0];
    if (!isRef(arg)) return { status: "error" }; // aggregation takes exactly one ref
    const values = ctx.resolveRef(arg.ref);
    if (values === null) return { status: "error" }; // binding not declared
    if (values.length === 0) return { status: "indeterminate" }; // no data yet
    return { status: "value", value: aggregate(op, values) };
  }

  if (ARITHMETIC.has(op)) {
    if (node.args.length !== 2) return { status: "error" };
    const a = evalNumArg(node.args[0], ctx);
    if (a.status !== "value") return a;
    const b = evalNumArg(node.args[1], ctx);
    if (b.status !== "value") return b;
    return arithmetic(op, a.value, b.value);
  }

  return { status: "error" }; // unknown / non-numeric operator in numeric context
}

// --- primitives ------------------------------------------------------------

function arithmetic(op: string, x: number, y: number): NumResult {
  switch (op) {
    case "+":
      return { status: "value", value: x + y };
    case "-":
      return { status: "value", value: x - y };
    case "*":
      return { status: "value", value: x * y };
    case "/":
      return y === 0 ? { status: "error" } : { status: "value", value: x / y };
    default:
      return { status: "error" };
  }
}

function aggregate(op: string, values: number[]): number {
  switch (op) {
    case "sum":
      return values.reduce((acc, v) => acc + v, 0);
    case "avg":
      return values.reduce((acc, v) => acc + v, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    case "count":
      return values.length;
    default:
      return 0;
  }
}

function compare(op: string, x: number, y: number): boolean {
  switch (op) {
    case "<":
      return x < y;
    case "<=":
      return x <= y;
    case ">":
      return x > y;
    case ">=":
      return x >= y;
    case "==":
      return x === y;
    case "!=":
      return x !== y;
    default:
      return false;
  }
}
