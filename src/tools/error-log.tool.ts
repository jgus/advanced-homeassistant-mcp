/**
 * Error Log Tool for Home Assistant
 *
 * Retrieves and parses the Home Assistant error log into structured entries.
 * Supports filtering by severity, component, keyword search, and time range.
 */

import { z } from "zod";
import { UserError } from "fastmcp";
import { logger } from "../utils/logger.js";
import { APP_CONFIG } from "../config/app.config.js";
import { Tool } from "../types/index.js";

const LEVEL_ORDER: Record<string, number> = {
  DEBUG: 0,
  INFO: 1,
  WARNING: 2,
  ERROR: 3,
};

const LOG_ENTRY_RE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?) (ERROR|WARNING|INFO|DEBUG) \(([^)]+)\) \[([^\]]+)\] (.*)$/;

interface LogEntry {
  timestamp: string;
  level: string;
  thread: string;
  component: string;
  message: string;
}

function parseLogEntries(text: string): LogEntry[] {
  const lines = text.split("\n");
  const entries: LogEntry[] = [];

  for (const line of lines) {
    const match = line.match(LOG_ENTRY_RE);
    if (match) {
      entries.push({
        timestamp: match[1],
        level: match[2],
        thread: match[3],
        component: match[4],
        message: match[5],
      });
    } else if (entries.length > 0 && line.length > 0) {
      // Continuation line (stack trace, etc.) — append to previous entry
      entries[entries.length - 1].message += "\n" + line;
    }
  }

  return entries;
}

interface TimestampRange {
  oldest: string | null;
  newest: string | null;
}

function getTimestampRange(entries: LogEntry[]): TimestampRange {
  if (entries.length === 0) return { oldest: null, newest: null };
  return {
    oldest: entries[0].timestamp,
    newest: entries[entries.length - 1].timestamp,
  };
}

const errorLogSchema = z.object({
  entries: z
    .number()
    .min(1)
    .optional()
    .default(50)
    .describe("Number of most recent entries to return (default: 50)"),
  level: z
    .enum(["ERROR", "WARNING", "INFO", "DEBUG"])
    .optional()
    .describe(
      "Minimum severity level. ERROR = only errors, WARNING = errors + warnings, etc.",
    ),
  component: z
    .string()
    .optional()
    .describe(
      'Filter by component name (case-insensitive substring match, e.g. "zwave", "mqtt")',
    ),
  search: z
    .string()
    .optional()
    .describe("Keyword search in message body (case-insensitive)"),
  oldest: z
    .string()
    .optional()
    .describe(
      'Only entries at or after this timestamp (e.g. "2026-04-05 10:00:00")',
    ),
  newest: z
    .string()
    .optional()
    .describe(
      'Only entries at or before this timestamp (e.g. "2026-04-05 12:00:00")',
    ),
});

type ErrorLogParams = z.infer<typeof errorLogSchema>;

async function executeGetErrorLog(params: ErrorLogParams): Promise<string> {
  try {
    const response = await fetch(`${APP_CONFIG.HASS_HOST}/api/error_log`, {
      headers: {
        Authorization: `Bearer ${APP_CONFIG.HASS_TOKEN}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new UserError(
        `Failed to fetch error log (${response.status}): ${errorText}`,
      );
    }

    const logText = await response.text();
    const allEntries = parseLogEntries(logText);
    const totalRange = getTimestampRange(allEntries);
    const total = {
      count: allEntries.length,
      oldest: totalRange.oldest,
      newest: totalRange.newest,
    };

    let filtered = allEntries;
    const filtersApplied: string[] = [];

    // Filter by time range
    if (params.oldest) {
      filtersApplied.push("oldest");
      filtered = filtered.filter((e) => e.timestamp >= params.oldest!);
    }
    if (params.newest) {
      filtersApplied.push("newest");
      filtered = filtered.filter((e) => e.timestamp <= params.newest!);
    }

    // Filter by severity level
    if (params.level) {
      filtersApplied.push("level");
      const minLevel = LEVEL_ORDER[params.level];
      filtered = filtered.filter(
        (e) => (LEVEL_ORDER[e.level] ?? 0) >= minLevel,
      );
    }

    // Filter by component
    if (params.component) {
      filtersApplied.push("component");
      const comp = params.component.toLowerCase();
      filtered = filtered.filter((e) =>
        e.component.toLowerCase().includes(comp),
      );
    }

    // Filter by keyword search in message
    if (params.search) {
      filtersApplied.push("search");
      const keyword = params.search.toLowerCase();
      filtered = filtered.filter((e) =>
        e.message.toLowerCase().includes(keyword),
      );
    }

    const availableRange = getTimestampRange(filtered);
    const available = {
      count: filtered.length,
      oldest: availableRange.oldest,
      newest: availableRange.newest,
    };

    // Slice to last N entries
    const sliced = filtered.slice(-params.entries);
    const returnedRange = getTimestampRange(sliced);

    return JSON.stringify({
      total,
      available,
      returned: {
        count: sliced.length,
        oldest: returnedRange.oldest,
        newest: returnedRange.newest,
      },
      filters_applied: filtersApplied,
      entries: sliced,
    });
  } catch (error) {
    if (error instanceof UserError) throw error;
    logger.error(`Failed to get error log: ${error}`);
    throw new UserError(
      `Failed to retrieve error log: ${(error as Error).message}`,
    );
  }
}

export const errorLogTool: Tool = {
  name: "get_error_log",
  description:
    "Retrieve the Home Assistant error log as structured entries. Each entry includes timestamp, severity level, thread, component, and message (including stack traces). Supports filtering by minimum severity level, component name, keyword search in message body, and time range.",
  parameters: errorLogSchema,
  execute: executeGetErrorLog,
  annotations: {
    title: "Get Error Log",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};
