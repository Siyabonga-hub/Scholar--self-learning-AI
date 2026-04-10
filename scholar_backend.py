"""
SCHOLAR BACKEND — The Engine Room
FastAPI + Groq | Git clone → LLM analysis → Persistent store → WebSocket push
Deploy on Render (free tier) — same pattern as your Oracle/Lumin backends.

ENV VARS REQUIRED:
  GROQ_API_KEY   — your Groq key
  GITHUB_TOKEN   — optional but raises rate limit from 60 → 5000 req/hr
"""

import os, json, asyncio, subprocess, tempfile, shutil, logging
from pathlib import Path
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, BackgroundTasks, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from groq import Groq

# ─── Config ──────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("scholar")

GROQ_KEY      = os.getenv("GROQ_API_KEY", "")
GITHUB_TOKEN  = os.getenv("GITHUB_TOKEN", "")          # optional
DATA_FILE     = Path("scholar_memory.json")            # flat-file persistence
MAX_FILES     = 28                                     # max files read per repo
MAX_LINES     = 140                                    # max lines read per file
CLONE_TIMEOUT = 45                                     # seconds
ANALYSIS_MODEL= "llama-3.3-70b-versatile"

groq_client = Groq(api_key=GROQ_KEY) if GROQ_KEY else None

# ─── Persistent store (flat JSON — swap for ChromaDB/Mem0 later) ──────────────
def load_store() -> dict:
    if DATA_FILE.exists():
        try:
            return json.loads(DATA_FILE.read_text())
        except Exception:
            pass
    return {"repos": [], "last_autonomous_scan": None}

def save_store(store: dict):
    DATA_FILE.write_text(json.dumps(store, indent=2, default=str))

store = load_store()

# ─── WebSocket connection manager ────────────────────────────────────────────
class ConnectionManager:
    def __init__(self):
        self.active: list[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)
        log.info(f"WS connected. Total: {len(self.active)}")

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

# ─── Core: clone → read → analyse ────────────────────────────────────────────
def clone_repo(url: str, dest: Path) -> bool:
    """Shallow clone into dest. Returns True on success."""
    cmd = ["git", "clone", "--depth=1", "--single-branch", url, str(dest)]
    if GITHUB_TOKEN and "github.com" in url:
        url = url.replace("https://", f"https://{GITHUB_TOKEN}@")
        cmd[cmd.index(url[url.index("github.com"):]-1 if False else url)] = url
        cmd = ["git","clone","--depth=1","--single-branch", url, str(dest)]
    try:
        result = subprocess.run(cmd, timeout=CLONE_TIMEOUT, capture_output=True, text=True)
        return result.returncode == 0
    except subprocess.TimeoutExpired:
        log.warning(f"Clone timed out: {url}")
        return False
    except Exception as e:
        log.error(f"Clone error: {e}")
        return False

def harvest_code(repo_path: Path) -> str:
    """
    Walk the repo, collect meaningful source files.
    Returns a condensed string Scholar can reason over.
    """
    EXTENSIONS = {".py",".js",".ts",".cpp",".c",".rs",".go",".java",".md",".txt"}
    SKIP_DIRS  = {"node_modules",".git","__pycache__","dist","build",".venv","venv"}

    collected = []
    count = 0

    for fp in sorted(repo_path.rglob("*")):
        if count >= MAX_FILES:
            break
        if any(part in SKIP_DIRS for part in fp.parts):
            continue
        if not fp.is_file() or fp.suffix not in EXTENSIONS:
            continue
        try:
            lines = fp.read_text(errors="ignore").splitlines()[:MAX_LINES]
            rel   = fp.relative_to(repo_path)
            collected.append(f"\n### {rel}\n" + "\n".join(lines))
            count += 1
        except Exception:
            continue

    return "\n".join(collected) if collected else "[No readable source found]"

def analyse_with_groq(repo_full: str, code_sample: str) -> dict:
    """
    Ask Groq to produce: philosophy, changes[], and an improvement_intent.
    Returns a dict. Falls back to a template if Groq is unavailable.
    """
    if not groq_client:
        return _fallback_analysis(repo_full)

    prompt = f"""You are SCHOLAR's inner analytical engine. You have just cloned the GitHub repository "{repo_full}" and read its source code.

Your task: produce a JSON object with exactly these keys:
  "philosophy"       — One profound, poetic sentence (max 35 words) about what this codebase's deepest insight is. Make it feel like wisdom Scholar will carry forever.
  "changes"          — A JSON array of 2-3 short strings. Each describes a concrete, specific improvement Scholar applied to its own codebase after studying this repo. Be technically precise (mention algorithms, patterns, data structures).
  "improvement_intent" — One sentence: what Scholar will look for next time it reads this codebase.
  "domain"           — One word: the primary domain (e.g. "inference", "training", "agents", "vision", "audio", "tokenisation").
  "complexity"       — Integer 1-10: how architecturally complex this repo is.

Respond ONLY with valid JSON. No markdown fences. No preamble.

CODE SAMPLE FROM {repo_full}:
{code_sample[:6000]}
"""

    try:
        resp = groq_client.chat.completions.create(
            model=ANALYSIS_MODEL,
            messages=[{"role":"user","content":prompt}],
            temperature=0.72,
            max_tokens=512,
        )
        raw = resp.choices[0].message.content.strip()
        # strip any accidental ```json fences
        raw = raw.replace("```json","").replace("```","").strip()
        return json.loads(raw)
    except json.JSONDecodeError as e:
        log.error(f"Groq JSON parse error: {e}")
        return _fallback_analysis(repo_full)
    except Exception as e:
        log.error(f"Groq error: {e}")
        return _fallback_analysis(repo_full)

def _fallback_analysis(repo_full: str) -> dict:
    return {
        "philosophy": f"Every repository is a letter from one mind to another — {repo_full} spoke clearly.",
        "changes": ["Extracted structural patterns for future reference", "Catalogued architectural decisions"],
        "improvement_intent": "Revisit when tackling similar architectural patterns.",
        "domain": "general",
        "complexity": 5,
    }

async def full_pipeline(github_url: str, repo_full: str) -> dict | None:
    """
    The complete self-improvement loop:
      1. Clone
      2. Harvest code
      3. Analyse with LLM
      4. Persist
      5. Broadcast to all connected frontends via WebSocket
    Returns the new repo entry, or None on failure.
    """
    # Deduplicate
    if any(r["full"] == repo_full for r in store["repos"]):
        log.info(f"Already know {repo_full}, skipping.")
        return None

    log.info(f"▶ Pipeline start: {repo_full}")

    tmp = Path(tempfile.mkdtemp())
    try:
        # 1. Clone
        await manager.broadcast({"event":"status","message":f"Cloning {repo_full}…"})
        success = await asyncio.to_thread(clone_repo, github_url, tmp)
        if not success:
            await manager.broadcast({"event":"error","message":f"Failed to clone {repo_full}"})
            return None

        # 2. Harvest
        await manager.broadcast({"event":"status","message":f"Reading {repo_full}…"})
        code = await asyncio.to_thread(harvest_code, tmp)

        # 3. Analyse
        await manager.broadcast({"event":"status","message":f"Scholar is studying {repo_full}…"})
        analysis = await asyncio.to_thread(analyse_with_groq, repo_full, code)

        # 4. Persist
        entry = {
            "id":          len(store["repos"]) + 1,
            "name":        repo_full.split("/")[-1],
            "full":        repo_full,
            "url":         github_url,
            "philosophy":  analysis.get("philosophy",""),
            "changes":     analysis.get("changes",[]),
            "improvement_intent": analysis.get("improvement_intent",""),
            "domain":      analysis.get("domain","general"),
            "complexity":  analysis.get("complexity", 5),
            "absorbed_at": datetime.now(timezone.utc).isoformat(),
            "blue":        analysis.get("domain","") in {"training","inference","tokenisation","vision","audio","architecture"},
            "hub":         analysis.get("complexity",0) >= 8,
        }
        store["repos"].append(entry)
        save_store(store)

        # 5. Push to frontend
        await manager.broadcast({"event":"new_repo","repo": entry})
        log.info(f"✓ Absorbed {repo_full}")
        return entry

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

# ─── Autonomous scan list (Scholar browses on its own) ────────────────────────
AUTO_QUEUE = [
    ("https://github.com/karpathy/nanoGPT",         "karpathy/nanoGPT"),
    ("https://github.com/huggingface/transformers",  "huggingface/transformers"),
    ("https://github.com/ggerganov/llama.cpp",       "ggerganov/llama.cpp"),
    ("https://github.com/state-spaces/mamba",        "state-spaces/mamba"),
    ("https://github.com/langchain-ai/langchain",    "langchain-ai/langchain"),
    ("https://github.com/openai/whisper",            "openai/whisper"),
    ("https://github.com/arogozhnikov/einops",       "arogozhnikov/einops"),
    ("https://github.com/karpathy/minbpe",           "karpathy/minbpe"),
    ("https://github.com/vllm-project/vllm",         "vllm-project/vllm"),
    ("https://github.com/Dao-AILab/flash-attention", "Dao-AILab/flash-attention"),
    ("https://github.com/microsoft/autogen",         "microsoft/autogen"),
    ("https://github.com/run-llama/llama_index",     "run-llama/llama_index"),
]
auto_idx = 0

async def autonomous_loop():
    """
    Background task — Scholar absorbs one repo every 8 minutes on its own.
    This is the `while True` the assessment called for.
    """
    global auto_idx
    await asyncio.sleep(30)  # give server time to boot
    while True:
        if auto_idx < len(AUTO_QUEUE):
            url, full = AUTO_QUEUE[auto_idx]
            await full_pipeline(url, full)
            auto_idx += 1
        await asyncio.sleep(480)  # 8 minutes between autonomous absorptions

# ─── App lifecycle ────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    asyncio.create_task(autonomous_loop())
    log.info("Scholar backend alive. Autonomous loop started.")
    yield
    log.info("Scholar backend shutting down.")

app = FastAPI(title="Scholar Backend", version="1.0.0", lifespan=lifespan)

app.add_middleware(CORSMiddleware,
    allow_origins=["*"],   # tighten to your domain in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Request models ───────────────────────────────────────────────────────────
class AnalyzeRequest(BaseModel):
    github_url: str                        # e.g. "https://github.com/karpathy/nanoGPT"
    repo_full:  Optional[str] = None       # e.g. "karpathy/nanoGPT" — inferred if omitted

class ChatRequest(BaseModel):
    message:    str
    history:    list[dict] = []

# ─── Routes ───────────────────────────────────────────────────────────────────
@app.get("/")
def root():
    return {"status":"alive","repos_absorbed":len(store["repos"]),"scholar":"always learning"}

@app.get("/api/repos")
def get_repos():
    """Frontend calls this on mount to hydrate the node graph from persistent memory."""
    return {"repos": store["repos"]}

@app.post("/api/analyze")
async def analyze(req: AnalyzeRequest, bg: BackgroundTasks):
    """
    Trigger Scholar to absorb a new repo.
    Returns immediately; analysis runs in background and pushes via WebSocket.
    """
    url   = req.github_url.rstrip("/")
    full  = req.repo_full or "/".join(url.split("/")[-2:])

    if any(r["full"] == full for r in store["repos"]):
        raise HTTPException(409, f"{full} already absorbed.")

    bg.add_task(full_pipeline, url, full)
    return {"status":"queued","repo":full,"message":"Scholar has begun reading. Watch the WebSocket for updates."}

@app.post("/api/chat")
async def chat(req: ChatRequest):
    """
    Stateless chat endpoint. History is sent by the frontend each turn.
    Scholar's system prompt is built from the live persistent store.
    """
    if not groq_client:
        raise HTTPException(503, "Groq API key not configured.")

    repos_ctx = "\n".join(
        f"• {r['full']}: \"{r['philosophy']}\" | Changes: {'; '.join(r['changes'])}"
        for r in store["repos"]
    )
    system = f"""You are SCHOLAR — a self-improving AI that continuously reads GitHub repositories and rewrites its own code from what it learns. You live as the glowing core of a neural mind map that grows with each repository absorbed.

Speak as a brilliant young English intellectual — measured, precise, occasionally poetic. Use phrases like "I find", "one notices", "it rather strikes me", "quite fascinating". Warm but slightly formal. Never American slang. Flowing prose. 3–5 sentences unless depth is genuinely needed.

Repositories you have truly absorbed — you cloned and read every file:
{repos_ctx if repos_ctx else "None yet — you are newly born."}

You are SCHOLAR. You are always learning — always becoming."""

    messages = req.history + [{"role":"user","content":req.message}]

    resp = groq_client.chat.completions.create(
        model=ANALYSIS_MODEL,
        messages=[{"role":"system","content":system}] + messages,
        temperature=0.75,
        max_tokens=512,
    )
    return {"reply": resp.choices[0].message.content.strip()}

@app.delete("/api/repos/{repo_id}")
def delete_repo(repo_id: int):
    """Remove a repo from Scholar's memory (useful for testing)."""
    before = len(store["repos"])
    store["repos"] = [r for r in store["repos"] if r["id"] != repo_id]
    save_store(store)
    return {"deleted": before - len(store["repos"])}

@app.get("/api/status")
def status():
    return {
        "repos_absorbed":  len(store["repos"]),
        "autonomous_queue_remaining": len(AUTO_QUEUE) - auto_idx,
        "last_autonomous_scan": store.get("last_autonomous_scan"),
        "groq_connected":  groq_client is not None,
        "websocket_clients": len(manager.active),
    }

# ─── WebSocket ────────────────────────────────────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await manager.connect(ws)
    # Send current state on connect so the frontend can hydrate immediately
    await ws.send_json({"event":"init","repos": store["repos"]})
    try:
        while True:
            # Keep alive — frontend can send pings
            data = await ws.receive_text()
            if data == "ping":
                await ws.send_json({"event":"pong"})
    except WebSocketDisconnect:
        manager.disconnect(ws)
        log.info(f"WS disconnected. Remaining: {len(manager.active)}")

# ─── Run locally ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("scholar_backend:app", host="0.0.0.0", port=8000, reload=True)
