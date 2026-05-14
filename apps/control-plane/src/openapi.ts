import {
  REMOTE_PROTOCOL_VERSION,
  remoteOpenApiComponents,
} from "@remote-controle/protocol";

const ref = (name: string) => ({
  $ref: `#/components/schemas/${name}`,
});

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
        post: {
          summary: "Create a remote session",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: ref("CreateSessionRequest"),
              },
            },
          },
          responses: {
            "201": {
              description: "Session created",
              content: {
                "application/json": {
                  schema: ref("CreateSessionResponse"),
                },
              },
            },
            "400": {
              description: "Validation failed",
              content: {
                "application/json": {
                  schema: ref("RemoteError"),
                },
              },
            },
          },
        },
      },
    },
  };
}
