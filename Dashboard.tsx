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

function deriveDefaults(discovery: DiscoveryResult, current: MappingConfig): MappingConfig {
  const logFile = current.log_file || discovery.log_candidates[0] || "";
  const metricOptions = discovery.headers_by_file[logFile] ?? [];
  const script = current.script_to_watch || discovery.script_candidates[0] || "";
  const metric = metricOptions.includes(current.y_axis_metric) ? current.y_axis_metric : metricOptions[0] || "";

  return {
    project_root: current.project_root || discovery.project_root,
    script_to_watch: script,
    log_file: logFile,
    y_axis_metric: metric,
    optimization_goal: current.optimization_goal,
    research_command: current.research_command || (script ? `python "${script}"` : ""),
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
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loopStageIndex, setLoopStageIndex] = useState(0);
  const bestMetricRef = useRef<number | null>(null);
  const chartRef = useRef<HTMLDivElement | null>(null);

  const deferredPoints = useDeferredValue(snapshot.metric_points);
  const deferredExperiments = useDeferredValue(snapshot.experiments);
  const headers = useMemo(
    () => (draft.log_file && discovery ? discovery.headers_by_file[draft.log_file] ?? [] : []),
    [draft.log_file, discovery],
  );

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
        const [discovered] = await Promise.all([
          requestJson<DiscoveryResult>("/api/discovery"),
          runConnectionCheck(),
        ]);
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
            setDiscovery(data.discovery);
            setDraft((current) => deriveDefaults(data.discovery!, { ...current, ...(data.config ?? {}) }));
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
      const discovered = await requestJson<DiscoveryResult>(`/api/discovery${query}`);
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
      className="min-h-screen bg-[var(--surface-0)] text-[var(--ink-strong)]"
      style={
        {
          "--surface-0": "#f4efe6",
          "--surface-1": "#fbf8f1",
          "--surface-2": "#ece4d6",
          "--ink-strong": "#16120d",
          "--ink-soft": "#695f55",
          "--line": "rgba(25,19,14,0.08)",
          "--accent": "#9f7a42",
          "--accent-soft": "#ead7b7",
          "--good": "#2d8a5d",
          "--bad": "#b95f5f",
        } as CSSProperties
      }
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(159,122,66,0.16),transparent_25%),radial-gradient(circle_at_bottom_right,rgba(45,138,93,0.10),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.72),rgba(244,239,230,0.92))]" />
      <div className="relative mx-auto flex max-w-[1600px] flex-col gap-6 px-4 py-6 lg:px-8">
        <header className="premium-panel premium-fade-up rounded-[36px] border border-black/5 bg-[linear-gradient(180deg,rgba(255,255,255,0.82),rgba(255,251,244,0.76))] p-6 shadow-[0_30px_80px_rgba(52,40,24,0.10)] backdrop-blur-xl">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="flex items-center gap-3 text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">
                <Cable className="h-4 w-4 text-[var(--accent)]" />
                AutoResearchUI
              </div>
              <h1 className="mt-4 max-w-4xl font-['Fraunces','Iowan_Old_Style',serif] text-4xl leading-[1.02] text-[var(--ink-strong)] lg:text-[5.25rem]">
                Quietly watch the loop.
                <span className="block text-[0.84em] text-[var(--ink-soft)]">Celebrate the ratchet when it moves.</span>
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-[var(--ink-soft)]">
                Map one script, one log, and one metric. AutoResearchUI handles the live graph, experiment history, and process state.
              </p>
            </div>

            <div className="flex flex-col gap-3">
              <GhostButton onClick={() => setShowAdvanced((current) => !current)}>
                {showAdvanced ? "Hide advanced view" : "Show advanced view"}
              </GhostButton>
              <div className="grid gap-3 sm:grid-cols-3">
              <StatChip
                label="HTTP"
                value={httpState}
                tone={httpState === "live" ? "good" : httpState === "checking" ? "neutral" : "bad"}
              />
              <StatChip
                label="State API"
                value={stateRouteState}
                tone={stateRouteState === "live" ? "good" : stateRouteState === "checking" ? "neutral" : "bad"}
              />
              <StatChip
                label="WebSocket"
                value={socketState}
                tone={socketState === "live" ? "good" : socketState === "checking" ? "neutral" : "bad"}
              />
              </div>
            </div>
          </div>
        </header>

        {celebration ? (
          <section className="premium-panel premium-fade-up overflow-hidden rounded-[32px] border border-[var(--accent)]/20 bg-[linear-gradient(135deg,rgba(255,251,245,0.95),rgba(245,235,219,0.92))] p-5 shadow-[0_24px_60px_rgba(119,92,52,0.14)]">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-start gap-4">
                <div className="premium-ring flex h-12 w-12 items-center justify-center rounded-full bg-[var(--accent)]/12 text-[var(--accent)]">
                  <Sparkles className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-[0.26em] text-[var(--ink-soft)]">New best locked in</p>
                  <h2 className="mt-1 font-['Fraunces','Iowan_Old_Style',serif] text-2xl text-[var(--ink-strong)]">
                    Iteration #{celebration.iteration} improved {draft.y_axis_metric || "metric"} to {formatMetric(celebration.value)}.
                  </h2>
                  <p className="mt-2 text-sm text-[var(--ink-soft)]">
                    Delta {formatMetric(celebration.delta)}. Keep the loop moving while the sidecar tracks the ratchet.
                  </p>
                </div>
              </div>
              <div className="rounded-full border border-[var(--accent)]/20 bg-white/60 px-4 py-2 text-sm text-[var(--ink-strong)]">
                Best so far
              </div>
            </div>
          </section>
        ) : null}

        <section className="premium-panel overflow-hidden rounded-[30px] border border-black/5 bg-[linear-gradient(180deg,rgba(255,255,255,0.76),rgba(255,250,241,0.70))] p-4 shadow-[0_24px_50px_rgba(44,33,20,0.08)]">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--ink-strong)] text-white">
                <Waves className="h-5 w-5" />
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-[0.26em] text-[var(--ink-soft)]">Research status</p>
                <p className="mt-1 text-sm text-[var(--ink-strong)]">
                  {snapshot.process.status === "running"
                    ? "The agent is running. Watch the graph and experiment feed update in real time."
                    : "Pick the files once, then start the loop when you are ready."}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {loopStages.map((stage, index) => (
                <div
                  key={stage.title}
                  className={`rounded-full border px-3 py-2 text-xs transition ${
                    stage.current || (snapshot.process.status === "running" && index === loopStageIndex)
                      ? "border-[var(--accent)]/35 bg-[var(--accent)]/12 text-[var(--ink-strong)]"
                      : stage.active
                        ? "border-black/8 bg-black/[0.03] text-[var(--ink-soft)]"
                        : "border-black/6 bg-white/50 text-[var(--ink-soft)]/70"
                  }`}
                >
                  <span className="font-medium">{stage.title}</span>
                  <span className="ml-2 text-[var(--ink-soft)]">{stage.detail}</span>
                </div>
              ))}
            </div>
          </div>

          {showAdvanced ? (
            <>
              <div className="mt-5 grid gap-3 lg:grid-cols-5">
                {loopStages.map((stage, index) => (
                  <div key={`${stage.title}-track`} className="rounded-[22px] border border-black/6 bg-white/55 p-3">
                    <div className="flex items-center gap-3">
                      <div
                        className={`premium-stage-dot h-2.5 w-2.5 rounded-full ${
                          stage.current || (snapshot.process.status === "running" && index === loopStageIndex)
                            ? "bg-[var(--accent)] shadow-[0_0_0_6px_rgba(159,122,66,0.12)]"
                            : stage.active
                              ? "bg-[var(--ink-strong)]/55"
                              : "bg-black/10"
                        }`}
                      />
                      <div className="h-px flex-1 bg-[linear-gradient(90deg,rgba(159,122,66,0.26),rgba(22,18,13,0.05))]" />
                    </div>
                    <p className="mt-3 text-[11px] uppercase tracking-[0.2em] text-[var(--ink-soft)]">{stage.title}</p>
                    <p className="mt-1 text-sm text-[var(--ink-strong)]">{stage.detail}</p>
                  </div>
                ))}
              </div>

              <div className="premium-marquee mt-4 flex gap-3 whitespace-nowrap">
                {[...activityItems, ...activityItems].map((item, index) => (
                  <div key={`${item}-${index}`} className="inline-flex items-center gap-2 rounded-full border border-black/6 bg-white/70 px-4 py-2 text-sm text-[var(--ink-soft)]">
                    <ArrowUpRight className="h-3.5 w-3.5 text-[var(--accent)]" />
                    {item}
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </section>

        {showAdvanced || snapshot.process.status === "running" || sessionFinished ? (
        <section className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
          <div className="premium-panel premium-sheen overflow-hidden rounded-[30px] border border-black/5 bg-[linear-gradient(180deg,rgba(255,255,255,0.78),rgba(255,249,239,0.72))] p-5 shadow-[0_20px_48px_rgba(44,33,20,0.08)]">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="flex items-center gap-3">
                  <span className={`premium-live-dot inline-flex h-2.5 w-2.5 rounded-full ${snapshot.process.status === "running" ? "bg-[var(--good)]" : "bg-[var(--accent)]"}`} />
                  <p className="text-[11px] uppercase tracking-[0.24em] text-[var(--ink-soft)]">
                    {snapshot.process.status === "running" ? "Live research loop" : "Session telemetry"}
                  </p>
                </div>
                <h2 className="mt-3 font-['Fraunces','Iowan_Old_Style',serif] text-2xl text-[var(--ink-strong)]">
                  {snapshot.process.status === "running"
                    ? "The sidecar is tracking every iteration in real time."
                    : sessionFinished
                      ? "The session has settled. The graph is ready to export."
                      : "Map the project, then let the sidecar watch the ratchet."}
                </h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--ink-soft)]">
                  {snapshot.process.status === "running"
                    ? compactText(snapshot.last_hypothesis || latestStdout || "The agent is cycling through edits, evaluations, and log updates.", 132)
                    : sessionFinished
                      ? compactText(latestStdout || snapshot.last_hypothesis || "Recent output has settled and the latest metric history is preserved in the UI.", 132)
                      : "Once the run begins, this strip becomes the quiet status layer between code diffs, stdout, and metric changes."}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <MetricCard label="Iterations" value={iterationCount ? String(iterationCount) : "n/a"} />
                <MetricCard label="Last metric" value={latestMetricPoint ? formatMetric(latestMetricPoint.metric) : "n/a"} />
                <MetricCard label="Updated" value={formatDate(snapshot.last_updated)} />
              </div>
            </div>
          </div>

          <div className="premium-panel overflow-hidden rounded-[30px] border border-black/5 bg-[linear-gradient(180deg,rgba(255,255,255,0.76),rgba(252,246,236,0.82))] p-5 shadow-[0_20px_48px_rgba(44,33,20,0.07)]">
            <div className="flex h-full flex-col justify-between gap-4">
              <div>
                <p className="text-[11px] uppercase tracking-[0.24em] text-[var(--ink-soft)]">
                  {sessionFinished ? "Research session complete" : "Export moment"}
                </p>
                <h3 className="mt-3 font-['Fraunces','Iowan_Old_Style',serif] text-[1.8rem] leading-tight text-[var(--ink-strong)]">
                  {sessionFinished ? "Archive the graph and keep the best run visible." : "The graph export unlocks as soon as the run has real metric history."}
                </h3>
                <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">
                  {sessionFinished
                    ? `Best ${draft.y_axis_metric || "metric"}: ${bestMetric === null ? "n/a" : formatMetric(bestMetric)}. Use the export to share or pin the session outcome.`
                    : "Once metric points arrive, the dashboard can save the live curve as an SVG without needing a screenshot."}
                </p>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row">
                <ActionButton onClick={downloadMetricGraph} disabled={!sessionFinished || !chartData.length} icon={Download}>
                  Download graph
                </ActionButton>
                <GhostButton onClick={() => void controlProcess("restart")} disabled={busy || !discovery?.git_present}>
                  Restart loop
                </GhostButton>
              </div>
            </div>
          </div>
        </section>
        ) : null}

        {error ? (
          <div className="rounded-[24px] border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-[var(--ink-strong)]">
            {error}
          </div>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-[340px_minmax(0,1fr)]">
          <aside className="space-y-6">
            <Panel>
              <PanelTitle icon={FolderSearch} title="Project Setup" subtitle="Choose the script, log file, and metric to track." />
              {showAdvanced ? (
                <div className="mt-5 rounded-2xl border border-black/6 bg-white/60 p-4 text-sm text-[var(--ink-soft)]">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium text-[var(--ink-strong)]">Connection checks</p>
                    <GhostButton onClick={() => void runConnectionCheck()} disabled={busy}>
                      Check Now
                    </GhostButton>
                  </div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    <MetricCard label="HTTP health" value={httpState} />
                    <MetricCard label="State route" value={stateRouteState} />
                    <MetricCard label="Socket" value={socketState} />
                  </div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <MetricCard label="Checked at" value={healthCheckedAt} />
                    <MetricCard label="WS clients" value={health ? String(health.websocket_clients) : "n/a"} />
                  </div>
                </div>
              ) : (
                <div className="mt-5 rounded-2xl border border-black/6 bg-white/60 px-4 py-3 text-sm text-[var(--ink-soft)]">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-[var(--ink-strong)]">System status</span>
                    <div className="flex items-center gap-2">
                      <InlineStatus label="HTTP" value={httpState} />
                      <InlineStatus label="State" value={stateRouteState} />
                      <InlineStatus label="Socket" value={socketState} />
                    </div>
                  </div>
                </div>
              )}

              <label className="mt-5 block text-xs uppercase tracking-[0.18em] text-[var(--ink-soft)]">Project root</label>
              <input
                value={projectRoot}
                onChange={(event) => setProjectRoot(event.target.value)}
                placeholder={"c:\\projects\\autorresearch"}
                className="mt-2 w-full rounded-2xl border border-black/8 bg-white/75 px-4 py-3 text-sm text-[var(--ink-strong)] outline-none transition focus:border-[var(--accent)]/50"
              />

              <div className="mt-3 flex gap-3">
                <ActionButton onClick={scanWorkspace} disabled={busy} icon={FolderSearch}>
                  Scan Workspace
                </ActionButton>
                <GhostButton onClick={applyMapping} disabled={busy || !draft.script_to_watch || !draft.log_file || !draft.y_axis_metric}>
                  Apply
                </GhostButton>
              </div>

              <FieldSelect
                label="Script to watch"
                value={draft.script_to_watch}
                onChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    project_root: projectRoot || current.project_root,
                    script_to_watch: value,
                    research_command: current.research_command || `python "${value}"`,
                  }))
                }
                options={discovery?.script_candidates ?? []}
              />

              <FieldSelect
                label="Log file"
                value={draft.log_file}
                onChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    project_root: projectRoot || current.project_root,
                    log_file: value,
                    y_axis_metric: discovery?.headers_by_file[value]?.[0] ?? "",
                  }))
                }
                options={discovery?.log_candidates ?? []}
              />

              <FieldSelect
                label="Y-axis metric"
                value={draft.y_axis_metric}
                onChange={(value) => setDraft((current) => ({ ...current, y_axis_metric: value }))}
                options={headers}
              />

              <div className="mt-5">
                <label className="text-xs uppercase tracking-[0.18em] text-[var(--ink-soft)]">Optimization goal</label>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <GoalButton
                    active={draft.optimization_goal === "minimize"}
                    icon={TrendingDown}
                    label="Minimize"
                    onClick={() => setDraft((current) => ({ ...current, optimization_goal: "minimize" }))}
                  />
                  <GoalButton
                    active={draft.optimization_goal === "maximize"}
                    icon={TrendingUp}
                    label="Maximize"
                    onClick={() => setDraft((current) => ({ ...current, optimization_goal: "maximize" }))}
                  />
                </div>
              </div>

              <label className="mt-5 block text-xs uppercase tracking-[0.18em] text-[var(--ink-soft)]">Research command</label>
              <input
                value={draft.research_command ?? ""}
                onChange={(event) => setDraft((current) => ({ ...current, research_command: event.target.value }))}
                placeholder={'python "run_agent.py"'}
                className="mt-2 w-full rounded-2xl border border-black/8 bg-white/75 px-4 py-3 text-sm text-[var(--ink-strong)] outline-none transition focus:border-[var(--accent)]/50"
              />

              <div className="mt-5 rounded-2xl border border-black/6 bg-white/60 p-4 text-sm text-[var(--ink-soft)]">
                <p className="font-medium text-[var(--ink-strong)]">Git check</p>
                <p className="mt-2 leading-6">
                  {discovery?.git_present
                    ? `Git detected at ${discovery.git_root}. You can start and restart safely.`
                    : "No Git repository detected yet. The backend will refuse code-modifying process starts."}
                </p>
              </div>
            </Panel>

            {showAdvanced ? (
            <Panel>
              <PanelTitle icon={GitCommitHorizontal} title="Recent Commits" subtitle="Latest repository state from GitPython." />
              <div className="mt-5 space-y-3">
                {(discovery?.recent_commits ?? []).length ? (
                  discovery?.recent_commits.map((commit) => (
                    <div key={commit.sha} className="rounded-2xl border border-black/6 bg-white/60 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-mono text-xs text-[var(--accent)]">{commit.sha}</span>
                        <span className="text-xs text-[var(--ink-soft)]">{formatDate(commit.authored_at)}</span>
                      </div>
                      <p className="mt-2 text-sm text-[var(--ink-strong)]">{commit.summary}</p>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-[var(--ink-soft)]">No commit metadata available yet.</p>
                )}
              </div>
            </Panel>
            ) : null}
          </aside>

          <main className="space-y-6">
            <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
              <Panel className="min-h-[420px]">
                <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
                  <PanelTitle
                    icon={Activity}
                    title="Live Metric"
                    subtitle={`Watching ${draft.y_axis_metric || "your selected metric"} as new log rows arrive.`}
                  />
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <ControlButton
                      label="Start"
                      icon={Play}
                      onClick={() => controlProcess("start")}
                      disabled={busy || !discovery?.git_present || snapshot.process.status === "running"}
                    />
                    <ControlButton
                      label="Stop"
                      icon={Pause}
                      onClick={() => controlProcess("stop")}
                      disabled={busy || snapshot.process.status === "idle"}
                    />
                    <ControlButton
                      label="Restart"
                      icon={RefreshCcw}
                      onClick={() => controlProcess("restart")}
                      disabled={busy || !discovery?.git_present}
                    />
                    <ControlButton
                      label="Graph"
                      icon={Download}
                      onClick={downloadMetricGraph}
                      disabled={!chartData.length}
                    />
                  </div>
                </div>

                <div className="mt-6 grid gap-4 md:grid-cols-3">
                  <MetricCard label="Process PID" value={snapshot.process.pid ? String(snapshot.process.pid) : "n/a"} />
                  <MetricCard label="Process" value={snapshot.process.status} />
                  <MetricCard label="Best" value={bestMetric === null ? "n/a" : `${draft.y_axis_metric || "metric"} ${bestMetric.toFixed(4)}`} />
                </div>

                <div
                  ref={chartRef}
                  className="mt-6 h-[280px] overflow-hidden rounded-[28px] border border-black/5 bg-[linear-gradient(180deg,rgba(255,255,255,0.88),rgba(251,248,241,0.94))] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]"
                >
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-[20px] border border-black/5 bg-white/60 px-3 py-2">
                    <div className="flex items-center gap-3">
                      <span className={`premium-live-dot inline-flex h-2.5 w-2.5 rounded-full ${snapshot.process.status === "running" ? "bg-[var(--good)]" : "bg-[var(--accent)]"}`} />
                      <p className="text-xs text-[var(--ink-soft)]">
                        {snapshot.process.status === "running"
                          ? `Watching ${draft.y_axis_metric || "metric"} in real time`
                          : sessionFinished
                            ? "Session settled. Export-ready."
                            : "Waiting for the first metric points"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[var(--ink-soft)]">
                      <span>{chartData.length} points</span>
                      <span className="h-1 w-1 rounded-full bg-black/15" />
                      <span>{formatDate(snapshot.last_updated)}</span>
                    </div>
                  </div>

                  {chartData.length ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={chartData} margin={{ left: 8, right: 24, top: 12, bottom: 12 }}>
                        <CartesianGrid stroke="rgba(22,18,13,0.06)" vertical={false} />
                        <XAxis dataKey="iteration" tickLine={false} axisLine={false} stroke="#8d877f" />
                        <YAxis tickLine={false} axisLine={false} stroke="#8d877f" width={80} />
                        <Tooltip
                          contentStyle={{
                            background: "#fffaf1",
                            border: "1px solid rgba(25,19,14,0.08)",
                            borderRadius: 18,
                            color: "#16120d",
                            boxShadow: "0 20px 40px rgba(44,33,20,0.10)",
                          }}
                        />
                        <Line
                          type="monotone"
                          dataKey="metric"
                          stroke="var(--accent)"
                          strokeWidth={2.5}
                          dot={false}
                          activeDot={{ r: 5, strokeWidth: 0, fill: "#f7d39f" }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  ) : (
                    <EmptyState
                      title="No metric points yet"
                      body="Apply a mapping and stream a log file. The chart will follow new rows without reloading the entire file."
                    />
                  )}
                </div>
              </Panel>

              <Panel className="min-h-[420px]">
                <PanelTitle
                  icon={SquareTerminal}
                  title="Experiment Feed"
                  subtitle="Each iteration is labeled as kept or discarded and paired with its reasoning."
                />
                <div className="mt-5 max-h-[340px] space-y-3 overflow-y-auto pr-1">
                  {deferredExperiments.length ? (
                    deferredExperiments
                      .slice()
                      .reverse()
                      .map((experiment) => (
                        <article key={`${experiment.iteration}-${experiment.timestamp}`} className="premium-panel rounded-[24px] border border-black/6 bg-white/65 p-4">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="text-sm font-medium text-[var(--ink-strong)]">Iteration #{experiment.iteration}</p>
                              <p className="mt-1 text-xs text-[var(--ink-soft)]">{formatDate(experiment.timestamp)}</p>
                            </div>
                            <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold tracking-[0.18em] ${getStatusTone(experiment.status)}`}>
                              {experiment.status}
                            </span>
                          </div>

                          <div className="mt-4 grid grid-cols-2 gap-3">
                            <MetricCard label={experiment.metric_name} value={experiment.metric_value === null ? "n/a" : experiment.metric_value.toFixed(4)} />
                            <MetricCard label="Raw keys" value={String(Object.keys(experiment.raw).length)} />
                          </div>

                          <div className="mt-4 rounded-2xl border border-black/6 bg-[var(--surface-1)] p-4">
                            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-[var(--ink-soft)]">
                              <Bot className="h-4 w-4 text-[var(--accent)]" />
                              Agent reasoning
                            </div>
                            <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">
                              {experiment.hypothesis || snapshot.last_hypothesis || "No explicit hypothesis found in log rows or stdout yet."}
                            </p>
                          </div>
                        </article>
                      ))
                  ) : (
                    <EmptyState
                      title="No experiments yet"
                      body="The feed populates once the sidecar sees appended log rows or stdout-derived reasoning."
                    />
                  )}
                </div>
              </Panel>
            </section>

            {showAdvanced ? (
            <section className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
              <Panel className="min-h-[480px]">
                <PanelTitle
                  icon={GitCommitHorizontal}
                  title="Code Diff"
                  subtitle={snapshot.diff.path ? snapshot.diff.path : "Watching the selected file for the current experiment delta."}
                />
                <div className="mt-5 overflow-hidden rounded-[24px] border border-black/6 bg-[#f8f4ec]">
                  {snapshot.diff.path ? (
                    <DiffViewer
                      oldValue={snapshot.diff.before}
                      newValue={snapshot.diff.after}
                      splitView
                      hideLineNumbers={false}
                      showDiffOnly={false}
                      styles={{
                        variables: {
                          dark: {
                            diffViewerBackground: "#f8f4ec",
                            diffViewerColor: "#16120d",
                            addedBackground: "rgba(45,138,93,0.10)",
                            addedColor: "#1e5b3d",
                            removedBackground: "rgba(185,95,95,0.10)",
                            removedColor: "#7f3f3f",
                            wordAddedBackground: "rgba(45,138,93,0.16)",
                            wordRemovedBackground: "rgba(185,95,95,0.16)",
                            addedGutterBackground: "rgba(45,138,93,0.08)",
                            removedGutterBackground: "rgba(185,95,95,0.08)",
                            gutterBackground: "#efe6d7",
                            gutterBackgroundDark: "#efe6d7",
                            highlightBackground: "rgba(159,122,66,0.08)",
                            highlightGutterBackground: "rgba(159,122,66,0.08)",
                            codeFoldGutterBackground: "#efe6d7",
                            codeFoldBackground: "#efe6d7",
                            emptyLineBackground: "#f8f4ec",
                            gutterColor: "#80705f",
                            addedGutterColor: "#2d8a5d",
                            removedGutterColor: "#b95f5f",
                            codeFoldContentColor: "#695f55",
                          },
                        },
                        contentText: {
                          fontSize: "13px",
                          lineHeight: 1.7,
                          fontFamily: '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace',
                        },
                      }}
                    />
                  ) : (
                    <EmptyState
                      title="No diff available"
                      body="Once the watched file changes, the dashboard keeps the prior snapshot and renders the current iteration side by side."
                    />
                  )}
                </div>
              </Panel>

              <Panel className="min-h-[480px]">
                <PanelTitle
                  icon={SquareTerminal}
                  title="Stdout Trace"
                  subtitle="Recent process output, useful when hypotheses are emitted outside structured logs."
                />
                <div className="mt-5 h-[380px] overflow-y-auto rounded-[24px] border border-black/6 bg-[#f7f2e9] p-4 font-mono text-xs leading-6 text-[var(--ink-soft)]">
                  {snapshot.stdout_tail.length ? (
                    snapshot.stdout_tail.map((line, index) => (
                      <div key={`${index}-${line.slice(0, 18)}`} className="border-b border-black/5 py-2 last:border-b-0">
                        {line}
                      </div>
                    ))
                  ) : (
                    <p className="text-[var(--ink-soft)]">No process output yet.</p>
                  )}
                </div>

                <div className="mt-5 rounded-[24px] border border-black/6 bg-white/60 p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-[var(--ink-soft)]">Current command</p>
                  <p className="mt-2 break-all text-sm text-[var(--ink-strong)]">{snapshot.process.command || draft.research_command || "n/a"}</p>
                </div>
              </Panel>
            </section>
            ) : null}
          </main>
        </div>
      </div>

      {loading ? (
        <div className="fixed inset-x-0 bottom-6 mx-auto w-fit rounded-full border border-black/8 bg-white/85 px-4 py-2 text-xs uppercase tracking-[0.22em] text-[var(--ink-soft)] backdrop-blur">
          Syncing backend state...
        </div>
      ) : null}
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
    <section className={`premium-panel rounded-[32px] border border-black/6 bg-[linear-gradient(180deg,rgba(255,255,255,0.78),rgba(255,250,241,0.72))] p-5 shadow-[0_24px_60px_rgba(44,33,20,0.08)] backdrop-blur-xl ${className}`}>
      {children}
    </section>
  );
}

function PanelTitle({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-3 text-xs uppercase tracking-[0.2em] text-[var(--ink-soft)]">
        <Icon className="h-4 w-4 text-[var(--accent)]" />
        {title}
      </div>
      <p className="mt-3 font-['Fraunces','Iowan_Old_Style',serif] text-2xl text-[var(--ink-strong)]">{title}</p>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--ink-soft)]">{subtitle}</p>
    </div>
  );
}

function StatChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "good" | "bad" | "neutral";
}) {
  const tones = {
    good: "border-emerald-500/20 bg-emerald-500/10 text-[var(--ink-strong)]",
    bad: "border-rose-500/20 bg-rose-500/10 text-[var(--ink-strong)]",
    neutral: "border-black/6 bg-white/60 text-[var(--ink-strong)]",
  };

  return (
    <div className={`premium-panel rounded-[24px] border px-4 py-3 ${tones[tone]}`}>
      <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--ink-soft)]">{label}</p>
      <p className="mt-2 text-sm font-medium">{value}</p>
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  disabled,
  icon: Icon,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="premium-button inline-flex items-center gap-2 rounded-2xl bg-[var(--accent)] px-4 py-3 text-sm font-medium text-black disabled:cursor-not-allowed disabled:opacity-45"
    >
      <Icon className="h-4 w-4" />
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
      className="premium-subtle-button inline-flex items-center justify-center rounded-2xl border border-black/8 bg-white/55 px-4 py-3 text-sm text-[var(--ink-strong)] disabled:cursor-not-allowed disabled:opacity-45"
    >
      {children}
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
    <div className="mt-5">
      <label className="text-xs uppercase tracking-[0.18em] text-[var(--ink-soft)]">{label}</label>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full rounded-2xl border border-black/8 bg-white/70 px-4 py-3 text-sm text-[var(--ink-strong)] outline-none transition duration-300 ease-out focus:border-[var(--accent)]/50 focus:bg-white"
      >
        {!value ? <option value="">Select {label.toLowerCase()}</option> : null}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}

function GoalButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`premium-subtle-button flex items-center justify-center gap-2 rounded-2xl border px-4 py-3 text-sm ${
        active ? "border-[var(--accent)]/45 bg-[var(--accent)]/14 text-[var(--ink-strong)]" : "border-black/8 bg-white/55 text-[var(--ink-soft)]"
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function ControlButton({
  label,
  icon: Icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: ComponentType<{ className?: string }>;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="premium-subtle-button inline-flex items-center justify-center gap-2 rounded-2xl border border-black/8 bg-white/60 px-4 py-3 text-sm text-[var(--ink-strong)] disabled:cursor-not-allowed disabled:opacity-45"
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="premium-panel rounded-[24px] border border-black/6 bg-white/60 p-4">
      <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--ink-soft)]">{label}</p>
      <p className="mt-2 text-sm text-[var(--ink-strong)]">{value}</p>
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
  const tone =
    value === "live"
      ? "bg-emerald-500/12 text-[var(--good)]"
      : value === "offline"
        ? "bg-rose-500/12 text-[var(--bad)]"
        : "bg-black/[0.05] text-[var(--ink-soft)]";

  return (
    <span className={`rounded-full px-3 py-1 text-xs ${tone}`}>
      {label}: {value}
    </span>
  );
}
