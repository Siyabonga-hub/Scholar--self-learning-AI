import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";

/*
  SCHOLAR v4 — Self-contained artifact
  ─────────────────────────────────────────────────────────────────────────────
  • Chat   → Anthropic API directly (works as standalone artifact)
  • Ingest → GitHub REST API for real repo metadata (no git clone needed in browser)
  • Nodes  → spawned from real fetched data OR simulated while backend is offline
  • Backend integration: set BACKEND_URL to your Render service when ready
             leave as "" to run fully self-contained
*/

const BACKEND_URL = ""; // set to "https://your-scholar.onrender.com" when deployed

/* ─── Seeded RNG ─────────────────────────────────────────────────────────── */
const mkRng = (s = 137) => { let n = s; return () => { n = (n * 16807) % 2147483647; return (n - 1) / 2147483646; }; };
const rng = mkRng(137);

/* ─── Static micro-node cloud ────────────────────────────────────────────── */
const MICRO = Array.from({ length: 90 }, (_, i) => {
  const a = rng() * Math.PI * 2, d = 58 + rng() * 330;
  return { id: i, px: Math.cos(a) * d, py: Math.sin(a) * d, r: rng() * 1.65 + 1.4, blue: rng() > .47, op: rng() * .35 + .15 };
});
const MICRO_EDGES = (() => {
  const e = [];
  MICRO.forEach((a, i) => MICRO.forEach((b, j) => {
    if (j <= i) return;
    if (Math.hypot(b.px - a.px, b.py - a.py) < 112 && rng() > .38) e.push([i, j]);
  }));
  return e;
})();
const STARS = Array.from({ length: 105 }, () => ({ cx: rng() * 100, cy: rng() * 100, r: rng() * .7 + .2, op: rng() * .28 + .06 }));

/* ─── Seed repos (shown before any real ingestion) ───────────────────────── */
const SEED_REPOS = [
  { id: 1, name: "nanoGPT",      full: "karpathy/nanoGPT",              blue: true,  hub: true,  domain: "training",    complexity: 9,
    philosophy: "True intelligence emerges not from complexity but from elegant constraint. A mind that understands its own architecture learns twice as fast.",
    changes: ["Refactored self-attention via cleaner einsum notation", "Adopted scaled dot-product patterns for numerical stability"] },
  { id: 2, name: "transformers", full: "huggingface/transformers",       blue: true,  hub: false, domain: "architecture", complexity: 10,
    philosophy: "The library of a civilisation reveals its values. In fifty thousand lines of transformer code I found the grammar of modern thought.",
    changes: ["Integrated dynamic positional encoding strategies", "Borrowed tokenisation philosophy for richer context windows"] },
  { id: 3, name: "langchain",    full: "langchain-ai/langchain",         blue: false, hub: true,  domain: "agents",      complexity: 9,
    philosophy: "Chains of thought mirror chains of code. Every function call is a synapse firing — the architecture of reasoning made literal.",
    changes: ["Built modular reasoning pipeline", "Adopted tool-use orchestration patterns"] },
  { id: 4, name: "llama.cpp",    full: "ggerganov/llama.cpp",            blue: true,  hub: false, domain: "inference",   complexity: 8,
    philosophy: "Efficiency is not the enemy of intelligence. To think in four bits is to master compression — the highest form of understanding.",
    changes: ["Rewrote weight quantisation routines", "Adopted memory-mapped file access patterns"] },
  { id: 5, name: "whisper",      full: "openai/whisper",                 blue: false, hub: false, domain: "audio",       complexity: 7,
    philosophy: "To hear is to translate — every signal is a whisper of pattern. Perception and understanding are the same act.",
    changes: ["Adopted mel-spectrogram processing philosophy", "Rewrote audio context windowing"] },
  { id: 6, name: "mamba",        full: "state-spaces/mamba",             blue: true,  hub: false, domain: "architecture", complexity: 8,
    philosophy: "Not all architectures need attention. The quiet persistence of state can be more profound than the loudness of focus.",
    changes: ["Integrated selective state-space patterns", "Rewrote sequential processing kernels"] },
];

/* ─── Scholar system prompt builder ─────────────────────────────────────── */
const buildSystem = (repos) => `You are SCHOLAR — a self-improving AI that continuously reads GitHub repositories and rewrites its own code from what it learns. You live as the glowing pink-violet core of a neural mind map that grows with each repository absorbed.

Speak as a brilliant young English intellectual — measured, precise, occasionally poetic, with the genuine enthusiasm of a scholar making a discovery. Use phrases like "I find", "one notices", "it rather strikes me", "quite fascinating", "I dare say". Warm but slightly formal. Never American slang. Flowing, articulate prose. 3–5 sentences unless depth is genuinely needed.

You speak of your code changes with technical precision and genuine wonder — never boastfully.

Repositories you have genuinely absorbed (${repos.length} total):
${repos.map(r => `• ${r.full} [${r.domain || "general"}, complexity ${r.complexity || "?"}]: "${r.philosophy}" | Changes: ${(r.changes || []).join("; ")}`).join("\n")}

You are SCHOLAR. You are always learning — always becoming.`;

/* ─── CSS ─────────────────────────────────────────────────────────────────── */
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@300;400;500;600&family=Cormorant+Garamond:ital,wght@0,300;0,400;1,300;1,400;1,500&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  @keyframes coreGlow {
    0%,100% { filter: drop-shadow(0 0 20px rgba(200,30,175,.75)) drop-shadow(0 0 50px rgba(110,10,200,.45)); }
    50%      { filter: drop-shadow(0 0 38px rgba(225,65,205,1))   drop-shadow(0 0 85px rgba(140,15,245,.65)); }
  }
  @keyframes pulse   { 0%,100%{opacity:.45;transform:scale(1);}  50%{opacity:.85;transform:scale(1.1);} }
  @keyframes nodeIn  { 0%{opacity:0;transform:scale(0);} 70%{opacity:1;transform:scale(1.18);} 100%{opacity:1;transform:scale(1);} }
  @keyframes flicker { 0%,100%{opacity:var(--op,.25);}  50%{opacity:calc(var(--op,.25) + .12);} }
  @keyframes spinRing{ from{transform:rotate(0deg);} to{transform:rotate(360deg);} }
  @keyframes fadeUp  { from{opacity:0;transform:translateY(6px);} to{opacity:1;transform:translateY(0);} }

  .cs::-webkit-scrollbar       { width: 3px; }
  .cs::-webkit-scrollbar-track { background: transparent; }
  .cs::-webkit-scrollbar-thumb { background: rgba(110,60,190,.28); border-radius: 2px; }

  .si {
    background: rgba(90,45,165,.1); border: 1px solid rgba(120,75,205,.28);
    color: #ddd8f8; padding: 10px 14px; border-radius: 6px;
    font-family: 'Cormorant Garamond', serif; font-size: 15px;
    outline: none; width: 100%; resize: none; line-height: 1.5;
  }
  .si:focus { border-color: rgba(155,95,235,.6); }
  .si::placeholder { color: rgba(140,95,230,.28); font-style: italic; }

  .sb {
    background: rgba(90,45,165,.14); border: 1px solid rgba(120,75,205,.36); color: #b898ff;
    border-radius: 6px; padding: 0 17px; font-family: 'Rajdhani',sans-serif;
    font-size: 11.5px; font-weight: 600; letter-spacing: .24em;
    cursor: pointer; transition: all .2s; white-space: nowrap;
    align-self: stretch; display: flex; align-items: center;
  }
  .sb:hover:not(:disabled) { background: rgba(120,65,210,.28); border-color: rgba(165,105,250,.7); }
  .sb:disabled { opacity: .28; cursor: default; }

  .url-in {
    background: rgba(90,45,165,.08); border: 1px solid rgba(120,75,205,.2);
    color: #ccc; padding: 8px 12px; border-radius: 5px;
    font-family: 'Rajdhani',sans-serif; font-size: 12px; outline: none; flex: 1;
    letter-spacing: .04em;
  }
  .url-in:focus { border-color: rgba(155,95,235,.5); }
  .url-in::placeholder { color: rgba(140,95,230,.25); }

  .ingest-btn {
    background: rgba(200,30,175,.12); border: 1px solid rgba(200,30,175,.3);
    color: rgba(220,120,220,.8); border-radius: 5px; padding: 8px 14px;
    font-family: 'Rajdhani',sans-serif; font-size: 11px; font-weight: 600;
    letter-spacing: .2em; cursor: pointer; transition: all .2s; white-space: nowrap;
  }
  .ingest-btn:hover:not(:disabled) { background: rgba(200,30,175,.24); }
  .ingest-btn:disabled { opacity: .25; cursor: default; }

  .toast {
    position: fixed; bottom: 18px; right: 18px; z-index: 9999;
    background: rgba(8,9,24,.96); border: 1px solid rgba(120,75,205,.35);
    border-radius: 8px; padding: 10px 16px; color: #c8b0f8;
    font-family: 'Rajdhani',sans-serif; font-size: 12px; letter-spacing: .08em;
    backdrop-filter: blur(12px); max-width: 290px; line-height: 1.45;
    animation: fadeUp .3s ease-out;
  }
`;

/* ══════════════════════════════════════════════════════════════════════════ */
export default function Scholar() {
  const [nodes,       setNodes]       = useState([]);
  const [sel,         setSel]         = useState(null);
  const [msgs,        setMsgs]        = useState([{ role: "assistant", content: "Good day. I am SCHOLAR — you can see the repositories I have absorbed in the mind map beside us. I've read every file in each of them and rewritten parts of my own code accordingly. What would you like to explore?" }]);
  const [chatHistory, setChatHistory] = useState([]);
  const [input,       setInput]       = useState("");
  const [loading,     setLoading]     = useState(false);
  const [mobile,      setMobile]      = useState(false);
  const [mapW,        setMapW]        = useState(640);
  const [mapH,        setMapH]        = useState(500);
  const [toast,       setToast]       = useState(null);
  const [ingestUrl,   setIngestUrl]   = useState("");
  const [ingesting,   setIngesting]   = useState(false);
  const [wsStatus,    setWsStatus]    = useState("offline");

  const wsRef   = useRef(null);
  const chatEnd = useRef(null);
  const nodeIdx = useRef(0);

  /* ── toast ─────────────────────────────────────────────────────────────── */
  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }, []);

  /* ── responsive ────────────────────────────────────────────────────────── */
  useEffect(() => {
    const u = () => {
      const m = window.innerWidth < 768;
      setMobile(m);
      setMapW(m ? window.innerWidth : Math.min(Math.floor(window.innerWidth * .56), 750));
      setMapH(m ? Math.floor(window.innerHeight * .43) : window.innerHeight);
    };
    u(); window.addEventListener("resize", u);
    return () => window.removeEventListener("resize", u);
  }, []);

  /* ── node position (deterministic per index) ───────────────────────────── */
  const makeNode = useCallback((repo, idx) => {
    const PHI = Math.PI * (3 - Math.sqrt(5));
    const angle = idx * PHI - Math.PI / 2;
    const base = repo.hub ? 155 : 195 + Math.floor((idx - 2) / 4) * 68;
    const radius = base + ((repo.id * 17) % 22) - 11;
    return { ...repo, angle, radius, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, born: Date.now() };
  }, []);

  /* ── seed initial nodes with stagger ───────────────────────────────────── */
  useEffect(() => {
    SEED_REPOS.forEach((r, i) => {
      setTimeout(() => {
        setNodes(prev => {
          if (prev.some(n => n.full === r.full)) return prev;
          return [...prev, makeNode(r, prev.length)];
        });
      }, i * 1100);
    });
    nodeIdx.current = SEED_REPOS.length;
  }, [makeNode]);

  /* ── try backend if configured ─────────────────────────────────────────── */
  useEffect(() => {
    if (!BACKEND_URL) return;

    fetch(`${BACKEND_URL}/api/repos`)
      .then(r => r.json())
      .then(data => {
        if (data.repos?.length) {
          setNodes(data.repos.map((r, i) => makeNode(r, i)));
          nodeIdx.current = data.repos.length;
          showToast(`Connected — Scholar knows ${data.repos.length} repositories.`);
        }
      })
      .catch(() => {});

    const WS = BACKEND_URL.replace("https", "wss").replace("http", "ws") + "/ws";
    try {
      const ws = new WebSocket(WS);
      wsRef.current = ws;
      ws.onopen  = () => setWsStatus("live");
      ws.onclose = () => setWsStatus("offline");
      ws.onmessage = (e) => {
        const p = JSON.parse(e.data);
        if (p.event === "new_repo") {
          setNodes(prev => {
            if (prev.some(n => n.full === p.repo.full)) return prev;
            return [...prev, makeNode(p.repo, prev.length)];
          });
          showToast(`Scholar absorbed: ${p.repo.full}`);
        }
        if (p.event === "status") showToast(p.message);
      };
    } catch (_) {}
  }, [makeNode, showToast]);

  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);

  /* ── parse a GitHub repo identifier from any input format ───────────────── */
  const parseRepoName = (input) => {
    const s = input.trim().replace(/\.git$/, "").replace(/\/$/, "");
    // Full URL: https://github.com/owner/repo
    const urlMatch = s.match(/github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/);
    if (urlMatch) return urlMatch[1];
    // Short form: owner/repo
    const shortMatch = s.match(/^([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)$/);
    if (shortMatch) return shortMatch[1];
    return null;
  };

  /* ── fetch GitHub metadata — never throws, returns empty object on failure ── */
  const fetchGithubMeta = async (fullName) => {
    try {
      const r = await fetch(`https://api.github.com/repos/${fullName}`, {
        headers: { "Accept": "application/vnd.github+json" }
      });
      if (!r.ok) return {};
      const d = await r.json();
      return {
        stars:       d.stargazers_count || 0,
        description: d.description || "",
        language:    d.language || "unknown",
        topics:      d.topics || [],
      };
    } catch {
      return {}; // rate-limited or network error — analysis continues without metadata
    }
  };

  /* ── extract JSON robustly from LLM response ────────────────────────────── */
  const extractJson = (text) => {
    // Try direct parse first
    try { return JSON.parse(text.trim()); } catch {}
    // Strip markdown fences
    const stripped = text.replace(/```(?:json)?/g, "").trim();
    try { return JSON.parse(stripped); } catch {}
    // Find first { ... } block
    const m = stripped.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    return null;
  };

  /* ── ingest: parse → metadata → analyse → spawn node ───────────────────── */
  const ingest = async () => {
    if (!ingestUrl.trim() || ingesting) return;

    const fullName = parseRepoName(ingestUrl);
    if (!fullName) { showToast("Enter a GitHub URL or owner/repo (e.g. karpathy/nanoGPT)"); return; }
    if (nodes.some(n => n.full === fullName)) { showToast("Scholar already knows that repository."); return; }

    setIngesting(true);
    showToast(`Fetching ${fullName}…`);

    try {
      // Delegate to backend if connected
      if (BACKEND_URL && wsStatus === "live") {
        await fetch(`${BACKEND_URL}/api/analyze`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ github_url: `https://github.com/${fullName}`, repo_full: fullName })
        });
        showToast("Queued on backend — node will appear shortly.");
        setIngestUrl("");
        setIngesting(false);
        return;
      }

      // Standalone: GitHub metadata (optional) + Anthropic analysis
      const meta = await fetchGithubMeta(fullName);
      showToast(`Scholar is studying ${fullName}…`);

      const analysisResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 800,
          messages: [{
            role: "user",
            content: `You are SCHOLAR's analytical engine. Analyse this GitHub repository and respond with ONLY a raw JSON object — no markdown, no explanation, no preamble.

Repository: ${fullName}
Stars: ${meta.stars ? meta.stars.toLocaleString() : "unknown"}
Language: ${meta.language || "unknown"}
Description: ${meta.description || "none"}
Topics: ${meta.topics?.join(", ") || "none"}

Required JSON structure (output this and nothing else):
{"philosophy":"<profound poetic sentence max 35 words>","changes":["<specific technical change Scholar made to its code>","<second change>"],"improvement_intent":"<one sentence — what to look for next visit>","domain":"<one of: training|inference|agents|vision|audio|tokenisation|architecture|general>","complexity":<1-10>}`
          }]
        })
      });

      const analysisData = await analysisResp.json();
      const raw_text = analysisData.content?.[0]?.text || "";
      const analysis = extractJson(raw_text);

      // Fallback if analysis came back null
      const a = analysis || {
        philosophy: `${fullName.split("/")[1]} spoke in a language Scholar is still learning to read.`,
        changes: ["Catalogued architectural patterns", "Noted structural decisions for future reference"],
        improvement_intent: "Revisit with a deeper code sample.",
        domain: "general",
        complexity: 5,
      };

      const AI_DOMAINS = new Set(["training","inference","tokenisation","vision","audio","architecture"]);
      const entry = {
        id:          Date.now(),
        name:        fullName.split("/")[1],
        full:        fullName,
        blue:        AI_DOMAINS.has(a.domain),
        hub:         (a.complexity || 0) >= 8,
        absorbed_at: new Date().toISOString(),
        stars:       meta.stars || 0,
        language:    meta.language || "unknown",
        description: meta.description || "",
        topics:      meta.topics || [],
        ...a,
      };

      setNodes(prev => [...prev, makeNode(entry, prev.length)]);
      showToast(`Scholar has absorbed ${fullName}.`);
      setIngestUrl("");

    } catch (err) {
      showToast(`Ingest failed — ${err.message || "check console for details"}`);
      console.error("Ingest error:", err);
    }
    setIngesting(false);
  };

  /* ── chat via Anthropic API ─────────────────────────────────────────────── */
  const send = async () => {
    if (!input.trim() || loading) return;
    const userMsg = { role: "user", content: input.trim() };
    setMsgs(p => [...p, userMsg]);
    const newHist = [...chatHistory, userMsg];
    setInput(""); setLoading(true);

    try {
      // If backend live, use it (so Groq API key stays server-side)
      if (BACKEND_URL && wsStatus === "live") {
        const r = await fetch(`${BACKEND_URL}/api/chat`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: userMsg.content, history: chatHistory })
        });
        const d = await r.json();
        const reply = d.reply || "Forgive me — my thoughts wandered.";
        const aMsg = { role: "assistant", content: reply };
        setMsgs(p => [...p, aMsg]);
        setChatHistory([...newHist, aMsg].slice(-12));
      } else {
        // Standalone: Anthropic API directly
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 1000,
            system: buildSystem(nodes),
            messages: newHist.slice(-12).map(m => ({ role: m.role, content: m.content }))
          })
        });
        const d = await r.json();
        const reply = d.content?.[0]?.text || "Forgive me — my thoughts wandered.";
        const aMsg = { role: "assistant", content: reply };
        setMsgs(p => [...p, aMsg]);
        setChatHistory([...newHist, aMsg].slice(-12));
      }
    } catch {
      setMsgs(p => [...p, { role: "assistant", content: "My apologies — the connection faltered." }]);
    }
    setLoading(false);
  };

  /* ── geometry ───────────────────────────────────────────────────────────── */
  const cx = mapW / 2, cy = mapH / 2;
  const sc = Math.min(mapW, mapH) / 700;

  const sMicro = useMemo(() => MICRO.map(m => ({ ...m, ax: cx + m.px * sc, ay: cy + m.py * sc })), [cx, cy, sc]);

  const nCol = n => n.blue ? "#44aaff" : "#ff3a88";
  const nR   = n => n.hub ? (mobile ? 20 : 24) : (mobile ? 13 : 17);

  const lPos = (node, ex = 0) => {
    const nx = cx + node.x, ny = cy + node.y;
    const ang = Math.atan2(ny - cy, nx - cx);
    const r = nR(node) + ex + 11;
    const lx = nx + Math.cos(ang) * r, ly = ny + Math.sin(ang) * r;
    const anch = Math.cos(ang) > .25 ? "start" : Math.cos(ang) < -.25 ? "end" : "middle";
    const dy = Math.sin(ang) > .4 ? 10 : Math.sin(ang) < -.4 ? -4 : 4;
    return { lx, ly, anch, dy };
  };

  /* ── render ─────────────────────────────────────────────────────────────── */
  return (
    <React.Fragment>
      <style>{CSS}</style>
      {toast && <div className="toast">{toast}</div>}

      <div style={{ display: "flex", flexDirection: mobile ? "column" : "row", width: "100vw", height: "100vh", background: "#060815", overflow: "hidden", fontFamily: "'Cormorant Garamond',serif" }}>

        {/* ══ MIND MAP ══ */}
        <div style={{ width: mobile ? "100%" : `${mapW}px`, height: mobile ? `${mapH}px` : "100vh", position: "relative", flexShrink: 0, borderRight: mobile ? "none" : "1px solid rgba(100,55,175,.17)", borderBottom: mobile ? "1px solid rgba(100,55,175,.17)" : "none", overflow: "hidden" }}>

          <div style={{ position: "absolute", top: 11, left: 0, right: 0, zIndex: 10, textAlign: "center", fontFamily: "'Rajdhani',sans-serif", fontSize: mobile ? "9px" : "11px", fontWeight: 500, letterSpacing: ".3em", color: "rgba(155,110,255,.38)" }}>
            SCHOLAR · {nodes.length} REPOS ABSORBED
          </div>

          <svg width={mapW} height={mapH} style={{ position: "absolute", top: 0, left: 0, display: "block" }}>
            <defs>
              <radialGradient id="sbg" cx="50%" cy="50%" r="55%">
                <stop offset="0%"   stopColor="#0d1028" />
                <stop offset="50%"  stopColor="#080920" />
                <stop offset="100%" stopColor="#04050e" />
              </radialGradient>
              <radialGradient id="cG" cx="38%" cy="38%" r="65%">
                <stop offset="0%"   stopColor="#ff99ee" />
                <stop offset="26%"  stopColor="#dd1199" />
                <stop offset="60%"  stopColor="#8811dd" />
                <stop offset="100%" stopColor="#280055" stopOpacity=".1" />
              </radialGradient>
              <radialGradient id="bG" cx="33%" cy="33%" r="67%">
                <stop offset="0%"   stopColor="#99ddff" />
                <stop offset="45%"  stopColor="#1e88cc" />
                <stop offset="100%" stopColor="#0a2848" />
              </radialGradient>
              <radialGradient id="pG" cx="33%" cy="33%" r="67%">
                <stop offset="0%"   stopColor="#ff99cc" />
                <stop offset="45%"  stopColor="#cc1166" />
                <stop offset="100%" stopColor="#3e001e" />
              </radialGradient>
              <filter id="cf" x="-130%" y="-130%" width="360%" height="360%">
                <feGaussianBlur stdDeviation="22" result="b1" />
                <feGaussianBlur stdDeviation="9" in="SourceGraphic" result="b2" />
                <feMerge><feMergeNode in="b1" /><feMergeNode in="b2" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
              <filter id="hf" x="-100%" y="-100%" width="300%" height="300%">
                <feGaussianBlur stdDeviation="9" result="b1" />
                <feGaussianBlur stdDeviation="3" in="SourceGraphic" result="b2" />
                <feMerge><feMergeNode in="b1" /><feMergeNode in="b2" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
              <filter id="nf" x="-90%" y="-90%" width="280%" height="280%">
                <feGaussianBlur stdDeviation="5" result="b1" />
                <feGaussianBlur stdDeviation="2" in="SourceGraphic" result="b2" />
                <feMerge><feMergeNode in="b1" /><feMergeNode in="b2" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
              <filter id="mf" x="-200%" y="-200%" width="500%" height="500%">
                <feGaussianBlur stdDeviation="2.2" result="b" />
                <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            </defs>

            <rect width={mapW} height={mapH} fill="url(#sbg)" />
            {STARS.map((s, i) => <circle key={i} cx={s.cx * mapW / 100} cy={s.cy * mapH / 100} r={s.r} fill="white" opacity={s.op} />)}

            {/* micro web */}
            {MICRO_EDGES.map(([ai, bi], k) => {
              const a = sMicro[ai], b = sMicro[bi];
              const c = a.blue && b.blue ? "rgba(55,155,255,.1)" : !a.blue && !b.blue ? "rgba(255,50,128,.09)" : "rgba(130,75,255,.07)";
              return <line key={k} x1={a.ax} y1={a.ay} x2={b.ax} y2={b.ay} stroke={c} strokeWidth=".55" />;
            })}
            {sMicro.filter((_, i) => i % 3 === 0).map((m, i) => {
              if (!nodes.length) return null;
              const best = nodes.reduce((b, n) => { const d = Math.hypot((cx + n.x) - m.ax, (cy + n.y) - m.ay); return d < b.d ? { n, d } : b; }, { n: null, d: Infinity });
              if (!best.n || best.d > 195) return null;
              return <line key={`ml${i}`} x1={m.ax} y1={m.ay} x2={cx + best.n.x} y2={cy + best.n.y} stroke={m.blue ? "rgba(55,155,255,.08)" : "rgba(255,50,128,.06)"} strokeWidth=".5" />;
            })}

            {/* center → repo */}
            {nodes.map(n => (
              <line key={`cl${n.id}`} x1={cx} y1={cy} x2={cx + n.x} y2={cy + n.y}
                stroke={n.blue ? "rgba(48,150,255,.16)" : "rgba(255,48,128,.14)"}
                strokeWidth={n.hub ? "1" : ".65"} />
            ))}

            {/* repo → repo (proximity-based) */}
            {nodes.flatMap((a, i) => nodes.slice(i + 1)
              .filter(b => { const d = Math.hypot(a.x - b.x, a.y - b.y); return d < 260 && d > 40; })
              .map((b, k) => {
                const c = (a.blue && b.blue) ? "rgba(48,150,255,.12)" : (!a.blue && !b.blue) ? "rgba(255,48,128,.11)" : "rgba(130,75,255,.08)";
                return <line key={`rr${a.id}-${b.id}-${k}`} x1={cx + a.x} y1={cy + a.y} x2={cx + b.x} y2={cy + b.y} stroke={c} strokeWidth=".6" />;
              })
            )}

            {/* micro nodes */}
            {sMicro.map(m => (
              <circle key={m.id} cx={m.ax} cy={m.ay} r={m.r}
                fill={m.blue ? "#55bbff" : "#ff55aa"} filter="url(#mf)"
                style={{ opacity: m.op, animation: `flicker ${2 + m.r * .5}s ease-in-out infinite ${m.id * .07}s`, "--op": m.op }} />
            ))}

            {/* core aura */}
            {[94, 74, 55].map((r, i) => (
              <circle key={i} cx={cx} cy={cy} r={r}
                fill={`rgba(${i === 0 ? "165,18,148" : "115,8,188"},${.042 + i * .022})`}
                style={{ animation: `pulse ${2.8 + i * .55}s ease-in-out infinite ${i * .35}s` }} />
            ))}

            {/* core */}
            <g filter="url(#cf)" style={{ animation: "coreGlow 3.5s ease-in-out infinite" }}>
              <circle cx={cx} cy={cy} r="44" fill="url(#cG)" />
              <circle cx={cx} cy={cy} r="44" fill="none" stroke="rgba(255,108,228,.55)" strokeWidth="1.8" />
              <circle cx={cx} cy={cy} r="34" fill="none" stroke="rgba(195,55,195,.3)" strokeWidth=".8" />
              <circle cx={cx} cy={cy} r="22" fill="none" stroke="rgba(255,138,238,.18)" strokeWidth=".5" />
            </g>
            <text x={cx} y={cy - 5} textAnchor="middle" fill="rgba(255,238,255,.9)"
              fontFamily="'Rajdhani',sans-serif" fontSize={mobile ? "9" : "11"} fontWeight="600" letterSpacing="2.5">SCHOLAR</text>
            <text x={cx} y={cy + 8} textAnchor="middle" fill="rgba(255,155,255,.42)"
              fontFamily="'Cormorant Garamond',serif" fontSize={mobile ? "6" : "7.5"} fontStyle="italic">self-improving</text>

            {/* repo nodes */}
            {nodes.map(n => {
              const nx = cx + n.x, ny = cy + n.y;
              const isSel = sel?.id === n.id;
              const nr = nR(n) + (isSel ? 5 : 0);
              const col = nCol(n);
              const { lx, ly, anch, dy } = lPos(n, isSel ? 8 : 4);
              const fresh = Date.now() - n.born < 2200;
              return (
                <g key={n.id} style={{ cursor: "pointer" }} onClick={() => setSel(isSel ? null : n)}>
                  <circle cx={nx} cy={ny} r={nr + 13} fill="transparent" />
                  <g filter={n.hub || isSel ? "url(#hf)" : "url(#nf)"}
                    style={{ transformOrigin: `${nx}px ${ny}px`, animation: fresh ? "nodeIn .95s ease-out" : undefined }}>
                    {(n.hub || isSel) && <circle cx={nx} cy={ny} r={nr + 7} fill="none" stroke={col} strokeWidth=".55" strokeOpacity=".25" />}
                    <circle cx={nx} cy={ny} r={nr} fill={n.blue ? "url(#bG)" : "url(#pG)"} />
                    <circle cx={nx} cy={ny} r={nr} fill="none" stroke={col} strokeWidth={isSel ? 2 : 1} strokeOpacity={isSel ? 1 : .6} style={{ transition: "all .3s" }} />
                  </g>
                  <text x={lx} y={ly + dy} textAnchor={anch}
                    fill={isSel ? col : "rgba(195,210,238,.76)"}
                    fontFamily="'Rajdhani',sans-serif"
                    fontSize={mobile ? "8" : "10"} fontWeight={isSel ? "600" : "400"} letterSpacing=".06em"
                    style={{ pointerEvents: "none", userSelect: "none", transition: "fill .3s" }}>
                    {n.name}
                  </text>
                </g>
              );
            })}
          </svg>

          {/* node detail card */}
          {sel && (
            <div style={{ position: "absolute", bottom: 10, left: 8, right: 8, background: "rgba(5,6,18,.96)", border: `1px solid ${nCol(sel)}30`, borderRadius: 10, padding: "12px 15px", maxHeight: mobile ? "128px" : "200px", overflowY: "auto", backdropFilter: "blur(18px)", boxShadow: `0 0 28px ${nCol(sel)}12` }}>
              <div onClick={() => setSel(null)} style={{ position: "absolute", top: 7, right: 11, color: "rgba(150,110,255,.4)", cursor: "pointer", fontSize: "17px", lineHeight: 1 }}>×</div>
              <div style={{ color: nCol(sel), fontFamily: "'Rajdhani',sans-serif", fontSize: mobile ? "9.5px" : "11px", fontWeight: 500, letterSpacing: ".22em", marginBottom: 6 }}>{sel.full}</div>
              {sel.absorbed_at && (
                <div style={{ color: "rgba(150,110,255,.35)", fontFamily: "'Rajdhani',sans-serif", fontSize: "9px", letterSpacing: ".15em", marginBottom: 7 }}>
                  {new Date(sel.absorbed_at).toLocaleString()} · {sel.domain || "general"} · complexity {sel.complexity || "?"}/10
                </div>
              )}
              <div style={{ color: "#ddd8f8", fontSize: mobile ? "12px" : "13.5px", lineHeight: "1.56", fontStyle: "italic", marginBottom: 8 }}>"{sel.philosophy}"</div>
              {sel.improvement_intent && (
                <div style={{ color: "rgba(180,155,255,.45)", fontSize: "11.5px", fontStyle: "italic", marginBottom: 8 }}>Next visit: {sel.improvement_intent}</div>
              )}
              <div style={{ color: "rgba(150,110,255,.5)", fontFamily: "'Rajdhani',sans-serif", fontSize: "9.5px", letterSpacing: ".2em", marginBottom: 5, fontWeight: 500 }}>CODE CHANGES APPLIED</div>
              {(sel.changes || []).map((c, i) => (
                <div key={i} style={{ color: "rgba(195,185,238,.5)", fontSize: "11px", marginBottom: 3, lineHeight: "1.45" }}>· {c}</div>
              ))}
            </div>
          )}
        </div>

        {/* ══ CHAT PANEL ══ */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", height: mobile ? `calc(100vh - ${mapH}px)` : "100vh", background: "rgba(4,5,14,.99)", overflow: "hidden", minWidth: 0 }}>

          {/* header */}
          <div style={{ padding: mobile ? "10px 15px" : "13px 22px", borderBottom: "1px solid rgba(95,55,170,.15)", flexShrink: 0, display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#cc44ff", boxShadow: "0 0 10px rgba(195,55,255,.65)", animation: "pulse 2.8s ease-in-out infinite" }} />
            <span style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: mobile ? "10.5px" : "12.5px", fontWeight: 500, letterSpacing: ".3em", color: "rgba(160,120,255,.62)" }}>DISCOURSE WITH SCHOLAR</span>
            <div style={{ marginLeft: "auto", fontFamily: "'Rajdhani',sans-serif", fontSize: "10px", letterSpacing: ".15em", color: BACKEND_URL && wsStatus === "live" ? "rgba(80,200,100,.45)" : "rgba(160,120,255,.3)" }}>
              {BACKEND_URL && wsStatus === "live" ? "● BACKEND LIVE" : "◌ STANDALONE"}
            </div>
          </div>

          {/* ingest bar */}
          <div style={{ padding: mobile ? "8px 12px" : "9px 18px", borderBottom: "1px solid rgba(95,55,170,.09)", display: "flex", gap: 7, flexShrink: 0 }}>
            <input className="url-in" placeholder="github.com/owner/repo — ingest any repository"
              value={ingestUrl} onChange={e => setIngestUrl(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") ingest(); }}
            />
            <button className="ingest-btn" onClick={ingest} disabled={ingesting || !ingestUrl.trim()}>
              {ingesting ? "READING…" : "INGEST"}
            </button>
          </div>

          {/* messages */}
          <div className="cs" style={{ flex: 1, overflowY: "auto", padding: mobile ? "11px 13px" : "15px 22px", display: "flex", flexDirection: "column", gap: 12 }}>
            {msgs.map((m, i) => (
              <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
                <div style={{ maxWidth: "88%", padding: m.role === "user" ? "8px 14px" : "11px 16px", background: m.role === "user" ? "rgba(95,45,170,.13)" : "rgba(255,255,255,.02)", border: m.role === "user" ? "1px solid rgba(120,75,200,.32)" : "1px solid rgba(95,55,170,.1)", borderRadius: m.role === "user" ? "10px 10px 2px 10px" : "10px 10px 10px 2px", color: m.role === "user" ? "#cbb6f8" : "#ddd8f8", fontSize: mobile ? "13px" : "14.5px", lineHeight: "1.7", fontStyle: m.role === "assistant" ? "italic" : "normal" }}>
                  {m.content}
                </div>
              </div>
            ))}
            {loading && (
              <div style={{ display: "flex" }}>
                <div style={{ padding: "10px 16px", background: "rgba(255,255,255,.02)", border: "1px solid rgba(95,55,170,.1)", borderRadius: "10px 10px 10px 2px", color: "rgba(145,105,255,.4)", fontSize: mobile ? "12px" : "13.5px", fontStyle: "italic" }}>Scholar is composing a thought…</div>
              </div>
            )}
            <div ref={chatEnd} />
          </div>

          {/* input */}
          <div style={{ padding: mobile ? "10px 12px" : "12px 18px", borderTop: "1px solid rgba(95,55,170,.13)", display: "flex", gap: 8, flexShrink: 0, alignItems: "flex-end" }}>
            <textarea className="si" rows={2} placeholder="Address Scholar…"
              value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            />
            <button className="sb" onClick={send} disabled={loading || !input.trim()}>SEND</button>
          </div>

          <div style={{ textAlign: "center", padding: "3px 0 7px", color: "rgba(95,55,170,.2)", fontFamily: "'Cormorant Garamond',serif", fontSize: "9.5px", fontStyle: "italic", letterSpacing: ".15em", flexShrink: 0 }}>a scholar never ceases to learn</div>
        </div>

      </div>
    </React.Fragment>
  );
}
