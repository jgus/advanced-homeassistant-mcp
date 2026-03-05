import { z } from "zod";
import { Tool } from "../types/index";
import { APP_CONFIG } from "../config/app.config";

const ErrorLogSchema = z.object({
  lines: z
    .number()
    .optional()
    .describe("Number of recent lines to return (default: all)"),
  search: z
    .string()
    .optional()
    .describe("Filter log lines containing this text (case-insensitive)"),
});

type ErrorLogParams = z.infer<typeof ErrorLogSchema>;

export const errorLogTool: Tool = {
  name: "get_error_log",
  description:
    "Get the Home Assistant error log. Useful for troubleshooting integrations, automations, and system issues.",
  annotations: {
    title: "Get Error Log",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  parameters: ErrorLogSchema,
  execute: async (params: unknown) => {
    try {
      const { lines, search } = params as ErrorLogParams;

      const response = await fetch(`${APP_CONFIG.HASS_HOST}/api/error_log`, {
        headers: {
          Authorization: `Bearer ${APP_CONFIG.HASS_TOKEN}`,
          "Content-Type": "text/plain",
        },
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch error log: ${response.status} ${response.statusText}`,
        );
      }

      let text = await response.text();

      if (search) {
        const needle = search.toLowerCase();
        text = text
          .split("\n")
          .filter((l) => l.toLowerCase().includes(needle))
          .join("\n");
      }

      if (lines) {
        const allLines = text.split("\n");
        text = allLines.slice(-lines).join("\n");
      }

      return JSON.stringify({ success: true, log: text });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred";
      return JSON.stringify({ success: false, error: errorMessage });
    }
  },
};
