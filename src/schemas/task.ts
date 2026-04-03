import { z } from "zod";

// ─── Enum Schemas ──────────────────────────────────────────

export const TaskStatusSchema = z.enum([
  "pending",
  "routed",
  "assigned",
  "in_progress",
  "awaiting_review",
  "completed",
  "failed",
  "cancelled",
]).describe("Current status of the task in its lifecycle");

export const TaskTypeSchema = z.enum([
  "physical",
  "digital",
  "hybrid",
]).describe("Whether the task requires physical presence, is digital-only, or both");

export const TaskCategorySchema = z.enum([
  "errand",
  "photo_video",
  "data_collection",
  "verification",
  "delivery",
  "digital_micro",
  "in_person",
  "custom",
]).describe("Category of the task — determines which backends are best suited");

export const ProofTypeSchema = z.enum([
  "photo",
  "video",
  "gps_checkin",
  "text_report",
  "receipt",
  "signature",
]).describe("Type of proof-of-completion required from the human worker");

export const QualitySLASchema = z.enum([
  "low",
  "medium",
  "high",
]).describe("Quality/speed tradeoff: low=fastest/cheapest, medium=default, high=verified workers with multi-proof");

export const BackendIdSchema = z.enum([
  "mturk",
  "rentahuman",
  "manual",
]).describe("Identifier for a backend task-routing service");

// ─── Composite Schemas ─────────────────────────────────────

export const TaskLocationSchema = z.object({
  address: z.string().describe("Human-readable street address where the task should be performed").optional(),
  latitude: z.number().min(-90).max(90).describe("Latitude coordinate of task location").optional(),
  longitude: z.number().min(-180).max(180).describe("Longitude coordinate of task location").optional(),
  radius_km: z.number().positive().describe("Acceptable radius in kilometers from the specified point").optional(),
  region: z.string().describe("City, state, or country as a fallback when coordinates are not available").optional(),
}).strict().describe("Location where the task should be performed — required for physical tasks");

export const BudgetSchema = z.object({
  max_usd: z.number().positive().describe("Maximum amount in USD you are willing to pay for this task"),
  currency: z.string().default("USD").describe("Currency code — currently only USD is supported"),
}).strict().describe("Budget constraints for the task");

export const DeadlineSchema = z.object({
  complete_by: z.string().datetime().describe("ISO 8601 datetime by which the task must be completed (e.g. '2025-01-15T18:00:00Z')"),
  urgency: z.enum(["low", "medium", "high", "asap"]).describe("Urgency level: low=days, medium=hours, high=under an hour, asap=immediately"),
}).strict().describe("When the task needs to be completed");

// ─── Main Task Request Schema ──────────────────────────────

export const TaskRequestSchema = z.object({
  description: z.string()
    .min(10)
    .max(2000)
    .describe("Clear, detailed description of what the human worker should do. Be specific about location, timing, and expected output. Example: 'Take a photo of the menu board at the Starbucks on 5th Ave and 42nd St, NYC'"),
  category: TaskCategorySchema,
  task_type: TaskTypeSchema,
  location: TaskLocationSchema.nullable().optional()
    .describe("Where the task should be performed. Required for physical tasks. Set to null or omit for digital tasks."),
  budget: BudgetSchema,
  deadline: DeadlineSchema,
  proof_required: z.array(ProofTypeSchema)
    .min(1)
    .describe("Types of proof the worker must submit upon completion. At least one is required. Example: ['photo', 'gps_checkin']"),
  quality_sla: QualitySLASchema,
  preferred_backends: z.array(BackendIdSchema).optional()
    .describe("Preferred backend services to route this task to, tried in order. If omitted, the router picks the best backend automatically."),
  fallback_chain: z.array(BackendIdSchema).optional()
    .describe("Ordered list of fallback backends if the preferred ones fail. The 'manual' backend is always available as a last resort."),
  callback_url: z.string().url().nullable().optional()
    .describe("Webhook URL to receive status update notifications. Set to null or omit if you will poll for status instead."),
  metadata: z.record(z.string(), z.string()).optional()
    .describe("Arbitrary key-value pairs for your own tracking (e.g. {'order_id': '12345', 'agent_name': 'my-bot'})"),
}).strict().describe("Complete task submission — everything the system needs to route and track a human task");

// ─── Query/Filter Schemas ──────────────────────────────────

export const TaskIdSchema = z.object({
  task_id: z.string().uuid().describe("The UUID of the task to look up, as returned by human_dispatch_task"),
}).strict().describe("Task identifier for status queries and operations");

export const TaskFilterSchema = z.object({
  status: TaskStatusSchema.optional()
    .describe("Filter tasks by status (e.g. 'pending', 'completed')"),
  backend_id: BackendIdSchema.optional()
    .describe("Filter tasks by which backend is handling them"),
  category: TaskCategorySchema.optional()
    .describe("Filter tasks by their category"),
  limit: z.number().int().min(1).max(100).default(20)
    .describe("Maximum number of tasks to return (1-100, default 20)"),
  offset: z.number().int().min(0).default(0)
    .describe("Number of tasks to skip for pagination (default 0)"),
}).strict().describe("Filters for listing tasks with pagination support");
