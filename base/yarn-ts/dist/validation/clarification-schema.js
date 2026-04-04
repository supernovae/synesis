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
export function parseSynesisClarificationRound(raw) {
    if (raw === null || raw === undefined)
        return null;
    let value = raw;
    if (typeof raw === "string") {
        try {
            value = JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    const parsed = SynesisClarificationRoundSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}
/** Merge validated `synesis_clarification_round` from request metadata into session record metadata. */
export function mergeSynesisClarificationFromRequestMetadata(recordMetadata, incoming) {
    if (!incoming)
        return;
    const round = parseSynesisClarificationRound(incoming.synesis_clarification_round);
    if (round) {
        recordMetadata.synesis_clarification_round = round;
    }
}
