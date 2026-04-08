/**
 * Deterministic detection of user prompts that require live web retrieval
 * (SearXNG). Used to veto trivial / direct-stream paths so the router runs.
 */

const EXPLICIT_WEB_RE =
  /\b(search\s+the\s+web|search\s+online|look\s+up\s+online|look\s+it\s+up\s+online|google\s+it|bing\s+it|web\s+search|internet\s+search|look\s+up\s+on\s+the\s+web)\b/i;

const FRESHNESS_RE =
  /\b(latest|up\s*to\s*date|up-to-date|current\s+version|newer\s+information|most\s+recent|still\s+accurate|right\s+now|breaking\s+news|just\s+announced|as\s+of\s+\d{4})\b/i;

const AS_OF_TODAY_RE = /\b(as\s+of\s+today|today's|updated\s+today|released\s+today)\b/i;

/** Headlines / current-events phrasing (narrow: requires news or headlines near today/this week). */
const CURRENT_NEWS_RE =
  /\b(news\s+today|headlines\s+today|what\s+is\s+in\s+the\s+news|what'?s\s+in\s+the\s+news|today'?s\s+news|today'?s\s+headlines|this\s+week'?s\s+news|this\s+week'?s\s+headlines|news\s+headlines)\b/i;

/** Calendar years likely to imply recency-sensitive answers (maintain periodically). */
const RECENT_YEAR_RE = /\b20(2[4-9]|3\d)\b/;

const WEATHER_RE = /\b(weather|forecast|temperature)\b/i;
const US_ZIP_RE = /\b\d{5}\b/;

export interface LiveWebIntentResult {
  needsLiveWeb: boolean;
}

/**
 * Returns true when the message should force planner → router retrieval with web
 * enabled (subject to `forceWeb` in unified retrieval).
 */
export function analyzeLiveWebIntent(rawText: string): LiveWebIntentResult {
  const text = rawText.slice(0, 4000);
  if (!text.trim()) return { needsLiveWeb: false };

  if (EXPLICIT_WEB_RE.test(text)) return { needsLiveWeb: true };
  if (FRESHNESS_RE.test(text)) return { needsLiveWeb: true };
  if (AS_OF_TODAY_RE.test(text)) return { needsLiveWeb: true };
  if (CURRENT_NEWS_RE.test(text)) return { needsLiveWeb: true };
  if (RECENT_YEAR_RE.test(text)) return { needsLiveWeb: true };

  if (WEATHER_RE.test(text)) {
    if (US_ZIP_RE.test(text)) return { needsLiveWeb: true };
    if (/\b(zip|postal|postcode)\b/i.test(text)) return { needsLiveWeb: true };
    if (/\b(today|now|current|tonight|tomorrow)\b/i.test(text)) return { needsLiveWeb: true };
  }

  return { needsLiveWeb: false };
}
