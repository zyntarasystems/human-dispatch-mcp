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
  "webhook_provider",
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
  callback_url: z.string().url()
    .refine((url) => {
      try {
        const { hostname, protocol } = new URL(url);
        if (protocol !== "https:") return false;
        if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|::1|fc00:|fe80:)/i.test(hostname)) return false;
        return true;
      } catch {
        return false;
      }
    }, { message: "callback_url must be an HTTPS URL pointing to a public host" })
    .nullable().optional()
    .describe("Webhook URL to receive status update notifications. Set to null or omit if you will poll for status instead."),
  metadata: z.record(
    z.string().max(64),
    z.string().max(256),
  ).refine(val => Object.keys(val).length <= 20, {
    message: "metadata cannot have more than 20 keys",
  }).optional()
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

// ─── Provider Schemas ─────────────────────────────────────

const httpsPublicUrl = z.string().url()
  .refine((url) => {
    try {
      const { hostname, protocol } = new URL(url);
      if (protocol !== "https:") return false;
      if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|::1|fc00:|fe80:)/i.test(hostname)) return false;
      return true;
    } catch {
      return false;
    }
  }, { message: "Must be an HTTPS URL pointing to a public host" });

export const ProviderRegistrationSchema = z.object({
  name: z.string().min(1).max(200)
    .describe("Human-readable provider name (e.g. 'Smith & Associates Law')"),
  webhook_url: httpsPublicUrl
    .describe("HTTPS URL where tasks will be POSTed"),
  webhook_secret: z.string().min(32).max(256)
    .describe("Shared secret for HMAC-SHA256 webhook signatures (min 32 chars)"),
  categories: z.array(TaskCategorySchema).min(1)
    .describe("Task categories this provider handles"),
  task_types: z.array(TaskTypeSchema).min(1)
    .describe("Task types this provider supports (physical, digital, hybrid)"),
  regions: z.array(z.string().min(1).max(20)).min(1)
    .describe("Regions served (e.g. ['US', 'EU', '*'] where * = global)"),
  min_budget_usd: z.number().min(0)
    .describe("Minimum task budget this provider accepts (USD)"),
  max_budget_usd: z.number().positive()
    .describe("Maximum task budget this provider accepts (USD)"),
  max_concurrent_tasks: z.number().int().min(1).max(10000).default(10)
    .describe("Maximum number of tasks this provider can handle concurrently"),
}).strict().refine(data => data.min_budget_usd <= data.max_budget_usd, {
  message: "min_budget_usd must be <= max_budget_usd",
}).describe("Register a new webhook provider to receive dispatched tasks");

export const ProviderFilterSchema = z.object({
  category: TaskCategorySchema.optional()
    .describe("Filter providers by supported category"),
  region: z.string().optional()
    .describe("Filter providers by supported region"),
  active_only: z.boolean().default(true)
    .describe("Only show active providers (default true)"),
}).strict().describe("Filters for listing providers");

export const ProviderIdSchema = z.object({
  provider_id: z.string().uuid()
    .describe("The UUID of the provider to operate on"),
}).strict().describe("Provider identifier");

export const CallbackPayloadSchema = z.object({
  status: z.enum(["completed", "failed"])
    .describe("Outcome of the task"),
  result: z.record(z.unknown()).optional()
    .describe("The deliverable/result data"),
  proof: z.array(z.object({
    type: ProofTypeSchema,
    url: z.string().url().optional(),
    text: z.string().optional(),
    submitted_at: z.string().datetime(),
  })).optional()
    .describe("Proof-of-completion items"),
  actual_cost_usd: z.number().min(0).optional()
    .describe("Actual cost charged for the task"),
  notes: z.string().max(2000).optional()
    .describe("Provider notes about the task"),
}).strict().describe("Payload from providers reporting task completion or failure");
