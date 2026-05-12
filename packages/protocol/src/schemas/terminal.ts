import { REMOTE_SCHEMA_BASE_URL } from "../constants.js";
import { metadataSchema } from "./common.js";

export const terminalStreamSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/terminal-stream.schema.json`,
  title: "TerminalStream",
  type: "string",
  enum: ["stdout", "stderr", "system"],
} as const;

const { $id: _terminalStreamSchemaId, ...embeddedTerminalStreamSchema } =
  terminalStreamSchema;

export const terminalOpenedSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/terminal-opened.schema.json`,
  title: "TerminalOpened",
  type: "object",
  additionalProperties: false,
  required: ["terminalId", "shell"],
  properties: {
    terminalId: { type: "string", minLength: 1 },
    shell: { type: "string", minLength: 1 },
    metadata: metadataSchema,
  },
} as const;

export const terminalInputSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/terminal-input.schema.json`,
  title: "TerminalInput",
  type: "object",
  additionalProperties: false,
  required: ["terminalId", "data", "encoding"],
  properties: {
    terminalId: { type: "string", minLength: 1 },
    data: { type: "string" },
    encoding: { type: "string", const: "utf8" },
  },
} as const;

export const terminalOutputSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/terminal-output.schema.json`,
  title: "TerminalOutput",
  type: "object",
  additionalProperties: false,
  required: ["terminalId", "stream", "data", "encoding"],
  properties: {
    terminalId: { type: "string", minLength: 1 },
    stream: embeddedTerminalStreamSchema,
    data: { type: "string" },
    encoding: { type: "string", const: "utf8" },
    truncated: { type: "boolean" },
  },
} as const;

export const terminalResizeSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/terminal-resize.schema.json`,
  title: "TerminalResize",
  type: "object",
  additionalProperties: false,
  required: ["terminalId", "columns", "rows"],
  properties: {
    terminalId: { type: "string", minLength: 1 },
    columns: { type: "integer", minimum: 1 },
    rows: { type: "integer", minimum: 1 },
  },
} as const;

export const terminalExitedSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/terminal-exited.schema.json`,
  title: "TerminalExited",
  type: "object",
  additionalProperties: false,
  required: ["terminalId", "exitCode"],
  properties: {
    terminalId: { type: "string", minLength: 1 },
    exitCode: { type: "integer" },
    signal: { type: "string" },
  },
} as const;
