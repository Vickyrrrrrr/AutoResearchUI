from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from contextlib import suppress
from pathlib import Path

from git import InvalidGitRepositoryError, NoSuchPathError, Repo


APP_ROOT = Path(__file__).resolve().parent
DEFAULT_BACKEND_HOST = "127.0.0.1"
DEFAULT_BACKEND_PORT = 8000
DEFAULT_FRONTEND_HOST = "127.0.0.1"
DEFAULT_FRONTEND_PORT = 3000
HEALTH_TIMEOUT_SECONDS = 45


def build_allowed_origins(frontend_host: str, frontend_port: int) -> str:
    origins = {
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        f"http://{frontend_host}:{frontend_port}",
    }
    if frontend_host in {"0.0.0.0", "127.0.0.1"}:
        origins.add(f"http://localhost:{frontend_port}")
        origins.add(f"http://127.0.0.1:{frontend_port}")
    return ",".join(sorted(origins))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="autoresearchui",
        description="Launch AutoResearchUI against the current Git repository or an explicit project path.",
    )
    parser.add_argument("--project-root", help="Explicit path to the project to monitor. Defaults to the current Git repo.")
    parser.add_argument(
        "--non-interactive",
        action="store_true",
        help="Keep the auto-detected mapping without prompting. This is now the default behavior.",
    )
    parser.add_argument(
        "--interactive-mapping",
        action="store_true",
        help="Prompt for script, log file, metric, and command instead of using the detected mapping.",
    )
    parser.add_argument("--backend-host", default=DEFAULT_BACKEND_HOST)
    parser.add_argument("--backend-port", default=DEFAULT_BACKEND_PORT, type=int)
    parser.add_argument("--frontend-host", default=DEFAULT_FRONTEND_HOST)
    parser.add_argument("--frontend-port", default=DEFAULT_FRONTEND_PORT, type=int)
    parser.add_argument("--no-open-browser", action="store_true", help="Do not open the browser after the UI is ready.")
    parser.add_argument("--skip-install", action="store_true", help="Do not auto-install missing Python or npm dependencies.")
    parser.add_argument(
        "--bootstrap-project",
        action="store_true",
        help="Opt in to installing dependencies of the detected target research repo.",
    )
    parser.add_argument("--backend-only", action="store_true", help="Start only the FastAPI backend.")
    parser.add_argument("--frontend-only", action="store_true", help="Start only the Next.js frontend.")
    return parser.parse_args()


def detect_project_root(explicit_root: str | None) -> Path:
    if explicit_root:
        root = Path(explicit_root).expanduser().resolve()
        if not root.exists():
            raise SystemExit(f"Project root does not exist: {root}")
        return root

    try:
        repo = Repo(Path.cwd(), search_parent_directories=True)
    except (InvalidGitRepositoryError, NoSuchPathError):
        raise SystemExit(
            "No Git repository detected from the current directory. Run this inside your research repo or pass --project-root."
        ) from None
    return Path(repo.working_tree_dir).resolve()


def detect_npm_executable() -> str:
    for candidate in ("npm.cmd", "npm"):
        executable = shutil.which(candidate)
        if executable:
            return executable
    raise SystemExit("npm was not found on PATH. Install Node.js 18+ to launch the web UI.")


def detect_uv_executable() -> str | None:
    for candidate in ("uv.exe", "uv"):
        executable = shutil.which(candidate)
        if executable:
            return executable
    return None


def port_open(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((host, port)) == 0


def ensure_port_available(host: str, port: int, label: str) -> None:
    if port_open(host, port):
        raise SystemExit(f"{label} port {host}:{port} is already in use.")


def ensure_python_dependencies(skip_install: bool) -> None:
    code = "import fastapi, uvicorn, pydantic, watchdog, git"
    check = subprocess.run([sys.executable, "-c", code], cwd=str(APP_ROOT), capture_output=True, text=True)
    if check.returncode == 0:
        return
    if skip_install:
        raise SystemExit("Python dependencies are missing. Install them with `pip install -r requirements.txt`.")

    subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", "requirements.txt"],
        cwd=str(APP_ROOT),
        check=True,
    )


def ensure_frontend_dependencies(skip_install: bool, npm_executable: str) -> None:
    next_binary = APP_ROOT / "node_modules" / ".bin" / ("next.cmd" if os.name == "nt" else "next")
    if next_binary.exists():
        return
    if skip_install:
        raise SystemExit("Frontend dependencies are missing. Install them with `npm install`.")

    subprocess.run([npm_executable, "install"], cwd=str(APP_ROOT), check=True)


def repo_has_file(root: Path, name: str) -> bool:
    return (root / name).exists()


def run_bootstrap(command: list[str], cwd: Path, label: str) -> None:
    print(f"[autoresearchui] Bootstrapping {label}: {' '.join(command)}")
    subprocess.run(command, cwd=str(cwd), check=True)


def bootstrap_target_repo(project_root: Path) -> None:
    uv_executable = detect_uv_executable()
    npm_executable = detect_npm_executable() if repo_has_file(project_root, "package.json") else None

    if repo_has_file(project_root, "uv.lock") and uv_executable:
        run_bootstrap([uv_executable, "sync"], cwd=project_root, label="project Python deps with uv")
    elif repo_has_file(project_root, "requirements.txt"):
        run_bootstrap([sys.executable, "-m", "pip", "install", "-r", "requirements.txt"], cwd=project_root, label="project Python deps from requirements.txt")
    elif repo_has_file(project_root, "pyproject.toml"):
        run_bootstrap([sys.executable, "-m", "pip", "install", "-e", "."], cwd=project_root, label="project Python deps from pyproject.toml")
    else:
        print("[autoresearchui] No Python dependency manifest detected in target repo.")

    if npm_executable:
        run_bootstrap([npm_executable, "install"], cwd=project_root, label="project Node deps")


def build_runtime_env() -> dict[str, str]:
    env = os.environ.copy()
    # Local vendored dependencies are for repository-side testing only.
    # End-user runs should rely on the active interpreter environment so
    # compiled wheels like pydantic_core match the user's Python version.
    if os.getenv("AUTORESEARCH_USE_VENDOR") == "1":
        vendor_path = APP_ROOT / ".vendor"
        if vendor_path.exists():
            current = env.get("PYTHONPATH", "")
            env["PYTHONPATH"] = str(vendor_path) if not current else os.pathsep.join([str(vendor_path), current])
    return env


def wait_for_http(url: str, timeout_seconds: int) -> None:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        with suppress(urllib.error.URLError, TimeoutError):
            with urllib.request.urlopen(url, timeout=2) as response:
                if 200 <= response.status < 500:
                    return
        time.sleep(0.5)
    raise SystemExit(f"Timed out waiting for {url}")


def post_json(url: str, payload: dict[str, object]) -> dict[str, object]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


def wait_for_port(host: str, port: int, timeout_seconds: int) -> None:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if port_open(host, port):
            return
        time.sleep(0.5)
    raise SystemExit(f"Timed out waiting for {host}:{port}")


def frontend_ready_urls(host: str, port: int) -> list[str]:
    candidates = [f"http://{host}:{port}"]
    if host == "127.0.0.1":
        candidates.append(f"http://localhost:{port}")
    elif host == "localhost":
        candidates.append(f"http://127.0.0.1:{port}")
    return candidates


def wait_for_frontend(process: subprocess.Popen[str], host: str, port: int, timeout_seconds: int) -> str:
    urls = frontend_ready_urls(host, port)
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if process.poll() is not None:
            raise SystemExit(
                f"Frontend process exited early with code {process.returncode}. "
                "Run `npm install` in the AutoResearchUI repo and retry."
            )
        for url in urls:
            with suppress(urllib.error.URLError, TimeoutError):
                with urllib.request.urlopen(url, timeout=2) as response:
                    if 200 <= response.status < 500:
                        return url
        time.sleep(0.5)
    joined = " or ".join(urls)
    raise SystemExit(
        f"Timed out waiting for the web UI at {joined}. "
        f"Try `autoresearchui --frontend-host 127.0.0.1 --frontend-port {port}`."
    )


def start_backend(
    project_root: Path,
    host: str,
    port: int,
    auto_config: bool,
    allowed_origins: str,
) -> subprocess.Popen[str]:
    env = build_runtime_env()
    env["AUTORESEARCH_AUTO_PROJECT_ROOT"] = str(project_root)
    env["AUTORESEARCH_AUTO_CONFIG"] = "1" if auto_config else "0"
    env["AUTORESEARCH_ALLOWED_ORIGINS"] = allowed_origins

    command = [
        sys.executable,
        "-m",
        "uvicorn",
        "app_backend:app",
        "--host",
        host,
        "--port",
        str(port),
    ]
    return subprocess.Popen(command, cwd=str(APP_ROOT), env=env)


def start_frontend(
    npm_executable: str,
    host: str,
    port: int,
    backend_host: str,
    backend_port: int,
) -> subprocess.Popen[str]:
    env = os.environ.copy()
    env["NEXT_PUBLIC_AUTORESEARCH_API"] = f"http://{backend_host}:{backend_port}"
    command = [npm_executable, "run", "dev", "--", "--hostname", host, "--port", str(port)]
    return subprocess.Popen(command, cwd=str(APP_ROOT), env=env)


def terminate_process(process: subprocess.Popen[str] | None) -> None:
    if not process or process.poll() is not None:
        return
    with suppress(Exception):
        process.terminate()
        process.wait(timeout=8)
    if process.poll() is None:
        with suppress(Exception):
            process.kill()


def load_repo_models():
    if str(APP_ROOT) not in sys.path:
        sys.path.insert(0, str(APP_ROOT))
    from app_backend import AutoMapper, MappingConfig, ProjectScanner

    return ProjectScanner, AutoMapper, MappingConfig


def relative_to_project(project_root: Path, candidate: str) -> str:
    path = Path(candidate)
    with suppress(ValueError):
        return str(path.relative_to(project_root))
    return str(path)


def prompt_text(label: str, default: str) -> str:
    response = input(f"{label} [{default}]: ").strip()
    return response or default


def prompt_file_choice(label: str, options: list[str], project_root: Path, default_value: str | None = None) -> str:
    if not options:
        manual = input(f"{label} (enter a path): ").strip()
        if not manual:
            raise SystemExit(f"{label} is required.")
        return str((project_root / manual).resolve()) if not Path(manual).is_absolute() else str(Path(manual).resolve())

    default_index = 0
    if default_value and default_value in options:
        default_index = options.index(default_value)

    print(f"\n{label}:")
    for index, option in enumerate(options, start=1):
        marker = " (default)" if index - 1 == default_index else ""
        print(f"  {index}. {relative_to_project(project_root, option)}{marker}")
    print("  m. enter a path manually")

    response = input(f"Select {label.lower()} [{default_index + 1}]: ").strip().lower()
    if not response:
        return options[default_index]
    if response == "m":
        manual = input(f"Enter {label.lower()} path: ").strip()
        if not manual:
            raise SystemExit(f"{label} is required.")
        return str((project_root / manual).resolve()) if not Path(manual).is_absolute() else str(Path(manual).resolve())

    try:
        selection = int(response) - 1
    except ValueError as exc:
        raise SystemExit(f"Invalid selection for {label}: {response}") from exc
    if selection < 0 or selection >= len(options):
        raise SystemExit(f"Invalid selection for {label}: {response}")
    return options[selection]


def prompt_value_choice(label: str, options: list[str], default_value: str | None = None) -> str:
    if not options:
        manual = input(f"{label}: ").strip()
        if not manual:
            raise SystemExit(f"{label} is required.")
        return manual

    default_index = 0
    if default_value and default_value in options:
        default_index = options.index(default_value)

    print(f"\n{label}:")
    for index, option in enumerate(options, start=1):
        marker = " (default)" if index - 1 == default_index else ""
        print(f"  {index}. {option}{marker}")
    print("  m. enter a value manually")

    response = input(f"Select {label.lower()} [{default_index + 1}]: ").strip().lower()
    if not response:
        return options[default_index]
    if response == "m":
        manual = input(f"Enter {label.lower()}: ").strip()
        if not manual:
            raise SystemExit(f"{label} is required.")
        return manual

    try:
        selection = int(response) - 1
    except ValueError as exc:
        raise SystemExit(f"Invalid selection for {label}: {response}") from exc
    if selection < 0 or selection >= len(options):
        raise SystemExit(f"Invalid selection for {label}: {response}")
    return options[selection]


def prompt_goal(default_goal: str) -> str:
    response = input(f"Optimization goal [1=minimize, 2=maximize, default={default_goal}]: ").strip()
    if not response:
        return default_goal
    if response == "1":
        return "minimize"
    if response == "2":
        return "maximize"
    lowered = response.lower()
    if lowered in {"minimize", "maximize"}:
        return lowered
    raise SystemExit(f"Invalid optimization goal: {response}")


def build_mapping(project_root: Path, interactive: bool) -> dict[str, object] | None:
    ProjectScanner, AutoMapper, MappingConfig = load_repo_models()
    discovery = ProjectScanner.discover(project_root)
    suggested = AutoMapper.build_config(discovery)

    if not interactive or not sys.stdin.isatty():
        if suggested:
            print("[autoresearchui] Auto-detected project mapping.")
            print(f"[autoresearchui] Script: {relative_to_project(project_root, suggested.script_to_watch)}")
            print(f"[autoresearchui] Log file: {relative_to_project(project_root, suggested.log_file)}")
            print(f"[autoresearchui] Metric: {suggested.y_axis_metric} ({suggested.optimization_goal})")
            return suggested.model_dump()
        print("[autoresearchui] Could not confidently auto-map the repo. Launching the backend and UI without a pinned mapping.")
        return None

    print("\n[autoresearchui] Review the detected project mapping.")
    print("[autoresearchui] Press Enter to accept the default selection shown in each prompt.\n")

    default_script = suggested.script_to_watch if suggested else discovery.script_candidates[0] if discovery.script_candidates else None
    script_to_watch = prompt_file_choice("Script to watch", discovery.script_candidates, project_root, default_script)

    default_log = suggested.log_file if suggested else discovery.log_candidates[0] if discovery.log_candidates else None
    log_file = prompt_file_choice("Log file", discovery.log_candidates, project_root, default_log)

    headers = discovery.headers_by_file.get(log_file)
    if headers is None:
        headers = ProjectScanner.infer_headers(Path(log_file))
    metric_options = headers or discovery.suggested_metrics
    default_metric = suggested.y_axis_metric if suggested and suggested.log_file == log_file else AutoMapper.pick_metric(metric_options or [])
    y_axis_metric = prompt_value_choice("Y-axis metric", metric_options or [], default_metric)

    default_goal = suggested.optimization_goal if suggested and suggested.y_axis_metric == y_axis_metric else AutoMapper.infer_goal(y_axis_metric)
    optimization_goal = prompt_goal(default_goal)

    default_command = suggested.research_command if suggested and suggested.script_to_watch == script_to_watch else AutoMapper.default_command(Path(script_to_watch))
    research_command = prompt_text("Research command", default_command or "")

    mapping = MappingConfig(
        project_root=str(project_root),
        script_to_watch=str(Path(script_to_watch).resolve()),
        log_file=str(Path(log_file).resolve()),
        y_axis_metric=y_axis_metric,
        optimization_goal=optimization_goal,
        research_command=research_command or None,
    )
    return mapping.model_dump()


def main() -> int:
    args = parse_args()
    if args.backend_only and args.frontend_only:
        raise SystemExit("Choose only one of --backend-only or --frontend-only.")

    project_root = detect_project_root(args.project_root)
    try:
        repo = Repo(project_root, search_parent_directories=True)
    except (InvalidGitRepositoryError, NoSuchPathError):
        raise SystemExit(
            f"No Git repository detected at {project_root}. Run this inside a Git-based research repo or pass a valid --project-root."
        ) from None
    trusted_root = Path(repo.working_tree_dir).resolve()
    selected_mapping: dict[str, object] | None = None

    print(f"[autoresearchui] Detected project repo: {trusted_root}")
    print("[autoresearchui] Local trust rule: the current Git working tree is treated as the target research project.")
    if trusted_root == APP_ROOT:
        print(
            "[autoresearchui] You launched from the AutoResearchUI repo itself. "
            "If you want to monitor another repo, `cd` into that repo first or pass --project-root."
        )

    if not args.frontend_only:
        ensure_python_dependencies(skip_install=args.skip_install)
        ensure_port_available(args.backend_host, args.backend_port, "Backend")

    npm_executable: str | None = None
    if not args.backend_only:
        ensure_port_available(args.frontend_host, args.frontend_port, "Frontend")
        npm_executable = detect_npm_executable()
        ensure_frontend_dependencies(skip_install=args.skip_install, npm_executable=npm_executable)

    if trusted_root != APP_ROOT and args.bootstrap_project:
        bootstrap_target_repo(trusted_root)
    elif trusted_root != APP_ROOT:
        print("[autoresearchui] Target repo dependency bootstrap is disabled by default.")
        print("[autoresearchui] If you want AutoResearchUI to install target repo deps, pass --bootstrap-project.")
    else:
        print("[autoresearchui] Target repo bootstrap skipped because the detected repo is AutoResearchUI itself.")

    backend_process: subprocess.Popen[str] | None = None
    frontend_process: subprocess.Popen[str] | None = None

    try:
        if not args.frontend_only:
            should_prompt_for_mapping = args.interactive_mapping and not args.bootstrap_project
            selected_mapping = build_mapping(trusted_root, interactive=should_prompt_for_mapping)
            backend_process = start_backend(
                project_root=trusted_root,
                host=args.backend_host,
                port=args.backend_port,
                auto_config=selected_mapping is None,
                allowed_origins=build_allowed_origins(args.frontend_host, args.frontend_port),
            )
            wait_for_http(f"http://{args.backend_host}:{args.backend_port}/api/health", HEALTH_TIMEOUT_SECONDS)
            if selected_mapping:
                post_json(f"http://{args.backend_host}:{args.backend_port}/api/config", selected_mapping)
                print("[autoresearchui] Applied interactive project mapping.")
            print(f"[autoresearchui] Backend ready at http://{args.backend_host}:{args.backend_port}")

        if not args.backend_only:
            frontend_process = start_frontend(
                npm_executable=npm_executable or detect_npm_executable(),
                host=args.frontend_host,
                port=args.frontend_port,
                backend_host=args.backend_host,
                backend_port=args.backend_port,
            )
            frontend_url = wait_for_frontend(frontend_process, args.frontend_host, args.frontend_port, HEALTH_TIMEOUT_SECONDS)
            print(f"[autoresearchui] UI ready at {frontend_url}")
            if not args.no_open_browser:
                with suppress(Exception):
                    webbrowser.open(frontend_url, new=2)

        if args.frontend_only:
            print("[autoresearchui] Frontend-only mode enabled.")
        elif args.interactive_mapping and selected_mapping:
            print("[autoresearchui] Interactive mapping enabled. The selected repo files were applied before the UI opened.")
        elif selected_mapping:
            print("[autoresearchui] Auto-mapping enabled. The detected repo files were applied before the UI opened.")
        else:
            print("[autoresearchui] Auto-detection enabled. Finish the mapping in the UI if the repo could not be pinned automatically.")
        print("[autoresearchui] Press Ctrl+C to stop.")

        while True:
            if backend_process and backend_process.poll() is not None:
                return backend_process.returncode or 1
            if frontend_process and frontend_process.poll() is not None:
                return frontend_process.returncode or 1
            time.sleep(1)

    except KeyboardInterrupt:
        print("\n[autoresearchui] Stopping services...")
        return 0
    finally:
        terminate_process(frontend_process)
        terminate_process(backend_process)


if __name__ == "__main__":
    raise SystemExit(main())
