from __future__ import annotations

import asyncio
import csv
import json
import os
import socket
import shlex
import subprocess
import sys
import threading
from collections import deque
from contextlib import suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Literal

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from git import InvalidGitRepositoryError, NoSuchPathError, Repo
from pydantic import BaseModel, Field
from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer


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


class GitCommit(BaseModel):
    sha: str
    summary: str
    authored_at: str


class DiscoveryResult(BaseModel):
    project_root: str
    git_root: str | None = None
    git_present: bool = False
    log_candidates: list[str] = Field(default_factory=list)
    script_candidates: list[str] = Field(default_factory=list)
    headers_by_file: dict[str, list[str]] = Field(default_factory=dict)
    recent_commits: list[GitCommit] = Field(default_factory=list)


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


class ProjectScanner:
    LOG_SUFFIXES = {".csv", ".tsv", ".json"}
    SCRIPT_SUFFIXES = {".py", ".v"}
    SKIP_DIRS = {".git", ".next", "node_modules", "dist", "build", "__pycache__", ".venv", "venv", ".vendor", ".mypy_cache"}
    IGNORE_LOG_NAMES = {"package.json", "package-lock.json", "tsconfig.json", "tsconfig.tsbuildinfo"}

    @classmethod
    def discover(cls, root: Path) -> DiscoveryResult:
        if not root.exists() or not root.is_dir():
            raise HTTPException(status_code=404, detail=f"Project root does not exist: {root}")

        logs: list[Path] = []
        scripts: list[Path] = []
        headers_by_file: dict[str, list[str]] = {}
        for current_root, dir_names, file_names in os.walk(root):
            dir_names[:] = [name for name in dir_names if name not in cls.SKIP_DIRS]
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

        logs.sort(key=safe_mtime, reverse=True)
        scripts.sort(key=safe_mtime, reverse=True)

        for item in logs[:20]:
            headers_by_file[str(item)] = cls.infer_headers(item)

        git_root, commits = cls.git_summary(root)
        return DiscoveryResult(
            project_root=str(root),
            git_root=str(git_root) if git_root else None,
            git_present=git_root is not None,
            log_candidates=[str(item) for item in logs[:20]],
            script_candidates=[str(item) for item in scripts[:20]],
            headers_by_file=headers_by_file,
            recent_commits=commits,
        )

    @classmethod
    def infer_headers(cls, path: Path) -> list[str]:
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

        if suffix == ".json":
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

        return []

    @classmethod
    def git_summary(cls, root: Path) -> tuple[Path | None, list[GitCommit]]:
        try:
            repo = Repo(root, search_parent_directories=True)
        except (InvalidGitRepositoryError, NoSuchPathError):
            return None, []

        commits: list[GitCommit] = []
        for commit in repo.iter_commits(max_count=5):
            commits.append(
                GitCommit(
                    sha=commit.hexsha[:10],
                    summary=commit.summary,
                    authored_at=datetime.fromtimestamp(commit.authored_date, timezone.utc).isoformat(),
                )
            )
        return Path(repo.working_tree_dir).resolve(), commits


class AutoMapper:
    MAXIMIZE_HINTS = ("accuracy", "acc", "score", "reward", "f1", "precision", "recall", "slack", "throughput")
    MINIMIZE_HINTS = ("loss", "error", "wer", "cer", "bpb", "area", "power", "latency", "runtime", "cost")
    METRIC_PRIORITY = (
        "accuracy",
        "acc",
        "score",
        "reward",
        "f1",
        "timing_slack",
        "slack",
        "loss",
        "bpb",
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
        "status",
        "result",
        "decision",
        "hypothesis",
        "reasoning",
        "agent_reasoning",
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
        headers = discovery.headers_by_file.get(log_file, [])
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
            research_command=cls.default_command(Path(script)),
        )

    @classmethod
    def pick_metric(cls, headers: list[str]) -> str | None:
        if not headers:
            return None

        lowered = {header.lower(): header for header in headers}
        for name in cls.METRIC_PRIORITY:
            if name in lowered:
                return lowered[name]

        for header in headers:
            if header.lower() not in cls.NON_METRIC_KEYS:
                return header
        return headers[0]

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
            return self._parse_delimited(chunk, delimiter="\t" if suffix == ".tsv" else ",")
        if suffix == ".json":
            return self._parse_json(chunk, start_offset=start_offset)
        return []

    def _parse_delimited(self, chunk: str, delimiter: str) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for raw_line in chunk.splitlines():
            if not raw_line.strip():
                continue
            parsed = next(csv.reader([raw_line], delimiter=delimiter))
            if self.header is None:
                self.header = parsed
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
        raw_status = pick_first(row, ("status", "result", "decision"))
        if isinstance(raw_status, str):
            normalized = raw_status.strip().lower()
            if normalized in {"kept", "accepted", "pass", "passed", "improved"}:
                status: ExperimentStatus = "KEPT"
            elif normalized in {"discarded", "rejected", "fail", "failed", "regressed"}:
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
            ("hypothesis", "reasoning", "agent_reasoning", "thought", "summary", "message", "notes"),
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
        discovery = ProjectScanner.discover(root)
        with self.lock:
            self.discovery = discovery
        self._schedule_broadcast()
        return discovery

    def apply_config(self, config: MappingConfig) -> AppSnapshot:
        root = normalize_path(config.project_root)
        script = normalize_path(config.script_to_watch)
        log_file = normalize_path(config.log_file)
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
        if not log_file.exists() or not log_file.is_file():
            raise HTTPException(status_code=404, detail=f"Log file not found: {log_file}")

        available_headers = ProjectScanner.infer_headers(log_file)
        if available_headers and config.y_axis_metric not in available_headers:
            raise HTTPException(
                status_code=400,
                detail=f"Metric '{config.y_axis_metric}' was not found in the selected log file headers.",
            )

        resolved = MappingConfig(
            project_root=str(root),
            script_to_watch=str(script),
            log_file=str(log_file),
            y_axis_metric=config.y_axis_metric,
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
            self.discovery = ProjectScanner.discover(root)
            self._refresh_diff_locked()

        self.watcher.watch(root)
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

        git_root, _ = ProjectScanner.git_summary(normalize_path(config.project_root))
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
                    for point in points:
                        self.metric_points.append(point)
                    for experiment in self._merge_hypothesis(experiments):
                        self.experiments.append(experiment)
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
        self.loop.call_soon_threadsafe(asyncio.create_task, self.broadcast())

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
        for connection in self.connections:
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
