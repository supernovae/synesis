import { z } from "zod";
import type { ClientToolCapabilities } from "../adapters/client-tool-capabilities.js";
import type { HarnessTask } from "../task-ledger/types.js";

export const PLANNER_TODO_PACKET_SCHEMA_VERSION = "synesis_planner_todo_packet_v1";

const PlannerTodoSchema = z.object({
  id: z.string().min(1).max(40),
  content: z.string().min(3).max(180),
  status: z.enum(["pending", "in_progress", "completed", "blocked"]).default("pending"),
  priority: z.enum(["high", "medium", "low"]).default("medium"),
});

const PlannerQuestionOptionSchema = z.object({
  label: z.string().min(1).max(40),
  description: z.string().min(1).max(140),
});

const PlannerQuestionSchema = z.object({
  id: z.string().min(1).max(40),
  header: z.string().min(1).max(40),
  question: z.string().min(3).max(240),
  options: z.array(PlannerQuestionOptionSchema).min(2).max(4),
});

const PlannerTodoPacketSchema = z.object({
  schema_version: z.literal(PLANNER_TODO_PACKET_SCHEMA_VERSION).default(PLANNER_TODO_PACKET_SCHEMA_VERSION),
  objective: z.string().min(3).max(300),
  ambiguity: z.enum(["none", "low", "medium", "high"]).default("low"),
  questions: z.array(PlannerQuestionSchema).max(3).default([]),
  todos: z.array(PlannerTodoSchema).min(1).max(7),
  success_criteria: z.array(z.string().min(3).max(180)).min(1).max(8),
});

export type PlannerTodoPacket = z.infer<typeof PlannerTodoPacketSchema>;

export interface PlannerTodoPacketGenerateInput {
  prompt: string;
  sourceHash: string;
  capabilities: ClientToolCapabilities;
  maxPromptChars: number;
}

export interface PlannerTodoPacketGenerateResult {
  packet: PlannerTodoPacket | null;
  rawText: string;
  parseError?: string;
}

function normalizePrompt(prompt: string, maxChars: number): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (maxChars <= 0 || compact.length <= maxChars) return compact;
  return compact.slice(0, maxChars);
}

function stripSlashPlan(prompt: string): string {
  return prompt.replace(/^\s*\/plan(?:\s+|$)/i, "").trim();
}

export function shouldGeneratePlannerTodoPacket(options: {
  enabled: boolean;
  governanceDisabled?: boolean;
  requireClientPlanningTool?: boolean;
  promptScope: string;
  planningSteered: boolean;
  planningOverride?: boolean;
  planModeRequested?: boolean;
  capabilities: ClientToolCapabilities;
  existingTaskCount?: number;
}): boolean {
  if (!options.enabled || options.governanceDisabled) return false;
  if (options.planningOverride) return false;
  if (options.requireClientPlanningTool && !options.capabilities.hasTodoTool && !options.capabilities.hasQuestionTool) {
    return false;
  }
  if ((options.existingTaskCount ?? 0) > 0) return false;
  if (options.planModeRequested) return true;
  return options.promptScope === "macro" && options.planningSteered;
}

export function buildPlannerTodoPacketPrompt(input: PlannerTodoPacketGenerateInput): string {
  const prompt = normalizePrompt(stripSlashPlan(input.prompt), input.maxPromptChars);
  const todoTool = input.capabilities.todoToolName ?? "none";
  const questionTool = input.capabilities.questionToolName ?? "none";
  return [
    "You are Synesis Coder Horizon acting only as a planning model.",
    "Produce a compact JSON todo packet that helps a smaller coding model execute safely.",
    "Do not write code. Do not include markdown. Return strict JSON only.",
    "",
    "Output schema:",
    JSON.stringify({
      schema_version: PLANNER_TODO_PACKET_SCHEMA_VERSION,
      objective: "short objective",
      ambiguity: "none|low|medium|high",
      questions: [
        {
          id: "q1",
          header: "Short label",
          question: "Question for the user when requirements are genuinely ambiguous",
          options: [
            { label: "Recommended", description: "Why this path is safe" },
            { label: "Alternative", description: "Tradeoff" },
          ],
        },
      ],
      todos: [
        { id: "todo_1", content: "Concrete implementation or verification step", status: "pending", priority: "high" },
      ],
      success_criteria: ["Observable done condition"],
    }),
    "",
    "Planning rules:",
    "- Generate 3-7 todos for macro tasks; use fewer only for very small /plan requests.",
    "- Todos must be concrete, ordered, and safe for a coding agent to execute.",
    "- Include questions only for blocking ambiguity. If there is a reasonable default, set ambiguity low and include no questions.",
    "- If no native question tool is available but a decision is blocking, include one concise question with options so the working model can ask in normal text.",
    "- Prefer implementation-neutral wording. Do not assume files that were not provided.",
    "- Include verification as one todo when tests/build/lint are likely relevant.",
    "- Keep every todo under 180 characters.",
    "- If calling OpenCode todowrite, every todo object must include id, content, status, and priority. Do not pass arrays of strings or status-only updates.",
    `- Native todo tool available: ${todoTool}. Native question tool available: ${questionTool}.`,
    "",
    `source_hash=${input.sourceHash}`,
    "User request:",
    prompt || "(empty)",
  ].join("\n");
}

function extractJsonObject(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced?.[1]?.trim() || trimmed;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(source.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

function normalizeTodoIds(packet: PlannerTodoPacket): PlannerTodoPacket {
  const seen = new Set<string>();
  const todos = packet.todos.map((todo, idx) => {
    const base = todo.id.trim() || `todo_${idx + 1}`;
    const clean = base.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || `todo_${idx + 1}`;
    const id = seen.has(clean) ? `${clean}_${idx + 1}`.slice(0, 40) : clean;
    seen.add(id);
    return { ...todo, id, status: todo.status ?? "pending" };
  });
  return { ...packet, todos };
}

export function parsePlannerTodoPacket(raw: string): PlannerTodoPacketGenerateResult {
  const parsed = extractJsonObject(raw);
  if (!parsed) {
    return { packet: null, rawText: raw, parseError: "json_not_found" };
  }
  const result = PlannerTodoPacketSchema.safeParse(parsed);
  if (!result.success) {
    return { packet: null, rawText: raw, parseError: result.error.issues.map((i) => i.path.join(".") || i.code).slice(0, 4).join(",") };
  }
  return { packet: normalizeTodoIds(result.data), rawText: raw };
}

export function formatPlannerTodoPacketBlock(options: {
  packet: PlannerTodoPacket;
  sourceHash: string;
  modelId: string;
  capabilities: ClientToolCapabilities;
}): string {
  const { packet, capabilities } = options;
  const lines = [
    `<synesis_planner_todo_packet source_hash="${options.sourceHash}" model="${options.modelId}" ambiguity="${packet.ambiguity}">`,
    `objective=${packet.objective}`,
  ];
  if (packet.questions.length > 0) {
    lines.push(`question_tool=${capabilities.questionToolName ?? "unavailable"}`);
    lines.push("blocking_questions:");
    for (const q of packet.questions) {
      const optionsText = q.options.map((o) => `${o.label}: ${o.description}`).join(" | ");
      lines.push(`- ${q.header}: ${q.question} [${optionsText}]`);
    }
  }
  if (capabilities.todoToolName) {
    lines.push(`todo_tool=${capabilities.todoToolName}`);
    if (capabilities.isOpenCode || capabilities.todoToolName.toLowerCase() === "todowrite") {
      lines.push('required_todowrite_shape={"todos":[{"id":"todo_1","content":"Concrete task","status":"pending","priority":"high"}]}');
      lines.push("- OpenCode todowrite requires id, content, status, and priority on every todo item, including updates.");
    }
    lines.push(`next_action=${packet.questions.length > 0 && capabilities.questionToolName ? "ask_question_then_todowrite" : "call_todowrite"}`);
  } else {
    lines.push("todo_tool=unavailable");
    if (packet.questions.length > 0) {
      lines.push(`next_action=${capabilities.questionToolName ? "ask_question_then_write_short_plan" : "ask_question_in_text_then_wait"}`);
    } else {
      lines.push("next_action=write_short_plan_then_execute");
    }
    lines.push("- No native todo tool was detected; use this packet as the working plan in the response before editing.");
  }
  lines.push("todos:");
  for (const todo of packet.todos) {
    lines.push(`- [${todo.status}/${todo.priority}] ${todo.id}: ${todo.content}`);
  }
  lines.push("success_criteria:");
  for (const criteria of packet.success_criteria) {
    lines.push(`- ${criteria}`);
  }
  lines.push("Use this packet as planning guidance. Prefer native question/todo tools when available; if the user declines planning, proceed with the smallest safe implementation step.");
  lines.push("</synesis_planner_todo_packet>");
  return lines.join("\n");
}

export function serializePlannerTodoPacket(packet: PlannerTodoPacket): Record<string, unknown> {
  return {
    schema_version: packet.schema_version,
    objective: packet.objective,
    ambiguity: packet.ambiguity,
    questions: packet.questions,
    todos: packet.todos,
    success_criteria: packet.success_criteria,
  };
}

export function deserializePlannerTodoPacket(raw: unknown): PlannerTodoPacket | null {
  const result = PlannerTodoPacketSchema.safeParse(raw);
  return result.success ? normalizeTodoIds(result.data) : null;
}

export function plannerTodoPacketToHarnessTasks(packet: PlannerTodoPacket, turn: number): HarnessTask[] {
  return packet.todos.map((todo) => ({
    id: `planner_${todo.id}`,
    title: todo.content,
    status: todo.status,
    source: "harness_inferred",
    clientTaskId: todo.id,
    evidence: ["planner_todo_packet"],
    lastUpdatedTurn: turn,
    createdTurn: turn,
    confidence: 0.9,
  }));
}
