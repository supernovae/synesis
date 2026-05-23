export type CanonicalValidationTool =
  | "Read"
  | "Write"
  | "Edit"
  | "Update"
  | "MultiEdit"
  | "Glob"
  | "Grep"
  | "Bash"
  | "PowerShell"
  | "LS"
  | "ApplyPatch"
  | "Skill"
  | "TodoWrite"
  | "Question"
  | "Agent"
  | "Monitor"
  | "EnterPlanMode"
  | "ExitPlanMode"
  | "TaskCreate"
  | "TaskUpdate"
  | "TaskList"
  | "TaskGet"
  | "WebFetch"
  | "WebSearch"
  | "Lsp"
  | "NotebookEdit";

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

  multiedit: "MultiEdit",
  multi_edit: "MultiEdit",

  update: "Update",
  str_replace: "Update",
  search_replace: "Update",
  str_replace_editor: "Update",

  glob: "Glob",
  ls: "LS",
  list: "LS",
  list_dir: "LS",

  grep: "Grep",
  rg: "Grep",
  search_code: "Grep",
  codebase_search: "Grep",
  workspace_search: "Grep",
  semantic_search: "Grep",
  file_search: "Grep",

  bash: "Bash",
  powershell: "PowerShell",
  pwsh: "PowerShell",
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
  taskcreate: "TaskCreate",
  task_create: "TaskCreate",
  taskupdate: "TaskUpdate",
  task_update: "TaskUpdate",
  tasklist: "TaskList",
  task_list: "TaskList",
  taskget: "TaskGet",
  task_get: "TaskGet",

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

  agent: "Agent",
  task: "Agent",
  monitor: "Monitor",
  enterplanmode: "EnterPlanMode",
  enter_plan_mode: "EnterPlanMode",
  exitplanmode: "ExitPlanMode",
  exit_plan_mode: "ExitPlanMode",
  notebookedit: "NotebookEdit",
  notebook_edit: "NotebookEdit",
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
