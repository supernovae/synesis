import { z } from "zod";

/** Machine-readable clarification round for native UIs (forms, wizards). */
export const SynesisClarificationQuestionSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  required: z.boolean().optional(),
});

export const SynesisClarificationRoundSchema = z.object({
  round_id: z.string().min(1),
  questions: z.array(SynesisClarificationQuestionSchema).min(1),
});

export type SynesisClarificationQuestion = z.infer<typeof SynesisClarificationQuestionSchema>;
export type SynesisClarificationRound = z.infer<typeof SynesisClarificationRoundSchema>;

export function parseSynesisClarificationRound(raw: unknown): SynesisClarificationRound | null {
  if (raw === null || raw === undefined) return null;
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  const parsed = SynesisClarificationRoundSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Merge validated `synesis_clarification_round` from request metadata into session record metadata. */
export function mergeSynesisClarificationFromRequestMetadata(
  recordMetadata: Record<string, unknown>,
  incoming: Record<string, unknown> | null | undefined,
): void {
  if (!incoming) return;
  const round = parseSynesisClarificationRound(incoming.synesis_clarification_round);
  if (round) {
    recordMetadata.synesis_clarification_round = round;
  }
}
