export type OptimizationGoal = "minimize" | "maximize";
export type ExperimentStatus = "KEPT" | "DISCARDED" | "INFO";
export type ProcessStatus = "idle" | "running" | "stopping" | "errored";

export interface GitCommit {
  sha: string;
  summary: string;
  authored_at: string;
}

export interface CommitMetricPoint {
  sha: string;
  summary: string;
  authored_at: string;
  best_metric: number | null;
  iteration_count: number;
}

export interface GpuStats {
  index: number;
  name: string;
  utilization_pct: number | null;
  memory_used_mb: number | null;
  memory_total_mb: number | null;
  temperature_c: number | null;
  watts: number | null;
  available: boolean;
}

export interface DiscoveryResult {
  project_root: string;
  git_root: string | null;
  git_present: boolean;
  log_candidates: string[];
  script_candidates: string[];
  headers_by_file: Record<string, string[]>;
  suggested_metrics: string[];
  suggested_command: string | null;
  file_hints: Record<string, string>;
  recent_commits: GitCommit[];
  program_plan: string[];
}

export interface MappingConfig {
  project_root: string;
  script_to_watch: string;
  log_file: string;
  y_axis_metric: string;
  optimization_goal: OptimizationGoal;
  research_command: string | null;
}

export interface MetricPoint {
  iteration: number;
  timestamp: string;
  metric: number;
}

export interface ExperimentRecord {
  iteration: number;
  timestamp: string;
  status: ExperimentStatus;
  metric_name: string;
  metric_value: number | null;
  hypothesis: string | null;
  raw: Record<string, unknown>;
}

export interface DiffSnapshot {
  path: string | null;
  before: string;
  after: string;
  updated_at: string | null;
  latest_commit: GitCommit | null;
}

export interface ProcessState {
  status: ProcessStatus;
  pid: number | null;
  command: string | null;
  started_at: string | null;
  exited_at: string | null;
  return_code: number | null;
}

export interface AppSnapshot {
  config: MappingConfig | null;
  discovery: DiscoveryResult | null;
  process: ProcessState;
  metric_points: MetricPoint[];
  experiments: ExperimentRecord[];
  diff: DiffSnapshot;
  stdout_tail: string[];
  last_hypothesis: string | null;
  last_updated: string;
}

export interface HealthReport {
  status: "ok";
  service: string;
  version: string;
  time: string;
  host: string;
  project_root: string;
  config_loaded: boolean;
  watcher_active: boolean;
  watched_root: string | null;
  websocket_clients: number;
  process_status: ProcessStatus;
  git_required_for_start: boolean;
  endpoints: Record<string, string>;
}

// ─── Session & API response types ────────────────────────────────────────────

export interface SessionInfo {
  id: number;
  project_root: string;
  script_path: string;
  log_path: string;
  metric_name: string;
  optimization_goal: OptimizationGoal;
  started_at: string;
  ended_at: string | null;
}

export interface SessionData {
  metric_points: MetricPoint[];
  experiments: ExperimentRecord[];
}

export interface RollbackResult {
  ok: string;
  sha: string;
  message: string;
}

export interface LlmResult {
  analysis: string;
  model: string;
}
