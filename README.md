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
- Interactive mapping flow for script, log file, metric, optimization goal, and research command
- Real-time metric chart backed by incremental `.csv`, `.tsv`, and `.json` tailing
- Experiment feed with `KEPT`, `DISCARDED`, and reasoning context
- Side-by-side watched-file diff viewer
- Process lifecycle controls: start, stop, restart
- Local trust gate: code-modifying starts require a Git repo
- WebSocket streaming for high-frequency UI updates
- SVG metric graph export after a run has produced results
- Repo-agnostic design for ML, VLSI, systems, or any metric-driven loop

## Quickstart

Install AutoResearchUI:

```powershell
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
- prompt for the correct script, log file, metric, optimization goal, and research command
- start the backend on `http://127.0.0.1:8000`
- start the web UI on `http://localhost:3000`
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

Skip prompts and use detected defaults when possible:

```powershell
autoresearchui --non-interactive
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
- `--non-interactive`: skip prompts and rely on detected defaults when possible
- `--no-open-browser`: do not open the dashboard automatically
- `--backend-only`: start only the backend service
- `--frontend-only`: start only the frontend service
- `--skip-install`: fail instead of auto-installing AutoResearchUI app dependencies
- `--bootstrap-project`: explicitly install dependencies in the detected target repo

## Interactive Mapping

AutoResearchUI is built for arbitrary research repos, so it does not assume that every project uses the same filenames.

When the CLI starts, it asks the user to confirm:

- `Script to watch`
- `Log file`
- `Y-axis metric`
- `Optimization goal`
- `Research command`

This keeps the system flexible while avoiding incorrect silent guesses.

## Expected Repo Shape

AutoResearchUI works best when the target repo has:

- a `.git` directory
- at least one script the agent edits, commonly `.py` or `.v`
- at least one structured metrics log in `.csv`, `.tsv`, or `.json`

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
- interactive mapping prompts
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
http://localhost:3000
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
