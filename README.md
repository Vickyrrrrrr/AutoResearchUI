# AutoResearchUI

**Local-first observability dashboard for agentic research loops.**

AutoResearchUI is an open-source sidecar application that gives your AI-driven research loop a dedicated real-time interface. It watches your research repository, streams live metrics, tracks experiment outcomes, shows code diffs, monitors hardware, and lets you review and compare runs over time — all without touching your existing research code.

---

## What Is an "Agentic Research Loop"?

An agentic research loop is a pattern popularised by Andrej Karpathy where a language model autonomously runs experiments:

1. **The agent reads `program.md`** — a file describing the research goal and current plan
2. **The agent edits `train.py`** (or equivalent) — modifying hyperparameters, architecture, or training logic
3. **The agent runs the experiment** — `uv run train.py > run.log 2>&1`
4. **The experiment writes results** — metrics appended to `results.tsv` or similar
5. **The agent evaluates** — if the metric improved, the code change is committed ("ratchet"); if not, it is discarded
6. **The loop repeats** — the agent proposes the next hypothesis and edits the code again

This process can run for hours or days. AutoResearchUI makes that process *visible* — showing you exactly what the agent is doing, what metrics it is achieving, and what code it is writing, all streamed live to a browser dashboard.

---

## What AutoResearchUI Is Not

- It is **not** an agent itself. It observes agents, it does not replace them.
- It does **not** modify your research repo. It only reads files and watches for changes.
- It is **not** a hosted service. It runs entirely on your local machine.
- It does **not** require changes to your research code. Point it at an existing repo and start watching.

---

## Key Concepts

| Concept | What It Means |
|---------|--------------|
| **Project Root** | The directory of your research repo — the folder AutoResearchUI watches |
| **Script to Watch** | The file the agent edits most (usually `train.py`) — diffs are tracked against this file |
| **Log File** | The structured metrics file the experiment writes to (CSV, TSV, JSONL, JSON) |
| **Primary Metric** | The column from the log file to visualize — e.g. `val_bpb`, `loss`, `accuracy` |
| **Optimization Goal** | Whether lower (`minimize`) or higher (`maximize`) is better |
| **Research Command** | The shell command that runs one full experiment — e.g. `uv run train.py > run.log 2>&1` |
| **Session** | One continuous monitoring session. Sessions are stored in SQLite and can be compared later. |
| **Ratchet** | An experiment result labeled `KEPT` — a commit that improved the best metric |

---

## Features

### Core Monitoring
- Real-time metric chart with WebSocket streaming (no page refresh needed)
- Experiment feed showing `KEPT`, `DISCARDED`, and `INFO` outcomes
- Side-by-side code diff viewer for the watched script
- Live stdout / stderr terminal panel
- Process lifecycle controls: Start, Stop, Restart

### Multi-Run Benchmarking
- Every session is persisted to a local SQLite database (`autoresearch.db`)
- Load any previous session as a **baseline** from the sidebar
- The chart overlays current run vs. baseline with a dashed line
- A banner shows `IMPROVED +X%` or `REGRESSED -X%` compared to the baseline best

### Git Ratchet Timeline
- The **Timeline** view shows a chart of best metric per commit across the last 30 commits
- Each commit is labeled with the best metric it achieved and how many iterations ran at that point
- A **Rollback** button on each commit lets you instantly revert the repo to any prior state (uses `git checkout`, puts repo in detached HEAD)

### Agent Plan Tracker
- If the research repo contains a `program.md` (or readme with checkboxes), AutoResearchUI parses it
- The right sidebar shows the agent's current plan as a checklist, with completed items crossed out
- Helps you track whether the agent is following its intended research protocol

### GPU & Hardware Monitoring
- Polls `nvidia-smi` every 5 seconds (silently skipped if no NVIDIA GPU is detected)
- Right sidebar shows per-GPU: utilization, VRAM used/total, temperature, power draw
- Progress bars update in real time during active training runs

### AI Research Assistant
- The **Activity** view includes an "Ask AI" panel backed by [Ollama](https://ollama.ai)
- Sends recent experiment context (metrics, hypotheses, outcomes) to a local LLM
- Returns a natural-language explanation of why experiments succeeded or failed
- Works with any model available in your local Ollama installation (default: `llama3.2`)

### Export
- **`.md`** — Markdown research summary with experiment table and best metric
- **`.html`** — Standalone interactive HTML with a Chart.js chart, experiment table, and GPU info; zero external dependencies, sharable as a single file
- **`.svg`** — Raw SVG of the metric chart for embedding in papers or notebooks

---

## The Dashboard

AutoResearchUI has five views, accessible from the left sidebar:

### Overview
The primary monitoring screen.

- **4 KPI cards** at the top: Current Metric, Best Metric, Total Experiments, Keep Rate
- **Baseline comparison banner** when a prior session is loaded for comparison
- **Live metric chart** — blue line for current run, dashed gray line for baseline
- **Experiment records table** — every iteration with status badge, metric value, and truncated hypothesis
- **Right panel** — GPU stats, recent git commits, agent plan checklist, process status

### Git Timeline
Track how the best metric has evolved across git commits.

- Line chart with commits on the X axis and best metric on the Y axis
- Per-commit metadata: short SHA, commit message, date, best metric reached, iteration count
- Hover on any row and a **Rollback** button appears — instantly reverts to that commit

### Run History
Browse and compare previous research sessions.

- Session list showing metric name, optimization goal, project path, and start time
- Click any session to see its best metric, experiment count, and outcome log
- Use the sidebar **Baseline Session** selector to overlay any past session on the Overview chart

### Activity
Detailed per-iteration logs and terminal output.

- **Hypothesis feed** — every experiment's hypothesis, status badge, metric value, and timestamp
- **Terminal panel** — live stdout/stderr stream in a dark terminal window
- **AI Research Assistant** — natural-language analysis of your run via Ollama

### Code Diff
Side-by-side diff of the watched script.

- Shows the before/after state of the file the agent is editing
- Linked to the latest Git commit when one is detected
- Updates in real time as the agent modifies the file

---

## Installation

### Requirements

| Dependency | Minimum Version |
|------------|----------------|
| Python | 3.10 |
| Node.js | 18 |
| npm | 9 |
| Git | any (required for timeline and rollback features) |

Optional for full feature set:

| Optional | Purpose |
|----------|---------|
| NVIDIA GPU + `nvidia-smi` | GPU monitoring panel |
| [Ollama](https://ollama.ai) | AI Research Assistant |

### Step 1 — Clone AutoResearchUI

```bash
git clone https://github.com/your-org/AutoResearchUI.git
cd AutoResearchUI
```

### Step 2 — Install Python Package

```bash
python -m pip install -e .
```

This installs the `autoresearchui` CLI command globally into your Python environment.

### Step 3 — Install Frontend Dependencies

```bash
npm install
```

That is everything. AutoResearchUI is now ready to use.

---

## Quick Start

Open a terminal in **your research repository** (not the AutoResearchUI folder):

```bash
cd /path/to/your-research-repo
autoresearchui
```

AutoResearchUI will:

1. Detect your Git repository
2. Scan for likely script files, log files, and metric columns
3. Auto-map the configuration (or prompt you if `--interactive-mapping` is set)
4. Start the FastAPI backend on `http://127.0.0.1:8000`
5. Start the Next.js dashboard on `http://127.0.0.1:3000`
6. Open your browser automatically

The entire process takes about 5–10 seconds on first start (Next.js build), then under 2 seconds on subsequent starts.

---

## Configuration Walkthrough

When you open the dashboard, you will see a dark sidebar on the left. If the mapping was not fully auto-detected, expand the **Configuration** section to set:

| Field | What to Enter |
|-------|--------------|
| **Workspace** | Path to your research repo root. Click the folder icon to scan. |
| **Target Script** | The `.py` file the agent edits — usually `train.py`. |
| **Log File** | The metrics file — usually `results.tsv`, `results.csv`, or a `.jsonl` file. |
| **Primary Metric** | The column to plot — e.g. `val_bpb`, `loss`, `accuracy`, `reward`. |
| **Optimization** | `Min` if lower is better (loss, BPB), `Max` if higher is better (accuracy, reward). |
| **Runtime Command** | The shell command that runs one experiment. |

Click **Apply Configuration** to activate the mapping and begin tracking.

To start the research loop from the UI, click **Start** in the top header bar.

---

## Karpathy-Style `autoresearch` Repo

If your repo follows the canonical [`autoresearch`](https://github.com/karpathy/autoresearch) layout:

```
research-repo/
├── train.py          # Model, optimizer, main loop — the file the agent edits
├── prepare.py        # Data prep, constants, evaluation helpers — rarely touched
├── program.md        # Agent instructions, research goal, expected output files
├── pyproject.toml    # Dependencies
├── results.tsv       # Appended by each experiment: iteration, metric, hypothesis, status
└── run.log           # Raw stdout from each run
```

AutoResearchUI will auto-detect this layout and suggest:

- `train.py` as **Script to Watch**
- `results.tsv` as **Log File**
- `val_bpb`, `loss`, or whichever metric column it finds as **Primary Metric**
- `minimize` as **Optimization Goal** (for loss-style metrics)
- `uv run train.py > run.log 2>&1` as **Runtime Command** (if found in `program.md`)

It also parses `program.md` for `- [ ]` / `- [x]` checkbox lines and displays them in the sidebar as the **Agent Plan** checklist.

Expected `results.tsv` format:

```tsv
iteration	timestamp	val_bpb	train_loss	hypothesis	status
1	2026-03-12T09:00:00Z	1.42	1.51	try wider hidden layer	KEPT
2	2026-03-12T09:04:00Z	1.31	1.39	raise learning rate	KEPT
3	2026-03-12T09:08:00Z	1.35	1.41	add weight decay	DISCARDED
```

---

## Supported Log Formats

AutoResearchUI reads structured experiment logs incrementally — only new lines are parsed on each update, so large logs never cause slowdowns.

### CSV

```csv
iteration,timestamp,loss,accuracy,hypothesis,status
1,2026-03-12T09:00:00Z,1.42,0.55,"try wider hidden layer",KEPT
2,2026-03-12T09:04:00Z,1.31,0.58,"raise learning rate slightly",KEPT
```

### TSV

Same as CSV but tab-separated. The most common format for `autoresearch`-style repos.

```tsv
iteration	timestamp	val_bpb	status	hypothesis
1	2026-03-12T09:00:00Z	1.42	KEPT	try wider hidden layer
```

### JSON Lines (`.jsonl` / `.ndjson`)

One JSON object per line, each object being one experiment row.

```jsonl
{"iteration": 1, "timestamp": "2026-03-12T09:00:00Z", "bpb": 1.42, "hypothesis": "wider layer", "status": "KEPT"}
{"iteration": 2, "timestamp": "2026-03-12T09:04:00Z", "bpb": 1.31, "hypothesis": "higher lr", "status": "KEPT"}
```

### Plain JSON

A JSON array of objects where each object is one experiment row.

```json
[
  {"iteration": 1, "loss": 1.42, "status": "KEPT"},
  {"iteration": 2, "loss": 1.31, "status": "KEPT"}
]
```

**Recommended columns** (flexible — only `iteration` or a numeric metric column is strictly required):

| Column | Type | Purpose |
|--------|------|---------|
| `iteration` | integer | Row number / experiment index |
| `timestamp` | ISO 8601 string | When this experiment completed |
| `val_bpb` / `loss` / `accuracy` / ... | float | The primary optimization metric |
| `hypothesis` | string | Agent's reasoning for this change |
| `status` | `KEPT` \| `DISCARDED` \| `INFO` | Whether the result was accepted |

---

## CLI Reference

```
autoresearchui [OPTIONS]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--project-root PATH` | current Git repo | Path to the research repo to monitor |
| `--interactive-mapping` | off | Prompt for script, log, metric, goal, and command in the terminal before starting |
| `--non-interactive` | on | Accept auto-detected mapping without prompting (this is the default) |
| `--no-open-browser` | off | Do not automatically open the dashboard in a browser |
| `--backend-only` | off | Start only the FastAPI backend (port 8000); skip the Next.js frontend |
| `--frontend-only` | off | Start only the Next.js frontend (port 3000); expect an external backend |
| `--skip-install` | off | Do not auto-install missing Python or npm dependencies |
| `--bootstrap-project` | off | Attempt to install the dependencies of the detected target research repo |
| `--backend-host HOST` | `127.0.0.1` | Host for the backend server |
| `--backend-port PORT` | `8000` | Port for the backend server |
| `--frontend-host HOST` | `127.0.0.1` | Host for the frontend server |
| `--frontend-port PORT` | `3000` | Port for the frontend server |

### Common Usage Patterns

**Standard — point at the current directory:**
```bash
cd /path/to/your-research-repo
autoresearchui
```

**Explicit path — point at a different repo:**
```bash
autoresearchui --project-root /path/to/research-repo
```

**Interactive mode — choose every mapping field via terminal prompts:**
```bash
autoresearchui --interactive-mapping
```

**Headless / CI — start without opening a browser:**
```bash
autoresearchui --no-open-browser
```

**Backend only — useful when the frontend is already running:**
```bash
autoresearchui --backend-only
```

---

## Multi-Run Benchmarking

Every time you start AutoResearchUI and run experiments, the session is saved to `autoresearch.db` (a local SQLite file in the AutoResearchUI folder).

**To compare a current run against a past session:**

1. Open **Configuration** in the left sidebar
2. Under **Baseline Session**, select any previous session from the dropdown
3. Return to **Overview** — the chart now shows both runs, with a difference banner

The banner reads:
- `IMPROVED +X%` in green if the current best is better than the baseline best
- `REGRESSED -X%` in red if the current run performs worse

Baselines are session-scoped — they do not affect your research repo in any way.

---

## Git Timeline and Rollback

The **Git Timeline** view (`GitBranch` icon in the sidebar) shows how your best metric evolved commit-by-commit.

**How it works:**

AutoResearchUI correlates the metric data stored in SQLite with Git commit history. For each commit, it finds the best metric value recorded while that commit was the `HEAD` of the branch.

**To use Rollback:**

1. Go to the **Git Timeline** view
2. Hover over any commit row
3. Click the **Rollback** button that appears
4. Confirm the dialog

This runs `git checkout <sha>` on your research repo, putting it in detached HEAD state at that commit. Your working tree will match the state of the code at that point. From there you can branch or continue experimenting.

> **Note:** Rollback does not delete any commits. It is non-destructive. You can return to `HEAD` at any time with `git checkout main` (or whatever your branch is called).

---

## GPU Monitoring

If an NVIDIA GPU is present, AutoResearchUI polls `nvidia-smi` every 5 seconds and shows:

- GPU name and index
- Utilization percentage (progress bar)
- VRAM used and total (progress bar, shown in GB)
- Temperature in Celsius
- Power draw in Watts

The GPU panel only appears when at least one NVIDIA GPU is detected. On systems without `nvidia-smi` (AMD, Apple Silicon, CPU-only), the panel is silently hidden.

---

## AI Research Assistant

The **Activity** view includes an AI panel backed by [Ollama](https://ollama.ai) running locally.

**To use it:**

1. Install Ollama: https://ollama.ai
2. Pull a model: `ollama pull llama3.2`
3. Ensure Ollama is running: `ollama serve`
4. In the Activity view, set the **Model** input to your model name (default: `llama3.2`)
5. Click **Ask AI**

AutoResearchUI sends the last 10 experiment outcomes (hypothesis, metric value, status) to the model and asks it to explain what is working, what is not, and what to try next.

You can use any model available in Ollama — `llama3.1`, `mistral`, `gemma2`, `phi3`, etc. Larger models give better analysis.

---

## Export

Three export formats are available from the header bar on any view:

| Button | Output | Contents |
|--------|--------|----------|
| `.md` | `research_summary.md` | Markdown file with project info, best metric, and full experiment table |
| `.html` | `research_summary.html` | Standalone HTML with an interactive Chart.js chart, experiment table, and GPU info — no internet required |
| `.svg` | `autoresearchui-<metric>-graph.svg` | SVG image of the current metric chart — suitable for papers, notebooks, or reports |

---

## Architecture

```
AutoResearchUI/
├── app_backend.py          FastAPI server — WebSocket streaming, file watching, log parsing,
│                           subprocess management, SQLite persistence, Git integration
├── autoresearchui_cli.py   CLI launcher — repo detection, auto-mapping, service orchestration
├── Dashboard.tsx           Next.js client component — the full dashboard UI
├── ProjectConfig.ts        Shared TypeScript type definitions
├── app/
│   ├── page.tsx            Next.js page (re-exports Dashboard)
│   ├── layout.tsx          Root layout
│   └── globals.css         Global styles
├── autoresearch.db         SQLite database (created at runtime, stores sessions/experiments)
├── pyproject.toml          Python package manifest
└── package.json            Node.js package manifest
```

### Data Flow

```
Your Research Repo
       │
       │  file events (watchdog)
       │  git history (GitPython)
       ▼
app_backend.py  ──── WebSocket ────►  Dashboard.tsx
       │                               (browser)
       │  SQLite (autoresearch.db)
       │  nvidia-smi subprocess
       │  Ollama HTTP (optional)
       ▼
 /api/* REST endpoints
```

### All API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Service health, config status, watcher state |
| `GET` | `/api/state` | Full application snapshot (config, metrics, experiments, diff, stdout) |
| `GET` | `/api/discovery` | Scan project root for scripts, logs, metrics, commits, plan |
| `POST` | `/api/config` | Apply a new mapping configuration |
| `POST` | `/api/process/start` | Start the research command |
| `POST` | `/api/process/stop` | Stop the research command |
| `POST` | `/api/process/restart` | Restart the research command |
| `WS` | `/ws` | WebSocket stream — pushes `AppSnapshot` on every file change |
| `GET` | `/api/sessions` | List all past sessions from SQLite |
| `GET` | `/api/sessions/{id}` | Metric points and experiments for a specific session |
| `GET` | `/api/git/timeline` | Best metric per commit for the last 30 commits |
| `POST` | `/api/git/rollback?sha=<sha>` | `git checkout <sha>` on the project root |
| `GET` | `/api/export/markdown` | Download `research_summary.md` |
| `GET` | `/api/export/html` | Download standalone `research_summary.html` |
| `GET` | `/api/gpu` | Current GPU stats from `nvidia-smi` |
| `POST` | `/api/llm/analyze?model=<name>` | Analyze experiments with a local Ollama model |

---

## Development

Run the services individually during development:

**Backend:**
```bash
uvicorn app_backend:app --reload --host 127.0.0.1 --port 8000
```

**Frontend:**
```bash
npm run dev
```

Open `http://127.0.0.1:3000` in your browser.

**Type-check the frontend:**
```bash
npx tsc --noEmit
```

**Syntax-check the backend:**
```bash
python -m py_compile app_backend.py
```

**Run tests:**
```bash
python -m pytest tests/
```

---

## Troubleshooting

**"Failed to load backend state" on first load**

The backend is not yet running. Make sure `uvicorn` or `autoresearchui` started successfully. Check that port 8000 is free: `netstat -an | grep 8000`.

**The chart shows no data**

The log file has not been written yet, or the mapping points to the wrong file. Open the sidebar, verify `Log File` points to the correct path, and check that `Primary Metric` matches a column in that file. Use `--interactive-mapping` to review these in the terminal.

**Diff view is empty**

Diff tracking requires a Git repository. Make sure the project root is inside a Git repo and at least one commit exists.

**GPU panel does not appear**

NVIDIA GPU monitoring requires `nvidia-smi` to be on the system PATH. On non-NVIDIA systems (AMD, Apple Silicon, CPU-only), the panel is intentionally hidden.

**AI Assistant returns "LLM unavailable"**

Check that Ollama is installed and running (`ollama serve`). The model must be pulled first (`ollama pull llama3.2`). The endpoint defaults to `http://localhost:11434`.

**The frontend takes a long time on first start**

Next.js compiles the frontend on the first run. This is a one-time step that takes 15–30 seconds. Subsequent starts are fast.

---

## Trust and Safety

AutoResearchUI is a local-only tool. It does not send data to any external service except Ollama (which also runs locally).

- The backend only watches files within the configured project root
- Process start requires a Git repository to be present (safety gate against accidental execution)
- WebSocket connections are origin-restricted to `127.0.0.1` and `localhost` by default
- SQLite data stays on your machine in `autoresearch.db`
- Rollback operations only run `git checkout` — they never delete branches or commits

---

## License

Released under the MIT License. See [LICENSE](LICENSE).
