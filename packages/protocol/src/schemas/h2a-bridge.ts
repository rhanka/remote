import { REMOTE_SCHEMA_BASE_URL } from "../constants.js";

/**
 * Contract between a Sentropic Remote session Pod (the host) and an
 * `@sentropic/h2a` MCP sidecar running inside it (`h2a mcp-serve`).
 *
 * Source of truth: `@sentropic/h2a` DEC-059. This schema is the host-side
 * mirror so the contract is validated symmetrically. The only V1 profile is
 * the `remote` host itself.
 */
export const h2aBridgeProfileSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/h2a-bridge-profile.schema.json`,
  title: "H2AHostBridgeProfile",
  type: "object",
  additionalProperties: false,
  $defs: {
    h2aLifecycleState: {
      type: "string",
      enum: ["opening", "live", "draining", "closed", "expired"],
    },
  },
  required: [
    "hostId",
    "label",
    "identity",
    "lifecycle",
    "resourceLimits",
    "disclosure",
    "authBoundary",
    "references",
  ],
  properties: {
    hostId: { type: "string", const: "remote" },
    label: { type: "string", minLength: 1 },

    identity: {
      type: "object",
      additionalProperties: false,
      required: ["instanceTemplate", "envVarMap", "hostHint"],
      properties: {
        instanceTemplate: {
          type: "string",
          const: "remote:${SESSION_ID}",
        },
        envVarMap: {
          type: "object",
          additionalProperties: false,
          required: ["instance", "host", "root"],
          properties: {
            instance: { type: "string", const: "H2A_INSTANCE" },
            host: { type: "string", const: "H2A_HOST" },
            root: { type: "string", const: "H2A_ROOT" },
          },
        },
        hostHint: { type: "string", const: "remote" },
      },
    },

    lifecycle: {
      type: "object",
      additionalProperties: false,
      required: ["stateMap", "description"],
      properties: {
        stateMap: {
          type: "object",
          additionalProperties: false,
          required: ["provisioning", "running", "terminating", "ended"],
          properties: {
            provisioning: { $ref: "#/$defs/h2aLifecycleState" },
            running: { $ref: "#/$defs/h2aLifecycleState" },
            terminating: { $ref: "#/$defs/h2aLifecycleState" },
            ended: { $ref: "#/$defs/h2aLifecycleState" },
          },
        },
        description: { type: "string" },
      },
    },

    resourceLimits: {
      type: "object",
      additionalProperties: false,
      required: ["reflected", "enforced"],
      properties: {
        reflected: { type: "boolean" },
        enforced: { type: "boolean", const: false },
        reflectedAs: { type: "string" },
      },
    },

    disclosure: {
      type: "object",
      additionalProperties: false,
      required: ["workspaceBoundary", "crossWorkspace"],
      properties: {
        workspaceBoundary: { type: "string" },
        crossWorkspace: {
          type: "string",
          enum: ["deferred", "supported", "n/a"],
        },
        crossWorkspaceReference: { type: "string" },
      },
    },

    authBoundary: {
      type: "object",
      additionalProperties: false,
      required: ["transport", "enforcement"],
      properties: {
        transport: { type: "string" },
        enforcement: { type: "string" },
      },
    },

    references: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      minItems: 1,
    },
  },
} as const;

/**
 * The only V1 host bridge profile: the `remote` host itself. Hard-coded here
 * (pure, no orchestrator dependency) so both the protocol consumers and the
 * k8s-orchestrator can read the same source of truth.
 */
export const H2A_BRIDGE_PROFILE_V1 = {
  hostId: "remote",
  label: "Sentropic Remote session host",
  identity: {
    instanceTemplate: "remote:${SESSION_ID}",
    envVarMap: {
      instance: "H2A_INSTANCE",
      host: "H2A_HOST",
      root: "H2A_ROOT",
    },
    hostHint: "remote",
  },
  lifecycle: {
    stateMap: {
      provisioning: "opening",
      running: "live",
      terminating: "draining",
      ended: "closed",
    },
    description:
      "Maps Sentropic Remote session lifecycle states onto the h2a sidecar lifecycle vocabulary.",
  },
  resourceLimits: {
    reflected: true,
    enforced: false,
    reflectedAs: "session.resourceLimits",
  },
  disclosure: {
    workspaceBoundary: "/workspace",
    crossWorkspace: "deferred",
  },
  authBoundary: {
    transport: "in-pod loopback (mcp-serve on localhost)",
    enforcement: "session Pod network policy",
  },
  references: ["@sentropic/h2a DEC-059"],
} as const;
