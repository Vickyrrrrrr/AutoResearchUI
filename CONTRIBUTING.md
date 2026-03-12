# Contributing

## Scope

AutoResearchUI is intended to stay:

- local-first
- repo-agnostic
- simple to launch from a CLI
- useful for real research loops rather than toy dashboards

Contributions that improve those goals are welcome.

## Before Opening A PR

1. Open an issue for significant changes.
2. Keep the change focused.
3. Avoid user-hostile defaults.
4. Preserve the local trust model.

## Development Setup

```powershell
python -m pip install -e .
npm install
```

Run the backend:

```powershell
uvicorn app_backend:app --reload --host 127.0.0.1 --port 8000
```

Run the frontend:

```powershell
npm run dev
```

Run the CLI locally:

```powershell
python autoresearchui_cli.py --help
```

## Pull Request Guidelines

- Add or update docs when behavior changes.
- Prefer backward-compatible CLI changes.
- Do not introduce assumptions about one specific research domain.
- Keep dependencies justified and minimal.
- If you change default behavior, explain why.

## Reporting Bugs

Include:

- operating system
- Python version
- Node version
- how you launched the tool
- whether the target repo had `.git`
- relevant log output or stack traces
