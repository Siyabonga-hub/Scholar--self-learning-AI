import { useState, useEffect, useRef, useMemo, useCallback } from "react";

/*
  SCHOLAR FRONTEND v3
  ─────────────────────────────────────────────────────────────────
  No more hardcoded REPOS. Node graph is hydrated from the backend:
    • On mount  → GET /api/repos  (loads everything Scholar already knows)
    • WebSocket → /ws             (receives new_repo events in real time)
    • Chat      → POST /api/chat  (Groq-powered, context = real absorbed repos)
    • Analyze   → POST /api/analyze (trigger Scholar to absorb a new repo)

  Set BACKEND_URL to your Render service URL.
  In local dev: http://localhost:8000
*/

const BACKEND_URL = "https://scholar-self-learning-ai.onrender.com/"; // ← change this
const WS_URL      = BACKEND_URL.replace("https","wss").replace("http","ws") + "/ws";

/* ─── Seeded RNG (deterministic micro-node layout) ───────────────────────── */
const mkRng=(s=137)=>{let n=s;return()=>{n=(n*16807)%2147483647;return(n-1)/2147483646;};};
const rng=mkRng(137);

const MICRO=Array.from({length:90},(_,i)=>{
  const a=rng()*Math.PI*2,d=58+rng()*330;
  return{id:i,px:Math.cos(a)*d,py:Math.sin(a)*d,r:rng()*1.65+1.4,blue:rng()>.47,op:rng()*.35+.15};
});
const MICRO_EDGES=(()=>{
  const e=[];
  MICRO.forEach((a,i)=>MICRO.forEach((b,j)=>{
    if(j<=i)return;
    const d=Math.hypot(b.px-a.px,b.py-a.py);
    if(d<112&&rng()>.38)e.push([i,j]);
  }));
  return e;
})();
const STARS=Array.from({length:105},()=>({cx:rng()*100,cy:rng()*100,r:rng()*.7+.2,op:rng()*.28+.06}));

/* ─── CSS ─────────────────────────────────────────────────────────────────── */
const CSS=`
  @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@300;400;500;600&family=Cormorant+Garamond:ital,wght@0,300;0,400;1,300;1,400;1,500&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  @keyframes coreGlow{
    0%,100%{filter:drop-shadow(0 0 20px rgba(200,30,175,.75)) drop-shadow(0 0 50px rgba(110,10,200,.45));}
    50%     {filter:drop-shadow(0 0 38px rgba(225,65,205,1))   drop-shadow(0 0 85px rgba(140,15,245,.65));}
  }
  @keyframes pulse{0%,100%{opacity:.45;transform:scale(1);}50%{opacity:.85;transform:scale(1.1);}}
  @keyframes nodeIn{0%{opacity:0;transform:scale(0);}70%{opacity:1;transform:scale(1.18);}100%{opacity:1;transform:scale(1);}}
  @keyframes flicker{0%,100%{opacity:var(--op,0.25);}50%{opacity:calc(var(--op,0.25) + 0.12);}}
  @keyframes scanline{0%{transform:translateY(-100%);}100%{transform:translateY(100vh);}}
  .cs::-webkit-scrollbar{width:3px;}
  .cs::-webkit-scrollbar-track{background:transparent;}
  .cs::-webkit-scrollbar-thumb{background:rgba(110,60,190,.28);border-radius:2px;}
  .si{background:rgba(90,45,165,.1);border:1px solid rgba(120,75,205,.28);color:#ddd8f8;
    padding:10px 14px;border-radius:6px;font-family:'Cormorant Garamond',serif;
    font-size:15px;outline:none;width:100%;resize:none;line-height:1.5;}
  .si:focus{border-color:rgba(155,95,235,.6);}
  .si::placeholder{color:rgba(140,95,230,.28);font-style:italic;}
  .sb{background:rgba(90,45,165,.14);border:1px solid rgba(120,75,205,.36);color:#b898ff;
    border-radius:6px;padding:0 17px;font-family:'Rajdhani',sans-serif;font-size:11.5px;
    font-weight:600;letter-spacing:.24em;cursor:pointer;transition:all .2s;white-space:nowrap;
    align-self:stretch;display:flex;align-items:center;}
  .sb:hover:not(:disabled){background:rgba(120,65,210,.28);border-color:rgba(165,105,250,.7);}
  .sb:disabled{opacity:.28;cursor:default;}
  .url-input{background:rgba(90,45,165,.08);border:1px solid rgba(120,75,205,.2);
    color:#ccc;padding:8px 12px;border-radius:5px;font-family:'Rajdhani',sans-serif;
    font-size:12px;outline:none;flex:1;letter-spacing:.04em;}
  .url-input:focus{border-color:rgba(155,95,235,.5);}
  .url-input::placeholder{color:rgba(140,95,230,.25);}
  .ingest-btn{background:rgba(200,30,175,.12);border:1px solid rgba(200,30,175,.3);
    color:rgba(220,120,220,.8);border-radius:5px;padding:8px 14px;
    font-family:'Rajdhani',sans-serif;font-size:11px;font-weight:600;
    letter-spacing:.2em;cursor:pointer;transition:all .2s;white-space:nowrap;}
  .ingest-btn:hover:not(:disabled){background:rgba(200,30,175,.22);}
  .ingest-btn:disabled{opacity:.25;cursor:default;}
  .toast{position:fixed;bottom:18px;right:18px;z-index:999;
    background:rgba(8,9,24,.95);border:1px solid rgba(120,75,205,.35);
    border-radius:8px;padding:10px 16px;color:#c8b0f8;
    font-family:'Rajdhani',sans-serif;font-size:12px;letter-spacing:.08em;
    backdrop-filter:blur(12px);max-width:280px;line-height:1.45;
    transition:opacity .4s;pointer-events:none;}
`;

/* ════════════════════════════════════════════════════════════════════════════ */
export default function Scholar(){
  const [nodes,     setNodes]     = useState([]);
  const [sel,       setSel]       = useState(null);
  const [msgs,      setMsgs]      = useState([{role:"assistant",
    content:"Good day. I am SCHOLAR — connecting to my backend now. In a moment, everything I have truly learned will appear before you."}]);
  const [input,     setInput]     = useState("");
  const [loading,   setLoading]   = useState(false);
  const [mobile,    setMobile]    = useState(false);
  const [mapW,      setMapW]      = useState(640);
  const [mapH,      setMapH]      = useState(500);
  const [wsStatus,  setWsStatus]  = useState("connecting"); // connecting|live|offline
  const [toast,     setToast]     = useState(null);
  const [ingestUrl, setIngestUrl] = useState("");
  const [ingesting, setIngesting] = useState(false);
  const [historyForApi, setHistoryForApi] = useState([]);

  const wsRef   = useRef(null);
  const chatEnd = useRef(null);

  /* ── responsive ─────────────────────────────────────────────────────────── */
  useEffect(()=>{
    const u=()=>{
      const m=window.innerWidth<768;
      setMobile(m);
      setMapW(m?window.innerWidth:Math.min(Math.floor(window.innerWidth*.56),750));
      setMapH(m?Math.floor(window.innerHeight*.43):window.innerHeight);
    };
    u();window.addEventListener("resize",u);return()=>window.removeEventListener("resize",u);
  },[]);

  /* ── toast helper ────────────────────────────────────────────────────────── */
  const showToast = useCallback((msg)=>{
    setToast(msg);
    setTimeout(()=>setToast(null), 4000);
  },[]);

  /* ── node position builder (deterministic from index) ───────────────────── */
  const buildNodePos = useCallback((repo, idx)=>{
    const PHI=Math.PI*(3-Math.sqrt(5));
    const angle=idx*PHI-Math.PI/2;
    const base=repo.hub?155:195+Math.floor((idx-2)/4)*68;
    const radius=base+((repo.id*17)%22)-11; // deterministic jitter
    return{ ...repo, angle, radius,
      x:Math.cos(angle)*radius, y:Math.sin(angle)*radius, born:Date.now() };
  },[]);

  /* ── REST hydration on mount ─────────────────────────────────────────────── */
  useEffect(()=>{
    fetch(`${BACKEND_URL}/api/repos`)
      .then(r=>r.json())
      .then(data=>{
        const positioned = (data.repos||[]).map((r,i)=>buildNodePos(r,i));
        setNodes(positioned);
        if(positioned.length>0)
          showToast(`Hydrated — Scholar already knows ${positioned.length} repositories.`);
      })
      .catch(()=>setWsStatus("offline"));
  },[buildNodePos, showToast]);

  /* ── WebSocket — live push ───────────────────────────────────────────────── */
  useEffect(()=>{
    let ws;
    const connect=()=>{
      try{
        ws = new WebSocket(WS_URL);
        wsRef.current = ws;

        ws.onopen=()=>{ setWsStatus("live"); };

        ws.onmessage=(e)=>{
          const payload=JSON.parse(e.data);

          if(payload.event==="init"){
            // Backend sends current state on connect
            const positioned=(payload.repos||[]).map((r,i)=>buildNodePos(r,i));
            setNodes(positioned);
          }
          else if(payload.event==="new_repo"){
            setNodes(prev=>{
              if(prev.some(n=>n.id===payload.repo.id)) return prev;
              return [...prev, buildNodePos(payload.repo, prev.length)];
            });
            showToast(`Scholar absorbed: ${payload.repo.full}`);
          }
          else if(payload.event==="status"){
            showToast(payload.message);
          }
          else if(payload.event==="error"){
            showToast(`⚠ ${payload.message}`);
          }
        };

        ws.onclose=()=>{
          setWsStatus("offline");
          setTimeout(connect, 5000); // auto-reconnect
        };
        ws.onerror=()=>{ setWsStatus("offline"); };
      }catch{ setWsStatus("offline"); }
    };
    connect();
    const ping=setInterval(()=>{ if(ws?.readyState===1) ws.send("ping"); },25000);
    return()=>{ clearInterval(ping); ws?.close(); };
  },[buildNodePos, showToast]);

  useEffect(()=>{chatEnd.current?.scrollIntoView({behavior:"smooth"});},[msgs]);

  /* ── Chat via backend ────────────────────────────────────────────────────── */
  const send = async()=>{
    if(!input.trim()||loading)return;
    const userMsg={role:"user",content:input.trim()};
    setMsgs(p=>[...p,userMsg]);
    const newHist=[...historyForApi,userMsg];
    setInput("");setLoading(true);

    try{
      const r=await fetch(`${BACKEND_URL}/api/chat`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({message:userMsg.content, history:historyForApi})
      });
      const d=await r.json();
      const reply=d.reply||"Forgive me — my thoughts wandered momentarily.";
      const assistantMsg={role:"assistant",content:reply};
      setMsgs(p=>[...p,assistantMsg]);
      setHistoryForApi([...newHist,assistantMsg].slice(-12)); // keep last 12 turns
    }catch{
      setMsgs(p=>[...p,{role:"assistant",content:"My apologies — the connection faltered."}]);
    }
    setLoading(false);
  };

  /* ── Ingest a new repo ───────────────────────────────────────────────────── */
  const ingest = async()=>{
    if(!ingestUrl.trim()||ingesting)return;
    setIngesting(true);
    try{
      const r=await fetch(`${BACKEND_URL}/api/analyze`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({github_url:ingestUrl.trim()})
      });
      const d=await r.json();
      if(r.status===409) showToast("Scholar already knows that repository.");
      else showToast(d.message||"Scholar has begun reading…");
      setIngestUrl("");
    }catch{
      showToast("Failed to queue repository.");
    }
    setIngesting(false);
  };

  /* ── Derived geometry ────────────────────────────────────────────────────── */
  const cx=mapW/2,cy=mapH/2;
  const sc=Math.min(mapW,mapH)/700;

  const sMicro=useMemo(()=>
    MICRO.map(m=>({...m,ax:cx+m.px*sc,ay:cy+m.py*sc})),
    [cx,cy,sc]
  );

  const nCol=n=>n.blue?"#44aaff":"#ff3a88";
  const nR  =n=>n.hub?(mobile?20:24):(mobile?13:17);

  const lPos=(node,ex=0)=>{
    const nx=cx+node.x,ny=cy+node.y;
    const ang=Math.atan2(ny-cy,nx-cx);
    const r=nR(node)+ex+11;
    const lx=nx+Math.cos(ang)*r,ly=ny+Math.sin(ang)*r;
    const anch=Math.cos(ang)>.25?"start":Math.cos(ang)<-.25?"end":"middle";
    const dy=Math.sin(ang)>.4?10:Math.sin(ang)<-.4?-4:4;
    return{lx,ly,anch,dy};
  };

  /* ── Render ──────────────────────────────────────────────────────────────── */
  return(
    <>
      <style>{CSS}</style>

      {/* Toast */}
      {toast&&<div className="toast">{toast}</div>}

      <div style={{display:"flex",flexDirection:mobile?"column":"row",width:"100vw",height:"100vh",background:"#060815",overflow:"hidden",fontFamily:"'Cormorant Garamond',serif"}}>

        {/* ══ MIND MAP ══════════════════════════════════════════════════════ */}
        <div style={{width:mobile?"100%":`${mapW}px`,height:mobile?`${mapH}px`:"100vh",position:"relative",flexShrink:0,borderRight:mobile?"none":"1px solid rgba(100,55,175,.17)",borderBottom:mobile?"1px solid rgba(100,55,175,.17)":"none",overflow:"hidden"}}>

          {/* Status bar */}
          <div style={{position:"absolute",top:11,left:0,right:0,zIndex:10,textAlign:"center",fontFamily:"'Rajdhani',sans-serif",fontSize:mobile?"9px":"11px",fontWeight:500,letterSpacing:".3em",color:wsStatus==="live"?"rgba(100,220,120,.45)":wsStatus==="connecting"?"rgba(220,180,60,.4)":"rgba(200,60,60,.4)"}}>
            SCHOLAR · {nodes.length} REPOS · {wsStatus==="live"?"● LIVE":wsStatus==="connecting"?"◌ CONNECTING":"○ OFFLINE"}
          </div>

          <svg width={mapW} height={mapH} style={{position:"absolute",top:0,left:0,display:"block"}}>
            <defs>
              <radialGradient id="sbg2" cx="50%" cy="50%" r="55%">
                <stop offset="0%"   stopColor="#0d1028"/>
                <stop offset="50%"  stopColor="#080920"/>
                <stop offset="100%" stopColor="#04050e"/>
              </radialGradient>
              <radialGradient id="coreG2" cx="38%" cy="38%" r="65%">
                <stop offset="0%"   stopColor="#ff99ee"/>
                <stop offset="26%"  stopColor="#dd1199"/>
                <stop offset="60%"  stopColor="#8811dd"/>
                <stop offset="100%" stopColor="#280055" stopOpacity=".1"/>
              </radialGradient>
              <radialGradient id="blueG2" cx="33%" cy="33%" r="67%">
                <stop offset="0%"   stopColor="#99ddff"/>
                <stop offset="45%"  stopColor="#1e88cc"/>
                <stop offset="100%" stopColor="#0a2848"/>
              </radialGradient>
              <radialGradient id="pinkG2" cx="33%" cy="33%" r="67%">
                <stop offset="0%"   stopColor="#ff99cc"/>
                <stop offset="45%"  stopColor="#cc1166"/>
                <stop offset="100%" stopColor="#3e001e"/>
              </radialGradient>
              <filter id="cf2" x="-130%" y="-130%" width="360%" height="360%">
                <feGaussianBlur stdDeviation="22" result="b1"/>
                <feGaussianBlur stdDeviation="9" in="SourceGraphic" result="b2"/>
                <feMerge><feMergeNode in="b1"/><feMergeNode in="b2"/><feMergeNode in="SourceGraphic"/></feMerge>
              </filter>
              <filter id="hf2" x="-100%" y="-100%" width="300%" height="300%">
                <feGaussianBlur stdDeviation="9" result="b1"/>
                <feGaussianBlur stdDeviation="3" in="SourceGraphic" result="b2"/>
                <feMerge><feMergeNode in="b1"/><feMergeNode in="b2"/><feMergeNode in="SourceGraphic"/></feMerge>
              </filter>
              <filter id="nf2" x="-90%" y="-90%" width="280%" height="280%">
                <feGaussianBlur stdDeviation="5" result="b1"/>
                <feGaussianBlur stdDeviation="2" in="SourceGraphic" result="b2"/>
                <feMerge><feMergeNode in="b1"/><feMergeNode in="b2"/><feMergeNode in="SourceGraphic"/></feMerge>
              </filter>
              <filter id="mf2" x="-200%" y="-200%" width="500%" height="500%">
                <feGaussianBlur stdDeviation="2.2" result="b"/>
                <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
              </filter>
            </defs>

            <rect width={mapW} height={mapH} fill="url(#sbg2)"/>
            {STARS.map((s,i)=>(
              <circle key={i} cx={s.cx*mapW/100} cy={s.cy*mapH/100} r={s.r} fill="white" opacity={s.op}/>
            ))}

            {/* micro web */}
            {MICRO_EDGES.map(([ai,bi],k)=>{
              const a=sMicro[ai],b=sMicro[bi];
              const c=a.blue&&b.blue?"rgba(55,155,255,.1)":!a.blue&&!b.blue?"rgba(255,50,128,.09)":"rgba(130,75,255,.07)";
              return<line key={k} x1={a.ax} y1={a.ay} x2={b.ax} y2={b.ay} stroke={c} strokeWidth=".55"/>;
            })}
            {sMicro.filter((_,i)=>i%3===0).map((m,i)=>{
              if(!nodes.length)return null;
              const best=nodes.reduce((b,n)=>{const d=Math.hypot((cx+n.x)-m.ax,(cy+n.y)-m.ay);return d<b.d?{n,d}:b;},{n:null,d:Infinity});
              if(!best.n||best.d>195)return null;
              return<line key={`ml${i}`} x1={m.ax} y1={m.ay} x2={cx+best.n.x} y2={cy+best.n.y} stroke={m.blue?"rgba(55,155,255,.08)":"rgba(255,50,128,.06)"} strokeWidth=".5"/>;
            })}
            {nodes.map(n=>(
              <line key={`cl${n.id}`} x1={cx} y1={cy} x2={cx+n.x} y2={cy+n.y}
                stroke={n.blue?"rgba(48,150,255,.16)":"rgba(255,48,128,.14)"}
                strokeWidth={n.hub?"1":".65"}/>
            ))}
            {/* cross-repo edges — connect nodes within 260px */}
            {nodes.flatMap((a,i)=>nodes.slice(i+1).filter(b=>{
              const d=Math.hypot(a.x-b.x,a.y-b.y);
              return d<260&&d>40;
            }).map((b,k)=>{
              const c=(a.blue&&b.blue)?"rgba(48,150,255,.12)":(!a.blue&&!b.blue)?"rgba(255,48,128,.11)":"rgba(130,75,255,.08)";
              return<line key={`rr${a.id}-${b.id}-${k}`} x1={cx+a.x} y1={cy+a.y} x2={cx+b.x} y2={cy+b.y} stroke={c} strokeWidth=".6"/>;
            }))}

            {sMicro.map(m=>(
              <circle key={m.id} cx={m.ax} cy={m.ay} r={m.r}
                fill={m.blue?"#55bbff":"#ff55aa"} filter="url(#mf2)"
                style={{opacity:m.op,animation:`flicker ${2+m.r*.5}s ease-in-out infinite ${m.id*.07}s`,"--op":m.op}}/>
            ))}

            {[94,74,55].map((r,i)=>(
              <circle key={i} cx={cx} cy={cy} r={r}
                fill={`rgba(${i===0?"165,18,148":"115,8,188"},${.042+i*.022})`}
                style={{animation:`pulse ${2.8+i*.55}s ease-in-out infinite ${i*.35}s`}}/>
            ))}

            <g filter="url(#cf2)" style={{animation:"coreGlow 3.5s ease-in-out infinite"}}>
              <circle cx={cx} cy={cy} r="44" fill="url(#coreG2)"/>
              <circle cx={cx} cy={cy} r="44" fill="none" stroke="rgba(255,108,228,.55)" strokeWidth="1.8"/>
              <circle cx={cx} cy={cy} r="34" fill="none" stroke="rgba(195,55,195,.3)" strokeWidth=".8"/>
              <circle cx={cx} cy={cy} r="22" fill="none" stroke="rgba(255,138,238,.18)" strokeWidth=".5"/>
            </g>
            <text x={cx} y={cy-5} textAnchor="middle" fill="rgba(255,238,255,.9)"
              fontFamily="'Rajdhani',sans-serif" fontSize={mobile?"9":"11"} fontWeight="600" letterSpacing="2.5">SCHOLAR</text>
            <text x={cx} y={cy+8} textAnchor="middle" fill="rgba(255,155,255,.42)"
              fontFamily="'Cormorant Garamond',serif" fontSize={mobile?"6":"7.5"} fontStyle="italic">self-improving</text>

            {nodes.map(n=>{
              const nx=cx+n.x,ny=cy+n.y;
              const isSel=sel?.id===n.id;
              const nr=nR(n)+(isSel?5:0);
              const col=nCol(n);
              const grad=n.blue?"url(#blueG2)":"url(#pinkG2)";
              const {lx,ly,anch,dy}=lPos(n,isSel?8:4);
              const fresh=Date.now()-n.born<2200;
              return(
                <g key={n.id} style={{cursor:"pointer"}} onClick={()=>setSel(isSel?null:n)}>
                  <circle cx={nx} cy={ny} r={nr+13} fill="transparent"/>
                  <g filter={n.hub||isSel?"url(#hf2)":"url(#nf2)"}
                     style={{transformOrigin:`${nx}px ${ny}px`,animation:fresh?"nodeIn .95s ease-out":undefined}}>
                    {(n.hub||isSel)&&<circle cx={nx} cy={ny} r={nr+7} fill="none" stroke={col} strokeWidth=".55" strokeOpacity=".25"/>}
                    <circle cx={nx} cy={ny} r={nr} fill={grad}/>
                    <circle cx={nx} cy={ny} r={nr} fill="none" stroke={col} strokeWidth={isSel?2:1} strokeOpacity={isSel?1:.6} style={{transition:"all .3s"}}/>
                  </g>
                  <text x={lx} y={ly+dy} textAnchor={anch}
                    fill={isSel?col:"rgba(195,210,238,.76)"}
                    fontFamily="'Rajdhani',sans-serif"
                    fontSize={mobile?"8":"10"} fontWeight={isSel?"600":"400"} letterSpacing=".06em"
                    style={{pointerEvents:"none",userSelect:"none",transition:"fill .3s"}}>
                    {n.name}
                  </text>
                </g>
              );
            })}
          </svg>

          {/* Node detail card */}
          {sel&&(
            <div style={{position:"absolute",bottom:10,left:8,right:8,background:"rgba(5,6,18,.96)",border:`1px solid ${nCol(sel)}30`,borderRadius:10,padding:"12px 15px",maxHeight:mobile?"128px":"198px",overflowY:"auto",backdropFilter:"blur(18px)",boxShadow:`0 0 28px ${nCol(sel)}12`}}>
              <div onClick={()=>setSel(null)} style={{position:"absolute",top:7,right:11,color:"rgba(150,110,255,.4)",cursor:"pointer",fontSize:"17px",lineHeight:1}}>×</div>
              <div style={{color:nCol(sel),fontFamily:"'Rajdhani',sans-serif",fontSize:mobile?"9.5px":"11px",fontWeight:500,letterSpacing:".22em",marginBottom:6}}>{sel.full}</div>
              {sel.absorbed_at&&<div style={{color:"rgba(150,110,255,.35)",fontFamily:"'Rajdhani',sans-serif",fontSize:"9px",letterSpacing:".15em",marginBottom:7}}>{new Date(sel.absorbed_at).toLocaleString()} · {sel.domain||"general"} · complexity {sel.complexity||"?"}/10</div>}
              <div style={{color:"#ddd8f8",fontSize:mobile?"12px":"13.5px",lineHeight:"1.56",fontStyle:"italic",marginBottom:8}}>"{sel.philosophy}"</div>
              {sel.improvement_intent&&<div style={{color:"rgba(180,155,255,.45)",fontSize:"11.5px",fontStyle:"italic",marginBottom:8}}>Next visit: {sel.improvement_intent}</div>}
              <div style={{color:"rgba(150,110,255,.5)",fontFamily:"'Rajdhani',sans-serif",fontSize:"9.5px",letterSpacing:".2em",marginBottom:5,fontWeight:500}}>CODE CHANGES APPLIED</div>
              {(sel.changes||[]).map((c,i)=>(
                <div key={i} style={{color:"rgba(195,185,238,.5)",fontSize:"11px",marginBottom:3,lineHeight:"1.45"}}>· {c}</div>
              ))}
            </div>
          )}
        </div>

        {/* ══ CHAT PANEL ════════════════════════════════════════════════════ */}
        <div style={{flex:1,display:"flex",flexDirection:"column",height:mobile?`calc(100vh - ${mapH}px)`:"100vh",background:"rgba(4,5,14,.99)",overflow:"hidden",minWidth:0}}>

          {/* header */}
          <div style={{padding:mobile?"10px 15px":"13px 22px",borderBottom:"1px solid rgba(95,55,170,.15)",flexShrink:0,display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:7,height:7,borderRadius:"50%",background:"#cc44ff",boxShadow:"0 0 10px rgba(195,55,255,.65)",animation:"pulse 2.8s ease-in-out infinite"}}/>
            <span style={{fontFamily:"'Rajdhani',sans-serif",fontSize:mobile?"10.5px":"12.5px",fontWeight:500,letterSpacing:".3em",color:"rgba(160,120,255,.62)"}}>DISCOURSE WITH SCHOLAR</span>
            <div style={{marginLeft:"auto",fontFamily:"'Rajdhani',sans-serif",fontSize:"10px",color:wsStatus==="live"?"rgba(80,200,100,.45)":"rgba(200,80,80,.4)",letterSpacing:".15em"}}>
              {wsStatus==="live"?"● LIVE":"○ OFFLINE"}
            </div>
          </div>

          {/* Ingest bar */}
          <div style={{padding:mobile?"8px 12px":"9px 18px",borderBottom:"1px solid rgba(95,55,170,.09)",display:"flex",gap:7,flexShrink:0}}>
            <input className="url-input" placeholder="https://github.com/owner/repo"
              value={ingestUrl} onChange={e=>setIngestUrl(e.target.value)}
              onKeyDown={e=>{if(e.key==="Enter")ingest();}}
            />
            <button className="ingest-btn" onClick={ingest} disabled={ingesting||!ingestUrl.trim()}>
              {ingesting?"READING…":"INGEST"}
            </button>
          </div>

          {/* messages */}
          <div className="cs" style={{flex:1,overflowY:"auto",padding:mobile?"11px 13px":"15px 22px",display:"flex",flexDirection:"column",gap:12}}>
            {msgs.map((m,i)=>(
              <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start"}}>
                <div style={{maxWidth:"88%",padding:m.role==="user"?"8px 14px":"11px 16px",background:m.role==="user"?"rgba(95,45,170,.13)":"rgba(255,255,255,.02)",border:m.role==="user"?"1px solid rgba(120,75,200,.32)":"1px solid rgba(95,55,170,.1)",borderRadius:m.role==="user"?"10px 10px 2px 10px":"10px 10px 10px 2px",color:m.role==="user"?"#cbb6f8":"#ddd8f8",fontSize:mobile?"13px":"14.5px",lineHeight:"1.7",fontStyle:m.role==="assistant"?"italic":"normal"}}>{m.content}</div>
              </div>
            ))}
            {loading&&(
              <div style={{display:"flex"}}>
                <div style={{padding:"10px 16px",background:"rgba(255,255,255,.02)",border:"1px solid rgba(95,55,170,.1)",borderRadius:"10px 10px 10px 2px",color:"rgba(145,105,255,.4)",fontSize:mobile?"12px":"13.5px",fontStyle:"italic"}}>Scholar is composing a thought…</div>
              </div>
            )}
            <div ref={chatEnd}/>
          </div>

          {/* chat input */}
          <div style={{padding:mobile?"10px 12px":"12px 18px",borderTop:"1px solid rgba(95,55,170,.13)",display:"flex",gap:8,flexShrink:0,alignItems:"flex-end"}}>
            <textarea className="si" rows={2} placeholder="Address Scholar…"
              value={input} onChange={e=>setInput(e.target.value)}
              onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}}}
            />
            <button className="sb" onClick={send} disabled={loading||!input.trim()}>SEND</button>
          </div>

          <div style={{textAlign:"center",padding:"3px 0 7px",color:"rgba(95,55,170,.2)",fontFamily:"'Cormorant Garamond',serif",fontSize:"9.5px",fontStyle:"italic",letterSpacing:".15em",flexShrink:0}}>a scholar never ceases to learn</div>
        </div>

      </div>
    </>
  );
}
