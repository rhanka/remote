import { Ajv } from "ajv";
import * as addFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import { describe, expect, it } from "vitest";
import { REMOTE_SCHEMA_BASE_URL } from "../constants.js";
import {
  approvalRequestedEventExample,
  browserTwoFactorRequestedEventExample,
  sessionLifecycleChangedEventExample,
  terminalOutputEventExample,
  uatRouteCreatedEventExample,
} from "../examples.js";
import {
  actorSchema,
  approvalDecisionSchema,
  approvalDecisionRequestSchema,
  approvalDecisionResponseSchema,
  approvalRequestSchema,
  createSessionRequestSchema,
  createSessionResponseSchema,
  browserTwoFactorRequestSchema,
  browserUserTakeoverChangedSchema,
  getSessionResponseSchema,
  listSessionsResponseSchema,
  remoteErrorCodeSchema,
  remoteErrorSchema,
  remoteEventEnvelopeSchema,
  riskSchema,
  sendInstructionRequestSchema,
  sendInstructionResponseSchema,
  sessionAnnounceSchema,
  sessionDescriptorSchema,
  secretDeliverySchema,
  refreshSessionCredentialsRequestSchema,
  refreshSessionCredentialsResponseSchema,
  secretGrantResponseSchema,
  secretGrantStatusSchema,
  secretRequestSchema,
  stopSessionRequestSchema,
  stopSessionResponseSchema,
  terminalOutputSchema,
  terminalResizeSchema,
  uatRouteCreatedSchema,
  h2aBridgeProfileSchema,
  workspaceDescriptorSchema,
  createWorkspaceRequestSchema,
  createWorkspaceResponseSchema,
} from "./index.js";
import { H2A_BRIDGE_PROFILE_V1 } from "./h2a-bridge.js";

const addFormats = addFormatsModule.default as unknown as FormatsPlugin;
const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);

const minimalSession = {
  id: "session_001",
  profile: "shell",
  target: "k3s",
  workspacePath: "/workspace",
  createdAt: "2026-05-11T12:00:00.000Z",
  createdBy: { id: "user_001", kind: "user" },
};

describe("session JSON Schemas", () => {
  it("validates a session descriptor", () => {
    const validate = ajv.compile(sessionDescriptorSchema);
    const valid = validate({
      id: "session_001",
      profile: "codex",
      target: "k3s",
      workspacePath: "/workspace",
      createdAt: "2026-05-11T12:00:00.000Z",
      createdBy: {
        id: "user_001",
        kind: "user",
        displayName: "Antoine",
      },
      requiredCapabilities: ["read-secret", "browser-login"],
      resourceLimits: {
        cpu: "1000m",
        memory: "2Gi",
      },
    });

    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("rejects a session descriptor with a relative (non-absolute) workspace path", () => {
    const validate = ajv.compile(sessionDescriptorSchema);
    const valid = validate({
      id: "session_001",
      profile: "codex",
      target: "k3s",
      workspacePath: "relative/workspace",
      createdAt: "2026-05-11T12:00:00.000Z",
      createdBy: { id: "user_001", kind: "user" },
    });

    expect(valid).toBe(false);
    expect(validate.errors?.[0]?.instancePath).toBe("/workspacePath");
  });

  it("accepts a session descriptor with the user's real local path (path parity)", () => {
    const validate = ajv.compile(sessionDescriptorSchema);
    const valid = validate({
      id: "session_001",
      profile: "claude",
      target: "k3s",
      workspacePath: "/home/antoinefa/src/surch",
      home: "/home/antoinefa",
      createdAt: "2026-05-11T12:00:00.000Z",
      createdBy: { id: "user_001", kind: "user" },
    });

    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("rejects a session descriptor with an invalid createdAt date-time", () => {
    const validate = ajv.compile(sessionDescriptorSchema);
    const valid = validate({
      ...minimalSession,
      createdAt: "not-a-date",
    });

    expect(valid).toBe(false);
    expect(validate.errors?.[0]?.instancePath).toBe("/createdAt");
  });

  it("validates create session request and response payloads", () => {
    expect(ajv.compile(actorSchema)({ id: "user_001", kind: "user" })).toBe(
      true,
    );
    expect(
      ajv.compile(createSessionRequestSchema)({
        profile: "shell",
        target: "k3s",
        displayName: "Shell smoke",
        requiredCapabilities: ["network-egress"],
      }),
    ).toBe(true);
    expect(
      ajv.compile(createSessionResponseSchema)({
        session: minimalSession,
      }),
    ).toBe(true);
  });

  it("validates refresh session credentials request and response payloads", () => {
    expect(
      ajv.compile(refreshSessionCredentialsRequestSchema)({
        ".codex/auth.json": "YmFzZTY0Cg==",
        ".claude/.credentials.json": "bW9yZS1iYXNlNjQ=",
      }),
    ).toBe(true);
    expect(
      ajv.compile(refreshSessionCredentialsResponseSchema)({
        sessionId: "session_001",
        accepted: true,
      }),
    ).toBe(true);
  });

  it("validates list and get session response payloads", () => {
    expect(
      ajv.compile(listSessionsResponseSchema)({
        sessions: [minimalSession],
      }),
    ).toBe(true);
    expect(
      ajv.compile(getSessionResponseSchema)({
        session: minimalSession,
      }),
    ).toBe(true);
  });

  it("validates stop session request and response payloads", () => {
    expect(ajv.compile(stopSessionRequestSchema)({ reason: "done" })).toBe(
      true,
    );
    expect(
      ajv.compile(stopSessionResponseSchema)({
        sessionId: "session_001",
        accepted: true,
      }),
    ).toBe(true);
  });

  it("validates send instruction request and response payloads", () => {
    expect(
      ajv.compile(sendInstructionRequestSchema)({
        instruction: "Run the smoke test",
      }),
    ).toBe(true);
    expect(
      ajv.compile(sendInstructionResponseSchema)({
        instructionId: "instruction_001",
        accepted: true,
      }),
    ).toBe(true);
  });

  it("rejects required and additionalProperties violations", () => {
    const validateMissingInstruction = ajv.compile(
      sendInstructionRequestSchema,
    );
    const validMissingInstruction = validateMissingInstruction({});

    expect(validMissingInstruction).toBe(false);
    expect(validateMissingInstruction.errors?.[0]?.keyword).toBe("required");

    const validateAdditionalStopProperty = ajv.compile(
      stopSessionRequestSchema,
    );
    const validAdditionalStopProperty = validateAdditionalStopProperty({
      reason: "done",
      ignored: true,
    });

    expect(validAdditionalStopProperty).toBe(false);
    expect(validateAdditionalStopProperty.errors?.[0]?.keyword).toBe(
      "additionalProperties",
    );
  });
});

describe("session.announce schema", () => {
  it("validates a fully-specified announce (all fields)", () => {
    expect(
      ajv.compile(sessionAnnounceSchema)({
        sessionId: "session_001",
        profile: "claude",
        target: "scaleway-kapsule",
        workspacePath: "/workspace",
        workspaceId: "ws-001",
        cliSessionId: "cli_session_abc",
      }),
    ).toBe(true);
  });

  it("validates a minimal announce (only required fields)", () => {
    expect(
      ajv.compile(sessionAnnounceSchema)({
        sessionId: "session_001",
        profile: "shell",
      }),
    ).toBe(true);
  });

  it("rejects an announce missing sessionId", () => {
    const validate = ajv.compile(sessionAnnounceSchema);
    expect(validate({ profile: "codex" })).toBe(false);
    expect(validate.errors?.some((e) => e.keyword === "required")).toBe(true);
  });

  it("rejects an announce missing profile", () => {
    const validate = ajv.compile(sessionAnnounceSchema);
    expect(validate({ sessionId: "session_001" })).toBe(false);
    expect(validate.errors?.some((e) => e.keyword === "required")).toBe(true);
  });

  it("is secret-free: schema has no credentials or token fields", () => {
    const fieldNames = Object.keys(sessionAnnounceSchema.properties);
    const secretFields = fieldNames.filter((f) =>
      ["credentials", "token", "secret", "password", "key"].some((s) =>
        f.toLowerCase().includes(s),
      ),
    );
    expect(secretFields).toHaveLength(0);
  });
});

describe("approval, secret, and error JSON Schemas", () => {
  it("exposes public enum schema ids and compiles them with strict Ajv", () => {
    const publicEnumSchemas = [
      [
        riskSchema,
        `${REMOTE_SCHEMA_BASE_URL}/approval-risk.schema.json`,
        "critical",
      ],
      [
        approvalDecisionSchema,
        `${REMOTE_SCHEMA_BASE_URL}/approval-decision.schema.json`,
        "approved",
      ],
      [
        secretDeliverySchema,
        `${REMOTE_SCHEMA_BASE_URL}/secret-delivery.schema.json`,
        "kubernetes-secret",
      ],
      [
        secretGrantStatusSchema,
        `${REMOTE_SCHEMA_BASE_URL}/secret-grant-status.schema.json`,
        "granted",
      ],
      [
        remoteErrorCodeSchema,
        `${REMOTE_SCHEMA_BASE_URL}/remote-error-code.schema.json`,
        "capability.denied",
      ],
    ] as const;

    for (const [schema, id, validValue] of publicEnumSchemas) {
      expect(schema.$id).toBe(id);
      expect(schema.title).toBeTypeOf("string");
      expect(ajv.compile(schema)(validValue)).toBe(true);
    }
  });

  it("validates approval request and decision payloads", () => {
    expect(
      ajv.compile(approvalRequestSchema)({
        approvalRequestId: "approval_001",
        sessionId: "session_001",
        capability: "publish-npm",
        risk: "high",
        reason: "Publish package after tests pass",
        requestedBy: { id: "agent_001", kind: "session-agent" },
        requestedAt: "2026-05-11T12:00:00.000Z",
        expiresAt: "2026-05-11T12:05:00.000Z",
        subject: "npm publish",
        proposedAction: "npm publish --access public",
        context: { packageName: "@sentropic/remote-protocol" },
      }),
    ).toBe(true);

    expect(
      ajv.compile(approvalDecisionRequestSchema)({
        approvalRequestId: "approval_001",
        decision: "approved",
        comment: "Tests passed",
      }),
    ).toBe(true);

    expect(
      ajv.compile(approvalDecisionResponseSchema)({
        approvalRequestId: "approval_001",
        decision: "approved",
        decidedAt: "2026-05-11T12:01:00.000Z",
      }),
    ).toBe(true);
  });

  it("validates secret request and grant payloads without secret values", () => {
    const request = {
      secretRequestId: "secret_req_001",
      sessionId: "session_001",
      secretRef: "github-token",
      capability: "read-secret",
      purpose: "Authenticate gh for repository access",
      requestedBy: { id: "agent_001", kind: "session-agent" },
      requestedAt: "2026-05-11T12:00:00.000Z",
      expiresAt: "2026-05-11T12:10:00.000Z",
      delivery: "kubernetes-secret",
      context: { repository: "rhanka/remote" },
    };

    const grant = {
      secretRequestId: "secret_req_001",
      status: "granted",
      handle: "secret_handle_001",
      expiresAt: "2026-05-11T12:10:00.000Z",
      redactedPreview: "ghp_...1234",
    };

    expect(ajv.compile(secretRequestSchema)(request)).toBe(true);
    expect(ajv.compile(secretGrantResponseSchema)(grant)).toBe(true);
    expect(JSON.stringify(grant)).not.toContain("ghp_secret_value");
  });

  it("validates remote errors", () => {
    expect(
      ajv.compile(remoteErrorSchema)({
        code: "capability.denied",
        message: "Capability denied by policy",
        retryable: false,
        correlationId: "corr_001",
        details: { capability: "publish-npm" },
      }),
    ).toBe(true);
  });
});

describe("workspace JSON Schemas", () => {
  const workspace = {
    id: "ws-001",
    createdAt: "2026-05-25T12:00:00.000Z",
    createdBy: { id: "control-plane", kind: "control-plane" },
    displayName: "my-project",
  };

  it("validates a workspace descriptor", () => {
    expect(ajv.compile(workspaceDescriptorSchema)(workspace)).toBe(true);
  });

  it("validates create-workspace request and response", () => {
    expect(
      ajv.compile(createWorkspaceRequestSchema)({ displayName: "proj" }),
    ).toBe(true);
    expect(ajv.compile(createWorkspaceRequestSchema)({})).toBe(true);
    expect(ajv.compile(createWorkspaceResponseSchema)({ workspace })).toBe(true);
  });

  it("rejects a workspace descriptor missing createdBy", () => {
    const { createdBy: _omit, ...invalid } = workspace;
    expect(ajv.compile(workspaceDescriptorSchema)(invalid)).toBe(false);
  });
});

describe("h2a host bridge JSON Schema", () => {
  it("validates the canonical V1 bridge profile", () => {
    const validate = ajv.compile(h2aBridgeProfileSchema);
    expect(validate(H2A_BRIDGE_PROFILE_V1)).toBe(true);
  });

  it("rejects a profile with an unexpected hostId", () => {
    const validate = ajv.compile(h2aBridgeProfileSchema);
    expect(
      validate({ ...H2A_BRIDGE_PROFILE_V1, hostId: "some-other-host" }),
    ).toBe(false);
  });

  it("rejects a profile that claims to enforce resource limits", () => {
    const validate = ajv.compile(h2aBridgeProfileSchema);
    expect(
      validate({
        ...H2A_BRIDGE_PROFILE_V1,
        resourceLimits: { reflected: true, enforced: true },
      }),
    ).toBe(false);
  });
});

describe("remote event envelope JSON Schema", () => {
  it("validates representative event examples", () => {
    const validate = ajv.compile(remoteEventEnvelopeSchema);

    expect(validate(sessionLifecycleChangedEventExample)).toBe(true);
    expect(validate(terminalOutputEventExample)).toBe(true);
    expect(validate(approvalRequestedEventExample)).toBe(true);
    expect(validate(browserTwoFactorRequestedEventExample)).toBe(true);
    expect(validate(uatRouteCreatedEventExample)).toBe(true);
  });

  it("rejects an event without protocol version", () => {
    const validate = ajv.compile(remoteEventEnvelopeSchema);
    const { protocolVersion: _protocolVersion, ...invalid } =
      terminalOutputEventExample;

    expect(validate(invalid)).toBe(false);
  });

  it("rejects a terminal output event whose payload is not terminal output", () => {
    const validate = ajv.compile(remoteEventEnvelopeSchema);
    const invalid = {
      ...terminalOutputEventExample,
      payload: {
        approvalRequestId: "approval_001",
        sessionId: "session_001",
        capability: "publish-npm",
      },
    };

    expect(validate(invalid)).toBe(false);
  });

  it("validates representative event payload examples against payload schemas", () => {
    expect(
      ajv.compile(approvalRequestSchema)(approvalRequestedEventExample.payload),
    ).toBe(true);
    expect(
      ajv.compile(terminalOutputSchema)(terminalOutputEventExample.payload),
    ).toBe(true);
    expect(
      ajv.compile(browserTwoFactorRequestSchema)(
        browserTwoFactorRequestedEventExample.payload,
      ),
    ).toBe(true);
  });
});

describe("terminal, browser, and UAT JSON Schemas", () => {
  it("validates terminal output and resize payloads", () => {
    expect(
      ajv.compile(terminalOutputSchema)({
        terminalId: "term_001",
        stream: "stdout",
        data: "$ npm test\n",
        encoding: "utf8",
      }),
    ).toBe(true);

    expect(
      ajv.compile(terminalResizeSchema)({
        terminalId: "term_001",
        columns: 120,
        rows: 40,
      }),
    ).toBe(true);
  });

  it("validates browser 2FA, takeover, and UAT route payloads", () => {
    expect(
      ajv.compile(browserTwoFactorRequestSchema)({
        pageId: "page_001",
        url: "https://github.com/login",
        challengeId: "challenge_001",
        method: "totp",
        requestedAt: "2026-05-11T12:00:00.000Z",
        expiresAt: "2026-05-11T12:02:00.000Z",
      }),
    ).toBe(true);

    expect(
      ajv.compile(browserUserTakeoverChangedSchema)({
        pageId: "page_001",
        state: "active",
        changedAt: "2026-05-11T12:01:00.000Z",
      }),
    ).toBe(true);

    expect(
      ajv.compile(uatRouteCreatedSchema)({
        routeId: "uat_001",
        url: "https://uat.example.invalid/session_001",
        port: 5173,
        expiresAt: "2026-05-11T13:00:00.000Z",
        exposurePolicy: "operator-only",
      }),
    ).toBe(true);
  });
});
