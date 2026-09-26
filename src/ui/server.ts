import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { SqliteGraph } from "../store/sqlite.js";
import { listConflicts } from "../agent/conflicts.js";
import { slotLabel, slotSubjectRef } from "../agent/slots.js";
import type { DimensionNode, GraphNode, StatementNode } from "../model/types.js";

const maxNodes = 60;
let graph: SqliteGraph;
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
        if (!target || nodes.has(targetId)) continue;
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
    const rows = (graph.queryNodes({ type: "core:dimension" }) as DimensionNode[])
      .map((s) => {
        const members = claims
          .filter((c) => c.dimension_id === s.id)
          .sort((a, b) => b.created_at.localeCompare(a.created_at));
        return {
          id: s.id,
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

const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EdgeLore Memory Explorer</title><style>
:root{color-scheme:dark;--bg:#0b1118;--panel:#111b25;--line:#263847;--text:#e6eef4;--muted:#8ea3b4;--mint:#7fe1c0;--red:#ff8291;--amber:#ffce78}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,"Segoe UI",sans-serif}header{height:62px;padding:12px 22px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center}h1{font-size:17px;margin:0}.mint{color:var(--mint)}.layout{height:calc(100vh - 62px);display:grid;grid-template-columns:300px 1fr 340px}aside,.detail{background:var(--panel);overflow:auto;padding:16px;border-right:1px solid var(--line)}main{overflow:auto}.stats{display:grid;grid-template-columns:1fr 1fr;gap:7px}.stat,.item{background:#15232e;border:1px solid var(--line);border-radius:8px;padding:10px}.stat b{display:block;color:var(--mint);font-size:20px}.stat small,.muted{color:var(--muted)}.tabs,.depth{display:flex;gap:5px;margin:12px 0}.tabs button,.depth button{flex:1}button,input{background:#14222d;color:var(--text);border:1px solid var(--line);border-radius:7px;padding:8px;font:inherit;cursor:pointer}button:hover,.active{border-color:var(--mint);color:var(--mint)}input{width:100%;margin-bottom:9px;cursor:text}.item{display:block;text-align:left;width:100%;margin:6px 0;cursor:pointer}.item small{display:block;color:var(--muted)}.tag{font-size:10px;color:var(--mint);margin-left:5px}.tag.conflict{color:var(--red)}.head{padding:14px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between}.graph{height:58vh;min-height:340px;border-bottom:1px solid var(--line);background-image:radial-gradient(#263b4b 1px,transparent 1px);background-size:22px 22px}.graph svg{width:100%;height:100%}.edge{stroke:#496172}.node rect{fill:#172833;stroke:#4d7180;rx:9}.node.root rect{fill:#173b34;stroke:var(--mint);stroke-width:2}.node text{fill:var(--text);font-size:11px}.node{cursor:pointer}.edge-label{fill:#9ab0bf;font-size:10px}.below{padding:15px}.placeholder{height:100%;display:grid;place-items:center;color:var(--muted);text-align:center}.detail h2{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin:18px 0 7px}.detail h3{overflow-wrap:anywhere}.kv{display:grid;grid-template-columns:85px 1fr;gap:7px;padding:7px 0;border-bottom:1px solid var(--line)}.kv label{color:var(--muted)}.kv div{overflow-wrap:anywhere}.source{white-space:pre-wrap;background:#0c151c;border-left:2px solid #89bfff;padding:9px;margin:6px 0}.warn{color:var(--amber)}@media(max-width:950px){.layout{grid-template-columns:250px 1fr}.detail{grid-column:1/-1;min-height:400px;border-top:1px solid var(--line)}}@media(max-width:620px){.layout{display:block;height:auto}aside,main,.detail{min-height:400px;border-right:0;border-bottom:1px solid var(--line)}.graph{height:380px}}
</style><header><h1>EdgeLore <span class="mint">Memory Explorer</span></h1><span class="mint">本地只读</span></header><div class="layout"><aside><div class="stats" id="stats"></div><div class="tabs"><button class="active" data-k="slots">Slots</button><button data-k="entities">Entities</button><button data-k="conflicts">Conflicts</button></div><input id="q" placeholder="搜索 Slot / Entity"><div id="list"></div><button id="more">加载更多</button></aside><main><div class="head"><div><b id="focus">选择一个记忆对象</b><div class="muted">限深 3 跳 · 最多 60 个节点</div></div><div class="depth"><button data-d="1">1</button><button data-d="2" class="active">2</button><button data-d="3">3</button></div></div><div class="graph" id="graph"><div class="placeholder">从左侧选择一个 Slot、Entity 或冲突</div></div><div class="below" id="note" class="muted">局部邻域</div></main><section class="detail" id="detail"><div class="placeholder">Claim 值、状态、时间、Episode 原文、来源和关系</div></section></div><script>
const $=s=>document.querySelector(s);let kind='slots',offset=0,depth=2,q='',chosen=null;async function get(u){let r=await fetch(u),d=await r.json();if(!r.ok)throw Error(d.error);return d}function kv(k,v){let x=document.createElement('div');x.className='kv';let a=document.createElement('label'),b=document.createElement('div');a.textContent=k;b.textContent=typeof v==='string'?v:JSON.stringify(v??'—');x.append(a,b);return x}async function load(reset=true){if(reset){offset=0;$('#list').innerHTML=''}let d=await get(kind==='conflicts'?'/api/conflicts?offset='+offset+'&limit=30':\`/api/\${kind}?offset=\${offset}&limit=30&q=\${encodeURIComponent(q)}\`);for(let row of d.items){let b=document.createElement('button');b.className='item';if(kind==='conflicts'){b.textContent=row.dimensionKey+' · '+row.incumbents.length+' incumbent · '+row.challengers.length+' challenger';b.onclick=()=>conflict(row)}else{b.innerHTML='<b></b><small></small>';b.querySelector('b').textContent=row.label;b.querySelector('small').textContent=(row.state||row.type)+' · '+(row.claimCount??row.id);b.onclick=()=>select(row)}$('#list').append(b)}offset+=d.items.length;$('#more').hidden=offset>=d.total;if(reset&&d.items[0]&&kind!=='conflicts')select(d.items[0])}function select(r){chosen=r;$('#focus').textContent=r.label||r.key;draw(r.id);if(r.type==='core:statement')detail(r.id);else show(r)}async function draw(id){let d=await get(\`/api/neighborhood/\${encodeURIComponent(id)}?depth=\${depth}&limit=60\`),box=$('#graph');box.innerHTML='';let w=Math.max(box.clientWidth,450),h=Math.max(box.clientHeight,340),cx=w/2,cy=h/2,pos=new Map;d.nodes.forEach((n,i)=>{let a=(i-1)*Math.PI*2/Math.max(1,d.nodes.length-1),r=i?Math.min(w,h)*.34:0;pos.set(n.id,[cx+Math.cos(a)*r,cy+Math.sin(a)*r])});let s=document.createElementNS('http://www.w3.org/2000/svg','svg');s.setAttribute('viewBox',\`0 0 \${w} \${h}\`);for(let e of d.edges){let a=pos.get(e.from),b=pos.get(e.to);if(!a||!b)continue;let l=document.createElementNS(s.namespaceURI,'line');l.setAttribute('x1',a[0]);l.setAttribute('y1',a[1]);l.setAttribute('x2',b[0]);l.setAttribute('y2',b[1]);l.setAttribute('class','edge');s.append(l)}for(let n of d.nodes){let [x,y]=pos.get(n.id),g=document.createElementNS(s.namespaceURI,'g');g.setAttribute('class','node '+(n.id===id?'root':''));g.setAttribute('transform',\`translate(\${x-72},\${y-22})\`);let r=document.createElementNS(s.namespaceURI,'rect');r.setAttribute('width',144);r.setAttribute('height',44);g.append(r);let t=document.createElementNS(s.namespaceURI,'text');t.setAttribute('x',8);t.setAttribute('y',18);t.textContent=String(n.label).slice(0,22);g.append(t);let st=document.createElementNS(s.namespaceURI,'text');st.setAttribute('x',8);st.setAttribute('y',34);st.textContent=n.state||n.type;g.append(st);g.onclick=()=>n.type==='core:statement'?detail(n.id):show(n);s.append(g)}box.append(s);$('#note').textContent=\`展示 \${d.nodes.length} 个节点、\${d.edges.length} 条关系\${d.truncated?' · 达到节点上限':''}\`}function show(r){let d=$('#detail');d.innerHTML='<h2></h2><h3></h3>';d.querySelector('h2').textContent=r.type;d.querySelector('h3').textContent=r.label||r.key;for(let [k,v]of Object.entries(r))d.append(kv(k,v))}async function detail(id){let x=await get('/api/claims/'+encodeURIComponent(id)),n=x.node,d=$('#detail');d.innerHTML='<h2>Claim · '+n.state+'</h2><h3></h3>';d.querySelector('h3').textContent=JSON.stringify(n.value);for(let k of ['unit','created_at','updated_at','saidBy','created_by','scope','source_refs','schema_version','attributes'])d.append(kv(k,n[k]));if(x.slot)d.append(kv('Slot',x.slot.label));d.insertAdjacentHTML('beforeend','<h2>Episode 原文</h2>');for(let ep of x.episodes){d.append(kv('Episode',ep.id+' · '+ep.created_at));for(let t of ep.turns){let p=document.createElement('div');p.className='source';p.textContent=t.role+': '+t.content;d.append(p)}}d.insertAdjacentHTML('beforeend','<h2>关系 / 裁决历史</h2>');for(let e of x.edges)d.append(kv(e.type,(e.from_node?.label||e.from)+' → '+(e.to_node?.label||e.to)+' · '+e.created_by+' · '+e.created_at))}function conflict(c){let d=$('#detail');d.innerHTML='<h2 class="warn">Conflict docket · 待裁决</h2><h3></h3><p class="muted">只读查看，不提供裁决操作</p>';d.querySelector('h3').textContent=c.dimensionKey;for(let [k,items]of [['Incumbents',c.incumbents],['Challengers',c.challengers]]){d.insertAdjacentHTML('beforeend','<h2>'+k+'</h2>');for(let x of items){let b=document.createElement('button');b.className='item';b.textContent=JSON.stringify(x.value)+' · '+x.state+' · '+x.createdAt+' · '+x.createdBy;b.onclick=()=>detail(x.statementId);d.append(b)}}}get('/api/summary').then(s=>$('#stats').innerHTML=Object.entries({Slots:s.slots,Claims:s.claims,Entities:s.entities,Conflicts:s.conflicts}).map(([k,v])=>'<div class="stat"><b>'+v+'</b><small>'+k+'</small></div>').join('')).then(load);document.querySelectorAll('[data-k]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-k]').forEach(x=>x.classList.remove('active'));b.classList.add('active');kind=b.dataset.k;load()});document.querySelectorAll('[data-d]').forEach(b=>b.onclick=()=>{depth=+b.dataset.d;document.querySelectorAll('[data-d]').forEach(x=>x.classList.remove('active'));b.classList.add('active');if(chosen)draw(chosen.id)});$('#q').oninput=e=>{q=e.target.value;clearTimeout(window.timer);window.timer=setTimeout(load,180)};$('#more').onclick=()=>load(false);
</script></html>`;

export function startMemoryExplorer(
  dbPath: string,
  port = 4173,
): { port: number; close: () => Promise<void> } {
  const path = realpathSync(resolve(dbPath));
  if (!statSync(path).isFile()) throw new Error("--db must point to an existing SQLite file");
  graph = new SqliteGraph(path, { readOnly: true });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) return api(req, res, url);
    if (req.method !== "GET") return send(res, 405, { error: "read-only UI: GET only" });
    if (url.pathname !== "/" && url.pathname !== "/index.html")
      return send(res, 404, { error: "not found" });
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    });
    res.end(html);
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
