export interface TaskLedgerOutputScrubResult {
  text: string;
  scrubbed: boolean;
}

const LEDGER_BLOCK_RE = /<synesis_task_ledger>[\s\S]*?<\/synesis_task_ledger>/gi;

const RECONCILIATION_SENTENCE_RE =
  /(?:^|\n)?(?:Before final response, reconcile the task ledger\.|For each open task: mark it completed with evidence, mark it obsolete\/not applicable with a reason, mark it blocked, or explicitly state it remains unfinished\.|Do not claim all work is complete while open tasks remain\.|(?:Call [A-Za-z0-9_-]+ to mark each task as completed, obsolete, or blocked before your final response\.)|Update the plan to reflect the current state of each task before your final response\.|Include a reconciled task summary in your response showing the status of each task\.|[0-9]+ task\(s\) remain open\.)[ \t]*/gi;

export function scrubTaskLedgerOutput(text: string): TaskLedgerOutputScrubResult {
  const original = text;
  let next = text.replace(LEDGER_BLOCK_RE, "");
  next = next.replace(RECONCILIATION_SENTENCE_RE, "");
  next = next
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    text: next,
    scrubbed: next !== original,
  };
}
