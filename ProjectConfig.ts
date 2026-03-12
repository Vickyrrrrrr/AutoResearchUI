export type OptimizationGoal = "minimize" | "maximize";
export type ExperimentStatus = "KEPT" | "DISCARDED" | "INFO";
export type ProcessStatus = "idle" | "running" | "stopping" | "errored";

export interface GitCommit {
  sha: string;
  summary: string;
  authored_at: string;
}

export interface DiscoveryResult {
  project_root: string;
  git_root: string | null;
  git_present: boolean;
  log_candidates: string[];
  script_candidates: string[];
  headers_by_file: Record<string, string[]>;
  recent_commits: GitCommit[];
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
