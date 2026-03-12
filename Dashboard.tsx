"use client";

import dynamic from "next/dynamic";
import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  startTransition,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowUpRight,
  Bot,
  Cable,
  Download,
  FolderSearch,
  GitCommitHorizontal,
  Pause,
  Play,
  RefreshCcw,
  Sparkles,
  SquareTerminal,
  TimerReset,
  TrendingDown,
  TrendingUp,
  Waves,
} from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type {
  AppSnapshot,
  DiscoveryResult,
  ExperimentRecord,
  HealthReport,
  MappingConfig,
  MetricPoint,
} from "./ProjectConfig";

const DiffViewer = dynamic(() => import("react-diff-viewer-continued"), { ssr: false });

const API_BASE = process.env.NEXT_PUBLIC_AUTORESEARCH_API ?? "http://127.0.0.1:8000";
const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

const INITIAL_CONFIG: MappingConfig = {
  project_root: "",
  script_to_watch: "",
  log_file: "",
  y_axis_metric: "",
  optimization_goal: "minimize",
  research_command: "",
};

const INITIAL_SNAPSHOT: AppSnapshot = {
  config: null,
  discovery: null,
  process: {
    status: "idle",
    pid: null,
    command: null,
    started_at: null,
    exited_at: null,
    return_code: null,
  },
  metric_points: [],
  experiments: [],
  diff: {
    path: null,
    before: "",
    after: "",
    updated_at: null,
    latest_commit: null,
  },
  stdout_tail: [],
  last_hypothesis: null,
  last_updated: new Date().toISOString(),
};

type ConnectionState = "checking" | "live" | "offline";

type CelebrationState = {
  iteration: number;
  value: number;
  delta: number;
};

type DashboardView = "overview" | "activity" | "diff";

function buildWsUrl(base: string) {
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  return url.toString();
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

function formatDate(value: string | null | undefined) {
  if (!value) {
    return "n/a";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : `${DATE_FORMATTER.format(parsed)} UTC`;
}

function formatMetric(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "n/a";
  }
  if (Math.abs(value) >= 1000) {
    return value.toFixed(1);
  }
  if (Math.abs(value) >= 10) {
    return value.toFixed(2);
  }
  return value.toFixed(4);
}

function compactText(value: string | null | undefined, maxLength = 88) {
  if (!value) {
    return "n/a";
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function downloadSvgElement(element: SVGSVGElement, filename: string) {
  const clone = element.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");

  const width = element.getAttribute("width") ?? String(element.clientWidth || 960);
  const height = element.getAttribute("height") ?? String(element.clientHeight || 480);
  clone.setAttribute("width", width);
  clone.setAttribute("height", height);

  if (!clone.getAttribute("viewBox")) {
    clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }

  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  background.setAttribute("x", "0");
  background.setAttribute("y", "0");
  background.setAttribute("width", "100%");
  background.setAttribute("height", "100%");
  background.setAttribute("fill", "#fbf8f1");
  clone.insertBefore(background, clone.firstChild);

  const blob = new Blob([clone.outerHTML], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function getStatusTone(status: ExperimentRecord["status"]) {
  if (status === "KEPT") {
    return "border-emerald-500/25 bg-emerald-500/10 text-[var(--good)]";
  }
  if (status === "DISCARDED") {
    return "border-rose-500/25 bg-rose-500/10 text-[var(--bad)]";
  }
  return "border-black/6 bg-white/55 text-[var(--ink-soft)]";
}

function metricOptionsForLog(discovery: DiscoveryResult | null, logFile: string) {
  if (!discovery) {
    return [];
  }
  const fileSpecific = logFile ? discovery.headers_by_file?.[logFile] ?? [] : [];
  const source = fileSpecific.length ? fileSpecific : discovery.suggested_metrics ?? [];
  return Array.from(new Set(source));
}

function fileHintFor(discovery: DiscoveryResult | null, filePath: string, fallback: string) {
  if (!discovery || !filePath) {
    return fallback;
  }
  return discovery.file_hints?.[filePath] ?? fallback;
}

function defaultCommandForScript(discovery: DiscoveryResult | null, scriptPath: string) {
  if (discovery?.suggested_command) {
    const scriptName = scriptPath.split(/[\\/]/).pop()?.toLowerCase();
    if (!scriptName || discovery.suggested_command.toLowerCase().includes(scriptName)) {
      return discovery.suggested_command;
    }
  }
  return scriptPath ? `python "${scriptPath}"` : "";
}

function isGenericScriptCommand(command: string | null | undefined, scriptPath: string) {
  if (!command || !scriptPath) {
    return false;
  }
  const normalizedCommand = command.trim().toLowerCase();
  const normalizedScript = scriptPath.trim().toLowerCase();
  return (
    normalizedCommand === `python "${normalizedScript}"` ||
    normalizedCommand === `python '${normalizedScript}'` ||
    normalizedCommand === `python ${normalizedScript}` ||
    normalizedCommand === `python.exe "${normalizedScript}"` ||
    normalizedCommand === `python.exe '${normalizedScript}'` ||
    normalizedCommand === `python.exe ${normalizedScript}`
  );
}

function normalizeDiscovery(discovery: DiscoveryResult): DiscoveryResult {
  return {
    ...discovery,
    log_candidates: discovery.log_candidates ?? [],
    script_candidates: discovery.script_candidates ?? [],
    headers_by_file: discovery.headers_by_file ?? {},
    suggested_metrics: discovery.suggested_metrics ?? [],
    suggested_command: discovery.suggested_command ?? null,
    file_hints: discovery.file_hints ?? {},
    recent_commits: discovery.recent_commits ?? [],
  };
}

function deriveDefaults(discovery: DiscoveryResult, current: MappingConfig): MappingConfig {
  const logFile = current.log_file || discovery.log_candidates[0] || "";
  const metricOptions = metricOptionsForLog(discovery, logFile);
  const script = current.script_to_watch || discovery.script_candidates[0] || "";
  const metric = metricOptions.includes(current.y_axis_metric) ? current.y_axis_metric : metricOptions[0] || "";
  const suggestedCommand = defaultCommandForScript(discovery, script);
  const researchCommand =
    !current.research_command || isGenericScriptCommand(current.research_command, script)
      ? suggestedCommand
      : current.research_command;

  return {
    project_root: current.project_root || discovery.project_root,
    script_to_watch: script,
    log_file: logFile,
    y_axis_metric: metric,
    optimization_goal: current.optimization_goal,
    research_command: researchCommand,
  };
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full min-h-[220px] items-center justify-center rounded-[28px] border border-black/6 bg-white/60 p-6 text-center">
      <div className="max-w-sm">
        <p className="font-['Fraunces','Iowan_Old_Style',serif] text-xl text-[var(--ink-strong)]">{title}</p>
        <p className="mt-2 text-sm text-[var(--ink-soft)]">{body}</p>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(INITIAL_SNAPSHOT);
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [draft, setDraft] = useState<MappingConfig>(INITIAL_CONFIG);
  const [projectRoot, setProjectRoot] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [httpState, setHttpState] = useState<ConnectionState>("checking");
  const [stateRouteState, setStateRouteState] = useState<ConnectionState>("checking");
  const [socketState, setSocketState] = useState<ConnectionState>("checking");
  const [celebration, setCelebration] = useState<CelebrationState | null>(null);
  const [activeView, setActiveView] = useState<DashboardView>("overview");
  const [loopStageIndex, setLoopStageIndex] = useState(0);
  const [hasMounted, setHasMounted] = useState(false);
  const bestMetricRef = useRef<number | null>(null);
  const chartRef = useRef<HTMLDivElement | null>(null);

  const deferredPoints = useDeferredValue(snapshot.metric_points);
  const deferredExperiments = useDeferredValue(snapshot.experiments);
  const headers = useMemo(() => metricOptionsForLog(discovery, draft.log_file), [draft.log_file, discovery]);
  const scriptHint = useMemo(
    () =>
      fileHintFor(
        discovery,
        draft.script_to_watch,
        "Choose the file the agent edits most often during the research loop. In many repos this is train.py or the main experiment entrypoint.",
      ),
    [discovery, draft.script_to_watch],
  );
  const logHint = useMemo(
    () =>
      fileHintFor(
        discovery,
        draft.log_file,
        "Choose the file where each experiment writes metrics. This is often results.tsv, metrics.csv, or a run.log file that prints loss or validation scores.",
      ),
    [discovery, draft.log_file],
  );
  const commandHint = useMemo(() => {
    if (discovery?.suggested_command) {
      return `Suggested from repo instructions: ${discovery.suggested_command}`;
    }
    return "Choose the command that actually runs one experiment loop. For autoresearch-style repos this is often `uv run train.py > run.log 2>&1`.";
  }, [discovery]);

  async function runConnectionCheck() {
    setHttpState("checking");
    setStateRouteState("checking");
    const [healthResult, stateResult] = await Promise.allSettled([
      requestJson<HealthReport>("/api/health"),
      requestJson<AppSnapshot>("/api/state"),
    ]);

    if (healthResult.status === "fulfilled") {
      setHealth(healthResult.value);
      setHttpState("live");
    } else {
      setHttpState("offline");
      throw healthResult.reason;
    }

    if (stateResult.status === "fulfilled") {
      setSnapshot(stateResult.value);
      setStateRouteState("live");
    } else {
      setStateRouteState("offline");
      throw stateResult.reason;
    }
  }

  useEffect(() => {
    let ignore = false;

    async function bootstrap() {
      try {
        setLoading(true);
        const [rawDiscovery] = await Promise.all([
          requestJson<DiscoveryResult>("/api/discovery"),
          runConnectionCheck(),
        ]);
        const discovered = normalizeDiscovery(rawDiscovery);
        if (ignore) {
          return;
        }
        setProjectRoot(discovered.project_root);
        setDiscovery(discovered);
        setDraft((current) => deriveDefaults(discovered, current));
      } catch (caught) {
        if (!ignore) {
          setError(caught instanceof Error ? caught.message : "Failed to load backend state.");
        }
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    }

    bootstrap();
    setHasMounted(true);
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let heartbeat: number | undefined;
    let reconnectTimer: number | undefined;
    let cancelled = false;

    const connect = () => {
      setSocketState("checking");
      socket = new WebSocket(buildWsUrl(API_BASE));

      socket.addEventListener("open", () => {
        setSocketState("live");
        heartbeat = window.setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send("ping");
          }
        }, 20000);
      });

      socket.addEventListener("message", (event) => {
        const data = JSON.parse(event.data) as AppSnapshot;
        startTransition(() => {
          setSnapshot(data);
          if (data.discovery) {
            const discovered = normalizeDiscovery(data.discovery);
            setDiscovery(discovered);
            setDraft((current) => deriveDefaults(discovered, { ...current, ...(data.config ?? {}) }));
          }
        });
      });

      socket.addEventListener("close", () => {
        setSocketState("offline");
        if (heartbeat) {
          window.clearInterval(heartbeat);
        }
        if (!cancelled) {
          reconnectTimer = window.setTimeout(connect, 3000);
        }
      });

      socket.addEventListener("error", () => {
        setSocketState("offline");
        if (heartbeat) {
          window.clearInterval(heartbeat);
        }
      });
    };

    connect();

    return () => {
      cancelled = true;
      if (heartbeat) {
        window.clearInterval(heartbeat);
      }
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        await runConnectionCheck();
      } catch (caught) {
        if (!cancelled) {
          setError((current) => current ?? (caught instanceof Error ? caught.message : "Connection check failed."));
        }
      }
    };

    const interval = window.setInterval(check, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!headers.length && draft.y_axis_metric) {
      setDraft((current) => ({ ...current, y_axis_metric: "" }));
      return;
    }
    if (headers.length && !headers.includes(draft.y_axis_metric)) {
      setDraft((current) => ({ ...current, y_axis_metric: headers[0] }));
    }
  }, [headers, draft.y_axis_metric]);

  async function scanWorkspace() {
    try {
      setBusy(true);
      setError(null);
      const query = projectRoot ? `?root_path=${encodeURIComponent(projectRoot)}` : "";
      const discovered = normalizeDiscovery(await requestJson<DiscoveryResult>(`/api/discovery${query}`));
      setDiscovery(discovered);
      setDraft((current) => deriveDefaults(discovered, { ...current, project_root: discovered.project_root }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Discovery failed.");
    } finally {
      setBusy(false);
    }
  }

  async function applyMapping() {
    try {
      setBusy(true);
      setError(null);
      const nextState = await requestJson<AppSnapshot>("/api/config", {
        method: "POST",
        body: JSON.stringify(draft),
      });
      setSnapshot(nextState);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Configuration failed.");
    } finally {
      setBusy(false);
    }
  }

  async function controlProcess(action: "start" | "stop" | "restart") {
    try {
      setBusy(true);
      setError(null);
      const nextState = await requestJson<AppSnapshot>(`/api/process/${action}`, { method: "POST" });
      setSnapshot(nextState);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Unable to ${action} process.`);
    } finally {
      setBusy(false);
    }
  }

  const bestMetric = useMemo(() => {
    if (!deferredPoints.length) {
      return null;
    }
    const values = deferredPoints.map((point) => point.metric);
    return draft.optimization_goal === "minimize" ? Math.min(...values) : Math.max(...values);
  }, [deferredPoints, draft.optimization_goal]);

  const chartData = useMemo(
    () =>
      deferredPoints.map((point: MetricPoint) => ({
        ...point,
        label: `#${point.iteration}`,
      })),
    [deferredPoints],
  );

  const latestExperiment = deferredExperiments[deferredExperiments.length - 1] ?? null;
  const latestMetricPoint = deferredPoints[deferredPoints.length - 1] ?? null;
  const latestStdout = snapshot.stdout_tail[snapshot.stdout_tail.length - 1] ?? null;
  const iterationCount = latestExperiment?.iteration ?? latestMetricPoint?.iteration ?? 0;
  const sessionFinished =
    snapshot.process.status !== "running" &&
    deferredPoints.length > 0 &&
    (snapshot.process.exited_at !== null || latestExperiment !== null);

  const loopStages = useMemo(() => {
    const activeStatus =
      !discovery?.project_root
        ? 0
        : snapshot.process.status === "running"
        ? 2
        : latestExperiment?.status === "KEPT"
          ? 4
          : latestExperiment
            ? 3
            : 1;

    return [
      {
        title: "Scan",
        detail: discovery?.project_root ? "Repo detected" : "Waiting for repo",
        active: activeStatus >= 0,
        current: activeStatus === 0,
      },
      {
        title: "Map",
        detail: snapshot.config ? "Files pinned" : "Select script and log",
        active: activeStatus >= 1,
        current: activeStatus === 1,
      },
      {
        title: "Iterate",
        detail: snapshot.process.status === "running" ? "Agent loop active" : "Idle",
        active: activeStatus >= 2,
        current: activeStatus === 2,
      },
      {
        title: "Evaluate",
        detail: latestExperiment ? `Iteration #${latestExperiment.iteration}` : "Awaiting result",
        active: activeStatus >= 3,
        current: activeStatus === 3,
      },
      {
        title: "Ratchet",
        detail:
          latestExperiment?.status === "KEPT"
            ? "Improvement kept"
            : latestExperiment?.status === "DISCARDED"
              ? "No gain this round"
              : "Watching best metric",
        active: activeStatus >= 4,
        current: activeStatus === 4,
      },
    ];
  }, [discovery?.project_root, latestExperiment, snapshot.config, snapshot.process.status]);

  const activityItems = useMemo(() => {
    return [
      `Process ${snapshot.process.status}`,
      snapshot.config ? `Tracking ${snapshot.config.y_axis_metric}` : "Mapping pending",
      latestExperiment
        ? `${latestExperiment.status === "KEPT" ? "Kept" : latestExperiment.status === "DISCARDED" ? "Discarded" : "Logged"} iteration #${latestExperiment.iteration}`
        : "Waiting for experiment rows",
      bestMetric !== null ? `Best ${draft.y_axis_metric || "metric"} ${formatMetric(bestMetric)}` : "Best metric pending",
      health?.watcher_active ? "Watcher locked to repo" : "Watcher idle",
      latestStdout ? latestStdout : "No stdout signal yet",
    ];
  }, [
    bestMetric,
    deferredExperiments,
    draft.y_axis_metric,
    health?.watcher_active,
    latestExperiment,
    latestStdout,
    snapshot.config,
    snapshot.process.status,
  ]);

  useEffect(() => {
    if (snapshot.process.status !== "running") {
      setLoopStageIndex(0);
      return;
    }
    const timer = window.setInterval(() => {
      setLoopStageIndex((current) => (current + 1) % 4);
    }, 2200);
    return () => window.clearInterval(timer);
  }, [snapshot.process.status]);

  useEffect(() => {
    if (bestMetric === null || !deferredPoints.length) {
      bestMetricRef.current = bestMetric;
      return;
    }

    const previous = bestMetricRef.current;
    const improved =
      previous === null ||
      (draft.optimization_goal === "minimize" ? bestMetric < previous : bestMetric > previous);

    if (improved && previous !== null) {
      const match =
        [...deferredPoints]
          .reverse()
          .find((point) => point.metric === bestMetric) ?? deferredPoints[deferredPoints.length - 1];
      setCelebration({
        iteration: match.iteration,
        value: bestMetric,
        delta: Math.abs(bestMetric - previous),
      });
      const timer = window.setTimeout(() => setCelebration(null), 4200);
      bestMetricRef.current = bestMetric;
      return () => window.clearTimeout(timer);
    }

    bestMetricRef.current = bestMetric;
  }, [bestMetric, deferredPoints, draft.optimization_goal]);

  const healthCheckedAt = health ? formatDate(health.time) : "n/a";
  const currentCommand = snapshot.process.command || draft.research_command || "n/a";
  const lastResultLabel =
    latestExperiment?.status === "KEPT"
      ? "Improved and kept"
      : latestExperiment?.status === "DISCARDED"
        ? "No improvement"
        : latestExperiment
          ? "Logged"
          : "Waiting";
  const navItems: Array<{ id: DashboardView; label: string; detail: string }> = [
    { id: "overview", label: "Overview", detail: "Metric-first monitoring" },
    { id: "activity", label: "Activity", detail: "Feed and stdout" },
    { id: "diff", label: "Diff", detail: "Code changes" },
  ];

  function downloadMetricGraph() {
    const svg = chartRef.current?.querySelector("svg");
    if (!svg || !chartData.length) {
      return;
    }

    const metricLabel =
      (draft.y_axis_metric || "metric")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "metric";

    downloadSvgElement(svg, `autoresearchui-${metricLabel}-graph.svg`);
  }

  return (
    <div
      className="min-h-screen bg-[var(--surface-0)] text-[var(--ink-strong)] font-sans selection:bg-[var(--accent)]/20"
      style={
        {
          "--surface-0": "#ffffff",
          "--surface-1": "#fcfcfc",
          "--surface-2": "#f0f0f0",
          "--ink-strong": "#000000",
          "--ink-soft": "#666666",
          "--line": "#000000",
          "--accent": "#000000",
          "--accent-soft": "#f0f0f0",
          "--good": "#000000",
          "--bad": "#ff0000",
        } as CSSProperties
      }
    >
      <style dangerouslySetInnerHTML={{ __html: `
        @font-face {
          font-family: 'Editorial';
          src: local('Georgia'), local('Times New Roman');
        }
        @keyframes premium-glitch {
          0% { transform: translate(0); text-shadow: -2px 0 #ff00c1, 2px 0 #00fff9; }
          2% { transform: translate(-2px, 2px); }
          4% { transform: translate(-2px, -2px); }
          6% { transform: translate(2px, 2px); }
          8% { transform: translate(2px, -2px); }
          10% { transform: translate(0); text-shadow: none; }
          100% { transform: translate(0); text-shadow: none; }
        }
        .premium-glitch-text:hover {
          animation: premium-glitch 0.5s cubic-bezier(.25,.46,.45,.94) both infinite;
          cursor: pointer;
        }
        .vertical-text {
          writing-mode: vertical-rl;
          text-orientation: mixed;
        }
        input, select, button {
          border-radius: 0 !important;
        }
        .sharp-border {
          border: 1px solid var(--line);
        }
      ` }} />
      <div className="relative flex min-h-screen w-full selection:bg-black selection:text-white">
        {/* Editorial Logo (Top Left) */}
        <div className="fixed left-0 top-0 z-50 flex h-16 w-16 items-center justify-center bg-black text-white">
          <Cable className="h-6 w-6" />
        </div>
        <div className="fixed left-20 top-6 z-50 text-[10px] font-black tracking-[0.4em] text-black">
          <span className="premium-glitch-text uppercase">Auto Research UI</span>
        </div>

        {/* Global Connection Status (Bottom Left) */}
        <div className="fixed bottom-10 left-10 z-50 flex flex-col gap-2 text-[9px] font-bold tracking-[0.2em] text-black uppercase">
          <div className="flex items-center gap-2">
            <div className={`h-1.5 w-1.5 ${httpState === "live" ? "bg-black" : "bg-red-600"}`} /> HTTP / {httpState}
          </div>
          <div className="flex items-center gap-2">
            <div className={`h-1.5 w-1.5 ${socketState === "live" ? "bg-black" : "bg-red-600"}`} /> WebSocket / {socketState}
          </div>
        </div>

        {/* Vertical Editorial Nav (Right Edge) */}
        <nav className="fixed right-10 top-0 z-50 flex h-full items-center justify-center">
          <div className="flex flex-col gap-16">
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => setActiveView(item.id as any)}
                className={`vertical-text group text-[11px] font-black tracking-[0.3em] uppercase transition-all duration-300 ${
                  activeView === item.id ? "text-black scale-110" : "text-gray-300 hover:text-black"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </nav>

        {/* Floating Social Hooks (Right Edge - Bottom) */}
        <div className="fixed bottom-10 right-10 z-50 flex flex-col gap-6 text-black opacity-40">
           <Bot className="h-4 w-4" />
           <Activity className="h-4 w-4" />
        </div>

        {/* Main Editorial Canvas */}
        <main className="flex-1 px-32 pb-32 pt-32 mx-auto w-full max-w-[1400px]">
          {celebration ? (
            <section className="mb-20 border-b border-black pb-10">
              <p className="font-['Editorial',serif] text-[48px] leading-tight tracking-tighter text-black">
                Locked: {formatMetric(celebration.value)}
              </p>
              <p className="mt-2 text-xs font-bold uppercase tracking-[0.3em] text-gray-400">
                Iteration #{celebration.iteration} / Improvement Found
              </p>
            </section>
          ) : (
            <section className="mb-20 border-b border-black pb-10">
              <h1 className="font-['Editorial',serif] text-[64px] leading-[0.9] tracking-tighter text-black uppercase">
                {activeView}
              </h1>
              <p className="mt-4 text-xs font-bold uppercase tracking-[0.4em] text-gray-500">
                Research Loop / Control Interface v2.0
              </p>
            </section>
          )}

          {error && (
            <div className="mb-12 border border-red-600 p-6 text-xs font-bold uppercase tracking-widest text-red-600">
              Exception: {error}
            </div>
          )}

          <div className="grid gap-24 xl:grid-cols-[280px_minmax(0,1fr)]">
            <aside className="space-y-16">
              <div className="space-y-8">
                <p className="text-[10px] font-black uppercase tracking-[0.3em] border-b border-black pb-2">Configuration</p>
                <div className="space-y-6">
                  <div>
                    <label className="block text-[9px] font-bold uppercase tracking-widest text-gray-400">Workspace</label>
                    <input
                      value={projectRoot}
                      onChange={(event) => setProjectRoot(event.target.value)}
                      className="mt-2 w-full border-b border-gray-200 bg-transparent py-2 text-xs font-bold outline-none transition focus:border-black"
                    />
                  </div>

                  <div className="flex gap-2">
                    <ActionButton onClick={scanWorkspace} disabled={busy} icon={FolderSearch}>
                      SCAN {">"}
                    </ActionButton>
                    <GhostButton onClick={applyMapping} disabled={busy || !draft.script_to_watch || !draft.log_file || !draft.y_axis_metric}>
                      SYNC {">"}
                    </GhostButton>
                  </div>

                  <FieldSelect
                    label="Target Script"
                    value={draft.script_to_watch}
                    onChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        project_root: projectRoot || current.project_root,
                        script_to_watch: value,
                        research_command: defaultCommandForScript(discovery, value) || current.research_command,
                      }))
                    }
                    options={discovery?.script_candidates ?? []}
                  />

                  <FieldSelect
                    label="Log Destination"
                    value={draft.log_file}
                    onChange={(value) => setDraft((current) => ({ ...current, log_file: value }))}
                    options={discovery?.log_candidates ?? []}
                  />

                  <FieldSelect
                    label="Primary Metric"
                    value={draft.y_axis_metric}
                    onChange={(value) => setDraft((current) => ({ ...current, y_axis_metric: value }))}
                    options={headers}
                  />

                  <div className="space-y-4">
                    <label className="text-[9px] font-bold uppercase tracking-widest text-gray-400">Optimization</label>
                    <div className="flex flex-col gap-2">
                      <GoalButton
                        active={draft.optimization_goal === "minimize"}
                        icon={TrendingDown}
                        label="MIN"
                        onClick={() => setDraft((current) => ({ ...current, optimization_goal: "minimize" }))}
                      />
                      <GoalButton
                        active={draft.optimization_goal === "maximize"}
                        icon={TrendingUp}
                        label="MAX"
                        onClick={() => setDraft((current) => ({ ...current, optimization_goal: "maximize" }))}
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-[9px] font-bold uppercase tracking-widest text-gray-400">Runtime Command</label>
                    <input
                      value={draft.research_command ?? ""}
                      onChange={(event) => setDraft((current) => ({ ...current, research_command: event.target.value }))}
                      className="mt-2 w-full border-b border-gray-200 bg-transparent py-2 text-xs font-bold font-mono outline-none transition focus:border-black"
                    />
                  </div>
                </div>
              </div>
            </aside>

            <div className="space-y-24">
              {activeView === "overview" && (
                <div className="space-y-20">
                  <div className="grid gap-12 lg:grid-cols-[1fr_300px]">
                    <div className="space-y-8">
                      <div className="flex items-end justify-between border-b border-black pb-4">
                        <p className="text-[10px] font-black uppercase tracking-[0.3em]">Metric Performance</p>
                        <div className="flex gap-4">
                          <button onClick={() => controlProcess("start")} disabled={busy || snapshot.process.status === "running"} className="text-[10px] font-black uppercase tracking-widest hover:underline disabled:opacity-20">Start Loop</button>
                          <button onClick={() => controlProcess("stop")} disabled={busy || snapshot.process.status === "idle"} className="text-[10px] font-black uppercase tracking-widest hover:underline disabled:opacity-20">Halt</button>
                        </div>
                      </div>
                      <div className="h-[400px] w-full border border-black p-8">
                        {chartData.length ? (
                          <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={chartData}>
                              <CartesianGrid stroke="#eee" vertical={false} />
                              <XAxis dataKey="iteration" hide />
                              <YAxis axisLine={false} tickLine={false} stroke="#000" fontSize={10} fontWeight="bold" />
                              <Tooltip contentStyle={{ border: '1px solid black', borderRadius: 0, padding: '10px' }} />
                              <Line type="stepAfter" dataKey="metric" stroke="#000" strokeWidth={2} dot={{ r: 0 }} activeDot={{ r: 4, fill: '#000' }} />
                            </LineChart>
                          </ResponsiveContainer>
                        ) : (
                          <div className="flex h-full items-center justify-center text-[10px] font-bold uppercase tracking-[0.2em] text-gray-300">
                            Awaiting Data Stream
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="space-y-8">
                      <p className="text-[10px] font-black uppercase tracking-[0.3em] border-b border-black pb-4">Record</p>
                      <div className="divide-y divide-gray-100 max-h-[400px] overflow-y-auto">
                        {deferredExperiments.length ? (
                          deferredExperiments.slice().reverse().map((exp) => (
                            <div key={`${exp.iteration}-${exp.timestamp}`} className="py-4">
                              <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-widest">
                                <span>Iter {exp.iteration}</span>
                                <span className={exp.status === "KEPT" ? "text-black" : "text-gray-400"}>{exp.status}</span>
                              </div>
                              <div className="mt-1 font-['Editorial',serif] text-2xl tracking-tighter">
                                {exp.metric_value?.toFixed(4) ?? '—'}
                              </div>
                            </div>
                          ))
                        ) : <p className="text-[10px] font-bold uppercase tracking-widest text-gray-300">No entries.</p>}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeView === "activity" && (
                <div className="grid gap-20 lg:grid-cols-[1fr_400px]">
                  <div className="space-y-10">
                    <p className="text-[10px] font-black uppercase tracking-[0.3em] border-b border-black pb-4">Thought Timeline</p>
                    <div className="space-y-12">
                      {deferredExperiments.length ? (
                        deferredExperiments.slice().reverse().map((exp) => (
                          <div key={`${exp.iteration}-${exp.timestamp}`} className="group">
                             <div className="flex items-center gap-4 text-[10px] font-black uppercase tracking-[0.2em] mb-4">
                                <span className="bg-black text-white px-2 py-1">Iteration {exp.iteration}</span>
                                <span className="text-gray-400">{hasMounted ? formatDate(exp.timestamp) : "..."}</span>
                             </div>
                             <p className="font-['Editorial',serif] text-3xl leading-tight tracking-tight text-black group-hover:italic transition-all">
                               "{exp.hypothesis || "Exploration in progress."}"
                             </p>
                          </div>
                        ))
                      ) : <p className="text-gray-300 italic">No activity logs recorded.</p>}
                    </div>
                  </div>

                  <div className="space-y-10">
                    <p className="text-[10px] font-black uppercase tracking-[0.3em] border-b border-black pb-4">Terminal</p>
                    <div className="h-[600px] overflow-y-auto border border-black p-6 font-mono text-[10px] leading-relaxed text-black bg-[#fafafa]">
                      {snapshot.stdout_tail.length ? (
                        snapshot.stdout_tail.map((line, idx) => <div key={idx} className="mb-1">{line}</div>)
                      ) : (
                        <p className="text-gray-300">Awaiting stream...</p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {activeView === "diff" && (
                <div className="space-y-10">
                  <div className="flex items-end justify-between border-b border-black pb-4">
                    <p className="text-[10px] font-black uppercase tracking-[0.3em]">Code Delta</p>
                    <p className="text-[10px] font-bold uppercase text-gray-400">{snapshot.diff.path || 'No file selected'}</p>
                  </div>
                  <div className="border border-black bg-white overflow-hidden">
                    {snapshot.diff.path ? (
                      <DiffViewer
                        oldValue={snapshot.diff.before}
                        newValue={snapshot.diff.after}
                        splitView
                        styles={{
                          variables: {
                            light: {
                              diffViewerBackground: "#fff",
                              addedBackground: "rgba(0,0,0,0.05)",
                              removedBackground: "rgba(255,0,0,0.05)",
                              gutterBackground: "#fff",
                              gutterColor: "#000",
                              codeFoldBackground: "#f9f9f9",
                            }
                          },
                          contentText: { fontSize: "12px", lineHeight: 2, fontFamily: 'monospace' }
                        }}
                      />
                    ) : (
                      <div className="flex h-[400px] items-center justify-center text-[10px] font-bold uppercase tracking-widest text-gray-300">
                        No Code Changes Detected
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </main>
      </div>

      {loading && (
        <div className="fixed inset-x-0 bottom-8 mx-auto w-fit border border-black bg-white px-6 py-3 text-[9px] font-black uppercase tracking-[0.3em] text-black shadow-2xl z-[100]">
          Synchronizing State...
        </div>
      )}
    </div>
  );
}

function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`border border-black bg-white p-8 ${className}`}>
      {children}
    </section>
  );
}

function PanelTitle({
  title,
  subtitle,
}: {
  icon?: any;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="mb-8">
      <p className="font-['Editorial',serif] text-3xl leading-none tracking-tight text-black uppercase">{title}</p>
      <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.2em] text-gray-400">{subtitle}</p>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-black bg-white p-6">
      <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400">{label}</p>
      <p className="mt-2 text-xl font-black tracking-tight text-black">{value}</p>
    </div>
  );
}

function InlineStatus({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <span className="inline-flex items-center border border-black px-2 py-1 text-[9px] font-black uppercase tracking-widest text-black">
      {label}: {value}
    </span>
  );
}

function ControlButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  icon?: any;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="border border-black bg-black px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white transition hover:bg-white hover:text-black disabled:opacity-20"
    >
      {label} {">"}
    </button>
  );
}

function ActionButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  icon: any;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center justify-center border border-black bg-black px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white transition hover:bg-white hover:text-black disabled:opacity-20"
    >
      {children}
    </button>
  );
}

function GhostButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center justify-center border border-black px-4 py-2 text-[10px] font-black uppercase tracking-widest text-black transition hover:bg-black hover:text-white disabled:opacity-20"
    >
      {children}
    </button>
  );
}

function GoalButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  icon: any;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`border px-4 py-2 text-[10px] font-black uppercase tracking-widest transition ${
        active ? "border-black bg-black text-white" : "border-gray-200 text-gray-400 hover:border-black hover:text-black"
      }`}
    >
      {label}
    </button>
  );
}

function FieldSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
}) {
  return (
    <div className="space-y-2">
      <label className="text-[9px] font-bold uppercase tracking-widest text-gray-400">{label}</label>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full border-b border-gray-200 bg-transparent py-2 text-xs font-bold outline-none transition focus:border-black appearance-none"
      >
        {!value ? <option value="">Select {label}</option> : null}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}
