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
const unauthorizedError = jsonResponse(
  "Authentication required or token rejected (when REMOTE_AUTH is enabled)",
  ref("RemoteError"),
);
const workspaceNotFound = jsonResponse("Workspace not found", ref("RemoteError"));

const idParam = [
  {
    name: "id",
    in: "path",
    required: true,
    schema: { type: "string", minLength: 1 },
  },
];

const jsonObjectResponse = (
  description: string,
  required: string[],
  properties: Record<string, unknown>,
) => ({
  description,
  content: {
    "application/json": {
      schema: { type: "object", required, properties },
    },
  },
});

type Operation = {
  responses: Record<string, unknown>;
  [key: string]: unknown;
};

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, Operation>> = {
    "/healthz": {
      get: {
        summary: "Liveness probe",
        // Public — the only route exempt from the document-wide bearer security.
        security: [],
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
          "200": jsonResponse("List of sessions", ref("ListSessionsResponse")),
        },
      },
      post: {
        summary: "Create a remote session",
        requestBody: jsonBody(ref("CreateSessionRequest")),
        responses: {
          "201": jsonResponse("Session created", ref("CreateSessionResponse")),
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
          "200": jsonResponse("Session descriptor", ref("GetSessionResponse")),
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
    "/sessions/{id}/terminal/input": {
      post: {
        summary: "Forward terminal input (keystrokes) to the session-agent",
        parameters: idParam,
        requestBody: jsonBody(ref("TerminalInput")),
        responses: {
          "202": jsonObjectResponse("Input accepted", ["accepted"], {
            accepted: { type: "boolean" },
          }),
          "400": validationError,
          "404": notFoundError,
          "503": jsonResponse("No session-agent connected", ref("RemoteError")),
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
          "503": jsonResponse("No session-agent connected", ref("RemoteError")),
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
    "/workspaces": {
      get: {
        summary: "List workspaces (each with its live soft-lock, if any)",
        responses: {
          "200": jsonResponse(
            "List of workspaces",
            ref("ListWorkspacesResponse"),
          ),
        },
      },
      post: {
        summary: "Create a workspace",
        requestBody: jsonBody(ref("CreateWorkspaceRequest")),
        responses: {
          "201": jsonResponse(
            "Workspace created",
            ref("CreateWorkspaceResponse"),
          ),
          "400": validationError,
        },
      },
    },
    "/workspaces/gc": {
      post: {
        summary:
          "Garbage-collect stale workspace directories on the shared volume " +
          "(dry-run unless apply=true; candidates are archived to on-volume " +
          ".trash/ before deletion; workspaces referenced by any known " +
          "session or registered workspace are always kept)",
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  olderThanDays: { type: "integer", minimum: 1, default: 30 },
                  apply: { type: "boolean", default: false },
                },
              },
            },
          },
        },
        responses: {
          "200": jsonObjectResponse(
            "GC report",
            ["candidates", "applied"],
            {
              candidates: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "sizeH", "lastModified"],
                  properties: {
                    id: { type: "string" },
                    sizeH: { type: "string" },
                    lastModified: { type: "string" },
                    archivedTo: { type: "string" },
                  },
                },
              },
              applied: { type: "boolean" },
            },
          ),
          "400": validationError,
          "501": jsonResponse(
            "Provisioner does not support shared-volume GC",
            ref("RemoteError"),
          ),
          "502": jsonResponse("Janitor run failed", ref("RemoteError")),
        },
      },
    },
    "/workspaces/{id}": {
      get: {
        summary: "Get a workspace (with its live soft-lock, if any)",
        parameters: idParam,
        responses: {
          "200": jsonResponse(
            "Workspace descriptor",
            ref("GetWorkspaceResponse"),
          ),
          "404": workspaceNotFound,
        },
      },
      delete: {
        summary: "Delete a workspace",
        parameters: idParam,
        responses: {
          "200": jsonResponse(
            "Delete accepted",
            ref("DeleteWorkspaceResponse"),
          ),
          "404": workspaceNotFound,
        },
      },
    },
    "/workspaces/{id}/lock": {
      post: {
        summary: "Acquire or refresh the workspace soft-lock",
        parameters: idParam,
        responses: {
          "200": jsonObjectResponse(
            "Lock acquired or refreshed",
            ["workspaceId", "holder", "acquiredAt", "accepted"],
            {
              workspaceId: { type: "string" },
              holder: { type: "string" },
              acquiredAt: { type: "string" },
              accepted: { type: "boolean" },
            },
          ),
          "404": workspaceNotFound,
          "409": jsonResponse(
            "Workspace already held by another lock holder",
            ref("RemoteError"),
          ),
        },
      },
      delete: {
        summary: "Release the workspace soft-lock",
        parameters: idParam,
        responses: {
          "200": jsonObjectResponse(
            "Lock released",
            ["workspaceId", "released"],
            {
              workspaceId: { type: "string" },
              released: { type: "boolean" },
            },
          ),
          "404": workspaceNotFound,
        },
      },
    },
  };

  // Every route except the public liveness probe sits behind the bearer
  // security scheme and may answer 401 when REMOTE_AUTH is enabled. Document it
  // uniformly so the contract stays correct as routes are added.
  for (const [path, operations] of Object.entries(paths)) {
    if (path === "/healthz") continue;
    for (const operation of Object.values(operations)) {
      operation.responses["401"] = unauthorizedError;
    }
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Sentropic Remote Control Plane",
      version: REMOTE_PROTOCOL_VERSION,
      summary: "Control plane API for Sentropic Remote sessions",
    },
    components: {
      ...remoteOpenApiComponents,
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            "Bearer JWT whose `sub` claim is the user id. Required on " +
            "/sessions and /workspaces when REMOTE_AUTH is enabled (off by " +
            "default, in which case no token is needed).",
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths,
  };
}
