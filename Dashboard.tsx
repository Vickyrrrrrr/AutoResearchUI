"use client";

import dynamic from "next/dynamic";
import {
  useDeferredValue,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  startTransition,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  BarChart2,
  Bot,
  Brain,
  Cable,
  CheckCircle2,
  ChevronRight,
  Code2,
  Cpu,
  Database,
  Download,
  FileDown,
  FolderSearch,
  GitBranch,
  GitCommitHorizontal,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  RefreshCcw,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  SquareTerminal,
  Sun,
  TrendingDown,
  TrendingUp,
  XCircle,
  Zap,
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
  CommitMetricPoint,
  DiscoveryResult,
  ExperimentRecord,
  GpuStats,
  HealthReport,
  LlmResult,
  MappingConfig,
  MetricPoint,
  SessionData,
  SessionInfo,
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

type DashboardView = "overview" | "history" | "activity" | "diff" | "timeline";

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
  if (!value) return "n/a";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : `${DATE_FORMATTER.format(parsed)} UTC`;
}

function formatMetric(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  if (Math.abs(value) >= 1000) return value.toFixed(1);
  if (Math.abs(value) >= 10) return value.toFixed(2);
  return value.toFixed(4);
}

function compactText(value: string | null | undefined, maxLength = 88) {
  if (!value) return "n/a";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
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
  background.setAttribute("fill", "#ffffff");
  clone.insertBefore(background, clone.firstChild);
  const blob = new Blob([clone.outerHTML], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function metricOptionsForLog(discovery: DiscoveryResult | null, logFile: string) {
  if (!discovery) return [];
  const fileSpecific = logFile ? discovery.headers_by_file?.[logFile] ?? [] : [];
  const source = fileSpecific.length ? fileSpecific : discovery.suggested_metrics ?? [];
  return Array.from(new Set(source));
}

function fileHintFor(discovery: DiscoveryResult | null, filePath: string, fallback: string) {
  if (!discovery || !filePath) return fallback;
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
  if (!command || !scriptPath) return false;
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
    program_plan: discovery.program_plan ?? [],
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

// ─── Sub-Components ──────────────────────────────────────────────────────────

function Card({ children, className = "", hover = false }: { children: ReactNode; className?: string; hover?: boolean }) {
  return (
    <div className={`bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm ${hover ? "card-hover" : ""} ${className}`}>
      {children}
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
      {children}
    </p>
  );
}

function StatusBadge({ status }: { status: ExperimentRecord["status"] }) {
  if (status === "KEPT") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 dark:bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-400 ring-1 ring-emerald-200 dark:ring-emerald-500/30">
        <CheckCircle2 className="h-2.5 w-2.5" /> KEPT
      </span>
    );
  }
  if (status === "DISCARDED") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-50 dark:bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-600 dark:text-red-400 ring-1 ring-red-200 dark:ring-red-500/30">
        <XCircle className="h-2.5 w-2.5" /> DISCARDED
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 dark:bg-slate-700 px-2 py-0.5 text-[10px] font-semibold text-slate-500 dark:text-slate-400 ring-1 ring-slate-200 dark:ring-slate-600">
      INFO
    </span>
  );
}

function ConnectionDot({ state }: { state: ConnectionState }) {
  if (state === "live") return <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.7)]" />;
  if (state === "checking") return <span className="inline-block h-2 w-2 rounded-full bg-amber-400 animate-pulse" />;
  return <span className="inline-block h-2 w-2 rounded-full bg-red-500" />;
}

function KpiCard({
  label,
  value,
  sub,
  delta,
  deltaPositive,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: string;
  deltaPositive?: boolean;
  accent?: string;
}) {
  return (
    <Card hover className={`p-5 border-l-4 ${accent ?? "border-l-blue-500"}`}>
      <p className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">{label}</p>
      <p className="text-2xl font-bold text-slate-800 dark:text-slate-100 leading-tight">{value}</p>
      {(sub || delta) && (
        <div className="mt-1.5 flex items-center gap-2">
          {delta && (
            <span className={`flex items-center gap-0.5 text-[10px] font-semibold rounded-full px-1.5 py-0.5 ${
              deltaPositive ? "bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400"
            }`}>
              {deltaPositive ? <ArrowUp className="h-2.5 w-2.5" /> : <ArrowDown className="h-2.5 w-2.5" />}
              {delta}
            </span>
          )}
          {sub && <p className="text-[10px] text-slate-400 dark:text-slate-500">{sub}</p>}
        </div>
      )}
    </Card>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

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
  const [socketState, setSocketState] = useState<ConnectionState>("checking");
  const [celebration, setCelebration] = useState<CelebrationState | null>(null);
  const [activeView, setActiveView] = useState<DashboardView>("overview");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  const [sessionData, setSessionData] = useState<SessionData | null>(null);
  const [baselineSessionId, setBaselineSessionId] = useState<number | null>(null);
  const [baselineData, setBaselineData] = useState<MetricPoint[] | null>(null);
  const [timelineData, setTimelineData] = useState<CommitMetricPoint[]>([]);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [gpuStats, setGpuStats] = useState<GpuStats[]>([]);
  const [llmAnalysis, setLlmAnalysis] = useState<string | null>(null);
  const [llmBusy, setLlmBusy] = useState(false);
  const [ollamaModel, setOllamaModel] = useState("llama3.2");
  const [hasMounted, setHasMounted] = useState(false);
  const [configOpen, setConfigOpen] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [notification, setNotification] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const bestMetricRef = useRef<number | null>(null);
  const chartRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<HTMLDivElement | null>(null);

  const deferredPoints = useDeferredValue(snapshot.metric_points);
  const deferredExperiments = useDeferredValue(snapshot.experiments);
  const headers = useMemo(() => metricOptionsForLog(discovery, draft.log_file), [draft.log_file, discovery]);
  const commandHint = useMemo(() => {
    if (discovery?.suggested_command) return `Suggested: ${discovery.suggested_command}`;
    return "Command that runs one experiment loop.";
  }, [discovery]);

  async function runConnectionCheck() {
    setHttpState("checking");
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
    } else {
      throw stateResult.reason;
    }
  }

  async function loadSessions() {
    try {
      const data = await requestJson<SessionInfo[]>("/api/sessions");
      setSessions(data);
    } catch (caught) {
      console.error("Failed to load sessions", caught);
    }
  }

  async function viewSession(session: SessionInfo) {
    try {
      setBusy(true);
      const data = await requestJson<SessionData>(`/api/sessions/${session.id}`);
      setSelectedSession(session);
      setSessionData(data);
    } catch {
      setError("Failed to load session details.");
    } finally {
      setBusy(false);
    }
  }

  async function loadBaseline(sessionId: number | null) {
    if (!sessionId) {
      setBaselineSessionId(null);
      setBaselineData(null);
      return;
    }
    try {
      const data = await requestJson<SessionData>(`/api/sessions/${sessionId}`);
      setBaselineSessionId(sessionId);
      setBaselineData(data.metric_points);
    } catch (caught) {
      console.error("Failed to load baseline data", caught);
    }
  }

  async function loadTimeline() {
    try {
      const data = await requestJson<CommitMetricPoint[]>("/api/git/timeline");
      setTimelineData(data);
    } catch (caught) {
      console.error("Failed to load git timeline", caught);
    }
  }

  async function rollbackToCommit(sha: string) {
    if (!window.confirm(`Roll back to commit ${sha}? This puts the repo in detached HEAD state.`)) return;
    try {
      setRollbackBusy(true);
      await requestJson(`/api/git/rollback?sha=${encodeURIComponent(sha)}`, { method: "POST" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Rollback failed.");
    } finally {
      setRollbackBusy(false);
    }
  }

  async function exportMarkdown() {
    try {
      const response = await fetch(`${API_BASE}/api/export/markdown`, { cache: "no-store" });
      if (!response.ok) {
        const msg = await response.text();
        throw new Error(msg);
      }
      const text = await response.text();
      const blob = new Blob([text], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "research_summary.md";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      showNotification("Markdown report exported", "success");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Export failed.");
    }
  }

  async function exportHtml() {
    try {
      const response = await fetch(`${API_BASE}/api/export/html`, { cache: "no-store" });
      if (!response.ok) {
        const msg = await response.text();
        throw new Error(msg);
      }
      const text = await response.text();
      const blob = new Blob([text], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "research_summary.html";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      showNotification("HTML report exported", "success");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "HTML export failed.");
    }
  }

  async function loadGpuStats() {
    try {
      const data = await requestJson<GpuStats[]>("/api/gpu");
      setGpuStats(data);
    } catch {
      // GPU not available — silently ignore
    }
  }

  async function askLLM() {
    try {
      setLlmBusy(true);
      setLlmAnalysis(null);
      const result = await requestJson<LlmResult>(
        `/api/llm/analyze?model=${encodeURIComponent(ollamaModel)}`,
        { method: "POST" },
      );
      setLlmAnalysis(result.analysis);
    } catch (caught) {
      setLlmAnalysis(`Error: ${caught instanceof Error ? caught.message : "LLM unavailable."}`);
    } finally {
      setLlmBusy(false);
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
        if (ignore) return;
        setProjectRoot(discovered.project_root);
        setDiscovery(discovered);
        setDraft((current) => deriveDefaults(discovered, current));
      } catch (caught) {
        if (!ignore) setError(caught instanceof Error ? caught.message : "Failed to load backend state.");
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    bootstrap();
    setHasMounted(true);
    return () => { ignore = true; };
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
          if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
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
        if (heartbeat) window.clearInterval(heartbeat);
        if (!cancelled) reconnectTimer = window.setTimeout(connect, 3000);
      });
      socket.addEventListener("error", () => {
        setSocketState("offline");
        if (heartbeat) window.clearInterval(heartbeat);
      });
    };
    connect();
    return () => {
      cancelled = true;
      if (heartbeat) window.clearInterval(heartbeat);
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        await runConnectionCheck();
      } catch (caught) {
        if (!cancelled) setError((current) => current ?? (caught instanceof Error ? caught.message : "Connection check failed."));
      }
    };
    const interval = window.setInterval(check, 15000);
    return () => { cancelled = true; window.clearInterval(interval); };
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

  useEffect(() => { loadSessions(); }, []);

  useEffect(() => {
    loadGpuStats();
    const interval = window.setInterval(loadGpuStats, 5000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (activeView === "history") loadSessions();
    if (activeView === "timeline") loadTimeline();
  }, [activeView]);

  // Notification auto-dismiss
  function showNotification(text: string, type: "success" | "error") {
    setNotification({ text, type });
    window.setTimeout(() => setNotification(null), 3000);
  }

  // Keyboard shortcuts: 1-5 switch views, Ctrl+S start, Ctrl+K stop
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      // Don't fire in inputs
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      const viewKeys: Record<string, DashboardView> = { "1": "overview", "2": "timeline", "3": "history", "4": "activity", "5": "diff" };
      if (viewKeys[e.key]) {
        e.preventDefault();
        setActiveView(viewKeys[e.key]);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  // Auto-scroll terminal to bottom
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [snapshot.stdout_tail]);

  // Dark mode body class
  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
  }, [darkMode]);

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
    if (!deferredPoints.length) return null;
    const values = deferredPoints.map((point) => point.metric);
    return draft.optimization_goal === "minimize" ? Math.min(...values) : Math.max(...values);
  }, [deferredPoints, draft.optimization_goal]);

  const chartData = useMemo(() => {
    const live = deferredPoints.map((point: any) => ({
      iteration: point.iteration,
      metric: point.metric,
      label: `#${point.iteration}`,
    }));
    if (!baselineData) return live;
    const maxIter = Math.max(...live.map((p) => p.iteration), ...baselineData.map((p) => p.iteration), 0);
    const merged = [];
    for (let i = 1; i <= maxIter; i++) {
      const livePoint = live.find((p) => p.iteration === i);
      const baselinePoint = baselineData.find((p: any) => p.iteration === i);
      if (livePoint || baselinePoint) {
        merged.push({ iteration: i, metric: livePoint?.metric ?? null, baseline: baselinePoint?.metric ?? null, label: `#${i}` });
      }
    }
    return merged;
  }, [deferredPoints, baselineData]);

  const latestExperiment = deferredExperiments[deferredExperiments.length - 1] ?? null;
  const latestMetricPoint = deferredPoints[deferredPoints.length - 1] ?? null;
  const iterationCount = latestExperiment?.iteration ?? latestMetricPoint?.iteration ?? 0;

  const keptCount = deferredExperiments.filter((e) => e.status === "KEPT").length;
  const keepRate = deferredExperiments.length > 0 ? Math.round((keptCount / deferredExperiments.length) * 100) : null;

  // Filtered experiments for search
  const filteredExperiments = useMemo(() => {
    if (!searchQuery.trim()) return deferredExperiments;
    const q = searchQuery.toLowerCase();
    return deferredExperiments.filter(
      (e) =>
        e.hypothesis?.toLowerCase().includes(q) ||
        e.status.toLowerCase().includes(q) ||
        String(e.iteration).includes(q)
    );
  }, [deferredExperiments, searchQuery]);

  const improvementBadge = useMemo(() => {
    if (!baselineData || bestMetric === null) return null;
    const baselineBest =
      draft.optimization_goal === "minimize"
        ? Math.min(...baselineData.map((p) => p.metric))
        : Math.max(...baselineData.map((p) => p.metric));
    if (!isFinite(baselineBest)) return null;
    const delta = ((bestMetric - baselineBest) / Math.abs(baselineBest)) * 100;
    const improved = draft.optimization_goal === "minimize" ? delta < 0 : delta > 0;
    return { improved, pct: Math.abs(delta).toFixed(1) };
  }, [baselineData, bestMetric, draft.optimization_goal]);

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
        [...deferredPoints].reverse().find((point) => point.metric === bestMetric) ??
        deferredPoints[deferredPoints.length - 1];
      setCelebration({ iteration: match.iteration, value: bestMetric, delta: Math.abs(bestMetric - previous) });
      const timer = window.setTimeout(() => setCelebration(null), 4200);
      bestMetricRef.current = bestMetric;
      return () => window.clearTimeout(timer);
    }
    bestMetricRef.current = bestMetric;
  }, [bestMetric, deferredPoints, draft.optimization_goal]);

  function downloadMetricGraph() {
    const svg = chartRef.current?.querySelector("svg");
    if (!svg || !chartData.length) return;
    const metricLabel =
      (draft.y_axis_metric || "metric")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "metric";
    downloadSvgElement(svg, `autoresearchui-${metricLabel}-graph.svg`);
  }

  const isRunning = snapshot.process.status === "running";
  const processLabel = isRunning ? "Running" : snapshot.process.status === "stopping" ? "Stopping…" : snapshot.process.status === "errored" ? "Errored" : "Idle";

  const navItems: Array<{ id: DashboardView; label: string; icon: any; shortcut: string }> = [
    { id: "overview", label: "Overview", icon: BarChart2, shortcut: "1" },
    { id: "timeline", label: "Git Timeline", icon: GitBranch, shortcut: "2" },
    { id: "history", label: "Run History", icon: Database, shortcut: "3" },
    { id: "activity", label: "Activity", icon: Activity, shortcut: "4" },
    { id: "diff", label: "Code Diff", icon: Code2, shortcut: "5" },
  ];

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-screen overflow-hidden bg-slate-100 dark:bg-[#0b1120] text-slate-800 dark:text-slate-200 transition-colors duration-300">

      {/* ── Left Sidebar ─────────────────────────────────────── */}
      <aside className={`${sidebarCollapsed ? "w-16" : "w-64"} sidebar-transition bg-[#0F172A] flex flex-col h-screen shrink-0 overflow-y-auto overflow-x-hidden`}>

        {/* Brand */}
        <div className="flex items-center gap-3 px-5 py-5 border-b border-white/10 shrink-0">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 shrink-0">
            <Cable className="h-4 w-4 text-white" />
          </div>
          {!sidebarCollapsed && (
            <div className="min-w-0">
              <p className="text-sm font-bold text-white leading-tight">AutoResearch UI</p>
              <p className="text-[10px] text-slate-500">Research Loop Monitor</p>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="py-3 shrink-0">
          {!sidebarCollapsed && (
            <p className="px-5 mb-1 text-[9px] font-semibold uppercase tracking-widest text-slate-600">Navigation</p>
          )}
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeView === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveView(item.id)}
                title={sidebarCollapsed ? `${item.label} (${item.shortcut})` : undefined}
                className={`w-full flex items-center gap-3 ${sidebarCollapsed ? "justify-center px-2" : "px-5"} py-2.5 text-sm font-medium transition-colors ${
                  active
                    ? "bg-blue-600/20 text-blue-400 border-r-2 border-blue-500"
                    : "text-slate-400 hover:bg-white/5 hover:text-white"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {!sidebarCollapsed && (
                  <>
                    <span className="flex-1 text-left">{item.label}</span>
                    <kbd className="hidden sm:inline-flex h-5 w-5 items-center justify-center rounded bg-white/5 text-[9px] font-mono text-slate-500">{item.shortcut}</kbd>
                  </>
                )}
              </button>
            );
          })}
        </nav>

        {/* Config Panel */}
        {!sidebarCollapsed && (
        <div className="border-t border-white/10 flex-1 overflow-y-auto">
          <button
            onClick={() => setConfigOpen((v) => !v)}
            className="w-full flex items-center justify-between px-5 py-3 text-[10px] font-semibold uppercase tracking-widest text-slate-500 hover:text-slate-300 transition-colors"
          >
            <span className="flex items-center gap-2"><Settings className="h-3 w-3" /> Configuration</span>
            <ChevronRight className={`h-3 w-3 transition-transform ${configOpen ? "rotate-90" : ""}`} />
          </button>

          {configOpen && (
            <div className="px-4 pb-4 space-y-4">
              <div className="space-y-1">
                <label className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">Workspace</label>
                <div className="flex gap-1">
                  <input
                    value={projectRoot}
                    onChange={(e) => setProjectRoot(e.target.value)}
                    placeholder="/path/to/project"
                    className="flex-1 min-w-0 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[11px] font-mono text-slate-300 outline-none placeholder:text-slate-600 focus:border-blue-500 focus:bg-white/8"
                  />
                  <button
                    onClick={scanWorkspace}
                    disabled={busy}
                    className="rounded-lg bg-blue-600 px-2.5 py-2 text-white transition hover:bg-blue-500 disabled:opacity-40"
                  >
                    <FolderSearch className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              <div className="space-y-3">
                <SidebarSelect
                  label="Target Script"
                  value={draft.script_to_watch}
                  onChange={(v) => setDraft((c) => ({ ...c, project_root: projectRoot || c.project_root, script_to_watch: v, research_command: defaultCommandForScript(discovery, v) || c.research_command }))}
                  options={discovery?.script_candidates ?? []}
                />
                <SidebarSelect
                  label="Log File"
                  value={draft.log_file}
                  onChange={(v) => setDraft((c) => ({ ...c, log_file: v }))}
                  options={discovery?.log_candidates ?? []}
                />
                <SidebarSelect
                  label="Primary Metric"
                  value={draft.y_axis_metric}
                  onChange={(v) => setDraft((c) => ({ ...c, y_axis_metric: v }))}
                  options={headers}
                />
              </div>

              <div>
                <label className="text-[10px] font-medium text-slate-500 uppercase tracking-wider block mb-1">Optimization</label>
                <div className="flex gap-1">
                  {(["minimize", "maximize"] as const).map((goal) => (
                    <button
                      key={goal}
                      onClick={() => setDraft((c) => ({ ...c, optimization_goal: goal }))}
                      className={`flex-1 flex items-center justify-center gap-1 rounded-lg py-1.5 text-[10px] font-semibold transition-colors ${
                        draft.optimization_goal === goal
                          ? "bg-blue-600 text-white"
                          : "bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white"
                      }`}
                    >
                      {goal === "minimize" ? <TrendingDown className="h-3 w-3" /> : <TrendingUp className="h-3 w-3" />}
                      {goal === "minimize" ? "Min" : "Max"}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-[10px] font-medium text-slate-500 uppercase tracking-wider block mb-1">Runtime Command</label>
                <input
                  value={draft.research_command ?? ""}
                  onChange={(e) => setDraft((c) => ({ ...c, research_command: e.target.value }))}
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[11px] font-mono text-slate-300 outline-none placeholder:text-slate-600 focus:border-blue-500"
                  placeholder="python train.py"
                />
                <p className="mt-1 text-[9px] text-slate-600 leading-relaxed italic">{commandHint}</p>
              </div>

              <SidebarSelect
                label="Baseline Session"
                value={baselineSessionId?.toString() ?? ""}
                onChange={(v) => loadBaseline(v ? parseInt(v) : null)}
                options={[
                  { label: "None (live only)", value: "" },
                  ...(sessions || []).map((s) => ({
                    label: `Session #${s.id} (${formatDate(s.started_at)})`,
                    value: s.id.toString(),
                  })),
                ]}
              />

              <button
                onClick={applyMapping}
                disabled={busy || !draft.script_to_watch || !draft.log_file || !draft.y_axis_metric}
                className="w-full rounded-lg bg-emerald-600 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
              >
                Apply Configuration
              </button>
            </div>
          )}
        </div>
        )}

        {/* Sidebar collapse toggle + Connection Status & Dark Mode */}
        <div className={`${sidebarCollapsed ? "px-2" : "px-5"} py-4 border-t border-white/10 shrink-0 space-y-2`}>
          {!sidebarCollapsed && (
            <>
              <div className="flex items-center justify-between text-[10px] text-slate-500">
                <span className="flex items-center gap-1.5"><ConnectionDot state={httpState} /> HTTP API</span>
                <span className="uppercase text-[9px]">{httpState}</span>
              </div>
              <div className="flex items-center justify-between text-[10px] text-slate-500">
                <span className="flex items-center gap-1.5"><ConnectionDot state={socketState} /> WebSocket</span>
                <span className="uppercase text-[9px]">{socketState}</span>
              </div>
            </>
          )}
          {sidebarCollapsed && (
            <div className="flex flex-col items-center gap-1.5 mb-1">
              <ConnectionDot state={httpState} />
              <ConnectionDot state={socketState} />
            </div>
          )}
          <button
            onClick={() => setDarkMode((v) => !v)}
            title={darkMode ? "Light mode" : "Dark mode"}
            className={`w-full flex items-center justify-center gap-1.5 rounded-lg bg-white/5 py-1.5 text-[10px] font-medium text-slate-400 transition hover:bg-white/10 hover:text-white`}
          >
            {darkMode ? <Sun className="h-3 w-3" /> : <Moon className="h-3 w-3" />}
            {!sidebarCollapsed && (darkMode ? "Light Mode" : "Dark Mode")}
          </button>
          <button
            onClick={() => setSidebarCollapsed((v) => !v)}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="w-full flex items-center justify-center gap-1.5 rounded-lg bg-white/5 py-1.5 text-[10px] font-medium text-slate-400 transition hover:bg-white/10 hover:text-white"
          >
            {sidebarCollapsed ? <PanelLeftOpen className="h-3 w-3" /> : <PanelLeftClose className="h-3 w-3" />}
            {!sidebarCollapsed && "Collapse"}
          </button>
        </div>
      </aside>

      {/* ── Main Area ─────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col overflow-hidden">

        {/* Top Header */}
        <header className="flex h-14 items-center justify-between border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-6 shrink-0 z-10 transition-colors">
          <div className="flex items-center gap-3 min-w-0">
            <div>
              <h1 className="text-sm font-bold text-slate-800 dark:text-slate-100 capitalize">
                {navItems.find((n) => n.id === activeView)?.label ?? activeView}
              </h1>
              <p className="text-[10px] text-slate-400 dark:text-slate-500 font-mono truncate max-w-[320px]">
                {discovery?.project_root || "No project loaded"}
              </p>
            </div>
            {celebration && (
              <div className="flex items-center gap-1.5 rounded-full bg-emerald-50 dark:bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 ring-1 ring-emerald-200 dark:ring-emerald-500/30 animate-pulse">
                <Sparkles className="h-3 w-3" /> New best: {formatMetric(celebration.value)} at #{celebration.iteration}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Process controls */}
            <div className="flex items-center gap-1 mr-2">
              <span className={`flex h-2 w-2 rounded-full ${
                isRunning ? "bg-emerald-400 animate-pulse" :
                snapshot.process.status === "errored" ? "bg-red-500" : "bg-slate-300"
              }`} />
              <span className="text-[11px] font-medium text-slate-500 mr-2">{processLabel}</span>
              <button
                onClick={() => controlProcess("start")}
                disabled={busy || isRunning}
                className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
              >
                <Play className="h-3 w-3" /> Start
              </button>
              <button
                onClick={() => controlProcess("stop")}
                disabled={busy || snapshot.process.status === "idle"}
                className="flex items-center gap-1 rounded-lg bg-slate-200 px-3 py-1.5 text-[11px] font-semibold text-slate-700 transition hover:bg-slate-300 disabled:opacity-40"
              >
                <Pause className="h-3 w-3" /> Stop
              </button>
              <button
                onClick={() => controlProcess("restart")}
                disabled={busy}
                className="flex items-center gap-1 rounded-lg bg-slate-200 px-3 py-1.5 text-[11px] font-semibold text-slate-700 transition hover:bg-slate-300 disabled:opacity-40"
              >
                <RefreshCcw className="h-3 w-3" /> Restart
              </button>
            </div>

            {/* Export buttons */}
            <div className="flex items-center gap-1 border-l border-slate-200 dark:border-slate-700 pl-2">
              <button onClick={exportMarkdown} disabled={!snapshot.config} className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400 transition hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-slate-800 dark:hover:text-white disabled:opacity-40">
                <FileDown className="h-3.5 w-3.5" /> .md
              </button>
              <button onClick={exportHtml} disabled={!snapshot.config} className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400 transition hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-slate-800 dark:hover:text-white disabled:opacity-40">
                <Download className="h-3.5 w-3.5" /> .html
              </button>
              <button onClick={downloadMetricGraph} disabled={!chartData.length} className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400 transition hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-slate-800 dark:hover:text-white disabled:opacity-40">
                <Download className="h-3.5 w-3.5" /> .svg
              </button>
            </div>
          </div>
        </header>

        {/* Content + Right Panel */}
        <div className="flex flex-1 overflow-hidden">

          {/* Main Scrollable Content */}
          <main className="flex-1 overflow-y-auto p-6 space-y-5">

            {/* Error Banner */}
            {error && (
              <div className="flex items-center justify-between rounded-xl border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-4 py-3">
                <p className="text-sm font-medium text-red-600 dark:text-red-400">{error}</p>
                <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600">
                  <XCircle className="h-4 w-4" />
                </button>
              </div>
            )}

            {/* ── OVERVIEW ── */}
            {activeView === "overview" && (
              <div className="space-y-5 view-enter">
                {/* KPI Cards */}
                <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
                  <KpiCard
                    label="Current Metric"
                    value={latestMetricPoint ? formatMetric(latestMetricPoint.metric) : "—"}
                    sub={latestMetricPoint ? `Iteration #${latestMetricPoint.iteration}` : "Awaiting data"}
                    accent={snapshot.process.status === "running" ? "border-l-blue-500" : "border-l-slate-300"}
                  />
                  <KpiCard
                    label={`Best (${draft.optimization_goal})`}
                    value={bestMetric !== null ? formatMetric(bestMetric) : "—"}
                    sub={draft.y_axis_metric || "metric"}
                    delta={improvementBadge ? `${improvementBadge.pct}% vs baseline` : undefined}
                    deltaPositive={improvementBadge?.improved}
                    accent={bestMetric !== null ? "border-l-emerald-500" : "border-l-slate-300"}
                  />
                  <KpiCard
                    label="Experiments"
                    value={String(deferredExperiments.length)}
                    sub={`${iterationCount} iterations`}
                    accent="border-l-violet-500"
                  />
                  <KpiCard
                    label="Keep Rate"
                    value={keepRate !== null ? `${keepRate}%` : "—"}
                    sub={`${keptCount} kept / ${deferredExperiments.length} total`}
                    delta={keepRate !== null ? `${keepRate}%` : undefined}
                    deltaPositive={keepRate !== null && keepRate >= 50}
                    accent="border-l-amber-500"
                  />
                </div>

                {/* Baseline comparison badge */}
                {improvementBadge && (
                  <div className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold ${
                    improvementBadge.improved
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : "border-red-200 bg-red-50 text-red-700"
                  }`}>
                    {improvementBadge.improved ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
                    {improvementBadge.improved ? "IMPROVED" : "REGRESSED"} {improvementBadge.pct}% vs. baseline session #{baselineSessionId}
                  </div>
                )}

                {/* Metric Chart */}
                <Card className="p-5">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                      Metric Performance —{" "}
                      <span className="text-blue-600 dark:text-blue-400 font-mono text-xs">{draft.y_axis_metric || "not configured"}</span>
                    </p>
                    {isRunning && (
                      <span className="flex items-center gap-1.5 rounded-full bg-blue-50 dark:bg-blue-500/10 px-2.5 py-1 text-[10px] font-semibold text-blue-600 dark:text-blue-400 ring-1 ring-blue-200 dark:ring-blue-500/30 animate-pulse">
                        <span className="h-1.5 w-1.5 rounded-full bg-blue-500" /> LIVE
                      </span>
                    )}
                  </div>
                  <div ref={chartRef} className="h-60 w-full">
                    {chartData.length ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData}>
                          <CartesianGrid stroke={darkMode ? "#1e293b" : "#f1f5f9"} vertical={false} />
                          <XAxis dataKey="iteration" tick={{ fontSize: 10, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                          <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} />
                          <Tooltip
                            contentStyle={{ background: darkMode ? "#1e293b" : "#fff", border: `1px solid ${darkMode ? "#334155" : "#e2e8f0"}`, borderRadius: 8, padding: "8px 12px", boxShadow: "0 4px 6px -1px rgba(0,0,0,0.1)", color: darkMode ? "#e2e8f0" : "#334155" }}
                            labelStyle={{ color: "#64748b", fontWeight: 600, fontSize: 11 }}
                          />
                          {baselineData && (
                            <Line type="stepAfter" dataKey="baseline" stroke="#cbd5e1" strokeWidth={1.5} strokeDasharray="5 4" dot={false} activeDot={false} isAnimationActive={false} name="Baseline" />
                          )}
                          <Line type="stepAfter" dataKey="metric" stroke="#3b82f6" strokeWidth={2} dot={{ r: 0 }} activeDot={{ r: 4, fill: "#3b82f6", stroke: "#fff", strokeWidth: 2 }} name={draft.y_axis_metric || "metric"} />
                        </LineChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="flex h-full items-center justify-center rounded-xl bg-slate-50 dark:bg-slate-800/50">
                        <div className="text-center">
                          <BarChart2 className="h-8 w-8 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
                          <p className="text-sm font-medium text-slate-400 dark:text-slate-500">Awaiting data stream</p>
                          <p className="text-xs text-slate-300 dark:text-slate-600 mt-1">Start a run to see metrics plotted here</p>
                        </div>
                      </div>
                    )}
                  </div>
                </Card>

                {/* Experiment Records Table */}
                <Card>
                  <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">Experiment Records</p>
                      <span className="rounded-full bg-slate-100 dark:bg-slate-700 px-2 py-0.5 text-[10px] font-semibold text-slate-500 dark:text-slate-400">{filteredExperiments.length}</span>
                    </div>
                    <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-700/50 px-2.5 py-1.5">
                      <Search className="h-3 w-3 text-slate-400" />
                      <input
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Filter experiments…"
                        className="bg-transparent text-[11px] text-slate-700 dark:text-slate-300 outline-none w-36 placeholder:text-slate-400 dark:placeholder:text-slate-500"
                      />
                    </div>
                  </div>
                  {filteredExperiments.length ? (
                    <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 z-[1]">
                          <tr className="border-b border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                            <th className="px-5 py-3 text-left">Iter</th>
                            <th className="px-5 py-3 text-left">Status</th>
                            <th className="px-5 py-3 text-right">Metric</th>
                            <th className="px-5 py-3 text-left">Hypothesis</th>
                            <th className="px-5 py-3 text-right">Time</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredExperiments.slice().reverse().map((exp) => (
                            <tr key={`${exp.iteration}-${exp.timestamp}`} className="zebra-row border-b border-slate-50 dark:border-slate-700/50 hover:bg-blue-50/40 dark:hover:bg-blue-500/5 transition-colors">
                              <td className="px-5 py-3 font-mono font-semibold text-slate-600 dark:text-slate-300">#{exp.iteration}</td>
                              <td className="px-5 py-3"><StatusBadge status={exp.status} /></td>
                              <td className="px-5 py-3 text-right font-mono font-bold text-slate-800 dark:text-slate-200">{formatMetric(exp.metric_value)}</td>
                              <td className="px-5 py-3 text-slate-500 dark:text-slate-400 max-w-[200px] truncate italic">{exp.hypothesis ? `"${compactText(exp.hypothesis, 50)}"` : "—"}</td>
                              <td className="px-5 py-3 text-right text-slate-400 dark:text-slate-500 whitespace-nowrap">{hasMounted ? formatDate(exp.timestamp) : "…"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center py-10 text-slate-400 dark:text-slate-500 text-sm">
                      {searchQuery ? "No experiments match your filter." : "No experiments recorded yet. Start a research loop."}
                    </div>
                  )}
                </Card>
              </div>
            )}

            {/* ── TIMELINE ── */}
            {activeView === "timeline" && (
              <div className="space-y-5 view-enter">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Git Ratchet Timeline</h2>
                    <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">Metric improvement linked to each commit</p>
                  </div>
                  <button
                    onClick={loadTimeline}
                    className="flex items-center gap-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 transition hover:bg-slate-50 dark:hover:bg-slate-700"
                  >
                    <RefreshCcw className="h-3.5 w-3.5" /> Refresh
                  </button>
                </div>

                {timelineData.filter((c) => c.best_metric !== null).length > 0 ? (
                  <Card className="p-5">
                    <p className="text-xs font-semibold text-slate-500 mb-4">Best metric by commit</p>
                    <div className="h-52">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart
                          data={timelineData
                            .filter((c) => c.best_metric !== null)
                            .map((c) => ({ sha: c.sha.slice(0, 7), metric: c.best_metric, iters: c.iteration_count }))
                            .reverse()}
                        >
                          <CartesianGrid stroke={darkMode ? "#1e293b" : "#f1f5f9"} vertical={false} />
                          <XAxis dataKey="sha" tick={{ fontSize: 10, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                          <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} />
                          <Tooltip
                            contentStyle={{ background: darkMode ? "#1e293b" : "#fff", border: `1px solid ${darkMode ? "#334155" : "#e2e8f0"}`, borderRadius: 8, padding: "8px 12px", color: darkMode ? "#e2e8f0" : "#334155" }}
                            formatter={(value: any, _: any, props: any) => [
                              `${value?.toFixed ? value.toFixed(4) : value} (${props.payload.iters} iters)`,
                              snapshot.config?.y_axis_metric ?? "metric",
                            ]}
                          />
                          <Line type="monotone" dataKey="metric" stroke="#8b5cf6" strokeWidth={2} dot={{ r: 4, fill: "#8b5cf6", stroke: "#fff", strokeWidth: 2 }} activeDot={{ r: 6 }} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </Card>
                ) : (
                  <Card className="flex items-center justify-center h-52">
                    <div className="text-center">
                      <GitBranch className="h-8 w-8 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
                      <p className="text-sm font-medium text-slate-400 dark:text-slate-500">
                        {timelineData.length ? "No metric data linked to commits yet" : "No commits found — start a run first"}
                      </p>
                    </div>
                  </Card>
                )}

                <Card>
                  <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-700">
                    <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">Commit History</p>
                  </div>
                  <div className="divide-y divide-slate-50 dark:divide-slate-700/50">
                    {timelineData.length ? (
                      timelineData.map((commit) => (
                        <div key={commit.sha} className="flex items-center justify-between px-5 py-4 group hover:bg-slate-50/60 dark:hover:bg-slate-700/30 transition-colors">
                          <div className="flex items-start gap-4 min-w-0">
                            <GitCommitHorizontal className="h-4 w-4 mt-0.5 shrink-0 text-slate-300 group-hover:text-violet-500 transition-colors" />
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-mono text-[10px] font-bold bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">
                                  {commit.sha.slice(0, 10)}
                                </span>
                                <span className="text-[10px] text-slate-400">{hasMounted ? formatDate(commit.authored_at) : "…"}</span>
                              </div>
                              <p className="mt-1 text-sm font-medium text-slate-700 dark:text-slate-300 truncate">{commit.summary}</p>
                              {commit.best_metric !== null && (
                                <p className="mt-0.5 text-[10px] text-slate-400">
                                  Best: <span className="font-bold text-violet-600">{formatMetric(commit.best_metric)}</span>
                                  {" "}· {commit.iteration_count} iterations
                                </p>
                              )}
                            </div>
                          </div>
                          <button
                            onClick={() => rollbackToCommit(commit.sha)}
                            disabled={rollbackBusy}
                            className="ml-4 flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-[10px] font-semibold text-slate-500 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-40 opacity-0 group-hover:opacity-100"
                          >
                            <RotateCcw className="h-3 w-3" /> Rollback
                          </button>
                        </div>
                      ))
                    ) : (
                      <div className="px-5 py-8 text-center text-sm text-slate-400">No commits found in project root.</div>
                    )}
                  </div>
                </Card>
              </div>
            )}

            {/* ── HISTORY ── */}
            {activeView === "history" && (
              <div className="space-y-5 view-enter">
                <div>
                  <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Run History</h2>
                  <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">Browse and compare previous research sessions</p>
                </div>

                <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
                  <Card>
                    <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-700">
                      <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">Sessions</p>
                    </div>
                    <div className="divide-y divide-slate-50 dark:divide-slate-700/50">
                      {sessions.length ? sessions.map((s) => (
                        <div
                          key={s.id}
                          onClick={() => viewSession(s)}
                          className={`flex items-center justify-between px-5 py-4 cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-slate-700/30 ${
                            selectedSession?.id === s.id ? "bg-blue-50 dark:bg-blue-500/10 border-l-2 border-blue-500" : ""
                          }`}
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-semibold rounded-full bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 px-2 py-0.5">Session #{s.id}</span>
                              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{s.metric_name}</span>
                              <span className="text-[10px] text-slate-400 capitalize">{s.optimization_goal}</span>
                            </div>
                            <p className="mt-1 text-[10px] font-mono text-slate-400 truncate max-w-xs">{s.project_root}</p>
                          </div>
                          <div className="text-right shrink-0 ml-4">
                            <p className="text-[10px] text-slate-400">{hasMounted ? formatDate(s.started_at) : "…"}</p>
                            <ChevronRight className="h-3.5 w-3.5 text-slate-300 mt-1 ml-auto" />
                          </div>
                        </div>
                      )) : (
                        <div className="flex items-center justify-center py-10 text-sm text-slate-400">
                          No historical sessions found.
                        </div>
                      )}
                    </div>
                  </Card>

                  <Card>
                    <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-700">
                      <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">Session Details</p>
                    </div>
                    {selectedSession && sessionData ? (
                      <div className="p-5 space-y-5">
                        <div className="grid grid-cols-2 gap-3">
                          <div className="rounded-xl bg-slate-50 dark:bg-slate-700/50 p-3">
                            <p className="text-[10px] font-semibold uppercase text-slate-400 dark:text-slate-500 tracking-wider">Best Metric</p>
                            <p className="mt-1 text-xl font-bold text-slate-800 dark:text-slate-100">
                              {sessionData.metric_points.length
                                ? formatMetric(
                                    selectedSession.optimization_goal === "minimize"
                                      ? Math.min(...sessionData.metric_points.map((p) => p.metric))
                                      : Math.max(...sessionData.metric_points.map((p) => p.metric))
                                  )
                                : "n/a"}
                            </p>
                          </div>
                          <div className="rounded-xl bg-slate-50 dark:bg-slate-700/50 p-3">
                            <p className="text-[10px] font-semibold uppercase text-slate-400 dark:text-slate-500 tracking-wider">Experiments</p>
                            <p className="mt-1 text-xl font-bold text-slate-800 dark:text-slate-100">{sessionData.experiments.length}</p>
                          </div>
                        </div>
                        <div>
                          <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-2">Outcome Log</p>
                          <div className="space-y-2 max-h-[300px] overflow-y-auto">
                            {sessionData.experiments.slice().reverse().map((exp, idx) => (
                              <div key={idx} className="rounded-lg border border-slate-100 dark:border-slate-700 p-3">
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">Iter #{exp.iteration}</span>
                                  <StatusBadge status={exp.status} />
                                </div>
                                <p className="text-xs italic text-slate-500 line-clamp-2">"{exp.hypothesis || "—"}"</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-center py-10 text-sm text-slate-400">
                        Select a session to view details.
                      </div>
                    )}
                  </Card>
                </div>
              </div>
            )}

            {/* ── ACTIVITY ── */}
            {activeView === "activity" && (
              <div className="space-y-5 view-enter">
                <div className="grid gap-5 lg:grid-cols-[1fr_400px]">
                  {/* Hypothesis Feed */}
                  <Card>
                    <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-700">
                      <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">Hypothesis Feed</p>
                    </div>
                    <div className="divide-y divide-slate-50 dark:divide-slate-700/50 max-h-[500px] overflow-y-auto">
                      {deferredExperiments.length ? (
                        deferredExperiments.slice().reverse().map((exp) => (
                          <div key={`${exp.iteration}-${exp.timestamp}`} className="px-5 py-4">
                            <div className="flex items-center gap-2 mb-2">
                              <span className="rounded-full bg-blue-100 text-blue-700 text-[10px] font-semibold px-2 py-0.5">#{exp.iteration}</span>
                              <StatusBadge status={exp.status} />
                              <span className="text-[10px] text-slate-400">{hasMounted ? formatDate(exp.timestamp) : "…"}</span>
                              <span className="ml-auto font-mono font-bold text-xs text-slate-700">{formatMetric(exp.metric_value)}</span>
                            </div>
                            <p className="text-sm italic text-slate-600 leading-relaxed">
                              "{exp.hypothesis || "Exploration in progress."}"
                            </p>
                          </div>
                        ))
                      ) : (
                        <div className="flex items-center justify-center py-10 text-sm text-slate-400">
                          No activity logs recorded yet.
                        </div>
                      )}
                    </div>
                  </Card>

                  {/* Terminal */}
                  <Card>
                    <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-700 flex items-center gap-2">
                      <SquareTerminal className="h-4 w-4 text-slate-400" />
                      <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">stdout / stderr</p>
                    </div>
                    <div ref={terminalRef} className="h-[452px] overflow-y-auto bg-[#0F172A] rounded-b-xl p-4 font-mono text-[11px] leading-relaxed text-slate-300">
                      {snapshot.stdout_tail.length ? (
                        snapshot.stdout_tail.map((line, idx) => (
                          <div key={idx} className="mb-0.5">{line}</div>
                        ))
                      ) : (
                        <p className="text-slate-600">Awaiting output stream…</p>
                      )}
                    </div>
                  </Card>
                </div>

                {/* LLM Research Assistant */}
                <Card className="p-5">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <Brain className="h-4 w-4 text-violet-500" />
                      <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">AI Research Assistant</p>
                      <span className="text-[10px] rounded-full bg-violet-50 text-violet-600 px-2 py-0.5 font-medium ring-1 ring-violet-200">Ollama</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        value={ollamaModel}
                        onChange={(e) => setOllamaModel(e.target.value)}
                        placeholder="llama3.2"
                        className="w-28 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px] font-mono text-slate-700 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                      />
                      <button
                        onClick={askLLM}
                        disabled={llmBusy || !snapshot.config}
                        className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-violet-500 disabled:opacity-40"
                      >
                        <Brain className="h-3.5 w-3.5" />
                        {llmBusy ? "Thinking…" : "Ask AI"}
                      </button>
                    </div>
                  </div>
                  {llmAnalysis ? (
                    <div className="rounded-xl bg-violet-50 border border-violet-100 p-4">
                      <p className="text-[10px] font-semibold uppercase text-violet-400 tracking-wider mb-2">Ollama · {ollamaModel}</p>
                      <p className="text-sm leading-relaxed text-slate-700 whitespace-pre-wrap italic">{llmAnalysis}</p>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-400 italic">
                      {llmBusy
                        ? "Querying local LLM…"
                        : "Click Ask AI to get an AI analysis of your recent experiments. Requires Ollama running locally."}
                    </p>
                  )}
                </Card>
              </div>
            )}

            {/* ── DIFF ── */}
            {activeView === "diff" && (
              <div className="space-y-5 view-enter">
                <div>
                  <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Code Diff</h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {snapshot.diff.path ? snapshot.diff.path : "No file selected"}
                    {snapshot.diff.latest_commit && (
                      <span className="ml-2 font-mono text-violet-600">@ {snapshot.diff.latest_commit.sha.slice(0, 8)}</span>
                    )}
                  </p>
                </div>
                <Card className="overflow-hidden">
                  {snapshot.diff.path ? (
                    <DiffViewer
                      oldValue={snapshot.diff.before}
                      newValue={snapshot.diff.after}
                      splitView
                      styles={{
                        variables: {
                          light: {
                            diffViewerBackground: "#ffffff",
                            addedBackground: "#f0fdf4",
                            removedBackground: "#fff1f2",
                            gutterBackground: "#f8fafc",
                            gutterColor: "#94a3b8",
                            codeFoldBackground: "#f8fafc",
                          },
                        },
                        contentText: { fontSize: "12px", lineHeight: 1.8, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
                      }}
                    />
                  ) : (
                    <div className="flex h-64 items-center justify-center">
                      <div className="text-center">
                        <Code2 className="h-8 w-8 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
                        <p className="text-sm font-medium text-slate-400 dark:text-slate-500">No code changes detected</p>
                        <p className="text-xs text-slate-300 dark:text-slate-600 mt-1">Changes will appear here when the agent modifies a tracked file</p>
                      </div>
                    </div>
                  )}
                </Card>
              </div>
            )}
          </main>

          {/* ── Right Panel (Overview) ──────────────── */}
          {activeView === "overview" && (
            <aside className="w-72 shrink-0 bg-white dark:bg-slate-800 border-l border-slate-200 dark:border-slate-700 overflow-y-auto flex flex-col gap-4 p-4 transition-colors">

              {/* GPU Stats */}
              {gpuStats.length > 0 && (
                <div>
                  <SectionTitle><Cpu className="h-3 w-3 inline mr-1" /> GPU Monitor</SectionTitle>
                  <div className="space-y-3">
                    {gpuStats.map((gpu) => (
                      <div key={gpu.index} className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-700/50 p-3 space-y-2">
                        <p className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 truncate">{gpu.name}</p>
                        {gpu.utilization_pct !== null && (
                          <div>
                            <div className="flex justify-between text-[9px] text-slate-400 mb-1">
                              <span>Utilization</span><span className="font-semibold">{gpu.utilization_pct}%</span>
                            </div>
                            <div className="h-1.5 w-full rounded-full bg-slate-200">
                              <div className="h-1.5 rounded-full bg-blue-500 transition-all" style={{ width: `${gpu.utilization_pct}%` }} />
                            </div>
                          </div>
                        )}
                        {gpu.memory_used_mb !== null && gpu.memory_total_mb !== null && (
                          <div>
                            <div className="flex justify-between text-[9px] text-slate-400 mb-1">
                              <span>VRAM</span>
                              <span className="font-semibold">
                                {(gpu.memory_used_mb / 1024).toFixed(1)} / {(gpu.memory_total_mb / 1024).toFixed(1)} GB
                              </span>
                            </div>
                            <div className="h-1.5 w-full rounded-full bg-slate-200">
                              <div
                                className="h-1.5 rounded-full bg-violet-500 transition-all"
                                style={{ width: `${(gpu.memory_used_mb / gpu.memory_total_mb) * 100}%` }}
                              />
                            </div>
                          </div>
                        )}
                        <div className="flex gap-3 text-[9px] text-slate-400 font-semibold">
                          {gpu.temperature_c !== null && <span className="flex items-center gap-0.5"><Zap className="h-2.5 w-2.5 text-amber-400" />{gpu.temperature_c}°C</span>}
                          {gpu.watts !== null && <span>{Math.round(gpu.watts)}W</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Recent Commits */}
              {(discovery?.recent_commits ?? []).length > 0 && (
                <div>
                  <SectionTitle><GitBranch className="h-3 w-3 inline mr-1" /> Recent Commits</SectionTitle>
                  <div className="space-y-2">
                    {(discovery?.recent_commits ?? []).slice(0, 5).map((commit) => (
                      <div key={commit.sha} className="rounded-xl border border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-700/50 p-3">
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="font-mono text-[9px] bg-slate-200 text-slate-500 rounded px-1 py-0.5">{commit.sha.slice(0, 7)}</span>
                          <span className="text-[9px] text-slate-400">{hasMounted ? formatDate(commit.authored_at) : "…"}</span>
                        </div>
                        <p className="text-[11px] text-slate-600 leading-tight">{commit.summary}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Agent Plan */}
              {(discovery?.program_plan ?? []).length > 0 && (
                <div>
                  <SectionTitle><Bot className="h-3 w-3 inline mr-1" /> Agent Plan</SectionTitle>
                  <div className="space-y-1.5">
                    {(discovery?.program_plan ?? []).map((item, idx) => {
                      const done = item.startsWith("- [x]") || item.startsWith("- [X]");
                      const text = item.replace(/^- \[[x X]\] ?|- \[ \] ?/i, "").trim();
                      return (
                        <div key={idx} className={`flex items-start gap-2 text-[11px] leading-relaxed ${done ? "text-slate-400 line-through" : "text-slate-600"}`}>
                          <div className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-sm border flex items-center justify-center ${
                            done ? "bg-emerald-500 border-emerald-500" : "border-slate-300"
                          }`}>
                            {done && <span className="text-white text-[8px] font-bold">✓</span>}
                          </div>
                          <span>{text}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Process Status Card */}
              <div>
                <SectionTitle>Process Status</SectionTitle>
                <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-700/50 p-3 space-y-2 text-[11px]">
                  <div className="flex justify-between text-slate-500 dark:text-slate-400">
                    <span>Status</span>
                    <span className={`font-semibold ${
                      isRunning ? "text-emerald-600" :
                      snapshot.process.status === "errored" ? "text-red-600" : "text-slate-600 dark:text-slate-400"
                    }`}>{processLabel}</span>
                  </div>
                  {snapshot.process.pid && (
                    <div className="flex justify-between text-slate-500">
                      <span>PID</span><span className="font-mono font-semibold text-slate-700">{snapshot.process.pid}</span>
                    </div>
                  )}
                  {snapshot.process.started_at && (
                    <div className="flex justify-between text-slate-500">
                      <span>Started</span><span className="text-slate-600">{hasMounted ? formatDate(snapshot.process.started_at) : "…"}</span>
                    </div>
                  )}
                  {snapshot.config?.y_axis_metric && (
                    <div className="flex justify-between text-slate-500">
                      <span>Tracking</span><span className="font-mono font-semibold text-blue-600">{snapshot.config.y_axis_metric}</span>
                    </div>
                  )}
                  {snapshot.process.return_code !== null && (
                    <div className="flex justify-between text-slate-500">
                      <span>Exit Code</span>
                      <span className={`font-mono font-bold ${snapshot.process.return_code === 0 ? "text-emerald-600" : "text-red-600"}`}>
                        {snapshot.process.return_code}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </aside>
          )}
        </div>
      </div>

      {/* Loading Overlay */}
      {loading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/60 dark:bg-slate-900/70 backdrop-blur-sm">
          <div className="flex items-center gap-3 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-6 py-4 shadow-xl">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
            <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">Connecting to backend…</span>
          </div>
        </div>
      )}

      {/* Notification Toast */}
      {notification && (
        <div className={`toast-enter fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold shadow-lg ${
          notification.type === "success"
            ? "bg-emerald-600 text-white"
            : "bg-red-600 text-white"
        }`}>
          {notification.type === "success" ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
          {notification.text}
        </div>
      )}
    </div>
  );
}

// ─── Sidebar Select ──────────────────────────────────────────────────────────

function SidebarSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[] | Array<{ label: string; value: string }>;
}) {
  return (
    <div className="space-y-1">
      <label className="text-[9px] font-medium text-slate-500 uppercase tracking-wider">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[11px] font-medium text-slate-300 outline-none transition focus:border-blue-500 focus:bg-white/8"
      >
        {!value ? <option value="">Select {label}</option> : null}
        {options.map((option) => {
          const optValue = typeof option === "string" ? option : option.value;
          const optLabel = typeof option === "string" ? option : option.label;
          return (
            <option key={optValue} value={optValue}>{optLabel}</option>
          );
        })}
      </select>
    </div>
  );
}
