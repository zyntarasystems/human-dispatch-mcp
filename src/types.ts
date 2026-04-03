// ─── Enums ─────────────────────────────────────────────────

export enum TaskStatus {
  PENDING = "pending",
  ROUTED = "routed",
  ASSIGNED = "assigned",
  IN_PROGRESS = "in_progress",
  AWAITING_REVIEW = "awaiting_review",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLED = "cancelled",
}

export enum TaskType {
  PHYSICAL = "physical",
  DIGITAL = "digital",
  HYBRID = "hybrid",
}

export enum TaskCategory {
  ERRAND = "errand",
  PHOTO_VIDEO = "photo_video",
  DATA_COLLECTION = "data_collection",
  VERIFICATION = "verification",
  DELIVERY = "delivery",
  DIGITAL_MICRO = "digital_micro",
  IN_PERSON = "in_person",
  CUSTOM = "custom",
}

export enum ProofType {
  PHOTO = "photo",
  VIDEO = "video",
  GPS_CHECKIN = "gps_checkin",
  TEXT_REPORT = "text_report",
  RECEIPT = "receipt",
  SIGNATURE = "signature",
}

export enum QualitySLA {
  LOW = "low",
  MEDIUM = "medium",
  HIGH = "high",
}

export enum BackendId {
  MTURK = "mturk",
  RENTAHUMAN = "rentahuman",
  MANUAL = "manual",
}

// ─── Task Schema ───────────────────────────────────────────

export interface TaskLocation {
  address?: string;
  latitude?: number;
  longitude?: number;
  radius_km?: number;
  region?: string;
}

export interface Budget {
  max_usd: number;
  currency: string;
}

export interface Deadline {
  complete_by: string;
  urgency: "low" | "medium" | "high" | "asap";
}

export interface TaskRequest {
  description: string;
  category: TaskCategory;
  task_type: TaskType;
  location?: TaskLocation | null;
  budget: Budget;
  deadline: Deadline;
  proof_required: ProofType[];
  quality_sla: QualitySLA;
  preferred_backends?: BackendId[];
  fallback_chain?: BackendId[];
  callback_url?: string | null;
  metadata?: Record<string, string>;
}

export interface ProofSubmission {
  type: ProofType;
  url?: string;
  text?: string;
  submitted_at: string;
}

export interface RoutingAttempt {
  backend_id: BackendId;
  attempted_at: string;
  success: boolean;
  error?: string;
}

export interface Task {
  id: string;
  request: TaskRequest;
  status: TaskStatus;
  backend_id: BackendId | null;
  backend_task_id: string | null;
  worker_id: string | null;
  proof: ProofSubmission[];
  created_at: string;
  updated_at: string;
  routed_at: string | null;
  completed_at: string | null;
  cost_usd: number | null;
  error: string | null;
  attempts: RoutingAttempt[];
}

// ─── Backend Adapter Interface ─────────────────────────────

export interface BackendCapabilities {
  id: BackendId;
  name: string;
  supports_physical: boolean;
  supports_digital: boolean;
  supports_location: boolean;
  available_regions: string[];
  min_budget_usd: number;
  max_budget_usd: number;
  avg_completion_minutes: number;
  requires_api_key: boolean;
  configured: boolean;
}

export interface BackendStatusResult {
  status: TaskStatus;
  worker_id?: string;
  proof?: ProofSubmission[];
  cost_usd?: number;
}

export interface BackendSubmitResult {
  backend_task_id: string;
}

export interface BackendAdapter {
  readonly id: BackendId;
  getCapabilities(): BackendCapabilities;
  isConfigured(): boolean;
  submitTask(task: Task): Promise<BackendSubmitResult>;
  getStatus(backend_task_id: string): Promise<BackendStatusResult>;
  cancelTask(backend_task_id: string): Promise<boolean>;
}
