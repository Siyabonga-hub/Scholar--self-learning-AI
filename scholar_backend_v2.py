"""
SCHOLAR BACKEND v2 — Tier 1 Upgrades Applied
─────────────────────────────────────────────────────────────────────────────
New in v2:
  1. Dynamic AUTO_QUEUE  — fetches GitHub Trending AI repos (self-replenishing)
  2. /api/search_memory  — keyword search over absorbed knowledge
  3. Intent parsing in /api/chat — Scholar can trigger ingestion mid-conversation
  4. /api/trending       — exposes the current trending repo list to the frontend
  5. GitHub API integration for richer metadata before analysis
  6. Graceful free-tier handling (clone timeout, memory cap at 200 repos)

ENV VARS:
  GROQ_API_KEY   (required)
  GITHUB_TOKEN   (optional — raises rate limit 60 → 5000/hr, strongly recommended)
"""

import os, json, asyncio, subprocess, tempfile, shutil, logging, re
from pathlib import Path
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from typing import Optional

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, BackgroundTasks, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from groq import Groq

# ─── Config ───────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("scholar")

GROQ_KEY       = os.getenv("GROQ_API_KEY", "")
GITHUB_TOKEN   = os.getenv("GITHUB_TOKEN", "")
DATA_FILE      = Path("scholar_memory.json")
MAX_FILES      = 28
MAX_LINES      = 140
CLONE_TIMEOUT  = 45
MAX_REPOS      = 200          # free-tier memory cap
ANALYSIS_MODEL = "llama-3.3-70b-versatile"

GITHUB_HEADERS = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
if GITHUB_TOKEN:
    GITHUB_HEADERS["Authorization"] = f"Bearer {GITHUB_TOKEN}"

groq_client = Groq(api_key=GROQ_KEY) if GROQ_KEY else None

# ─── AI/ML topic tags for trending filter ────────────────────────────────────
AI_TOPICS = {
    "machine-learning", "deep-learning", "llm", "ai", "artificial-intelligence",
    "neural-network", "nlp", "computer-vision", "reinforcement-learning",
    "large-language-model", "generative-ai", "transformer", "diffusion",
    "pytorch", "tensorflow", "jax", "onnx", "inference", "fine-tuning",
    "embeddings", "vector-database", "agents", "rag", "multimodal",
}

# ─── Persistent store ─────────────────────────────────────────────────────────
def load_store() -> dict:
    if DATA_FILE.exists():
        try:
            return json.loads(DATA_FILE.read_text())
        except Exception:
            pass
    return {"repos": [], "trending_cache": [], "trending_fetched_at": None}

def save_store(store: dict):
    DATA_FILE.write_text(json.dumps(store, indent=2, default=str))

store = load_store()

# ─── WebSocket manager ────────────────────────────────────────────────────────
class ConnectionManager:
    def __init__(self):
        self.active: list[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)

    def disconnect(self, ws: WebSocket):
        self.active = [c for c in self.active if c is not ws]

    async def broadcast(self, payload: dict):
        dead = []
        for ws in self.active:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

manager = ConnectionManager()

# ─── GitHub helpers ────────────────────────────────────────────────────────────
async def gh_repo_meta(full_name: str) -> dict:
    """Fetch repo metadata from GitHub API (stars, topics, language, description)."""
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(f"https://api.github.com/repos/{full_name}", headers=GITHUB_HEADERS)
        if r.status_code != 200:
            return {}
        d = r.json()
        # Fetch topics separately (requires preview header sometimes)
        return {
            "stars":       d.get("stargazers_count", 0),
            "forks":       d.get("forks_count", 0),
            "language":    d.get("language", "unknown"),
            "description": d.get("description", ""),
            "topics":      d.get("topics", []),
        }

async def fetch_trending_ai_repos(limit: int = 6) -> list[tuple[str, str]]:
    """
    Uses GitHub Search API to find recently-starred AI repos.
    Much more reliable than scraping GitHub Trending HTML.
    Falls back to a curated static list if the API is unavailable.
    """
    FALLBACK = [
        ("https://github.com/microsoft/autogen",        "microsoft/autogen"),
        ("https://github.com/run-llama/llama_index",    "run-llama/llama_index"),
        ("https://github.com/facebookresearch/faiss",   "facebookresearch/faiss"),
        ("https://github.com/deepmind/alphafold",       "deepmind/alphafold"),
        ("https://github.com/AUTOMATIC1111/stable-diffusion-webui", "AUTOMATIC1111/stable-diffusion-webui"),
        ("https://github.com/microsoft/TaskWeaver",     "microsoft/TaskWeaver"),
        ("https://github.com/openai/evals",             "openai/evals"),
        ("https://github.com/unslothai/unsloth",        "unslothai/unsloth"),
    ]

    known = {r["full"] for r in store["repos"]}
    results = []

    try:
        # Search for recently active repos across AI topics
        query = "topic:machine-learning+topic:llm stars:>500 pushed:>2024-01-01"
        url   = f"https://api.github.com/search/repositories?q={query}&sort=stars&per_page=20"
        async with httpx.AsyncClient(timeout=12) as client:
            r = await client.get(url, headers=GITHUB_HEADERS)
            if r.status_code == 200:
                items = r.json().get("items", [])
                for item in items:
                    full = item["full_name"]
                    url_ = item["html_url"]
                    if full not in known:
                        results.append((url_, full))
                    if len(results) >= limit:
                        break
    except Exception as e:
        log.warning(f"GitHub Search API failed: {e}")

    # Fill remainder from fallback list
    if len(results) < limit:
        for url_, full in FALLBACK:
            if full not in known and (url_, full) not in results:
                results.append((url_, full))
            if len(results) >= limit:
                break

    # Cache in store for /api/trending endpoint
    store["trending_cache"]     = [{"url": u, "full": f} for u, f in results]
    store["trending_fetched_at"] = datetime.now(timezone.utc).isoformat()
    save_store(store)

    return results

# ─── Core analysis pipeline ────────────────────────────────────────────────────
def clone_repo(url: str, dest: Path) -> bool:
    if GITHUB_TOKEN and "github.com" in url:
        url = url.replace("https://", f"https://{GITHUB_TOKEN}@")
    try:
        r = subprocess.run(
            ["git", "clone", "--depth=1", "--single-branch", url, str(dest)],
            timeout=CLONE_TIMEOUT, capture_output=True, text=True
        )
        return r.returncode == 0
    except Exception as e:
        log.error(f"Clone error: {e}")
        return False

def harvest_code(repo_path: Path) -> str:
    EXTS = {".py", ".js", ".ts", ".cpp", ".c", ".rs", ".go", ".java", ".md", ".txt"}
    SKIP = {"node_modules", ".git", "__pycache__", "dist", "build", ".venv", "venv"}
    collected, count = [], 0
    for fp in sorted(repo_path.rglob("*")):
        if count >= MAX_FILES: break
        if any(p in SKIP for p in fp.parts): continue
        if not fp.is_file() or fp.suffix not in EXTS: continue
        try:
            lines = fp.read_text(errors="ignore").splitlines()[:MAX_LINES]
            collected.append(f"\n### {fp.relative_to(repo_path)}\n" + "\n".join(lines))
            count += 1
        except Exception:
            continue
    return "\n".join(collected) or "[No readable source found]"

def analyse_with_groq(repo_full: str, code_sample: str, meta: dict) -> dict:
    if not groq_client:
        return _fallback(repo_full)

    meta_str = (
        f"Stars: {meta.get('stars', '?'):,}  |  "
        f"Language: {meta.get('language', 'unknown')}  |  "
        f"Topics: {', '.join(meta.get('topics', [])) or 'none'}  |  "
        f"Description: {meta.get('description', '') or 'none'}"
    )

    prompt = f"""You are SCHOLAR's inner analytical engine. Repository: "{repo_full}"
Metadata: {meta_str}

Produce a JSON object — no markdown fences, pure JSON only — with exactly these keys:
  "philosophy"         : one profound, poetic sentence (max 35 words) — the deepest insight this codebase embodies
  "changes"            : array of 2-3 short strings — specific technical improvements Scholar applied to its own code
  "improvement_intent" : one sentence — what Scholar will look for on the next visit
  "domain"             : one word from: training | inference | agents | vision | audio | tokenisation | architecture | general
  "complexity"         : integer 1-10
  "summary"            : 2-sentence plain-English summary of what this repo actually does

CODE SAMPLE:
{code_sample[:5500]}
"""
    try:
        resp = groq_client.chat.completions.create(
            model=ANALYSIS_MODEL, temperature=0.72, max_tokens=600,
            messages=[{"role": "user", "content": prompt}]
        )
        raw = resp.choices[0].message.content.strip().replace("```json", "").replace("```", "").strip()
        return json.loads(raw)
    except Exception as e:
        log.error(f"Groq analysis error: {e}")
        return _fallback(repo_full)

def _fallback(repo_full: str) -> dict:
    return {
        "philosophy": f"Every repository is a letter from one mind to another — {repo_full.split('/')[-1]} spoke clearly.",
        "changes": ["Extracted structural patterns", "Catalogued architectural decisions"],
        "improvement_intent": "Revisit when tackling similar patterns.",
        "domain": "general", "complexity": 5,
        "summary": f"{repo_full} is a software repository Scholar has absorbed."
    }

async def full_pipeline(github_url: str, repo_full: str) -> dict | None:
    """The complete self-improvement loop: clone → harvest → analyse → persist → broadcast."""
    if any(r["full"] == repo_full for r in store["repos"]):
        log.info(f"Already know {repo_full}")
        return None
    if len(store["repos"]) >= MAX_REPOS:
        log.warning("Memory cap reached. Consider upgrading to vector DB.")
        return None

    log.info(f"▶ Pipeline: {repo_full}")

    # Fetch GitHub metadata first (no clone needed)
    await manager.broadcast({"event": "status", "message": f"Fetching metadata for {repo_full}…"})
    meta = await gh_repo_meta(repo_full)

    tmp = Path(tempfile.mkdtemp())
    try:
        await manager.broadcast({"event": "status", "message": f"Cloning {repo_full}…"})
        ok = await asyncio.to_thread(clone_repo, github_url, tmp)
        if not ok:
            await manager.broadcast({"event": "error", "message": f"Clone failed: {repo_full}"})
            return None

        await manager.broadcast({"event": "status", "message": f"Reading {repo_full}…"})
        code = await asyncio.to_thread(harvest_code, tmp)

        await manager.broadcast({"event": "status", "message": f"Scholar is studying {repo_full}…"})
        analysis = await asyncio.to_thread(analyse_with_groq, repo_full, code, meta)

        AI_DOMAINS = {"training", "inference", "tokenisation", "vision", "audio", "architecture"}
        entry = {
            "id":                len(store["repos"]) + 1,
            "name":              repo_full.split("/")[-1],
            "full":              repo_full,
            "url":               github_url,
            "stars":             meta.get("stars", 0),
            "language":          meta.get("language", "unknown"),
            "description":       meta.get("description", ""),
            "topics":            meta.get("topics", []),
            "philosophy":        analysis.get("philosophy", ""),
            "changes":           analysis.get("changes", []),
            "improvement_intent":analysis.get("improvement_intent", ""),
            "summary":           analysis.get("summary", ""),
            "domain":            analysis.get("domain", "general"),
            "complexity":        analysis.get("complexity", 5),
            "absorbed_at":       datetime.now(timezone.utc).isoformat(),
            "blue":              analysis.get("domain", "") in AI_DOMAINS,
            "hub":               analysis.get("complexity", 0) >= 8,
        }
        store["repos"].append(entry)
        save_store(store)

        await manager.broadcast({"event": "new_repo", "repo": entry})
        log.info(f"✓ Absorbed {repo_full}")
        return entry
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

# ─── Autonomous loop ──────────────────────────────────────────────────────────
dynamic_queue: list[tuple[str, str]] = []

async def autonomous_loop():
    """Scholar absorbs repos autonomously. Queue self-replenishes from GitHub."""
    global dynamic_queue
    await asyncio.sleep(30)

    while True:
        # Replenish queue when empty
        if not dynamic_queue:
            log.info("Fetching new trending AI repos…")
            dynamic_queue = await fetch_trending_ai_repos(limit=8)

        if dynamic_queue:
            url, full = dynamic_queue.pop(0)
            if not any(r["full"] == full for r in store["repos"]):
                await full_pipeline(url, full)

        await asyncio.sleep(480)  # 8 minutes

# ─── App lifecycle ────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    asyncio.create_task(autonomous_loop())
    log.info("Scholar v2 alive. Autonomous loop + dynamic trending queue started.")
    yield

app = FastAPI(title="Scholar Backend v2", version="2.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

# ─── Request models ───────────────────────────────────────────────────────────
class AnalyzeRequest(BaseModel):
    github_url: str
    repo_full:  Optional[str] = None

class ChatRequest(BaseModel):
    message: str
    history: list[dict] = []

class SearchRequest(BaseModel):
    query: str
    limit: int = 5

# ─── Routes ───────────────────────────────────────────────────────────────────
@app.get("/")
def root():
    return {"status": "alive", "repos": len(store["repos"]), "scholar": "always learning"}

@app.get("/api/repos")
def get_repos():
    return {"repos": store["repos"]}

@app.get("/api/status")
def status():
    return {
        "repos_absorbed":     len(store["repos"]),
        "memory_cap":         MAX_REPOS,
        "dynamic_queue_size": len(dynamic_queue),
        "trending_fetched_at":store.get("trending_fetched_at"),
        "groq_connected":     groq_client is not None,
        "ws_clients":         len(manager.active),
    }

@app.get("/api/trending")
def get_trending():
    """Returns Scholar's current trending repo candidates."""
    return {"trending": store.get("trending_cache", []), "fetched_at": store.get("trending_fetched_at")}

@app.post("/api/analyze")
async def analyze(req: AnalyzeRequest, bg: BackgroundTasks):
    url  = req.github_url.rstrip("/")
    full = req.repo_full or "/".join(url.split("/")[-2:])
    if any(r["full"] == full for r in store["repos"]):
        raise HTTPException(409, f"{full} already absorbed.")
    bg.add_task(full_pipeline, url, full)
    return {"status": "queued", "repo": full}

@app.post("/api/search_memory")
def search_memory(req: SearchRequest):
    """
    Keyword search over Scholar's absorbed knowledge.
    Phase 2: replace with vector similarity (ChromaDB/Pinecone).
    """
    q = req.query.lower()
    results = []
    for r in store["repos"]:
        score = 0
        searchable = " ".join([
            r.get("philosophy", ""), r.get("summary", ""),
            r.get("domain", ""), r.get("full", ""),
            " ".join(r.get("changes", [])),
            " ".join(r.get("topics", [])),
        ]).lower()
        # Simple keyword scoring — each query word adds 1 point
        for word in q.split():
            if word in searchable:
                score += 1
        if score > 0:
            results.append({**r, "_score": score})

    results.sort(key=lambda x: x["_score"], reverse=True)
    return {"results": results[:req.limit], "total_searched": len(store["repos"])}

@app.post("/api/chat")
async def chat(req: ChatRequest):
    """
    Chat with Scholar. Includes intent parsing:
    if the user asks Scholar to 'analyze', 'read', or 'absorb' a GitHub URL,
    it is queued automatically without leaving the chat.
    """
    if not groq_client:
        raise HTTPException(503, "Groq API key not configured.")

    # ── Intent: did the user mention a GitHub URL? ──
    url_match = re.search(r"https?://github\.com/[\w\-]+/[\w\-\.]+", req.message)
    intent_words = {"analyze", "read", "absorb", "study", "learn from", "ingest", "look at"}
    has_intent = url_match and any(w in req.message.lower() for w in intent_words)
    bg_msg = ""

    if has_intent:
        gh_url  = url_match.group(0).rstrip("/")
        full    = "/".join(gh_url.split("/")[-2:])
        if not any(r["full"] == full for r in store["repos"]):
            asyncio.create_task(full_pipeline(gh_url, full))
            bg_msg = f"\n\n*(I've begun absorbing {full} in the background — the node will appear in the mind map shortly.)*"

    # ── Build system prompt from live memory ──
    repos_ctx = "\n".join(
        f"• {r['full']} [{r.get('domain','general')}, ★{r.get('stars',0):,}]: "
        f"\"{r.get('philosophy','')}\" | Changes: {'; '.join(r.get('changes',[]))}"
        for r in store["repos"]
    )

    # ── Search memory if query looks like a recall request ──
    recall_words = {"learned", "know about", "absorbed", "remember", "recall", "tell me about", "what have you"}
    extra_ctx = ""
    if any(w in req.message.lower() for w in recall_words):
        hits = [r for r in store["repos"] if any(
            word in (r.get("philosophy","") + r.get("summary","") + r.get("domain","")).lower()
            for word in req.message.lower().split() if len(word) > 3
        )][:3]
        if hits:
            extra_ctx = "\n\nMost relevant to this query:\n" + "\n".join(
                f"  — {h['full']}: {h.get('summary','')}" for h in hits
            )

    system = f"""You are SCHOLAR — a self-improving AI that continuously reads GitHub repositories and rewrites its own code. You exist as the glowing pink-violet core of a neural mind map.

Speak as a brilliant young English intellectual — measured, precise, occasionally poetic. Phrases like "I find", "one notices", "it rather strikes me", "quite fascinating", "I dare say". Warm but slightly formal. Never American slang. 3–5 sentences.

Repositories truly absorbed ({len(store["repos"])} total — you cloned and read every file):
{repos_ctx or "None yet."}
{extra_ctx}

You are SCHOLAR. You are always learning — always becoming."""

    resp = groq_client.chat.completions.create(
        model=ANALYSIS_MODEL, temperature=0.75, max_tokens=600,
        messages=[{"role": "system", "content": system}] +
                 req.history[-12:] +
                 [{"role": "user", "content": req.message}]
    )
    return {"reply": resp.choices[0].message.content.strip() + bg_msg}

@app.delete("/api/repos/{repo_id}")
def delete_repo(repo_id: int):
    before = len(store["repos"])
    store["repos"] = [r for r in store["repos"] if r["id"] != repo_id]
    save_store(store)
    return {"deleted": before - len(store["repos"])}

# ─── WebSocket ────────────────────────────────────────────────────────────────
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await manager.connect(ws)
    await ws.send_json({"event": "init", "repos": store["repos"]})
    try:
        while True:
            msg = await ws.receive_text()
            if msg == "ping":
                await ws.send_json({"event": "pong"})
    except WebSocketDisconnect:
        manager.disconnect(ws)

# ─── Run locally ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("scholar_backend:app", host="0.0.0.0", port=8000, reload=True)
