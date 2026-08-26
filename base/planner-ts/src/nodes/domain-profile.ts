/**
 * Domain profiling and frame coherence classification.
 *
 * Based on Data-Frame theory (Klein et al. 2007): sensemaking fits data
 * into frames. Frame coherence tells us whether the request maps to a
 * single, well-understood domain (focused), multiple overlapping domains
 * (composite), or no clear frame (diffuse).
 *
 * Cynefin mapping (Snowden & Boone 2007):
 *   focused   -> obvious/complicated: safe to constrain, single frame
 *   composite -> complicated, multi-expert: address all proportionally
 *   diffuse   -> complex/chaotic: probe before acting
 */

export interface WeightedDomain {
  key: string;
  weight: number;
}

export type FrameCoherence = "focused" | "composite" | "diffuse";

export interface DomainProfile {
  domains: WeightedDomain[];
  frameCoherence: FrameCoherence;
}

interface DomainPattern {
  key: string;
  re: RegExp;
  baseWeight: number;
}

const DOMAIN_PATTERNS: DomainPattern[] = [
  { key: "golang", re: /\b(?:golang|go\s+(?:http|service|server|context|request|module|mod|test|build|routine|program|code|package)|net\/http|goroutine|context\.Context)\b/gi, baseWeight: 0.7 },
  { key: "software_development", re: /\b(?:programming|developer|code|runtime|library|framework|request\s+context|context\s+cancellation|server\s+timeouts?|graceful\s+shutdown)\b/gi, baseWeight: 0.5 },
  { key: "web_frontend", re: /\b(html|css|react|vue|angular|frontend|ui|ux|sticky\s*header|responsive|layout|tailwind)\b/gi, baseWeight: 0.4 },
  { key: "backend_api", re: /\b(api|rest|graphql|endpoint|microservice|http\s+(?:service|server)|server\s+timeouts?|request\s+context|graceful\s+shutdown|fastify|express|flask|django|gin|echo)\b/gi, baseWeight: 0.55 },
  { key: "cloud_infra", re: /\b(kubernetes|k8s|aws|gcp|azure|terraform|docker|container|infra|cluster|pod|deployment|openshift)\b/gi, baseWeight: 0.55 },
  { key: "data_engineering", re: /\b(database|sql|nosql|etl|pipeline|nornicdb|postgres|redis|kafka|data\s*lake)\b/gi, baseWeight: 0.5 },
  { key: "ml_ai", re: /\b(model|embedding|rag|inference|transformer|llm|training|fine.?tun|neural|bert|gpt)\b/gi, baseWeight: 0.6 },
  { key: "security", re: /\b(security|auth|rbac|encryption|compliance|hipaa|pci|vulnerability|tls|certificate)\b/gi, baseWeight: 0.6 },
  { key: "devops", re: /\b(ci[\s/]?cd|github\s*action|jenkins|deploy|rollout|monitoring|prometheus|grafana|logging)\b/gi, baseWeight: 0.5 },
  { key: "architecture", re: /\b(architecture|design\s*pattern|system\s*design|distributed|event.?driven|cqrs|domain.?driven)\b/gi, baseWeight: 0.6 },
  { key: "general", re: /\b(explain|help|what\s+is|how\s+to|creative|ideas|list|tips|advice)\b/gi, baseWeight: 0.25 },
];

function countMatches(text: string, re: RegExp): number {
  const globalRe = new RegExp(re.source, "gi");
  return (text.match(globalRe) ?? []).length;
}

export function buildDomainProfile(text: string): DomainProfile {
  const scored: WeightedDomain[] = [];

  for (const pattern of DOMAIN_PATTERNS) {
    const hits = countMatches(text, pattern.re);
    if (hits === 0) continue;
    const weight = pattern.baseWeight * Math.min(hits, 5) / 3;
    scored.push({ key: pattern.key, weight });
  }

  if (scored.length === 0) {
    return {
      domains: [{ key: "general", weight: 1.0 }],
      frameCoherence: "focused",
    };
  }

  const hasSpecificDomain = scored.some((domain) => domain.key !== "general");
  const adjusted = hasSpecificDomain
    ? scored.map((domain) => domain.key === "general"
      ? { ...domain, weight: domain.weight * 0.25 }
      : domain)
    : scored;
  const totalWeight = adjusted.reduce((sum, domain) => sum + domain.weight, 0);

  const normalized = adjusted
    .map((d) => ({ key: d.key, weight: totalWeight > 0 ? d.weight / totalWeight : 0 }))
    .sort((a, b) => b.weight - a.weight);

  const frameCoherence = classifyCoherence(normalized);

  return { domains: normalized, frameCoherence };
}

function classifyCoherence(domains: WeightedDomain[]): FrameCoherence {
  if (domains.length === 0) return "focused";

  const top = domains[0].weight;
  if (top >= 0.6) return "focused";

  const topTwo = domains.slice(0, 2).reduce((sum, d) => sum + d.weight, 0);
  if (topTwo >= 0.7) return "composite";

  return "diffuse";
}
