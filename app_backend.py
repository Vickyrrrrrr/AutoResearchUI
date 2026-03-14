from __future__ import annotations

import asyncio
import csv
import html as _html_mod
import json
import os
import re
import socket
import shlex
import subprocess
import sys
import threading
import sqlite3
from collections import deque
from contextlib import suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Literal

from fastapi import FastAPI, HTTPException, Query, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from git import GitCommandError, InvalidGitRepositoryError, NoSuchPathError, Repo
from pydantic import BaseModel, Field
from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

try:
    import httpx as _httpx
    _HTTPX_AVAILABLE = True
except ImportError:
    _HTTPX_AVAILABLE = False


ROOT_DIR = Path.cwd()
MAX_POINTS = 1_000
MAX_EXPERIMENTS = 250
MAX_STDOUT_LINES = 300
DEFAULT_ALLOWED_ORIGINS = ("http://localhost:3000", "http://127.0.0.1:3000")

OptimizationGoal = Literal["minimize", "maximize"]
ExperimentStatus = Literal["KEPT", "DISCARDED", "INFO"]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_path(value: str | Path) -> Path:
    return Path(value).expanduser().resolve()


def safe_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def pick_first(mapping: dict[str, Any], keys: tuple[str, ...]) -> Any:
    lowered = {str(key).lower(): key for key in mapping.keys()}
    for candidate in keys:
        if candidate in lowered:
            return mapping[lowered[candidate]]
    return None


def iso_from_value(value: Any) -> str:
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc).isoformat()
    if isinstance(value, str) and value.strip():
        text = value.strip()
        with suppress(ValueError):
            return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()
        with suppress(ValueError):
            return datetime.strptime(text, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).isoformat()
        return text
    return utc_now()


def parse_bool_env(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def parse_allowed_origins() -> list[str]:
    raw = os.getenv("AUTORESEARCH_ALLOWED_ORIGINS")
    if not raw:
        return list(DEFAULT_ALLOWED_ORIGINS)
    return [item.strip() for item in raw.split(",") if item.strip()]


def is_subpath(candidate: Path, root: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def safe_mtime(path: Path) -> float:
    with suppress(OSError):
        return path.stat().st_mtime
    return 0.0


def split_command(command: str) -> list[str]:
    normalized = command.strip()
    if not normalized:
        return []

    # Use POSIX-style splitting on every platform so quoted Windows paths like
    # "C:\\Program Files\\Python\\python.exe" are unwrapped before Popen.
    try:
        return shlex.split(normalized, posix=True)
    except ValueError:
        return shlex.split(normalized, posix=os.name != "nt")


def query_gpu_stats() -> list[GpuStats]:
    """Query NVIDIA GPU stats via nvidia-smi. Returns empty list if not available."""
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            return []

        def _f(x: str) -> float | None:
            s = x.strip()
            return float(s) if s not in ("", "[N/A]", "N/A") else None

        gpus: list[GpuStats] = []
        for line in result.stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 6:
                continue
            gpus.append(GpuStats(
                index=int(parts[0]),
                name=parts[1].strip(),
                utilization_pct=_f(parts[2]),
                memory_used_mb=_f(parts[3]),
                memory_total_mb=_f(parts[4]),
                temperature_c=_f(parts[5]),
                watts=_f(parts[6]) if len(parts) > 6 else None,
                available=True,
            ))
        return gpus
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return []


class GitCommit(BaseModel):
    sha: str
    summary: str
    authored_at: str


class CommitMetricPoint(BaseModel):
    sha: str
    summary: str
    authored_at: str
    best_metric: float | None = None
    iteration_count: int = 0


class GpuStats(BaseModel):
    index: int = 0
    name: str = "Unknown"
    utilization_pct: float | None = None
    memory_used_mb: float | None = None
    memory_total_mb: float | None = None
    temperature_c: float | None = None
    watts: float | None = None
    available: bool = False


class DiscoveryResult(BaseModel):
    project_root: str
    git_root: str | None = None
    git_present: bool = False
    log_candidates: list[str] = Field(default_factory=list)
    script_candidates: list[str] = Field(default_factory=list)
    headers_by_file: dict[str, list[str]] = Field(default_factory=dict)
    suggested_metrics: list[str] = Field(default_factory=list)
    suggested_command: str | None = None
    file_hints: dict[str, str] = Field(default_factory=dict)
    recent_commits: list[GitCommit] = Field(default_factory=list)
    program_plan: list[str] = Field(default_factory=list)


class MappingConfig(BaseModel):
    project_root: str
    script_to_watch: str
    log_file: str
    y_axis_metric: str
    optimization_goal: OptimizationGoal = "minimize"
    research_command: str | None = None


class MetricPoint(BaseModel):
    iteration: int
    timestamp: str
    metric: float


class ExperimentRecord(BaseModel):
    iteration: int
    timestamp: str
    status: ExperimentStatus
    metric_name: str
    metric_value: float | None = None
    hypothesis: str | None = None
    raw: dict[str, Any] = Field(default_factory=dict)


class DiffSnapshot(BaseModel):
    path: str | None = None
    before: str = ""
    after: str = ""
    updated_at: str | None = None
    latest_commit: GitCommit | None = None


class ProcessState(BaseModel):
    status: Literal["idle", "running", "stopping", "errored"] = "idle"
    pid: int | None = None
    command: str | None = None
    started_at: str | None = None
    exited_at: str | None = None
    return_code: int | None = None


class AppSnapshot(BaseModel):
    config: MappingConfig | None = None
    discovery: DiscoveryResult | None = None
    process: ProcessState
    metric_points: list[MetricPoint] = Field(default_factory=list)
    experiments: list[ExperimentRecord] = Field(default_factory=list)
    diff: DiffSnapshot = Field(default_factory=DiffSnapshot)
    stdout_tail: list[str] = Field(default_factory=list)
    last_hypothesis: str | None = None
    last_updated: str = Field(default_factory=utc_now)


class HealthReport(BaseModel):
    status: Literal["ok"] = "ok"
    service: str = "autoresearch-sidecar"
    version: str = "0.1.0"
    time: str = Field(default_factory=utc_now)
    host: str = Field(default_factory=socket.gethostname)
    project_root: str = str(ROOT_DIR)
    config_loaded: bool = False
    watcher_active: bool = False
    watched_root: str | None = None
    websocket_clients: int = 0
    process_status: Literal["idle", "running", "stopping", "errored"] = "idle"
    git_required_for_start: bool = True
    endpoints: dict[str, str] = Field(
        default_factory=lambda: {
            "health": "/api/health",
            "discovery": "/api/discovery",
            "state": "/api/state",
            "config": "/api/config",
            "start": "/api/process/start",
            "stop": "/api/process/stop",
            "restart": "/api/process/restart",
            "websocket": "/ws",
        }
    )


class SessionInfo(BaseModel):
    id: int
    project_root: str
    script_path: str
    log_path: str
    metric_name: str
    optimization_goal: OptimizationGoal
    started_at: str
    ended_at: str | None = None


class DatabaseManager:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self._init_db()

    def _init_db(self) -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_root TEXT,
                    script_path TEXT,
                    log_path TEXT,
                    metric_name TEXT,
                    optimization_goal TEXT,
                    started_at TEXT,
                    ended_at TEXT
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS datapoints (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id INTEGER,
                    iteration INTEGER,
                    metric_value REAL,
                    timestamp TEXT,
                    FOREIGN KEY(session_id) REFERENCES sessions(id)
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS experiments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id INTEGER,
                    iteration INTEGER,
                    status TEXT,
                    hypothesis TEXT,
                    raw_json TEXT,
                    timestamp TEXT,
                    metric_name TEXT DEFAULT '',
                    metric_value REAL,
                    FOREIGN KEY(session_id) REFERENCES sessions(id)
                )
            """)
            # Migrate old tables that lack metric_name/metric_value columns
            try:
                conn.execute("SELECT metric_name FROM experiments LIMIT 1")
            except sqlite3.OperationalError:
                conn.execute("ALTER TABLE experiments ADD COLUMN metric_name TEXT DEFAULT ''")
                conn.execute("ALTER TABLE experiments ADD COLUMN metric_value REAL")

    def create_session(self, config: MappingConfig) -> int:
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute(
                "INSERT INTO sessions (project_root, script_path, log_path, metric_name, optimization_goal, started_at) VALUES (?, ?, ?, ?, ?, ?)",
                (config.project_root, config.script_to_watch, config.log_file, config.y_axis_metric, config.optimization_goal, utc_now())
            )
            return cursor.lastrowid

    def add_datapoint(self, session_id: int, point: MetricPoint) -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "INSERT INTO datapoints (session_id, iteration, metric_value, timestamp) VALUES (?, ?, ?, ?)",
                (session_id, point.iteration, point.metric, point.timestamp)
            )

    def add_experiment(self, session_id: int, exp: ExperimentRecord) -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "INSERT INTO experiments (session_id, iteration, status, hypothesis, raw_json, timestamp, metric_name, metric_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (session_id, exp.iteration, exp.status, exp.hypothesis, json.dumps(exp.raw), exp.timestamp, exp.metric_name, exp.metric_value)
            )

    def end_session(self, session_id: int) -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("UPDATE sessions SET ended_at = ? WHERE id = ?", (utc_now(), session_id))

    def list_sessions(self) -> list[SessionInfo]:
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute("SELECT * FROM sessions ORDER BY started_at DESC")
            return [SessionInfo(**dict(row)) for row in cursor.fetchall()]

    def get_session_data(self, session_id: int) -> tuple[list[MetricPoint], list[ExperimentRecord]]:
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            points = [
                MetricPoint(iteration=row["iteration"], metric=row["metric_value"], timestamp=row["timestamp"])
                for row in conn.execute("SELECT * FROM datapoints WHERE session_id = ? ORDER BY iteration ASC", (session_id,))
            ]
            # Fetch session-level metric_name for fallback
            session_row = conn.execute("SELECT metric_name FROM sessions WHERE id = ?", (session_id,)).fetchone()
            session_metric = session_row["metric_name"] if session_row else ""
            experiments = [
                ExperimentRecord(
                    iteration=row["iteration"],
                    timestamp=row["timestamp"],
                    status=row["status"],
                    metric_name=row["metric_name"] if row["metric_name"] else session_metric,
                    metric_value=row["metric_value"],
                    hypothesis=row["hypothesis"],
                    raw=json.loads(row["raw_json"]) if row["raw_json"] else {},
                )
                for row in conn.execute("SELECT * FROM experiments WHERE session_id = ? ORDER BY iteration ASC", (session_id,))
            ]
            return points, experiments

    def get_datapoints_for_timeline(self, session_id: int) -> list[tuple[float, str]]:
        """Return (metric_value, timestamp) pairs ordered by timestamp for the given session."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            return [
                (float(row["metric_value"]), str(row["timestamp"]))
                for row in conn.execute(
                    "SELECT metric_value, timestamp FROM datapoints WHERE session_id = ? ORDER BY timestamp ASC",
                    (session_id,),
                )
            ]

    LOG_SUFFIXES = {".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".log", ".ipynb"}
    SCRIPT_SUFFIXES = {".py", ".v"}
    DOC_SUFFIXES = {".md", ".markdown", ".txt", ".rst"}
    SKIP_DIRS = {".git", ".next", "node_modules", "dist", "build", "__pycache__", ".venv", "venv", ".vendor", ".mypy_cache", ".pytest_cache", ".ruff_cache"}
    IGNORE_LOG_NAMES = {
        "package.json",
        "package-lock.json",
        "tsconfig.json",
        "tsconfig.tsbuildinfo",
        ".package-lock.json",
        "pyproject.toml",
        "uv.lock",
    }
    LOG_NAME_PRIORITY = (
        "results.tsv",
        "results.csv",
        "metrics.tsv",
        "metrics.csv",
        "metrics.jsonl",
        "metrics.ndjson",
        "metrics.json",
        "run.log",
        "train.log",
        "progress.log",
    )
    SCRIPT_NAME_PRIORITY = ("train.py", "run.py", "main.py", "research.py", "search.py", "agent.py")
    FILE_REFERENCE_PATTERN = re.compile(r"(?P<path>[\w./\\-]+\.(?:csv|tsv|json|jsonl|ndjson|log))", re.IGNORECASE)
    METRIC_PATTERN = re.compile(
        r"(?P<key>[A-Za-z][A-Za-z0-9_./-]{1,63})\s*[:=]\s*(?P<value>[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)"
    )

    @classmethod
    def should_skip_dir(cls, name: str) -> bool:
        if name in cls.SKIP_DIRS:
            return True
        if name.startswith("."):
            return True
        if name.startswith("venv") or name.startswith(".venv"):
            return True
        if name.endswith(".egg-info"):
            return True
        return False

    @classmethod
    def looks_like_metric_name(cls, value: str) -> bool:
        lowered = value.lower()
        if lowered in AutoMapper.NON_METRIC_KEYS:
            return False
        if lowered.startswith(("val_", "valid_", "eval_", "test_", "test-", "val-")):
            return True
        metric_tokens = AutoMapper.MINIMIZE_HINTS + AutoMapper.MAXIMIZE_HINTS + (
            "perplexity", "ppl", "bleu", "rouge", "auc", "mae", "mse", "rmse", "bpb", "bits-per-byte"
        )
        return any(token in lowered for token in metric_tokens)

    @classmethod
    def discover(cls, root: Path) -> DiscoveryResult:
        if not root.exists() or not root.is_dir():
            raise HTTPException(status_code=404, detail=f"Project root does not exist: {root}")

        logs: list[Path] = []
        scripts: list[Path] = []
        docs: list[Path] = []
        headers_by_file: dict[str, list[str]] = {}
        for current_root, dir_names, file_names in os.walk(root):
            dir_names[:] = [name for name in dir_names if not cls.should_skip_dir(name)]
            base = Path(current_root)
            for file_name in file_names:
                candidate = base / file_name
                suffix = candidate.suffix.lower()
                if suffix in cls.LOG_SUFFIXES:
                    if candidate.name in cls.IGNORE_LOG_NAMES:
                        continue
                    logs.append(candidate)
                if suffix in cls.SCRIPT_SUFFIXES:
                    scripts.append(candidate)
                if suffix in cls.DOC_SUFFIXES:
                    docs.append(candidate)

        referenced_logs, suggested_metrics, suggested_command, reference_sources = cls.inspect_repo_hints(root, docs, scripts, logs)
        known_logs = {item.resolve(strict=False) for item in logs}
        for candidate in referenced_logs:
            resolved = candidate.resolve(strict=False)
            if resolved not in known_logs and is_subpath(resolved, root):
                logs.append(candidate)
                known_logs.add(resolved)

        logs.sort(key=cls.log_rank)
        scripts.sort(key=cls.script_rank)

        top_logs = logs[:20]
        top_scripts = scripts[:20]
        for item in logs[:20]:
            headers_by_file[str(item)] = cls.infer_headers(item)

        metric_names = set(suggested_metrics)
        for headers in headers_by_file.values():
            metric_names.update(headers)

        file_hints: dict[str, str] = {}
        for item in top_logs + top_scripts:
            sources = reference_sources.get(item.resolve(strict=False), set())
            file_hints[str(item)] = cls.describe_candidate(item, sources)

        git_root, commits = cls.git_summary(root)

        plan_items: list[str] = []
        for doc in docs[:8]:
            if doc.name.lower() in {"program.md", "readme.md", "instructions.md", "plan.md", "goals.md"}:
                try:
                    content = doc.read_text(encoding="utf-8", errors="ignore")[:32768]
                except OSError:
                    continue
                for line in content.splitlines():
                    stripped = line.strip()
                    if stripped.startswith(("- [ ]", "- [x]", "- [X]")):
                        plan_items.append(stripped)
                    elif stripped.lower().startswith(("goal:", "objective:", "**goal", "**objective", "mission:")):
                        plan_items.append(stripped)
                if plan_items:
                    break

        return DiscoveryResult(
            project_root=str(root),
            git_root=str(git_root) if git_root else None,
            git_present=git_root is not None,
            log_candidates=[str(item) for item in top_logs],
            script_candidates=[str(item) for item in top_scripts],
            headers_by_file=headers_by_file,
            suggested_metrics=AutoMapper.rank_metrics(list(metric_names)),
            suggested_command=suggested_command,
            file_hints=file_hints,
            recent_commits=commits,
            program_plan=plan_items,
        )

    @classmethod
    def infer_headers(cls, path: Path) -> list[str]:
        if not path.exists() or not path.is_file():
            return []

        suffix = path.suffix.lower()
        if suffix in {".csv", ".tsv"}:
            delimiter = "\t" if suffix == ".tsv" else ","
            try:
                with path.open("r", encoding="utf-8", errors="ignore", newline="") as handle:
                    for line in handle:
                        if line.strip():
                            return next(csv.reader([line], delimiter=delimiter))
            except OSError:
                return []
            except StopIteration:
                return []
            return []

        if suffix in {".json", ".jsonl", ".ndjson"}:
            try:
                with path.open("r", encoding="utf-8", errors="ignore") as handle:
                    sample = handle.read(131072).strip()
            except OSError:
                return []
            if not sample:
                return []
            if sample.startswith("["):
                with suppress(json.JSONDecodeError):
                    payload = json.loads(sample)
                    if isinstance(payload, list) and payload and isinstance(payload[0], dict):
                        return list(payload[0].keys())
            for line in sample.splitlines():
                text = line.strip().rstrip(",")
                if not text:
                    continue
                with suppress(json.JSONDecodeError):
                    row = json.loads(text)
                    if isinstance(row, dict):
                        return list(row.keys())
            return []

        if suffix == ".log":
            try:
                with path.open("r", encoding="utf-8", errors="ignore") as handle:
                    sample = handle.read(131072)
            except OSError:
                return []
            return cls.infer_metric_candidates_from_text(sample)

        return []

    @classmethod
    def infer_metric_candidates_from_text(cls, text: str) -> list[str]:
        candidates: dict[str, str] = {}
        for match in cls.METRIC_PATTERN.finditer(text):
            key = match.group("key").strip("[](){}<>.,:;\"'")
            lowered = key.lower()
            if lowered in candidates:
                continue
            if not cls.looks_like_metric_name(key):
                continue
            candidates[lowered] = key

        for raw_line in text.splitlines():
            line = raw_line.strip().strip("|")
            if "\t" not in line and "," not in line:
                continue
            delimiter = "\t" if "\t" in line else ","
            parts = [part.strip(" `|'\"") for part in line.split(delimiter)]
            if len(parts) < 2:
                continue
            if not all(part and re.fullmatch(r"[A-Za-z][A-Za-z0-9_./-]{0,63}", part) for part in parts):
                continue
            for part in parts:
                lowered = part.lower()
                if lowered in candidates or not cls.looks_like_metric_name(part):
                    continue
                candidates[lowered] = part

        return AutoMapper.rank_metrics(list(candidates.values()))

    @classmethod
    def inspect_repo_hints(
        cls,
        root: Path,
        docs: list[Path],
        scripts: list[Path],
        logs: list[Path],
    ) -> tuple[list[Path], list[str], str | None, dict[Path, set[str]]]:
        referenced_logs: list[Path] = []
        metrics: dict[str, str] = {}
        reference_sources: dict[Path, set[str]] = {}
        suggested_command: str | None = None

        def add_metrics(values: list[str]) -> None:
            for value in values:
                lowered = value.lower()
                if lowered in metrics:
                    continue
                metrics[lowered] = value

        for path in docs[:24]:
            try:
                sample = path.read_text(encoding="utf-8", errors="ignore")[:262144]
            except OSError:
                continue
            for match in cls.FILE_REFERENCE_PATTERN.finditer(sample):
                raw = match.group("path").strip("\"'`()[]{}")
                candidate = normalize_path(root / raw) if not Path(raw).is_absolute() else normalize_path(raw)
                if is_subpath(candidate, root) and candidate.name not in cls.IGNORE_LOG_NAMES:
                    referenced_logs.append(candidate)
                    reference_sources.setdefault(candidate.resolve(strict=False), set()).add(path.name)
            if suggested_command is None:
                suggested_command = cls.infer_command_from_text(sample)
            
            # Special check for Karpathy-style hints in program.md or README
            if "val_bpb" in sample.lower():
                add_metrics(["val_bpb"])
            if "bits-per-byte" in sample.lower():
                add_metrics(["bits-per-byte"])
            
            add_metrics(cls.infer_metric_candidates_from_text(sample))

        for path in scripts[:12]:
            try:
                sample = path.read_text(encoding="utf-8", errors="ignore")[:262144]
            except OSError:
                continue
            add_metrics(cls.infer_metric_candidates_from_text(sample))

        for path in logs[:12]:
            headers = cls.infer_headers(path)
            if headers:
                add_metrics(headers)

        deduped_logs: list[Path] = []
        seen_logs: set[Path] = set()
        for candidate in referenced_logs:
            resolved = candidate.resolve(strict=False)
            if resolved in seen_logs:
                continue
            seen_logs.add(resolved)
            deduped_logs.append(candidate)

        return deduped_logs, AutoMapper.rank_metrics(list(metrics.values())), suggested_command, reference_sources

    @classmethod
    def infer_command_from_text(cls, text: str) -> str | None:
        command_patterns = (
            re.compile(r"(?mi)^\s*(uv\s+run\s+[^\r\n`]+?)(?:\s*$)"),
            re.compile(r"(?mi)^\s*(python(?:3)?\s+[^\r\n`]+?)(?:\s*$)"),
        )
        for pattern in command_patterns:
            for match in pattern.finditer(text):
                command = match.group(1).strip().strip("`")
                if "train.py" in command or "run.py" in command or "main.py" in command:
                    return command
        return None

    @classmethod
    def describe_candidate(cls, path: Path, sources: set[str]) -> str:
        name = path.name.lower()
        source_text = ""
        if sources:
            ordered_sources = ", ".join(sorted(sources))
            source_text = f" Referenced in {ordered_sources}."

        if path.suffix.lower() in cls.SCRIPT_SUFFIXES:
            if name == "train.py":
                return "Likely the main training or research loop. This is usually the file the agent edits and reruns." + source_text
            if name == "prepare.py":
                return "Usually constants, data preparation, or runtime utilities. Often supporting code rather than the main watched loop." + source_text
            if name in {"run.py", "main.py", "research.py", "search.py", "agent.py"}:
                return "Looks like an entrypoint for the experiment loop or agent runner." + source_text
            return "Candidate research script inside the repo." + source_text

        if path.suffix.lower() == ".log" or name.endswith(".log"):
            if path.exists():
                return "Plain-text runtime log. Useful when the research process prints metrics like val_bpb or loss to stdout." + source_text
            return "Expected runtime log that will be created when the run starts." + source_text

        if path.suffix.lower() in {".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".ipynb"}:
            if path.exists():
                return "Structured experiment log. This is the best choice when each run appends metric rows." + source_text
            return "Expected structured metrics file. AutoResearchUI can watch it as soon as the first experiment writes to it." + source_text

        return "Candidate file detected during repo scan." + source_text

    @classmethod
    def log_rank(cls, path: Path) -> tuple[int, int, int, float]:
        name = path.name.lower()
        try:
            priority = cls.LOG_NAME_PRIORITY.index(name)
        except ValueError:
            priority = len(cls.LOG_NAME_PRIORITY)
        suffix_rank = {".tsv": 0, ".csv": 1, ".jsonl": 2, ".ndjson": 3, ".json": 4, ".ipynb": 5, ".log": 6}.get(path.suffix.lower(), 7)
        depth = len(path.parts)
        return (priority, suffix_rank, depth, -safe_mtime(path))

    @classmethod
    def script_rank(cls, path: Path) -> tuple[int, int, float]:
        name = path.name.lower()
        try:
            priority = cls.SCRIPT_NAME_PRIORITY.index(name)
        except ValueError:
            priority = len(cls.SCRIPT_NAME_PRIORITY)
        depth = len(path.parts)
        return (priority, depth, -safe_mtime(path))

    @classmethod
    def git_summary(cls, root: Path) -> tuple[Path | None, list[GitCommit]]:
        try:
            repo = Repo(root, search_parent_directories=True)
        except (InvalidGitRepositoryError, NoSuchPathError):
            return None, []

        commits: list[GitCommit] = []
        with suppress(ValueError, GitCommandError, OSError):
            for commit in repo.iter_commits(max_count=30):
                commits.append(
                    GitCommit(
                        sha=commit.hexsha[:10],
                        summary=commit.summary,
                        authored_at=datetime.fromtimestamp(commit.authored_date, timezone.utc).isoformat(),
                    )
                )
        return Path(repo.working_tree_dir).resolve(), commits


class AutoMapper:
    MAXIMIZE_HINTS = ("accuracy", "acc", "score", "reward", "f1", "precision", "recall", "slack", "throughput", "bleu", "rouge", "auc")
    MINIMIZE_HINTS = ("loss", "error", "wer", "cer", "bpb", "area", "power", "latency", "runtime", "cost", "perplexity", "ppl", "mse", "mae", "rmse")
    METRIC_PRIORITY = (
        "val_bpb",
        "val_loss",
        "val_accuracy",
        "test_bpb",
        "test_loss",
        "test_accuracy",
        "bpb",
        "loss",
        "accuracy",
        "acc",
        "score",
        "reward",
        "f1",
        "timing_slack",
        "slack",
        "area",
        "power",
    )
    NON_METRIC_KEYS = {
        "iteration",
        "iter",
        "step",
        "trial",
        "experiment",
        "timestamp",
        "time",
        "datetime",
        "created_at",
        "logged_at",
        "status",
        "result",
        "decision",
        "outcome",
        "hypothesis",
        "reasoning",
        "agent_reasoning",
        "thought",
        "message",
        "summary",
        "notes",
    }

    @classmethod
    def build_config(cls, discovery: DiscoveryResult) -> MappingConfig | None:
        if not discovery.script_candidates or not discovery.log_candidates:
            return None

        script = discovery.script_candidates[0]
        log_file = discovery.log_candidates[0]
        headers = discovery.headers_by_file.get(log_file, []) or discovery.suggested_metrics
        metric = cls.pick_metric(headers)
        if not metric:
            return None

        goal: OptimizationGoal = cls.infer_goal(metric)
        return MappingConfig(
            project_root=discovery.project_root,
            script_to_watch=script,
            log_file=log_file,
            y_axis_metric=metric,
            optimization_goal=goal,
            research_command=discovery.suggested_command or cls.default_command(Path(script)),
        )

    @classmethod
    def pick_metric(cls, headers: list[str]) -> str | None:
        if not headers:
            return None

        ranked = cls.rank_metrics(headers)
        if not ranked:
            return None

        for name in cls.METRIC_PRIORITY:
            for header in ranked:
                if header.lower() == name.lower():
                    return header

        for prefix in ("val_", "valid_", "eval_", "test_", "best_", "train_"):
            for name in cls.METRIC_PRIORITY:
                for header in ranked:
                    lowered_header = header.lower()
                    if lowered_header.startswith(prefix) and name in lowered_header:
                        return header
        
        for header in ranked:
            if header.lower() not in cls.NON_METRIC_KEYS:
                return header
        return ranked[0]

    @classmethod
    def rank_metrics(cls, headers: list[str]) -> list[str]:
        seen: dict[str, str] = {}
        for header in headers:
            candidate = str(header).strip()
            if not candidate:
                continue
            lowered = candidate.lower()
            if lowered in seen or lowered in cls.NON_METRIC_KEYS:
                continue
            seen[lowered] = candidate

        def rank(item: str) -> tuple[int, int, str]:
            lowered = item.lower()
            for index, name in enumerate(cls.METRIC_PRIORITY):
                if lowered.startswith(("val_", "valid_", "eval_", "test_", "best_", "train_")) and name in lowered:
                    return (0, index, lowered)
            for index, name in enumerate(cls.METRIC_PRIORITY):
                if lowered == name:
                    return (1, index, lowered)
            if any(token in lowered for token in cls.MINIMIZE_HINTS + cls.MAXIMIZE_HINTS):
                return (2, len(cls.METRIC_PRIORITY), lowered)
            return (3, len(cls.METRIC_PRIORITY), lowered)

        return sorted(seen.values(), key=rank)

    @classmethod
    def infer_goal(cls, metric_name: str) -> OptimizationGoal:
        lowered = metric_name.lower()
        if any(token in lowered for token in cls.MAXIMIZE_HINTS):
            return "maximize"
        if any(token in lowered for token in cls.MINIMIZE_HINTS):
            return "minimize"
        return "maximize" if "score" in lowered else "minimize"

    @classmethod
    def default_command(cls, script_path: Path) -> str:
        suffix = script_path.suffix.lower()
        if suffix == ".py":
            return f'"{sys.executable}" "{script_path}"'
        if suffix == ".v":
            return f'echo "Set a real research command for {script_path.name}"'
        return str(script_path)


class IncrementalLogParser:
    def __init__(self, log_file: Path, metric_name: str, goal: OptimizationGoal) -> None:
        self.log_file = log_file
        self.metric_name = metric_name
        self.goal = goal
        self.header: list[str] | None = None
        self.offset = 0
        self.best_metric: float | None = None
        self.experiment_count = 0

    def reset(self) -> None:
        self.header = None
        self.offset = 0
        self.best_metric = None
        self.experiment_count = 0

    def bootstrap(self) -> tuple[list[MetricPoint], list[ExperimentRecord]]:
        self.reset()
        return self.consume_available()

    def consume_available(self) -> tuple[list[MetricPoint], list[ExperimentRecord]]:
        if not self.log_file.exists():
            return [], []

        file_size = self.log_file.stat().st_size
        if file_size < self.offset:
            self.reset()

        start_offset = self.offset
        try:
            with self.log_file.open("r", encoding="utf-8", newline="") as handle:
                handle.seek(self.offset)
                chunk = handle.read()
                self.offset = handle.tell()
        except OSError:
            return [], []

        if not chunk.strip():
            return [], []

        points: list[MetricPoint] = []
        experiments: list[ExperimentRecord] = []
        for row in self._parse_chunk(chunk, start_offset=start_offset):
            experiment = self._row_to_experiment(row)
            experiments.append(experiment)
            if experiment.metric_value is not None:
                points.append(
                    MetricPoint(
                        iteration=experiment.iteration,
                        timestamp=experiment.timestamp,
                        metric=experiment.metric_value,
                    )
                )
        return points, experiments

    def _parse_chunk(self, chunk: str, start_offset: int) -> list[dict[str, Any]]:
        suffix = self.log_file.suffix.lower()
        if suffix in {".csv", ".tsv"}:
            # Try to be smart about the delimiter regardless of extension
            sample = chunk[:4096]
            if "\t" in sample and "," not in sample:
                return self._parse_delimited(chunk, delimiter="\t")
            if "," in sample and "\t" not in sample:
                return self._parse_delimited(chunk, delimiter=",")
            # Fallback to extension
            return self._parse_delimited(chunk, delimiter="\t" if suffix == ".tsv" else ",")
        if suffix in {".json", ".jsonl", ".ndjson"}:
            return self._parse_json(chunk, start_offset=start_offset)
        if suffix == ".ipynb":
            return self._parse_ipynb(chunk)
        if suffix == ".log":
            # Some .log files are actually CSVs in disguise
            sample = chunk[:4096]
            if "," in sample or "\t" in sample:
                try:
                    return self._parse_delimited(chunk, delimiter="\t" if "\t" in sample else ",")
                except Exception:
                    pass
            return self._parse_text_log(chunk)
        return []

    def _parse_delimited(self, chunk: str, delimiter: str) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        lines = chunk.splitlines()
        
        # If we don't have a header yet, try to find it by skipping empty/garbage lines
        if self.header is None:
            for i, line in enumerate(lines):
                clean = line.strip()
                if not clean:
                    continue
                # If it looks like a header (mostly text, exists in metric priority or looks like a metric)
                parts = [p.strip() for p in next(csv.reader([clean], delimiter=delimiter))]
                if any(DatabaseManager.looks_like_metric_name(p) or p.lower() in AutoMapper.NON_METRIC_KEYS for p in parts):
                    self.header = parts
                    lines = lines[i+1:]
                    break
            else:
                return [] # No header found yet

        for raw_line in lines:
            if not raw_line.strip():
                continue
            try:
                parsed = next(csv.reader([raw_line], delimiter=delimiter))
            except (csv.Error, StopIteration):
                continue
                
            if parsed == self.header:
                continue
            row = {key: parsed[index] if index < len(parsed) else "" for index, key in enumerate(self.header)}
            rows.append(row)
        return rows

    def _parse_json(self, chunk: str, start_offset: int) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        stripped = chunk.strip()
        if start_offset == 0 and stripped.startswith("["):
            with suppress(json.JSONDecodeError):
                payload = json.loads(stripped)
                if isinstance(payload, list):
                    return [item for item in payload if isinstance(item, dict)]

        for raw_line in chunk.splitlines():
            line = raw_line.strip().rstrip(",")
            if not line or line in {"[", "]"}:
                continue
            with suppress(json.JSONDecodeError):
                payload = json.loads(line)
                if isinstance(payload, dict):
                    rows.append(payload)
        return rows

    def _parse_text_log(self, chunk: str) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for raw_line in chunk.splitlines():
            line = raw_line.strip()
            if not line:
                continue
            row: dict[str, Any] = {"message": line}
            metric_found = False
            for match in DatabaseManager.METRIC_PATTERN.finditer(line):
                row[match.group("key")] = match.group("value")
                metric_found = True
            if metric_found:
                rows.append(row)
        return rows

    def _parse_ipynb(self, chunk: str) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        try:
            notebook = json.loads(chunk)
            if not isinstance(notebook, dict) or "cells" not in notebook:
                return rows
                
            for cell in notebook["cells"]:
                if cell.get("cell_type") != "code":
                    continue
                for output in cell.get("outputs", []):
                    text_blocks = []
                    if "text" in output:
                        text_blocks = output["text"]
                    elif "text/plain" in output.get("data", {}):
                        text_blocks = output["data"]["text/plain"]
                    
                    if not isinstance(text_blocks, list):
                        text_blocks = [text_blocks]
                    
                    for text_block in text_blocks:
                        for line in str(text_block).splitlines():
                            clean_line = line.strip()
                            if not clean_line:
                                continue
                            row: dict[str, Any] = {"message": clean_line}
                            metric_found = False
                            for match in DatabaseManager.METRIC_PATTERN.finditer(clean_line):
                                row[match.group("key")] = match.group("value")
                                metric_found = True
                            if metric_found:
                                rows.append(row)
        except json.JSONDecodeError:
            pass
        return rows

    def _row_to_experiment(self, row: dict[str, Any]) -> ExperimentRecord:
        self.experiment_count += 1

        timestamp = iso_from_value(
            pick_first(
                row,
                ("timestamp", "time", "created_at", "datetime", "logged_at"),
            )
        )

        iteration_value = pick_first(row, ("iteration", "iter", "step", "trial", "experiment"))
        iteration = int(float(iteration_value)) if safe_float(iteration_value) is not None else self.experiment_count

        metric_value = safe_float(row.get(self.metric_name))
        raw_status = pick_first(row, ("status", "result", "decision", "outcome", "label"))
        if isinstance(raw_status, str):
            normalized = raw_status.strip().lower()
            if normalized in {"kept", "accepted", "pass", "passed", "improved", "ok", "success"}:
                status: ExperimentStatus = "KEPT"
            elif normalized in {"discarded", "rejected", "fail", "failed", "regressed", "error", "bad"}:
                status = "DISCARDED"
            else:
                status = "INFO"
        elif metric_value is None:
            status = "INFO"
        else:
            improved = self.best_metric is None
            if self.best_metric is not None:
                improved = metric_value < self.best_metric if self.goal == "minimize" else metric_value > self.best_metric
            if improved:
                self.best_metric = metric_value
            status = "KEPT" if improved else "DISCARDED"

        hypothesis = pick_first(
            row,
            ("hypothesis", "reasoning", "agent_reasoning", "thought", "summary", "message", "notes", "description", "details"),
        )
        return ExperimentRecord(
            iteration=iteration,
            timestamp=timestamp,
            status=status,
            metric_name=self.metric_name,
            metric_value=metric_value,
            hypothesis=str(hypothesis) if hypothesis not in (None, "") else None,
            raw=row,
        )


class ProjectFileHandler(FileSystemEventHandler):
    def __init__(self, coordinator: "ResearchCoordinator") -> None:
        self.coordinator = coordinator

    def on_modified(self, event: FileSystemEvent) -> None:
        self._route(event)

    def on_created(self, event: FileSystemEvent) -> None:
        self._route(event)

    def on_moved(self, event: FileSystemEvent) -> None:
        self._route(event)

    def _route(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        candidate = getattr(event, "dest_path", None) or event.src_path
        self.coordinator.handle_file_event(Path(candidate))


class FileWatcher:
    def __init__(self, coordinator: "ResearchCoordinator") -> None:
        self.coordinator = coordinator
        self.observer: Observer | None = None
        self.root: Path | None = None

    def watch(self, root: Path) -> None:
        resolved = root.resolve()
        if self.root == resolved and self.observer and self.observer.is_alive():
            return
        self.stop()
        self.observer = Observer()
        self.observer.schedule(ProjectFileHandler(self.coordinator), str(resolved), recursive=True)
        self.observer.start()
        self.root = resolved

    def stop(self) -> None:
        if self.observer:
            self.observer.stop()
            self.observer.join(timeout=5)
        self.observer = None
        self.root = None


class ProcessOrchestrator:
    def __init__(self, on_stdout: Callable[[str], None], on_exit: Callable[[int], None]) -> None:
        self.on_stdout = on_stdout
        self.on_exit = on_exit
        self.process: subprocess.Popen[str] | None = None
        self.stdout_thread: threading.Thread | None = None
        self.wait_thread: threading.Thread | None = None
        self.state = ProcessState()
        self.lock = threading.RLock()

    def start(self, command: str, cwd: Path) -> ProcessState:
        with self.lock:
            if self.process and self.process.poll() is None:
                raise HTTPException(status_code=409, detail="Research process is already running.")

            args = split_command(command)
            if not args:
                raise HTTPException(status_code=400, detail="Empty research command.")

            try:
                self.process = subprocess.Popen(
                    args,
                    cwd=str(cwd),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    bufsize=1,
                )
            except OSError as exc:
                self.process = None
                self.state = ProcessState(status="errored", command=command, exited_at=utc_now())
                raise HTTPException(status_code=400, detail=f"Failed to start process: {exc}") from exc

            self.state = ProcessState(
                status="running",
                pid=self.process.pid,
                command=command,
                started_at=utc_now(),
            )
            self.stdout_thread = threading.Thread(target=self._pump_stdout, daemon=True)
            self.wait_thread = threading.Thread(target=self._wait_for_exit, daemon=True)
            self.stdout_thread.start()
            self.wait_thread.start()
            return self.state

    def stop(self) -> ProcessState:
        with self.lock:
            if not self.process or self.process.poll() is not None:
                self.state = ProcessState(status="idle", exited_at=utc_now())
                return self.state

            self.state.status = "stopping"
            self.process.terminate()

        with suppress(subprocess.TimeoutExpired):
            self.process.wait(timeout=5)
        if self.process and self.process.poll() is None:
            self.process.kill()
        return self.snapshot()

    def snapshot(self) -> ProcessState:
        with self.lock:
            return self.state.model_copy(deep=True)

    def shutdown(self) -> None:
        with suppress(Exception):
            self.stop()

    def _pump_stdout(self) -> None:
        if not self.process or not self.process.stdout:
            return
        for raw_line in self.process.stdout:
            text = raw_line.rstrip()
            if text:
                self.on_stdout(text)

    def _wait_for_exit(self) -> None:
        if not self.process:
            return
        code = self.process.wait()
        with self.lock:
            command = self.state.command
            started_at = self.state.started_at
            self.state = ProcessState(
                status="idle" if code == 0 else "errored",
                pid=None,
                command=command,
                started_at=started_at,
                exited_at=utc_now(),
                return_code=code,
            )
            self.process = None
        self.on_exit(code)


class ResearchCoordinator:
    def __init__(self) -> None:
        self.loop: asyncio.AbstractEventLoop | None = None
        self.lock = threading.RLock()
        self.connections: set[WebSocket] = set()
        self.config: MappingConfig | None = None
        self.discovery: DiscoveryResult | None = None
        self.metric_points: deque[MetricPoint] = deque(maxlen=MAX_POINTS)
        self.experiments: deque[ExperimentRecord] = deque(maxlen=MAX_EXPERIMENTS)
        self.stdout_tail: deque[str] = deque(maxlen=MAX_STDOUT_LINES)
        self.last_hypothesis: str | None = None
        self.diff = DiffSnapshot()
        self.parser: IncrementalLogParser | None = None
        self.watcher = FileWatcher(self)
        self.db = DatabaseManager(ROOT_DIR / "autoresearch.db")
        self.current_session_id: int | None = None
        self.process = ProcessOrchestrator(self.handle_stdout, self.handle_process_exit)

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop

    def snapshot(self) -> AppSnapshot:
        with self.lock:
            return AppSnapshot(
                config=self.config.model_copy(deep=True) if self.config else None,
                discovery=self.discovery.model_copy(deep=True) if self.discovery else None,
                process=self.process.snapshot(),
                metric_points=list(self.metric_points),
                experiments=list(self.experiments),
                diff=self.diff.model_copy(deep=True),
                stdout_tail=list(self.stdout_tail),
                last_hypothesis=self.last_hypothesis,
                last_updated=utc_now(),
            )

    def health_report(self) -> HealthReport:
        with self.lock:
            active_root = self.config.project_root if self.config else self.discovery.project_root if self.discovery else str(ROOT_DIR)
            return HealthReport(
                time=utc_now(),
                project_root=active_root,
                config_loaded=self.config is not None,
                watcher_active=bool(self.watcher.observer and self.watcher.observer.is_alive()),
                watched_root=str(self.watcher.root) if self.watcher.root else None,
                websocket_clients=len(self.connections),
                process_status=self.process.snapshot().status,
            )

    def discover(self, root_path: str) -> DiscoveryResult:
        root = normalize_path(root_path)
        discovery = DatabaseManager.discover(root)
        with self.lock:
            self.discovery = discovery
        self._schedule_broadcast()
        return discovery

    def apply_config(self, config: MappingConfig) -> AppSnapshot:
        root = normalize_path(config.project_root)
        script = normalize_path(config.script_to_watch)
        log_file = normalize_path(config.log_file)
        metric_name = config.y_axis_metric.strip()
        if not root.exists():
            raise HTTPException(status_code=404, detail=f"Project root not found: {root}")
        if not root.is_dir():
            raise HTTPException(status_code=400, detail=f"Project root is not a directory: {root}")
        if not is_subpath(script, root):
            raise HTTPException(status_code=400, detail="Script to watch must be inside the selected project root.")
        if not is_subpath(log_file, root):
            raise HTTPException(status_code=400, detail="Log file must be inside the selected project root.")
        if not script.exists() or not script.is_file():
            raise HTTPException(status_code=404, detail=f"Script to watch not found: {script}")
        if log_file.exists() and not log_file.is_file():
            raise HTTPException(status_code=400, detail=f"Log file path is not a file: {log_file}")
        if not metric_name:
            raise HTTPException(status_code=400, detail="Choose a Y-axis metric before applying the mapping.")

        available_headers = DatabaseManager.infer_headers(log_file) if log_file.exists() else []
        if available_headers and config.y_axis_metric not in available_headers:
            raise HTTPException(
                status_code=400,
                detail=f"Metric '{config.y_axis_metric}' was not found in the selected log file headers.",
            )

        resolved = MappingConfig(
            project_root=str(root),
            script_to_watch=str(script),
            log_file=str(log_file),
            y_axis_metric=metric_name,
            optimization_goal=config.optimization_goal,
            research_command=config.research_command,
        )

        parser = IncrementalLogParser(log_file=log_file, metric_name=resolved.y_axis_metric, goal=resolved.optimization_goal)
        points, experiments = parser.bootstrap()

        with self.lock:
            self.config = resolved
            self.parser = parser
            self.metric_points = deque(points, maxlen=MAX_POINTS)
            self.experiments = deque(self._merge_hypothesis(experiments), maxlen=MAX_EXPERIMENTS)
            self.discovery = DatabaseManager.discover(root)
            self._refresh_diff_locked()

        self.watcher.watch(root)
        
        # Initialize new session in database
        with self.lock:
            self.current_session_id = self.db.create_session(resolved)
            # Re-persist existing points/experiments found during bootstrap
            for point in self.metric_points:
                self.db.add_datapoint(self.current_session_id, point)
            for experiment in self.experiments:
                self.db.add_experiment(self.current_session_id, experiment)

        self._schedule_broadcast()
        return self.snapshot()

    def auto_configure(self, root_path: str) -> AppSnapshot | None:
        discovery = self.discover(root_path)
        mapping = AutoMapper.build_config(discovery)
        if not mapping:
            return None
        return self.apply_config(mapping)

    def start_process(self) -> AppSnapshot:
        with self.lock:
            if not self.config:
                raise HTTPException(status_code=400, detail="Apply a project mapping before starting the process.")
            config = self.config

        git_root, _ = DatabaseManager.git_summary(normalize_path(config.project_root))
        if git_root is None or not (git_root / ".git").exists():
            raise HTTPException(status_code=400, detail="Refusing to start a code-modifying workflow outside a Git repository.")

        command = config.research_command or f'python "{config.script_to_watch}"'
        self.process.start(command=command, cwd=normalize_path(config.project_root))
        self._schedule_broadcast()
        return self.snapshot()

    def stop_process(self) -> AppSnapshot:
        self.process.stop()
        self._schedule_broadcast()
        return self.snapshot()

    def restart_process(self) -> AppSnapshot:
        self.process.stop()
        return self.start_process()

    def handle_stdout(self, line: str) -> None:
        with self.lock:
            self.stdout_tail.append(line)
            lowered = line.lower()
            if "hypothesis" in lowered or "reasoning" in lowered:
                self.last_hypothesis = line
                if self.experiments and not self.experiments[-1].hypothesis:
                    latest = self.experiments[-1].model_copy(deep=True)
                    latest.hypothesis = line
                    self.experiments[-1] = latest
        self._schedule_broadcast()

    def handle_process_exit(self, _: int) -> None:
        with self.lock:
            if self.current_session_id:
                self.db.end_session(self.current_session_id)
        self._schedule_broadcast()

    def handle_file_event(self, changed_path: Path) -> None:
        with self.lock:
            config = self.config
            parser = self.parser
        if not config:
            return

        resolved = changed_path.resolve()
        if parser and resolved == normalize_path(config.log_file):
            points, experiments = parser.consume_available()
            if points or experiments:
                with self.lock:
                    session_id = self.current_session_id
                    for point in points:
                        self.metric_points.append(point)
                        if session_id:
                            self.db.add_datapoint(session_id, point)
                    for experiment in self._merge_hypothesis(experiments):
                        self.experiments.append(experiment)
                        if session_id:
                            self.db.add_experiment(session_id, experiment)
                self._schedule_broadcast()

        if resolved == normalize_path(config.script_to_watch):
            with self.lock:
                self._refresh_diff_locked()
            self._schedule_broadcast()

    def shutdown(self) -> None:
        self.watcher.stop()
        self.process.shutdown()

    def _refresh_diff_locked(self) -> None:
        if not self.config:
            self.diff = DiffSnapshot()
            return
        script_path = normalize_path(self.config.script_to_watch)
        latest_commit = self.discovery.recent_commits[0] if self.discovery and self.discovery.recent_commits else None
        current = script_path.read_text(encoding="utf-8", errors="ignore") if script_path.exists() else ""
        previous = self.diff.after if self.diff.path == str(script_path) else current
        if not previous:
            previous = current
        self.diff = DiffSnapshot(
            path=str(script_path),
            before=previous,
            after=current,
            updated_at=utc_now(),
            latest_commit=latest_commit,
        )

    def _merge_hypothesis(self, experiments: list[ExperimentRecord]) -> list[ExperimentRecord]:
        if not self.last_hypothesis:
            return experiments
        merged: list[ExperimentRecord] = []
        for experiment in experiments:
            if experiment.hypothesis:
                merged.append(experiment)
                continue
            copy = experiment.model_copy(deep=True)
            copy.hypothesis = self.last_hypothesis
            merged.append(copy)
        return merged

    def _schedule_broadcast(self) -> None:
        if not self.loop:
            return
        now = threading.current_thread().ident
        self._broadcast_pending = True
        # Debounce: coalesce broadcasts within 100ms to prevent flooding
        if hasattr(self, '_broadcast_timer') and self._broadcast_timer:
            return  # already scheduled
        def _do_broadcast():
            self._broadcast_timer = None
            self._broadcast_pending = False
            if self.loop:
                self.loop.call_soon_threadsafe(asyncio.create_task, self.broadcast())
        self._broadcast_timer = threading.Timer(0.1, _do_broadcast)
        self._broadcast_timer.daemon = True
        self._broadcast_timer.start()

    async def register(self, websocket: WebSocket) -> bool:
        await websocket.accept()
        self.connections.add(websocket)
        try:
            await websocket.send_json(self.snapshot().model_dump(mode="json"))
        except Exception:
            self.connections.discard(websocket)
            return False
        return True

    async def unregister(self, websocket: WebSocket) -> None:
        self.connections.discard(websocket)

    async def broadcast(self) -> None:
        if not self.connections:
            return
        payload = self.snapshot().model_dump(mode="json")
        dead: list[WebSocket] = []
        for connection in tuple(self.connections):
            try:
                await connection.send_json(payload)
            except Exception:
                dead.append(connection)
        for connection in dead:
            self.connections.discard(connection)


coordinator = ResearchCoordinator()
ALLOWED_ORIGINS = parse_allowed_origins()


app = FastAPI(
    title="AutoResearch Sidecar",
    version="0.1.0",
    description="Real-time observer and controller for agentic research workflows.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def on_startup() -> None:
    coordinator.set_loop(asyncio.get_running_loop())
    auto_root = os.getenv("AUTORESEARCH_AUTO_PROJECT_ROOT")
    auto_config = parse_bool_env("AUTORESEARCH_AUTO_CONFIG", default=True)
    if auto_root and auto_config:
        with suppress(Exception):
            coordinator.auto_configure(auto_root)


@app.on_event("shutdown")
async def on_shutdown() -> None:
    coordinator.shutdown()


@app.get("/api/health", response_model=HealthReport)
async def health() -> HealthReport:
    return coordinator.health_report()


@app.get("/api/sessions")
async def list_sessions():
    return coordinator.db.list_sessions()


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: int):
    points, experiments = coordinator.db.get_session_data(session_id)
    return {"metric_points": points, "experiments": experiments}


@app.get("/api/discovery", response_model=DiscoveryResult)
async def discovery(root_path: str | None = Query(default=None)) -> DiscoveryResult:
    if root_path:
        return coordinator.discover(root_path)
    if coordinator.discovery:
        return coordinator.discovery
    return coordinator.discover(str(ROOT_DIR))


@app.post("/api/config", response_model=AppSnapshot)
async def configure(mapping: MappingConfig) -> AppSnapshot:
    return coordinator.apply_config(mapping)


@app.get("/api/state", response_model=AppSnapshot)
async def state() -> AppSnapshot:
    return coordinator.snapshot()


@app.post("/api/process/start", response_model=AppSnapshot)
async def start_process() -> AppSnapshot:
    return coordinator.start_process()


@app.post("/api/process/stop", response_model=AppSnapshot)
async def stop_process() -> AppSnapshot:
    return coordinator.stop_process()


@app.post("/api/process/restart", response_model=AppSnapshot)
async def restart_process() -> AppSnapshot:
    return coordinator.restart_process()


@app.websocket("/ws")
async def websocket_stream(websocket: WebSocket) -> None:
    origin = websocket.headers.get("origin")
    if origin and origin not in ALLOWED_ORIGINS:
        await websocket.close(code=1008, reason="Origin not allowed")
        return
    if not await coordinator.register(websocket):
        return
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await coordinator.unregister(websocket)


@app.get("/api/git/timeline", response_model=list[CommitMetricPoint])
async def git_timeline() -> list[CommitMetricPoint]:
    """Return git commits overlaid with the best metric achieved up to each commit's timestamp."""
    if not coordinator.config:
        raise HTTPException(status_code=400, detail="No config loaded.")
    root = normalize_path(coordinator.config.project_root)
    _git_root, commits = DatabaseManager.git_summary(root)
    if not commits:
        return []

    session_id = coordinator.current_session_id
    goal = coordinator.config.optimization_goal
    datapoints: list[tuple[float, str]] = coordinator.db.get_datapoints_for_timeline(session_id) if session_id else []

    result: list[CommitMetricPoint] = []
    for commit in commits:
        earlier = [v for v, ts in datapoints if ts <= commit.authored_at]
        best: float | None = None
        if earlier:
            best = min(earlier) if goal == "minimize" else max(earlier)
        result.append(CommitMetricPoint(
            sha=commit.sha,
            summary=commit.summary,
            authored_at=commit.authored_at,
            best_metric=best,
            iteration_count=len(earlier),
        ))
    return result


@app.post("/api/git/rollback")
async def git_rollback(sha: str = Query(..., description="Commit SHA to check out")) -> dict[str, str]:
    """Check out a specific commit in the watched project repo (puts repo in detached HEAD)."""
    if not coordinator.config:
        raise HTTPException(status_code=400, detail="No config loaded.")
    root = normalize_path(coordinator.config.project_root)
    try:
        repo = Repo(root, search_parent_directories=True)
        repo.git.checkout(sha)
        # Refresh coordinator state after rollback
        with coordinator.lock:
            coordinator._refresh_diff_locked()
            coordinator.discovery = DatabaseManager.discover(root)
        coordinator._schedule_broadcast()
        return {"ok": "true", "sha": sha, "message": f"Rolled back to {sha}. Repo is now in detached HEAD state."}
    except InvalidGitRepositoryError:
        raise HTTPException(status_code=400, detail="Project root is not a Git repository.")
    except GitCommandError as exc:
        raise HTTPException(status_code=400, detail=f"Git rollback failed: {exc}")


@app.get("/api/export/markdown")
async def export_markdown() -> Response:
    """Generate a Markdown research summary for the current session."""
    snap = coordinator.snapshot()
    config = snap.config
    if not config:
        raise HTTPException(status_code=400, detail="No config loaded.")

    lines: list[str] = [
        "# AutoResearchUI — Research Summary",
        "",
        f"**Generated:** {utc_now()[:19].replace('T', ' ')} UTC",
        f"**Project:** `{config.project_root}`",
        f"**Script:** `{Path(config.script_to_watch).name}`",
        f"**Log file:** `{Path(config.log_file).name}`",
        f"**Metric:** `{config.y_axis_metric}` ({config.optimization_goal})",
        "",
    ]

    points = snap.metric_points
    experiments = snap.experiments

    if points:
        metrics = [p.metric for p in points]
        best = min(metrics) if config.optimization_goal == "minimize" else max(metrics)
        best_iter = next((p.iteration for p in points if p.metric == best), "?")
        lines += [
            "## Best Result",
            "",
            f"| Metric | Value | Iteration |",
            f"|--------|-------|-----------|",
            f"| `{config.y_axis_metric}` | **{best:.4f}** | #{best_iter} |",
            "",
        ]

    kept = sum(1 for e in experiments if e.status == "KEPT")
    discarded = sum(1 for e in experiments if e.status == "DISCARDED")
    lines += [
        "## Run Statistics",
        "",
        f"- **Total iterations:** {len(experiments)}",
        f"- **Kept:** {kept}",
        f"- **Discarded:** {discarded}",
        f"- **Data points:** {len(points)}",
        "",
    ]

    if experiments:
        col = config.y_axis_metric or "metric"
        lines += [
            "## Experiment Log",
            "",
            f"| # | Status | {col} | Hypothesis |",
            f"|---|--------|{'-' * max(len(col), 6)}|------------|",
        ]
        for exp in experiments:
            mv = f"{exp.metric_value:.4f}" if exp.metric_value is not None else "n/a"
            hyp = (exp.hypothesis or "").replace("|", "\\|")[:100]
            lines.append(f"| {exp.iteration} | {exp.status} | {mv} | {hyp} |")
        lines.append("")

    if snap.diff.path:
        lines += [
            "## Latest Code Delta",
            "",
            f"**File:** `{snap.diff.path}`",
            "",
        ]

    content = "\n".join(lines)
    return Response(
        content=content,
        media_type="text/markdown",
        headers={"Content-Disposition": 'attachment; filename="research_summary.md"'},
    )


@app.get("/api/gpu", response_model=list[GpuStats])
async def gpu_status() -> list[GpuStats]:
    """Stream current GPU utilization, memory, temperature and wattage via nvidia-smi."""
    return query_gpu_stats()


@app.post("/api/llm/analyze")
async def llm_analyze(
    model: str = Query(default="llama3.2", description="Ollama model name"),
    ollama_url: str = Query(default="http://localhost:11434", description="Ollama base URL"),
) -> dict[str, str]:
    """Ask a local LLM (Ollama) to explain why recent experiments succeeded or failed."""
    if not _HTTPX_AVAILABLE:
        raise HTTPException(status_code=503, detail="httpx not available. Install httpx to enable LLM analysis.")

    snap = coordinator.snapshot()
    config = snap.config
    if not config:
        raise HTTPException(status_code=400, detail="No config loaded.")

    experiments = snap.experiments[-12:]
    stdout_lines = snap.stdout_tail[-15:]
    exp_lines = "\n".join(
        f"  - Iter {e.iteration}: {e.status}, "
        f"{config.y_axis_metric}={f'{e.metric_value:.4f}' if e.metric_value is not None else 'n/a'}"
        + (f', hypothesis: "{e.hypothesis[:120]}"' if e.hypothesis else "")
        for e in experiments
    )

    prompt = (
        f"You are an AI research assistant analyzing an automated experiment loop.\n\n"
        f"Metric being tracked: `{config.y_axis_metric}` (goal: {config.optimization_goal})\n"
        f"Script under optimization: {Path(config.script_to_watch).name}\n\n"
        f"Recent experiments:\n{exp_lines or '  (no experiments yet)'}\n\n"
        f"Last stdout lines:\n{chr(10).join('  ' + l for l in stdout_lines) or '  (no output)'}\n\n"
        f"In 3-4 concise sentences, answer:\n"
        f"1. What trend do you observe in the metric?\n"
        f"2. Why might recent experiments be succeeding or failing?\n"
        f"3. What concrete change would you try next?"
    )

    import httpx as _httpx_local  # noqa: PLC0415
    try:
        async with _httpx_local.AsyncClient(timeout=45.0) as client:
            resp = await client.post(
                f"{ollama_url.rstrip('/')}/api/generate",
                json={"model": model, "prompt": prompt, "stream": False},
            )
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail=f"Ollama returned HTTP {resp.status_code}: {resp.text[:200]}")
        return {"analysis": resp.json().get("response", "").strip(), "model": model}
    except _httpx_local.ConnectError:
        raise HTTPException(status_code=503, detail=f"Cannot reach Ollama at {ollama_url}. Run `ollama serve` first.")
    except _httpx_local.TimeoutException:
        raise HTTPException(status_code=504, detail="Ollama took too long to respond.")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"LLM analysis failed: {exc}") from exc


@app.get("/api/export/html")
async def export_html() -> Response:
    """Export a standalone interactive HTML report with embedded Chart.js visualisation."""
    snap = coordinator.snapshot()
    config = snap.config
    if not config:
        raise HTTPException(status_code=400, detail="No config loaded.")

    project_name = _html_mod.escape(Path(config.project_root).name or "project")
    metric = _html_mod.escape(config.y_axis_metric)
    goal = config.optimization_goal

    points_json = json.dumps([{"x": p.iteration, "y": p.metric} for p in snap.metric_points])
    experiments_json = json.dumps([
        {
            "iteration": e.iteration,
            "status": e.status,
            "metric": e.metric_value,
            "hypothesis": (e.hypothesis or "")[:200],
        }
        for e in snap.experiments
    ])

    gpu_info = ""
    gpus = query_gpu_stats()
    if gpus:
        gpu_info = _html_mod.escape(" | ".join(
            f"{g.name}: {g.utilization_pct}% util, {g.memory_used_mb}/{g.memory_total_mb} MB"
            + (f", {g.temperature_c}°C" if g.temperature_c else "")
            + (f", {g.watts:.0f}W" if g.watts else "")
            for g in gpus
        ))

    best_str = "n/a"
    if snap.metric_points:
        metrics = [p.metric for p in snap.metric_points]
        best_val = min(metrics) if goal == "minimize" else max(metrics)
        best_iter = next(p.iteration for p in snap.metric_points if p.metric == best_val)
        best_str = f"{best_val:.4f} @ iter #{best_iter}"

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Research Summary — {project_name}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <style>
    *{{box-sizing:border-box;margin:0;padding:0}}
    body{{font-family:monospace;background:#fff;color:#000;max-width:1100px;margin:48px auto;padding:0 24px}}
    h1{{font-size:2.4rem;font-weight:900;letter-spacing:-0.04em;border-bottom:3px solid #000;padding-bottom:12px;margin-bottom:8px}}
    .meta{{font-size:.7rem;color:#666;margin-bottom:32px;line-height:2}}
    .stats{{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:36px}}
    .stat{{border:1px solid #000;padding:16px}}
    .stat-label{{font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.15em;color:#888}}
    .stat-value{{font-size:1.6rem;font-weight:900;letter-spacing:-.03em;margin-top:4px}}
    .chart-wrap{{border:1px solid #000;padding:24px;margin-bottom:36px}}
    table{{width:100%;border-collapse:collapse;font-size:.75rem}}
    th{{border-bottom:2px solid #000;text-align:left;padding:8px 12px;font-weight:900;text-transform:uppercase;letter-spacing:.1em;font-size:.65rem}}
    td{{border-bottom:1px solid #eee;padding:8px 12px;vertical-align:top}}
    .KEPT{{color:#000;font-weight:900}}
    .DISCARDED{{color:#bbb}}
    .INFO{{color:#888}}
    .gpu-bar{{background:#000;color:#fff;font-size:.65rem;font-weight:700;padding:6px 12px;margin-bottom:28px;letter-spacing:.1em}}
    footer{{margin-top:48px;font-size:.65rem;color:#bbb;border-top:1px solid #eee;padding-top:16px}}
  </style>
</head>
<body>
  <h1>{project_name}</h1>
  <div class="meta">
    <strong>Metric:</strong> {metric} &nbsp;({goal}) &nbsp;&nbsp;
    <strong>Script:</strong> {Path(config.script_to_watch).name} &nbsp;&nbsp;
    <strong>Log:</strong> {Path(config.log_file).name} &nbsp;&nbsp;
    <strong>Generated:</strong> {utc_now()[:19].replace("T", " ")} UTC
  </div>
  {"<div class='gpu-bar'>GPU: " + gpu_info + "</div>" if gpu_info else ""}
  <div class="stats">
    <div class="stat"><div class="stat-label">Best {metric}</div><div class="stat-value" id="best">{best_str}</div></div>
    <div class="stat"><div class="stat-label">Total Iterations</div><div class="stat-value" id="total">…</div></div>
    <div class="stat"><div class="stat-label">Kept / Discarded</div><div class="stat-value" id="kd">…</div></div>
  </div>
  <div class="chart-wrap"><canvas id="chart" style="max-height:320px"></canvas></div>
  <table>
    <thead><tr><th>#</th><th>Status</th><th>{metric}</th><th>Hypothesis</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <footer>Generated by AutoResearchUI &mdash; <a href="https://github.com/anthropics/AutoResearchUI">github.com/anthropics/AutoResearchUI</a></footer>
  <script>
    const points = {points_json};
    const experiments = {experiments_json};
    // Stats
    document.getElementById('total').textContent = experiments.length;
    const kept = experiments.filter(e=>e.status==='KEPT').length;
    document.getElementById('kd').textContent = kept + ' / ' + (experiments.length - kept);
    // Chart
    new Chart(document.getElementById('chart'),{{
      type:'line',
      data:{{labels:points.map(p=>'#'+p.x),datasets:[{{label:'{metric}',data:points.map(p=>p.y),borderColor:'#000',borderWidth:2.5,pointRadius:3,pointHoverRadius:6,fill:false,tension:0}}]}},
      options:{{responsive:true,plugins:{{legend:{{display:false}},tooltip:{{callbacks:{{label:ctx=>ctx.dataset.label+': '+ctx.parsed.y.toFixed(4)}}}}}},scales:{{y:{{grid:{{color:'#f0f0f0'}},ticks:{{font:{{family:'monospace',weight:'bold'}}}}}},x:{{grid:{{display:false}},ticks:{{font:{{family:'monospace',weight:'bold',size:10}},maxRotation:0,autoSkip:true,maxTicksLimit:12}}}}}}}}
    }});
    // Table
    const tbody=document.getElementById('rows');
    [...experiments].reverse().forEach(e=>{{
      const tr=document.createElement('tr');
      tr.innerHTML='<td>'+e.iteration+'</td><td class="'+e.status+'">'+e.status+'</td><td>'+(e.metric!==null?e.metric.toFixed(4):'n/a')+'</td><td style="max-width:420px;white-space:normal;">'+((e.hypothesis||'').replace(/</g,'&lt;').replace(/>/g,'&gt;'))+'</td>';
      tbody.appendChild(tr);
    }});
  </script>
</body>
</html>"""

    return Response(
        content=html,
        media_type="text/html",
        headers={"Content-Disposition": f'attachment; filename="research_summary_{project_name}.html"'},
    )
