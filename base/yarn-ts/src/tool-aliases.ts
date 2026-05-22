export type CanonicalValidationTool =
  | "Read"
  | "Write"
  | "Edit"
  | "Update"
  | "Glob"
  | "Grep"
  | "Bash"
  | "ApplyPatch"
  | "Skill"
  | "TodoWrite"
  | "Question"
  | "WebFetch"
  | "WebSearch"
  | "Lsp";

const ALIAS_TO_CANONICAL: Record<string, CanonicalValidationTool> = {
  read: "Read",
  read_file: "Read",
  readfile: "Read",
  filesystem_read_file: "Read",
  view_file: "Read",

  write: "Write",
  write_file: "Write",
  filesystem_write_file: "Write",

  edit: "Edit",
  edit_file: "Edit",

  update: "Update",
  str_replace: "Update",
  search_replace: "Update",
  str_replace_editor: "Update",

  glob: "Glob",

  grep: "Grep",
  rg: "Grep",
  search_code: "Grep",
  codebase_search: "Grep",
  workspace_search: "Grep",
  semantic_search: "Grep",
  file_search: "Grep",

  bash: "Bash",
  shell: "Bash",
  run_terminal_cmd: "Bash",
  execute_command: "Bash",
  run_test: "Bash",
  run_build: "Bash",
  run_lint: "Bash",
  format_code: "Bash",

  apply_patch: "ApplyPatch",
  applypatch: "ApplyPatch",
  patch: "ApplyPatch",

  skill: "Skill",
  load_skill: "Skill",

  todowrite: "TodoWrite",
  todo_write: "TodoWrite",
  update_todo: "TodoWrite",

  question: "Question",
  ask_question: "Question",
  ask_user_question: "Question",
  ask_followup_question: "Question",

  webfetch: "WebFetch",
  web_fetch: "WebFetch",
  fetch: "WebFetch",

  websearch: "WebSearch",
  web_search: "WebSearch",
  search_web: "WebSearch",

  lsp: "Lsp",
  language_server: "Lsp",
};

export function normalizeToolAlias(name: string): string {
  return name.trim().toLowerCase().replace(/-/g, "_");
}

export function canonicalValidationToolName(name: string): string {
  const n = normalizeToolAlias(name);
  return ALIAS_TO_CANONICAL[n] ?? name;
}
