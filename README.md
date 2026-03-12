# AutoResearchUI

Local-first observability for agentic research loops.

AutoResearchUI is an open-source sidecar for research repositories where an agent edits code, runs experiments, logs metrics, and iterates over time. It is inspired by repo-native workflows such as Karpathy's `autoresearch`, but it is intentionally repo-agnostic: no hard-coded script names, no fixed metric assumptions, and no domain lock-in.

The goal is simple: make continuous research improvement visible in real time.

## Overview

AutoResearchUI combines three pieces:

- a FastAPI backend that watches files, tails metrics incrementally, manages the research subprocess, and streams updates over WebSockets
- a Next.js frontend that presents the live metric curve, experiment feed, diff view, stdout, and health state in a polished dashboard
- a CLI launcher that detects the current Git repo, asks the user to map the important files, and starts everything locally

It is designed for researchers, builders, and open-source teams running iterative loops inside their own repositories.

## For First-Time Users

If you are new to this project, the most important thing to understand is that there are two separate repos involved:

- `AutoResearchUI`: the tool you install once
- `your research repo`: the project AutoResearchUI watches

AutoResearchUI does not need to be copied into your research repo.

Instead, the normal model is:

1. clone and install AutoResearchUI once on your machine
2. go into your own research repo
3. run `autoresearchui`

So the tool lives in one folder, and you use it from another folder.

### Beginner Example

First, install AutoResearchUI once:

```powershell
git clone <your-autoresearchui-repo-url>
cd AutoResearchUI
python -m pip install -e .
npm install
```

Then, every time you want to use it on a research repo:

```powershell
cd C:\path\to\your-research-repo
autoresearchui
```

That is the intended beginner workflow.

## Why AutoResearchUI

Research loops usually have good execution and poor visibility.

You can often run the agent, inspect a CSV, watch stdout, and check Git diffs manually. That works for a while, but it breaks down once iterations become frequent and improvement depends on noticing patterns over time.

AutoResearchUI gives that loop a dedicated interface:

- detect the active repo from the current Git working tree
- map repo-specific files instead of assuming a fixed project layout
- stream structured metric updates without reloading the full log file
- show which experiments were kept or discarded
- surface agent reasoning from logs or stdout
- track the watched file diff as the loop evolves
- export the final metric graph when a run completes

## Features

- Repo-aware CLI startup from the current Git repository
- Auto-detected project mapping for script, log file, metric, and optimization goal
- Real-time metric chart backed by incremental `.csv`, `.tsv`, and `.json` tailing
- Experiment feed with `KEPT`, `DISCARDED`, and reasoning context
- Side-by-side watched-file diff viewer
- Process lifecycle controls: start, stop, restart
- Local trust gate: code-modifying starts require a Git repo
- WebSocket streaming for high-frequency UI updates
- SVG metric graph export after a run has produced results
- Repo-agnostic design for ML, VLSI, systems, or any metric-driven loop

## Quickstart

Install AutoResearchUI once:

```powershell
git clone <your-autoresearchui-repo-url>
cd AutoResearchUI
python -m pip install -e .
npm install
```

Then open a terminal in the research repo you want to monitor:

```powershell
cd C:\path\to\your-research-repo
autoresearchui
```

AutoResearchUI will:

- detect the current Git repo
- discover likely script and log candidates
- auto-assign the script, log file, metric, and optimization goal when possible
- start the backend on `http://127.0.0.1:8000`
- start the web UI on `http://127.0.0.1:3000`
- open the dashboard in your browser

## What The UI Shows

- live metric chart for the selected metric
- process state and health indicators
- experiment feed with iteration outcome and reasoning
- watched-file diff between revisions
- stdout trace from the research process
- connection status for HTTP, state route, and WebSocket
- live loop rail showing the scan, map, iterate, evaluate, and ratchet stages
- graph export once a run has completed and produced metric history

## Installation

### Requirements

- Python 3.10+
- Node.js 18+
- npm

### Python setup

Install the package in editable mode:

```powershell
python -m pip install -e .
```

This provides the CLI entrypoint:

```powershell
autoresearchui
```

### Frontend setup

Install the frontend dependencies:

```powershell
npm install
```

## Usage

### Default

Run inside a research repo:

```powershell
autoresearchui
```

### Common examples

Use an explicit project root:

```powershell
autoresearchui --project-root C:\path\to\research-repo
```

Start without opening the browser:

```powershell
autoresearchui --no-open-browser
```

Force prompt-driven mapping:

```powershell
autoresearchui --interactive-mapping
```

Start only the backend:

```powershell
autoresearchui --backend-only
```

Start only the frontend:

```powershell
autoresearchui --frontend-only
```

Opt in to bootstrapping the target repo:

```powershell
autoresearchui --bootstrap-project
```

### CLI flags

- `--project-root`: use an explicit repo instead of the current working tree
- `--interactive-mapping`: prompt for script, log file, metric, goal, and command
- `--non-interactive`: keep the auto-detected mapping without prompting; this is the default behavior
- `--no-open-browser`: do not open the dashboard automatically
- `--backend-only`: start only the backend service
- `--frontend-only`: start only the frontend service
- `--skip-install`: fail instead of auto-installing AutoResearchUI app dependencies
- `--bootstrap-project`: explicitly install dependencies in the detected target repo

## Mapping Behavior

AutoResearchUI is built for arbitrary research repos, so it does not assume that every project uses the same filenames.

By default, the CLI tries to auto-map:

- `Script to watch`
- `Log file`
- `Y-axis metric`
- `Optimization goal`

If the mapping is clear enough, AutoResearchUI starts immediately and opens the UI.

If the repo cannot be mapped confidently, AutoResearchUI still starts and leaves the mapping editable in the web app.

If you want to review or override every field from the terminal first, use:

```powershell
autoresearchui --interactive-mapping
```

### Karpathy-Style `autoresearch` Repos

If the target repo follows the standard `autoresearch` shape, AutoResearchUI is intended to read it like this:

```text
prepare.py      fixed constants, data prep, evaluation helpers
train.py        model, optimizer, training loop, main file the agent edits
program.md      instructions for the agent and references to output files
results.tsv     structured experiment history
run.log         raw stdout/stderr from each run
analysis.ipynb  post-run notebook for offline analysis
pyproject.toml  dependency manifest
```

In that setup:

- `train.py` should usually be `Script to watch`
- `results.tsv` should usually be the primary `Log file`
- `run.log` is the fallback log when metrics are printed to stdout before they are written into the TSV
- `val_bpb`, `loss`, `accuracy`, or similar fields become the `Y-axis metric`
- `analysis.ipynb` is not a live metric source; it is for after-the-fact analysis
- `pyproject.toml` is not a watched research file; it only defines dependencies

For the canonical `autoresearch` loop, the repo should actually produce:

1. `run.log` from commands like `uv run train.py > run.log 2>&1`
2. `results.tsv` with one row appended per finished experiment

Without one of those files being produced, AutoResearchUI can infer the mapping, but it cannot show a real live metric curve yet.

AutoResearchUI can also use repo context to explain its choices in the web UI. For example:

- `train.py`: usually suggested as `Script to watch` because it often contains the model, optimizer, and training loop
- `prepare.py`: usually treated as supporting code for data prep, constants, or runtime utilities
- `program.md`: scanned for references to expected log files such as `results.tsv` or `run.log`
- `pyproject.toml`: used as a repo signal and dependency manifest, but not as a watched research file

If auto-mapping is not perfect, the sidebar now shows a short hint under each selector explaining why a file was suggested.

## Expected Repo Shape

AutoResearchUI works best when the target repo has:

- a `.git` directory
- at least one script the agent edits, commonly `.py` or `.v`
- at least one structured metrics log in `.csv`, `.tsv`, `.json`, `.jsonl`, or `.ndjson`

One especially clean pattern is:

```text
prepare.py      constants, data prep, runtime helpers
train.py        model, optimizer, training loop
program.md      agent instructions, expected outputs, research protocol
pyproject.toml  dependencies
results.tsv     per-experiment metrics written over time
run.log         plain-text runtime output
```

In a repo shaped like this, AutoResearchUI will usually:

- suggest `train.py` as the watched script
- suggest `results.tsv` or `run.log` as the log file
- infer metrics such as `val_bpb`, `loss`, `accuracy`, or `reward` from the log headers, stdout-style text, and repo docs
- let the user override the metric manually if needed

Recommended log fields:

- `iteration`
- `timestamp`
- one or more numeric metrics
- optional `status`
- optional `hypothesis` or `reasoning`

## Supported Log Formats

### CSV

```csv
iteration,timestamp,loss,accuracy,hypothesis,status
1,2026-03-12T09:00:00Z,1.42,0.55,"try wider hidden layer",KEPT
2,2026-03-12T09:04:00Z,1.31,0.58,"raise learning rate slightly",KEPT
```

### JSON Lines

```json
{"iteration": 1, "timestamp": "2026-03-12T09:00:00Z", "bpb": 1.42, "hypothesis": "try wider hidden layer"}
{"iteration": 2, "timestamp": "2026-03-12T09:04:00Z", "bpb": 1.31, "hypothesis": "raise learning rate slightly"}
```

## Detection Model

When a repo is detected, AutoResearchUI scans for:

- recently updated `.csv`, `.tsv`, and `.json` files as log candidates
- recently updated `.py` and `.v` files as script candidates

It can infer likely defaults for:

- `script_to_watch`
- `log_file`
- `y_axis_metric`
- `optimization_goal`

Those defaults are only a starting point. The user can confirm or override them before launch.

## Trust And Safety

AutoResearchUI is local-first. It does not rely on remote authentication.

Its trust model is intentionally simple:

- if the launcher is run inside a Git repository, that repository is treated as the intended project
- code-modifying process starts are gated behind Git detection
- watched files and selected paths are constrained to the chosen project root
- WebSocket access is origin-restricted for local use

This is a developer tool, not a hosted multi-tenant platform.

## Architecture

### Backend

[app_backend.py](c:\Documents\GitHub\AutoResearchUI\app_backend.py)

- FastAPI application
- WebSocket snapshot streaming
- file watching with `watchdog`
- incremental log parsing
- subprocess orchestration
- Git-aware safety checks

### Frontend

[Dashboard.tsx](c:\Documents\GitHub\AutoResearchUI\Dashboard.tsx)

- Next.js App Router client page
- Recharts metric visualization
- premium real-time dashboard surface
- diff viewer
- process controls and connection checks

### CLI

[autoresearchui_cli.py](c:\Documents\GitHub\AutoResearchUI\autoresearchui_cli.py)

- repo detection
- auto-detected mapping with optional interactive prompts
- local service orchestration
- optional target-repo bootstrap
- browser launch

## Development

Run the backend:

```powershell
uvicorn app_backend:app --reload --host 127.0.0.1 --port 8000
```

Run the frontend:

```powershell
npm run dev
```

Open the dashboard:

```text
http://127.0.0.1:3000
```

Type-check the frontend:

```powershell
node node_modules\\typescript\\bin\\tsc --noEmit
```

## Project Structure

- [app_backend.py](c:\Documents\GitHub\AutoResearchUI\app_backend.py): backend observer and process controller
- [autoresearchui_cli.py](c:\Documents\GitHub\AutoResearchUI\autoresearchui_cli.py): CLI launcher
- [Dashboard.tsx](c:\Documents\GitHub\AutoResearchUI\Dashboard.tsx): primary dashboard UI
- [ProjectConfig.ts](c:\Documents\GitHub\AutoResearchUI\ProjectConfig.ts): shared frontend types
- [pyproject.toml](c:\Documents\GitHub\AutoResearchUI\pyproject.toml): Python package metadata
- [package.json](c:\Documents\GitHub\AutoResearchUI\package.json): frontend package metadata
- [CONTRIBUTING.md](c:\Documents\GitHub\AutoResearchUI\CONTRIBUTING.md): contribution guide
- [CODE_OF_CONDUCT.md](c:\Documents\GitHub\AutoResearchUI\CODE_OF_CONDUCT.md): community standards
- [CHANGELOG.md](c:\Documents\GitHub\AutoResearchUI\CHANGELOG.md): release notes
- [.github](c:\Documents\GitHub\AutoResearchUI\.github): issue and PR templates

## Roadmap

- screenshot and demo assets for the public repo page
- packaged release flow for PyPI and npm distribution
- richer export options beyond SVG
- optional persistence for saved sessions
- integration guides for common autoresearch-style repos

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](c:\Documents\GitHub\AutoResearchUI\CONTRIBUTING.md).

## Code Of Conduct

This project follows the community guidelines in [CODE_OF_CONDUCT.md](c:\Documents\GitHub\AutoResearchUI\CODE_OF_CONDUCT.md).

## License

Released under the MIT License. See [LICENSE](c:\Documents\GitHub\AutoResearchUI\LICENSE).
