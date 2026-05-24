import {
  REMOTE_PROTOCOL_VERSION,
  remoteOpenApiComponents,
} from "@sentropic/remote-protocol";

const ref = (name: string) => ({
  $ref: `#/components/schemas/${name}`,
});

const jsonBody = (schemaRef: ReturnType<typeof ref>) => ({
  required: true,
  content: { "application/json": { schema: schemaRef } },
});

const jsonResponse = (
  description: string,
  schemaRef: ReturnType<typeof ref>,
) => ({
  description,
  content: { "application/json": { schema: schemaRef } },
});

const validationError = jsonResponse("Validation failed", ref("RemoteError"));
const notFoundError = jsonResponse("Session not found", ref("RemoteError"));

export function buildOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Sentropic Remote Control Plane",
      version: REMOTE_PROTOCOL_VERSION,
      summary: "Control plane API for Sentropic Remote sessions",
    },
    components: remoteOpenApiComponents,
    paths: {
      "/healthz": {
        get: {
          summary: "Liveness probe",
          responses: {
            "200": {
              description: "Service is up",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["ok", "service", "protocolVersion"],
                    properties: {
                      ok: { type: "boolean", const: true },
                      service: { type: "string" },
                      protocolVersion: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/sessions": {
        get: {
          summary: "List remote sessions",
          responses: {
            "200": jsonResponse(
              "List of sessions",
              ref("ListSessionsResponse"),
            ),
          },
        },
        post: {
          summary: "Create a remote session",
          requestBody: jsonBody(ref("CreateSessionRequest")),
          responses: {
            "201": jsonResponse(
              "Session created",
              ref("CreateSessionResponse"),
            ),
            "400": validationError,
          },
        },
      },
      "/sessions/{id}": {
        get: {
          summary: "Get a remote session",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", minLength: 1 },
            },
          ],
          responses: {
            "200": jsonResponse(
              "Session descriptor",
              ref("GetSessionResponse"),
            ),
            "404": notFoundError,
          },
        },
      },
      "/sessions/{id}/stop": {
        post: {
          summary: "Stop a remote session",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", minLength: 1 },
            },
          ],
          requestBody: jsonBody(ref("StopSessionRequest")),
          responses: {
            "200": jsonResponse("Stop accepted", ref("StopSessionResponse")),
            "400": validationError,
            "404": notFoundError,
          },
        },
      },
      "/sessions/{id}/credentials": {
        post: {
          summary: "Refresh auth credentials for a running session",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", minLength: 1 },
            },
          ],
          requestBody: jsonBody(ref("RefreshSessionCredentialsRequest")),
          responses: {
            "200": jsonResponse(
              "Credentials refresh accepted",
              ref("RefreshSessionCredentialsResponse"),
            ),
            "400": validationError,
            "404": notFoundError,
          },
        },
      },
      "/sessions/{id}/instructions": {
        post: {
          summary: "Send an instruction to a session",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", minLength: 1 },
            },
          ],
          requestBody: jsonBody(ref("SendInstructionRequest")),
          responses: {
            "202": jsonResponse(
              "Instruction accepted",
              ref("SendInstructionResponse"),
            ),
            "400": validationError,
            "404": notFoundError,
          },
        },
      },
      "/sessions/{id}/terminal/resize": {
        post: {
          summary: "Propagate a terminal resize to the session-agent",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", minLength: 1 },
            },
          ],
          requestBody: jsonBody(ref("TerminalResize")),
          responses: {
            "202": {
              description: "Resize accepted",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["accepted"],
                    properties: { accepted: { type: "boolean" } },
                  },
                },
              },
            },
            "400": validationError,
            "404": notFoundError,
            "503": jsonResponse(
              "No session-agent connected",
              ref("RemoteError"),
            ),
          },
        },
      },
      "/sessions/{id}/events": {
        get: {
          summary: "Stream protocol events for a session as SSE",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", minLength: 1 },
            },
          ],
          responses: {
            "200": {
              description: "Event stream",
              content: {
                "text/event-stream": {
                  schema: ref("RemoteEventEnvelope"),
                },
              },
            },
            "404": notFoundError,
          },
        },
      },
    },
  };
}
