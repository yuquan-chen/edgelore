import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, readFileSync, realpathSync, statSync } from "node:fs";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { SqliteGraph } from "../store/sqlite.js";
import { listConflicts } from "../agent/conflicts.js";
import { slotLabel, slotSubjectRef } from "../agent/slots.js";
import type { DimensionNode, GraphNode, StatementNode } from "../model/types.js";
import { graphBrowserPage } from "./page.js";

const maxNodes = 60;
let graph: SqliteGraph;
const sessions = new Map<string, number>();
const loginAttempts = new Map<string, { count: number; blockedUntil: number }>();
const sessionLifetimeMs = 12 * 60 * 60 * 1000;
let passwordHash = process.env.EDGELORE_UI_PASSWORD_HASH ?? "";
const send = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(data));
};
const int = (value: string | null, fallback: number, max: number) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : fallback;
};
function summary(node: GraphNode): Record<string, unknown> {
  if (node.type === "core:statement") {
    const c = node as StatementNode;
    return {
      id: c.id,
      type: c.type,
      label: String(c.value),
      value: c.value,
      unit: c.unit,
      state: c.state,
      created_at: c.created_at,
      dimension_id: c.dimension_id,
    };
  }
  if (node.type === "core:dimension") {
    const s = node as DimensionNode;
    return {
      id: s.id,
      type: s.type,
      label: slotLabel(graph, s),
      key: s.key,
      state: s.state,
      subject_id: slotSubjectRef(s),
      property_key: s.attributes.propertyKey ?? s.key,
    };
  }
  return {
    id: node.id,
    type: node.type,
    label: (typeof node.value === "string" && node.value) || node.key || node.type,
    key: node.key,
    value: node.value,
    state: node.state,
  };
}
function paged<T>(items: T[], url: URL) {
  const offset = int(url.searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER);
  const limit = Math.max(1, int(url.searchParams.get("limit"), 30, 100));
  return {
    items: items.slice(offset, offset + limit),
    offset,
    limit,
    total: items.length,
    nextOffset: offset + limit < items.length ? offset + limit : null,
  };
}
function details(id: string) {
  const node = graph.getNode(id);
  if (!node) return undefined;
  const slot =
    node.type === "core:statement"
      ? graph.getNode((node as StatementNode).dimension_id)
      : undefined;
  const edges = [
    ...new Map(
      [...graph.queryEdges({ from: id }), ...graph.queryEdges({ to: id })].map((e) => [e.id, e]),
    ).values(),
  ];
  const episodes = node.source_refs.slice(0, 10).flatMap((ref) => {
    const ep = graph.getEpisode(ref);
    return ep
      ? [
          {
            id: ep.id,
            created_at: ep.created_at,
            created_by: ep.created_by,
            turns: ep.turns
              .slice(0, 20)
              .map((t) => ({ role: t.role, content: t.content.slice(0, 2000) })),
          },
        ]
      : [];
  });
  return {
    node,
    slot: slot?.type === "core:dimension" ? summary(slot) : undefined,
    episodes,
    edges: edges
      .slice(0, 80)
      .map((e) => ({
        ...e,
        from_node: graph.getNode(e.from) ? summary(graph.getNode(e.from)!) : undefined,
        to_node: graph.getNode(e.to) ? summary(graph.getNode(e.to)!) : undefined,
      })),
  };
}
function neighborhood(id: string, depth: number, cap: number) {
  const root = graph.getNode(id);
  if (!root) return undefined;
  const nodes = new Map([[id, root]]);
  const edges = new Map<string, { id: string; type: string; from: string; to: string }>();
  let frontier = [id];
  for (let step = 0; step < depth && frontier.length && nodes.size < cap; step++) {
    const next = new Set<string>();
    for (const currentId of frontier) {
      const current = graph.getNode(currentId)!;
      let links: Array<{ id: string; type: string; from: string; to: string }> = [];
      if (current.type === "core:dimension") {
        links = graph
          .queryNodes({ type: "core:statement" })
          .filter((n) => (n as StatementNode).dimension_id === currentId)
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .slice(0, 12)
          .map((n) => ({
            id: `local:${currentId}:${n.id}`,
            type: "slot:claim",
            from: currentId,
            to: n.id,
          }));
      } else {
        links = [
          ...graph.queryEdges({ from: currentId }).slice(0, 24),
          ...graph.queryEdges({ to: currentId }).slice(0, 24),
        ];
        if (current.type !== "core:statement") {
          links.push(...graph.queryEdges({ type: "core:about", to: currentId }).slice(0, 12));
          links.push(
            ...graph
              .queryNodes({ type: "core:dimension" })
              .filter((n) => slotSubjectRef(n as DimensionNode) === currentId)
              .slice(0, 12)
              .map((n) => ({
                id: `local:${currentId}:${n.id}`,
                type: "slot:subject",
                from: currentId,
                to: n.id,
              })),
          );
        } else {
          links.push({
            id: `local:${currentId}:${(current as StatementNode).dimension_id}`,
            type: "claim:slot",
            from: currentId,
            to: (current as StatementNode).dimension_id,
          });
        }
      }
      for (const edge of links) {
        const targetId = edge.from === currentId ? edge.to : edge.from;
        const target = graph.getNode(targetId);
        if (!target) continue;
        if (nodes.has(targetId)) {
          edges.set(edge.id, edge);
          continue;
        }
        if (nodes.size >= cap) break;
        nodes.set(targetId, target);
        next.add(targetId);
        edges.set(edge.id, edge);
      }
    }
    frontier = [...next];
  }
  return {
    rootId: id,
    depth,
    nodes: [...nodes.values()].map(summary),
    edges: [...edges.values()].filter((e) => nodes.has(e.from) && nodes.has(e.to)).slice(0, 160),
    truncated: nodes.size >= cap,
  };
}
function api(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method !== "GET") return send(res, 405, { error: "read-only API: GET only" });
  if (url.pathname === "/api/summary") {
    const all = graph.getAllNodes();
    return send(res, 200, {
      slots: all.filter((n) => n.type === "core:dimension").length,
      claims: all.filter((n) => n.type === "core:statement").length,
      entities: all.filter((n) => n.type !== "core:dimension" && n.type !== "core:statement")
        .length,
      episodes: graph.getAllEpisodes().length,
      conflicts: listConflicts(graph).length,
    });
  }
  if (url.pathname === "/api/slots") {
    const q = (url.searchParams.get("q") ?? "").toLocaleLowerCase();
    const claims = graph.queryNodes({ type: "core:statement" }) as StatementNode[];
    const claimsBySlot = new Map<string, StatementNode[]>();
    for (const claim of claims) {
      const members = claimsBySlot.get(claim.dimension_id) ?? [];
      members.push(claim);
      claimsBySlot.set(claim.dimension_id, members);
    }
    const rows = (graph.queryNodes({ type: "core:dimension" }) as DimensionNode[])
      .map((s) => {
        const members = (claimsBySlot.get(s.id) ?? []).sort((a, b) =>
          b.created_at.localeCompare(a.created_at),
        );
        return {
          id: s.id,
          type: s.type,
          key: s.key,
          label: slotLabel(graph, s),
          subject_id: slotSubjectRef(s),
          property_key: s.attributes.propertyKey ?? s.key,
          state: s.state,
          cardinality: s.cardinality,
          claimCount: members.length,
          latest: members
            .slice(0, 3)
            .map((c) => ({ id: c.id, value: c.value, state: c.state, created_at: c.created_at })),
        };
      })
      .filter(
        (s) =>
          (!url.searchParams.has("state") || s.state === url.searchParams.get("state")) &&
          (!q || `${s.label} ${s.key} ${s.subject_id}`.toLocaleLowerCase().includes(q)),
      );
    return send(res, 200, paged(rows, url));
  }
  if (url.pathname === "/api/entities") {
    const q = (url.searchParams.get("q") ?? "").toLocaleLowerCase();
    const rows = graph
      .queryNodes({})
      .filter((n) => n.type !== "core:dimension" && n.type !== "core:statement")
      .map(summary)
      .filter((n) => !q || `${n.label} ${n.type} ${n.key ?? ""}`.toLocaleLowerCase().includes(q));
    return send(res, 200, paged(rows, url));
  }
  if (url.pathname === "/api/conflicts") return send(res, 200, paged(listConflicts(graph), url));
  const match = url.pathname.match(/^\/api\/(claims|episodes|neighborhood)\/(.+)$/);
  if (!match) return send(res, 404, { error: "not found" });
  const id = decodeURIComponent(match[2]!);
  if (match[1] === "claims") {
    const node = graph.getNode(id);
    if (!node || node.type !== "core:statement")
      return send(res, 404, { error: "claim not found" });
    return send(res, 200, details(id));
  }
  if (match[1] === "episodes") {
    const ep = graph.getEpisode(id);
    return ep
      ? send(res, 200, {
          ...ep,
          turns: ep.turns
            .slice(0, 100)
            .map((t) => ({ role: t.role, content: t.content.slice(0, 4000) })),
        })
      : send(res, 404, { error: "episode not found" });
  }
  const depth = Math.min(3, Math.max(1, int(url.searchParams.get("depth"), 2, 3)));
  const cap = Math.max(1, Math.min(maxNodes, int(url.searchParams.get("limit"), 36, maxNodes)));
  const result = neighborhood(id, depth, cap);
  return result ? send(res, 200, result) : send(res, 404, { error: "node not found" });
}

const html = graphBrowserPage;
const require = createRequire(import.meta.url);
const cytoscapeModule = readFileSync(
  resolve(dirname(require.resolve("cytoscape")), "cytoscape.esm.min.mjs"),
  "utf8",
);
const cytoscapeBundle = Buffer.from(
  `window.cytoscape=(function(){${cytoscapeModule.replace(/export\{Gh as default\};\s*$/, "return Gh;")}})();`,
);
const loginPage = String.raw`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EdgeLore · Login</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fa;color:#263241;font:14px/1.5 system-ui,"Segoe UI",sans-serif}.card{width:min(390px,calc(100% - 32px));padding:30px;border:1px solid #e1e6ed;border-radius:14px;background:#fff;box-shadow:0 12px 36px #25364a0b}.brand{font-weight:750;font-size:18px}.sub{margin:7px 0 22px;color:#748194;font-size:12px}.tag{display:inline-block;margin:0 0 14px;padding:4px 8px;border-radius:999px;background:#f1f5f8;color:#657489;font-size:10px;letter-spacing:.04em}h1{margin:0;font-size:20px}p{color:#68778a;font-size:12px}label{display:block;margin:16px 0 6px;color:#526176;font-size:12px}input{width:100%;padding:11px 12px;border:1px solid #dbe2e9;border-radius:7px;background:#fbfcfe;color:#273547;font:inherit;outline:0}input:focus{border-color:#96aabd;box-shadow:0 0 0 3px #e7edf355}button{width:100%;margin-top:17px;padding:10px 12px;border:1px solid #526e88;border-radius:7px;background:#526e88;color:white;font:inherit;font-weight:650;cursor:pointer}button:hover{background:#435e78}.error{min-height:20px;margin-top:10px;color:#b85d65;font-size:12px}.fine{margin-top:18px;color:#8490a0;font-size:10px}
</style><main class="card"><div class="brand">EdgeLore</div><div class="sub">Local Memory Graph</div><span class="tag">LOCAL · READ ONLY</span><h1 id="title">Sign in</h1><p id="description">Enter your local access credentials to open the memory graph.</p><form id="auth-form"><label for="username">Username</label><input id="username" autocomplete="username" required value="root"><div id="confirm-wrap" hidden><label for="confirm">Confirm password</label><input id="confirm" type="password" autocomplete="new-password"></div><label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required minlength="6"><button id="submit" type="submit">Sign in</button><div class="error" id="error" role="alert"></div></form><div class="fine">Passwords stay on this machine. Sessions expire after 12 hours and are cleared when the server restarts.</div></main><script>
const $=id=>document.getElementById(id);let setup=false;async function init(){const r=await fetch("/api/auth/status");const d=await r.json();setup=d.setupRequired;if(setup){$("title").textContent="Set up local access";$("description").textContent="Create the local root account. Only a password hash is stored.";$("confirm-wrap").hidden=false;$("confirm").required=true;$("confirm").autocomplete="new-password";$("password").autocomplete="new-password";$("submit").textContent="Create account"}}$("auth-form").addEventListener("submit",async e=>{e.preventDefault();$("error").textContent="";const password=$("password").value,username=$("username").value;if(setup&&password!==$("confirm").value){$("error").textContent="Passwords do not match.";return}try{const r=await fetch(setup?"/api/auth/setup":"/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username,password})});const d=await r.json();if(!r.ok)throw Error(d.error||"Sign in failed.");location.reload()}catch(err){$("error").textContent=err.message}});init().catch(()=>$("error").textContent="Could not reach the local server.");
</script></html>`;

function sendPage(res: ServerResponse, page: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy":
      "default-src 'self'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
  });
  res.end(page);
}
function sessionFor(req: IncomingMessage): string | undefined {
  const cookie = req.headers.cookie?.split(";").map((part) => part.trim()) ?? [];
  const token = cookie.find((part) => part.startsWith("edgelore_session="))?.slice(17);
  if (!token) return undefined;
  const expires = sessions.get(token);
  if (!expires || expires <= Date.now()) {
    sessions.delete(token);
    return undefined;
  }
  return token;
}
function passwordMatches(candidate: string): boolean {
  const [scheme, salt, expectedHex] = passwordHash.split("$");
  if (scheme !== "scrypt" || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = scryptSync(candidate, salt, expected.length);
  return expected.length > 0 && timingSafeEqual(actual, expected);
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString();
    if (body.length > 4096) throw new Error("request too large");
  }
  const parsed: unknown = JSON.parse(body || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("invalid request");
  return parsed as Record<string, unknown>;
}
function localOrigin(req: IncomingMessage): boolean {
  const host = req.headers.host;
  return !!host && req.headers.origin === `http://${host}` && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
}
function issueSession(res: ServerResponse): void {
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, Date.now() + sessionLifetimeMs);
  res.setHeader("set-cookie", `edgelore_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
  send(res, 200, { ok: true });
}
async function authRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === "/api/auth/status" && req.method === "GET") {
    send(res, 200, { setupRequired: !passwordHash });
    return true;
  }
  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    const token = sessionFor(req);
    if (token) sessions.delete(token);
    res.setHeader("set-cookie", "edgelore_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    send(res, 200, { ok: true });
    return true;
  }
  if ((url.pathname !== "/api/auth/login" && url.pathname !== "/api/auth/setup") || req.method !== "POST")
    return false;
  if (!localOrigin(req)) {
    send(res, 403, { error: "request origin rejected" });
    return true;
  }
  const address = req.socket.remoteAddress ?? "unknown";
  const attempts = loginAttempts.get(address) ?? { count: 0, blockedUntil: 0 };
  if (attempts.blockedUntil > Date.now()) {
    send(res, 429, { error: "too many attempts; try again later" });
    return true;
  }
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch {
    send(res, 400, { error: "invalid request" });
    return true;
  }
  const candidate = typeof body.password === "string" ? body.password : "";
  const username = typeof body.username === "string" ? body.username : "";
  if (url.pathname.endsWith("/setup")) {
    if (passwordHash) {
      send(res, 409, { error: "local access is already set up" });
      return true;
    }
    if (username !== "root" || candidate.length < 6 || candidate.length > 1024) {
      send(res, 400, { error: "username must be root and password must be between 6 and 1024 characters" });
      return true;
    }
    const salt = randomBytes(16).toString("hex");
    const derived = scryptSync(candidate, salt, 64).toString("hex");
    passwordHash = `scrypt$${salt}$${derived}`;
    appendFileSync(resolve(".env.local"), `\nEDGELORE_UI_PASSWORD_HASH=${passwordHash}\n`, { encoding: "utf8", mode: 0o600 });
    issueSession(res);
    return true;
  }
  if (username !== "root" || !passwordMatches(candidate)) {
    attempts.count += 1;
    if (attempts.count >= 8) {
      attempts.count = 0;
      attempts.blockedUntil = Date.now() + 5 * 60 * 1000;
    }
    loginAttempts.set(address, attempts);
    send(res, 401, { error: "incorrect password" });
    return true;
  }
  loginAttempts.delete(address);
  issueSession(res);
  return true;
}

export function startMemoryExplorer(
  dbPath: string,
  port = 4173,
): { port: number; close: () => Promise<void> } {
  const path = realpathSync(resolve(dbPath));
  if (!statSync(path).isFile()) throw new Error("--db must point to an existing SQLite file");
  graph = new SqliteGraph(path, { readOnly: true });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (await authRoute(req, res, url)) return;
      if (!sessionFor(req)) {
        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
          sendPage(res, loginPage);
          return;
        }
        send(res, 401, { error: "authentication required" });
        return;
      }
    if (url.pathname === "/assets/cytoscape.js" && req.method === "GET") {
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=86400",
        "x-content-type-options": "nosniff",
      });
      res.end(cytoscapeBundle);
      return;
    }
    if (url.pathname.startsWith("/api/")) return api(req, res, url);
    if (req.method !== "GET") return send(res, 405, { error: "read-only UI: GET only" });
    if (url.pathname !== "/" && url.pathname !== "/index.html")
      return send(res, 404, { error: "not found" });
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'self'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
    });
    res.end(html);
    } catch {
      if (!res.headersSent) send(res, 500, { error: "local server error" });
      else res.destroy();
    }
  });
  server.listen(port, "127.0.0.1");
  return {
    port,
    close: () =>
      new Promise((done, fail) =>
        server.close((err) => {
          graph.close();
          if (err) fail(err);
          else done();
        }),
      ),
  };
}
