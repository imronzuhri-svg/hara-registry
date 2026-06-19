/* Hara Registry — API Console
 * Self-contained, dependency-free vanilla JS.
 * Calls LIVE production endpoints. No build step.
 * All facts mirror doc/api/hara-registry-facts.md.
 */
"use strict";

/* ------------------------------------------------------------------ *
 * Constants (canonical — see doc/api/hara-registry-facts.md)
 * ------------------------------------------------------------------ */
const RPC = "https://rpc.ledger.haratrust.io";
const RPC_READ = RPC + "/read/";
const RPC_WRITE = RPC + "/write/";
const TRACE = "https://trace.ledger.haratrust.io";
const CHAIN_ID = 131216; // 0x20070

const CONTRACTS = {
  HaraPalmOil: "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853",
  TraceabilityBatchRelay: "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6",
  PQAnchorRegistry: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318",
  ContractRegistry: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
};

/* ------------------------------------------------------------------ *
 * Minimal keccak-256 (for ABI selectors / name hashing).
 * Pure JS, no deps. Works on UTF-8 byte arrays.
 * ------------------------------------------------------------------ */
const Keccak = (() => {
  // Round constants as [low32, high32]
  const RNDC = [
    [0x00000001,0x00000000],[0x00008082,0x00000000],[0x0000808a,0x80000000],
    [0x80008000,0x80000000],[0x0000808b,0x00000000],[0x80000001,0x00000000],
    [0x80008081,0x80000000],[0x00008009,0x80000000],[0x0000008a,0x00000000],
    [0x00000088,0x00000000],[0x80008009,0x00000000],[0x8000000a,0x00000000],
    [0x8000808b,0x00000000],[0x0000008b,0x80000000],[0x00008089,0x80000000],
    [0x00008003,0x80000000],[0x00008002,0x80000000],[0x00000080,0x80000000],
    [0x0000800a,0x00000000],[0x8000000a,0x80000000],[0x80008081,0x80000000],
    [0x00008080,0x80000000],[0x80000001,0x00000000],[0x80008008,0x80000000],
  ];
  const ROFF = [0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14];

  function rotl(lo, hi, n) {
    if (n === 0) return [lo, hi];
    if (n < 32) {
      const nlo = (lo << n) | (hi >>> (32 - n));
      const nhi = (hi << n) | (lo >>> (32 - n));
      return [nlo >>> 0, nhi >>> 0];
    }
    n -= 32;
    if (n === 0) return [hi, lo];
    const nlo = (hi << n) | (lo >>> (32 - n));
    const nhi = (lo << n) | (hi >>> (32 - n));
    return [nlo >>> 0, nhi >>> 0];
  }

  function keccakF(s) { // s: 50 ints (25 lanes * [lo,hi])
    for (let r = 0; r < 24; r++) {
      const C = new Array(10);
      for (let x = 0; x < 5; x++) {
        C[x*2]   = s[x*2] ^ s[(x+5)*2] ^ s[(x+10)*2] ^ s[(x+15)*2] ^ s[(x+20)*2];
        C[x*2+1] = s[x*2+1] ^ s[(x+5)*2+1] ^ s[(x+10)*2+1] ^ s[(x+15)*2+1] ^ s[(x+20)*2+1];
      }
      for (let x = 0; x < 5; x++) {
        const [rlo, rhi] = rotl(C[((x+1)%5)*2], C[((x+1)%5)*2+1], 1);
        const dlo = C[((x+4)%5)*2] ^ rlo;
        const dhi = C[((x+4)%5)*2+1] ^ rhi;
        for (let y = 0; y < 25; y += 5) {
          s[(x+y)*2] ^= dlo;
          s[(x+y)*2+1] ^= dhi;
        }
      }
      const B = new Array(50);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
        const idx = x + y*5;
        const [rlo, rhi] = rotl(s[idx*2], s[idx*2+1], ROFF[idx]);
        const nx = y, ny = (2*x + 3*y) % 5;
        const ni = nx + ny*5;
        B[ni*2] = rlo; B[ni*2+1] = rhi;
      }
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
        const i = (x + y*5)*2;
        const i1 = (((x+1)%5) + y*5)*2;
        const i2 = (((x+2)%5) + y*5)*2;
        s[i]   = B[i]   ^ ((~B[i1])   & B[i2]);
        s[i+1] = B[i+1] ^ ((~B[i1+1]) & B[i2+1]);
      }
      s[0] ^= RNDC[r][0];
      s[1] ^= RNDC[r][1];
    }
  }

  function keccak256(bytes) {
    const rate = 136; // 1088 bits
    const s = new Array(50).fill(0);
    const msg = Array.from(bytes);
    msg.push(0x01);
    while (msg.length % rate !== 0) msg.push(0);
    msg[msg.length - 1] ^= 0x80;
    for (let off = 0; off < msg.length; off += rate) {
      for (let i = 0; i < rate / 8; i++) {
        const b = off + i * 8;
        const lo = (msg[b] | (msg[b+1]<<8) | (msg[b+2]<<16) | (msg[b+3]<<24)) >>> 0;
        const hi = (msg[b+4] | (msg[b+5]<<8) | (msg[b+6]<<16) | (msg[b+7]<<24)) >>> 0;
        s[i*2] ^= lo; s[i*2+1] ^= hi;
      }
      keccakF(s);
    }
    const out = [];
    for (let i = 0; i < 4; i++) { // 32 bytes = first 4 lanes
      const lo = s[i*2], hi = s[i*2+1];
      out.push(lo&0xff,(lo>>>8)&0xff,(lo>>>16)&0xff,(lo>>>24)&0xff);
      out.push(hi&0xff,(hi>>>8)&0xff,(hi>>>16)&0xff,(hi>>>24)&0xff);
    }
    return out;
  }
  return { keccak256 };
})();

function utf8Bytes(str){ return Array.from(new TextEncoder().encode(str)); }
function toHex(bytes){ return bytes.map(b=>b.toString(16).padStart(2,"0")).join(""); }
function keccakHex(str){ return "0x" + toHex(Keccak.keccak256(utf8Bytes(str))); }
function selector(sig){ return "0x" + toHex(Keccak.keccak256(utf8Bytes(sig))).slice(0,8); }

/* ABI helpers */
function pad32(hexNo0x){ return hexNo0x.toLowerCase().padStart(64,"0"); }
function encAddress(addr){
  const h = (addr||"").replace(/^0x/,"");
  if(!/^[0-9a-fA-F]{40}$/.test(h)) throw new Error("invalid address: "+addr);
  return pad32(h);
}
function encUint(v){
  let bi = BigInt(v);
  return pad32(bi.toString(16));
}
function encBytes32(name){
  // name = keccak256(utf8(name))  (per ContractRegistry convention)
  return keccakHex(name).replace(/^0x/,"");
}

/* ------------------------------------------------------------------ *
 * Operation catalog
 * Each op: { id, group, name, method/desc, fields[], build(values) -> request }
 * build returns { url, kind:'rpc'|'rest', body, basic? }  for execution + codegen
 * ------------------------------------------------------------------ */
const TRANSFER_SINGLE_TOPIC =
  "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";

function rpcBody(method, params){
  return { jsonrpc:"2.0", id:1, method, params: params||[] };
}

const OPS = [
  /* ---- Chain JSON-RPC ---- */
  {
    id:"blockNumber", group:"Chain JSON-RPC", name:"eth_blockNumber",
    sub:"current block height",
    desc:"Returns the latest block height. The cheapest liveness check on the chain.",
    fields:[ endpointField("read") ],
    build:(v)=>({ kind:"rpc", url:v.endpoint, body:rpcBody("eth_blockNumber",[]) }),
  },
  {
    id:"chainId", group:"Chain JSON-RPC", name:"eth_chainId",
    sub:"expect 0x20070 (131216)",
    desc:"Returns the chain id. Must be 0x20070 (131216). Use it to confirm you are pointed at Hara Registry.",
    fields:[ endpointField("read") ],
    build:(v)=>({ kind:"rpc", url:v.endpoint, body:rpcBody("eth_chainId",[]) }),
  },
  {
    id:"getBalance", group:"Chain JSON-RPC", name:"eth_getBalance",
    sub:"native HARA balance",
    desc:"Native HARA balance of an address. A 0x0 result means the wallet is unfunded — it must receive >= 1 wei before its first tx (Besu silently drops zero-balance senders).",
    fields:[
      textField("address","Address","0x70997970C51812dc3A010C7d01b50e0d17dc79C8"),
      blockField(), endpointField("read"),
    ],
    build:(v)=>({ kind:"rpc", url:v.endpoint,
      body:rpcBody("eth_getBalance",[v.address, v.block||"latest"]) }),
  },
  {
    id:"getLogs", group:"Chain JSON-RPC", name:"eth_getLogs",
    sub:"TransferSingle custody hops",
    desc:"Fetch TransferSingle logs (custody hops) from HaraPalmOil. Full-range getLogs exceeds the RPC range limit — chunk by block range. id = batchId, value = litres.",
    fields:[
      textField("address","Contract address",CONTRACTS.HaraPalmOil),
      textField("fromBlock","From block (hex or 'earliest')","0x0"),
      textField("toBlock","To block (hex or 'latest')","0x3e8"),
      endpointField("read"),
    ],
    build:(v)=>({ kind:"rpc", url:v.endpoint, body:rpcBody("eth_getLogs",[{
      address:v.address, topics:[TRANSFER_SINGLE_TOPIC],
      fromBlock:v.fromBlock||"0x0", toBlock:v.toBlock||"latest" }]) }),
  },
  {
    id:"getReceipt", group:"Chain JSON-RPC", name:"eth_getTransactionReceipt",
    sub:"verify status == 0x1",
    desc:"Fetch a transaction receipt. Always verify result.status == 0x1 — a mined tx can still have reverted (0x0).",
    fields:[
      textField("txHash","Transaction hash","0x"),
      endpointField("read"),
    ],
    build:(v)=>({ kind:"rpc", url:v.endpoint,
      body:rpcBody("eth_getTransactionReceipt",[v.txHash]) }),
  },
  {
    id:"sendRaw", group:"Chain JSON-RPC", name:"eth_sendRawTransaction",
    sub:"writes -> /write/",
    desc:"Submit a pre-signed legacy transaction (chainId 131216, gasPrice 0). Sign locally; this console does not hold keys. Writes MUST go to /write/.",
    fields:[
      textField("raw","Signed raw tx (0x...)","0x"),
      endpointField("write"),
    ],
    build:(v)=>({ kind:"rpc", url:v.endpoint,
      body:rpcBody("eth_sendRawTransaction",[v.raw]) }),
  },

  /* ---- Contract reads ---- */
  {
    id:"balanceOf", group:"Contract reads", name:"HaraPalmOil.balanceOf",
    sub:"litres held of a batch",
    desc:"ERC-1155 balanceOf(account, id) on HaraPalmOil = litres of a batch held by an address. Selector 0x00fdd58e. The console ABI-encodes the call and POSTs eth_call to /read/.",
    fields:[
      textField("account","Account address","0x70997970C51812dc3A010C7d01b50e0d17dc79C8"),
      textField("batchId","Batch id (decimal)","1001"),
      endpointField("read"),
    ],
    build:(v)=>{
      const data = selector("balanceOf(address,uint256)")
        + encAddress(v.account) + encUint(v.batchId);
      return { kind:"rpc", url:v.endpoint, decode:"uint",
        body:rpcBody("eth_call",[{ to:CONTRACTS.HaraPalmOil, data }, "latest"]) };
    },
  },
  {
    id:"getActive", group:"Contract reads", name:"ContractRegistry.getActive",
    sub:"name -> active address",
    desc:"getActive(bytes32 name) on ContractRegistry. name = keccak256(utf8(\"ContractName\")) — NOT formatBytes32String. Selector 0x3f3a5c8a. Result's low 20 bytes are the active address.",
    fields:[
      textField("name","Contract name (utf8, e.g. IssuerRegistry)","IssuerRegistry"),
      endpointField("read"),
    ],
    build:(v)=>{
      const data = selector("getActive(bytes32)") + encBytes32(v.name);
      return { kind:"rpc", url:v.endpoint, decode:"address",
        body:rpcBody("eth_call",[{ to:CONTRACTS.ContractRegistry, data }, "latest"]) };
    },
  },

  /* ---- Traceability REST API ---- */
  {
    id:"batches", group:"Traceability REST API", name:"GET /v1/batches",
    sub:"list batches", rest:true,
    desc:"List minted batches ordered by minted_at desc. HTTP Basic auth required.",
    fields:[
      numField("limit","limit","50"), numField("offset","offset","0"),
    ],
    build:(v)=>({ kind:"rest", method:"GET",
      url:`${TRACE}/v1/batches?limit=${enc(v.limit||"50")}&offset=${enc(v.offset||"0")}` }),
  },
  {
    id:"batch", group:"Traceability REST API", name:"GET /v1/batches/:batchId",
    sub:"batch detail", rest:true,
    desc:"One BatchSummary. 404 {\"error\":\"batch not found\"} if unknown.",
    fields:[ textField("batchId","Batch id","1001") ],
    build:(v)=>({ kind:"rest", method:"GET",
      url:`${TRACE}/v1/batches/${enc(v.batchId)}` }),
  },
  {
    id:"hops", group:"Traceability REST API", name:"GET /v1/batches/:batchId/hops",
    sub:"custody hops", rest:true,
    desc:"Custody hops in order (block, then log index).",
    fields:[ textField("batchId","Batch id","1001") ],
    build:(v)=>({ kind:"rest", method:"GET",
      url:`${TRACE}/v1/batches/${enc(v.batchId)}/hops` }),
  },
  {
    id:"graph", group:"Traceability REST API", name:"GET /v1/batches/:batchId/graph",
    sub:"custody DAG", rest:true,
    desc:"Custody DAG (Cytoscape/React-Flow ready). aggregate=true collapses parallel A->B transfers into one weighted edge.",
    fields:[
      textField("batchId","Batch id","1001"),
      selectField("aggregate","aggregate",["true","false"],"true"),
    ],
    build:(v)=>({ kind:"rest", method:"GET",
      url:`${TRACE}/v1/batches/${enc(v.batchId)}/graph?aggregate=${enc(v.aggregate||"true")}` }),
  },
  {
    id:"holderBatches", group:"Traceability REST API",
    name:"GET /v1/holders/:address/batches",
    sub:"batches by holder", rest:true,
    desc:"Batch ids held by an address. Lookup matches the checksummed (mixed-case) address case-sensitively.",
    fields:[ textField("address","Holder address (checksummed)","0xa513E6E4b8f2a923D98304ec87F64353C4D5C853") ],
    build:(v)=>({ kind:"rest", method:"GET",
      url:`${TRACE}/v1/holders/${enc(v.address)}/batches` }),
  },
  {
    id:"healthz", group:"Traceability REST API", name:"GET /healthz",
    sub:"indexer liveness", rest:true, noAuth:true,
    desc:"Returns 200 when the indexer is up. No auth required.",
    fields:[],
    build:()=>({ kind:"rest", method:"GET", url:`${TRACE}/healthz`, noAuth:true }),
  },
  {
    id:"metrics", group:"Traceability REST API", name:"GET /metrics",
    sub:"Prometheus metrics", rest:true, noAuth:true,
    desc:"Prometheus exposition (hara_indexer_*). No auth required.",
    fields:[],
    build:()=>({ kind:"rest", method:"GET", url:`${TRACE}/metrics`, noAuth:true, text:true }),
  },
];

/* field factories */
function enc(s){ return encodeURIComponent(s==null?"":s); }
function textField(key,label,ph){ return {key,label,type:"text",placeholder:ph,value:ph}; }
function numField(key,label,ph){ return {key,label,type:"number",placeholder:ph,value:ph}; }
function selectField(key,label,opts,def){ return {key,label,type:"select",options:opts,value:def}; }
function blockField(){ return selectField("block","Block tag",["latest","earliest","pending"],"latest"); }
function endpointField(kind){
  return { key:"endpoint", label:"Endpoint", type:"select",
    options:[RPC_READ,RPC_WRITE],
    value: kind==="write"?RPC_WRITE:RPC_READ };
}

/* ------------------------------------------------------------------ *
 * State + UI
 * ------------------------------------------------------------------ */
const state = {
  current: OPS[0].id,
  tab: "request",      // request | code
  lang: "curl",
  values: {},          // per-op field values
  basic: { user:"", pass:"" },
};

function el(tag, attrs, ...kids){
  const e = document.createElement(tag);
  if(attrs) for(const k in attrs){
    if(k==="class") e.className=attrs[k];
    else if(k.startsWith("on")) e.addEventListener(k.slice(2),attrs[k]);
    else if(k==="html") e.innerHTML=attrs[k];
    else e.setAttribute(k,attrs[k]);
  }
  for(const kid of kids){ if(kid!=null) e.append(kid.nodeType?kid:document.createTextNode(kid)); }
  return e;
}

function opById(id){ return OPS.find(o=>o.id===id); }
function valuesFor(op){
  state.values[op.id] = state.values[op.id] || {};
  const v = state.values[op.id];
  for(const f of op.fields) if(v[f.key]===undefined) v[f.key]=f.value!==undefined?f.value:"";
  return v;
}

/* ---- sidebar ---- */
function renderSidebar(){
  const aside = document.getElementById("catalog");
  aside.innerHTML="";
  const groups = ["Chain JSON-RPC","Contract reads","Traceability REST API"];
  for(const g of groups){
    const wrap = el("div",{class:"group"}, el("h3",null,g));
    for(const op of OPS.filter(o=>o.group===g)){
      const btn = el("button",{
        class:"op"+(op.id===state.current?" active":""),
        onclick:()=>{ state.current=op.id; state.tab="request"; render(); },
      }, el("span",null,op.name), el("span",{class:"m"},op.sub));
      wrap.append(btn);
    }
    aside.append(wrap);
  }
}

/* ---- main panel ---- */
function render(){
  renderSidebar();
  const op = opById(state.current);
  const v = valuesFor(op);
  const main = document.getElementById("main");
  main.innerHTML="";

  const card = el("div",{class:"opcard"});
  card.append(
    el("div",null,
      el("span",{class:"meta"},op.rest?"REST":"JSON-RPC"),
      el("span",{class:"meta"},op.group)),
    el("h2",null,op.name),
    el("p",{class:"desc"},op.desc),
  );

  const tabs = el("div",{class:"tabs"},
    tabBtn("request","Request"),
    tabBtn("code","Code"));
  card.append(tabs);

  if(state.tab==="request") card.append(renderRequest(op,v));
  else card.append(renderCode(op,v));

  main.append(card);
}

function tabBtn(id,label){
  return el("button",{ class: state.tab===id?"active":"",
    onclick:()=>{ state.tab=id; render(); } }, label);
}

function renderRequest(op,v){
  const wrap = el("div");

  // Basic auth for gated REST
  if(op.rest && !op.noAuth){
    wrap.append(el("div",{class:"row"},
      authInput("user","Username (HTTP Basic)"),
      authInput("pass","Password",true)));
    wrap.append(el("div",{class:"endpoint-note"},
      "trace.ledger.haratrust.io is gated — request credentials from ops@haratrust.io."));
  }

  for(const f of op.fields) wrap.append(renderField(op,v,f));

  const out = el("pre",{class:"out",id:"out"},"Ready. Press Send to call the live endpoint.");
  const statusRow = el("div",{class:"status",id:"statusRow"});

  const send = el("button",{class:"send",onclick:()=>doSend(op,v,send,out,statusRow)},"Send");
  wrap.append(el("div",null,send));
  wrap.append(statusRow);
  wrap.append(el("div",{class:"codewrap"},
    el("button",{class:"copybtn",onclick:e=>copyText(out.textContent,e.target)},"Copy"),
    out));
  return wrap;
}

function renderField(op,v,f){
  const id = "f_"+op.id+"_"+f.key;
  let input;
  if(f.type==="select"){
    input = el("select",{id,onchange:e=>{v[f.key]=e.target.value;}});
    for(const o of f.options){
      const opt=el("option",{value:o},labelForEndpoint(o));
      if(o===v[f.key]) opt.setAttribute("selected","selected");
      input.append(opt);
    }
  } else {
    input = el("input",{id,type:f.type==="number"?"number":"text",
      placeholder:f.placeholder||"", value:v[f.key]||"",
      oninput:e=>{v[f.key]=e.target.value;}});
  }
  return el("div",{class:"field"}, el("label",{for:id},f.label), input);
}
function labelForEndpoint(o){
  if(o===RPC_READ) return o+"  (reads, cached)";
  if(o===RPC_WRITE) return o+"  (writes)";
  return o;
}

function authInput(key,label,pw){
  return el("div",{class:"field"},
    el("label",null,label),
    el("input",{type:pw?"password":"text",value:state.basic[key]||"",
      oninput:e=>{state.basic[key]=e.target.value;}}));
}

/* ------------------------------------------------------------------ *
 * Execution
 * ------------------------------------------------------------------ */
async function doSend(op,v,btn,out,statusRow){
  let req;
  try { req = op.build(v); }
  catch(e){ showOut(out,statusRow,null,0,0,"build error: "+e.message); return; }

  btn.disabled = true; btn.textContent="Sending…";
  const t0 = performance.now();
  try {
    const headers = {};
    let body;
    const init = { method: req.kind==="rest" ? (req.method||"GET") : "POST", headers };
    if(req.kind==="rpc"){
      headers["content-type"]="application/json";
      body = JSON.stringify(req.body);
      init.body = body;
    }
    if(req.kind==="rest" && op.rest && !req.noAuth){
      if(state.basic.user || state.basic.pass){
        headers["Authorization"]="Basic "+btoa(state.basic.user+":"+state.basic.pass);
      }
    }
    const resp = await fetch(req.url, init);
    const ms = Math.round(performance.now()-t0);
    const raw = await resp.text();
    let pretty = raw, parsed=null;
    try { parsed = JSON.parse(raw); pretty = JSON.stringify(parsed,null,2); } catch(_) {}

    // decode contract-read results inline
    let decoded = "";
    if(req.decode && parsed && parsed.result){
      decoded = decodeResult(req.decode, parsed.result);
    }
    showOut(out,statusRow,resp.status,ms,raw.length,null,pretty,decoded);
  } catch(e){
    const ms = Math.round(performance.now()-t0);
    showOut(out,statusRow,null,ms,0,
      "fetch failed: "+e.message+
      "\n\nThis is usually CORS (the production endpoint did not send "+
      "Access-Control-Allow-Origin for this origin) or a network/DNS error. "+
      "The request itself may be valid — try the generated curl/Code snippet from a terminal.");
  } finally {
    btn.disabled=false; btn.textContent="Send";
  }
}

function decodeResult(kind, hex){
  try {
    const h = hex.replace(/^0x/,"");
    if(kind==="uint") return "decoded uint256 = " + BigInt("0x"+h).toString();
    if(kind==="address") return "decoded address = 0x" + h.slice(-40);
  } catch(_){}
  return "";
}

function showOut(out,statusRow,status,ms,bytes,err,pretty,decoded){
  statusRow.innerHTML="";
  if(status!=null){
    const ok = status>=200 && status<300;
    statusRow.append(el("span",{class:"pill "+(ok?"ok":"err")},"HTTP "+status));
  } else if(err){
    statusRow.append(el("span",{class:"pill err"},"ERROR"));
  }
  if(ms!=null) statusRow.append(el("span",{class:"pill"},ms+" ms"));
  if(bytes) statusRow.append(el("span",{class:"pill"},bytes+" B"));

  out.innerHTML="";
  if(err){ out.append(el("span",{class:"err"},err)); return; }
  let txt = pretty||"";
  if(decoded) txt = decoded + "\n\n" + txt;
  out.textContent = txt;
}

/* ------------------------------------------------------------------ *
 * Code generation (curl / TypeScript / Python / Go)
 * ------------------------------------------------------------------ */
function renderCode(op,v){
  const wrap = el("div");
  const langs = ["curl","ts","py","go"];
  const labels = {curl:"curl", ts:"TypeScript", py:"Python", go:"Go"};
  const bar = el("div",{class:"langtabs"});
  for(const l of langs){
    bar.append(el("button",{class:state.lang===l?"active":"",
      onclick:()=>{state.lang=l; render();}}, labels[l]));
  }
  wrap.append(bar);
  let req;
  try { req = op.build(v); }
  catch(e){ wrap.append(el("pre",{class:"out"},"build error: "+e.message)); return wrap; }
  const code = genCode(state.lang, op, req);
  wrap.append(el("div",{class:"codewrap"},
    el("button",{class:"copybtn",onclick:e=>copyText(code,e.target)},"Copy"),
    el("pre",{class:"out"},code)));
  return wrap;
}

function basicAuthNeeded(op,req){ return op.rest && !req.noAuth; }

function genCode(lang, op, req){
  if(req.kind==="rpc") return genRpc(lang, req);
  return genRest(lang, op, req);
}

function genRpc(lang, req){
  const url = req.url, body = JSON.stringify(req.body);
  if(lang==="curl"){
    return `curl -s -X POST ${url} \\\n`+
      `  -H 'content-type: application/json' \\\n`+
      `  -d '${body}'`;
  }
  if(lang==="ts"){
    return `// fetch (works in Node 18+ / browser). For viem, use a custom transport to ${url}\n`+
      `const res = await fetch(${JSON.stringify(url)}, {\n`+
      `  method: "POST",\n`+
      `  headers: { "content-type": "application/json" },\n`+
      `  body: JSON.stringify(${pj(req.body)}),\n`+
      `});\n`+
      `const json = await res.json();\n`+
      `console.log(json.result);`;
  }
  if(lang==="py"){
    return `import requests\n`+
      `r = requests.post(${JSON.stringify(url)},\n`+
      `    json=${pyObj(req.body)})\n`+
      `r.raise_for_status()\n`+
      `print(r.json()["result"])`;
  }
  if(lang==="go"){
    return `package main\n\n`+
      `import (\n\t"bytes"\n\t"fmt"\n\t"io"\n\t"net/http"\n)\n\n`+
      `func main() {\n`+
      `\tbody := []byte(\`${body}\`)\n`+
      `\tresp, err := http.Post(${JSON.stringify(url)},\n`+
      `\t\t"application/json", bytes.NewReader(body))\n`+
      `\tif err != nil { panic(err) }\n`+
      `\tdefer resp.Body.Close()\n`+
      `\tout, _ := io.ReadAll(resp.Body)\n`+
      `\tfmt.Println(resp.Status, string(out))\n`+
      `}`;
  }
}

function genRest(lang, op, req){
  const url = req.url;
  const auth = basicAuthNeeded(op,req);
  const U = "USER", P = "PASS";
  if(lang==="curl"){
    return `curl -s ${auth?`-u '${U}:${P}' `:""}'${url}'`;
  }
  if(lang==="ts"){
    return `const res = await fetch(${JSON.stringify(url)}, {\n`+
      (auth?`  headers: { Authorization: "Basic " + btoa("${U}:${P}") },\n`:"")+
      `});\n`+
      `const json = await res.json();\n`+
      `console.log(json);`;
  }
  if(lang==="py"){
    return `import requests\n`+
      `r = requests.get(${JSON.stringify(url)}`+
      (auth?`,\n    auth=("${U}", "${P}")`:"")+`)\n`+
      `r.raise_for_status()\n`+
      `print(r.json())`;
  }
  if(lang==="go"){
    return `package main\n\n`+
      `import (\n\t"fmt"\n\t"io"\n\t"net/http"\n)\n\n`+
      `func main() {\n`+
      `\treq, _ := http.NewRequest("GET", ${JSON.stringify(url)}, nil)\n`+
      (auth?`\treq.SetBasicAuth("${U}", "${P}")\n`:"")+
      `\tresp, err := http.DefaultClient.Do(req)\n`+
      `\tif err != nil { panic(err) }\n`+
      `\tdefer resp.Body.Close()\n`+
      `\tout, _ := io.ReadAll(resp.Body)\n`+
      `\tfmt.Println(resp.Status, string(out))\n`+
      `}`;
  }
}

function pj(o){ return JSON.stringify(o); }
function pyObj(o){
  // JSON is valid python dict literal for these shapes (true/false/null differ but unused here)
  return JSON.stringify(o)
    .replace(/:true/g,":True").replace(/:false/g,":False").replace(/:null/g,":None");
}

/* ------------------------------------------------------------------ *
 * Utilities
 * ------------------------------------------------------------------ */
function copyText(txt,btn){
  navigator.clipboard.writeText(txt).then(()=>{
    const old=btn.textContent; btn.textContent="Copied"; setTimeout(()=>btn.textContent=old,1200);
  }).catch(()=>{});
}

/* boot */
document.addEventListener("DOMContentLoaded",()=>{
  // sanity: balanceOf selector must be 0x00fdd58e (validates keccak impl)
  const bsel = selector("balanceOf(address,uint256)");
  if(bsel !== "0x00fdd58e"){
    console.error("keccak self-test FAILED: balanceOf selector =", bsel);
  } else {
    console.info("keccak self-test ok — getActive selector =", selector("getActive(bytes32)"));
  }
  render();
});
