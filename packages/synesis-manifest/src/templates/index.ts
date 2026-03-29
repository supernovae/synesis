import type { ProjectKind, ProjectTemplate } from "../schemas.js";
import { goCli } from "./go-cli.js";
import { goHttpService } from "./go-http-service.js";
import { terraformIac } from "./terraform-iac.js";

const TEMPLATES: ReadonlyMap<ProjectKind, ProjectTemplate> = new Map([
  ["go_cli", goCli],
  ["go_http_service", goHttpService],
  ["terraform_iac", terraformIac],
]);

export function getTemplate(kind: ProjectKind): ProjectTemplate | undefined {
  return TEMPLATES.get(kind);
}

export function listTemplateKinds(): ProjectKind[] {
  return [...TEMPLATES.keys()];
}

export function getAllTemplates(): ProjectTemplate[] {
  return [...TEMPLATES.values()];
}

export { goCli, goHttpService, terraformIac };
