import { Ajv } from "ajv";
import * as addFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  actorSchema,
  createSessionRequestSchema,
  createSessionResponseSchema,
  getSessionResponseSchema,
  listSessionsResponseSchema,
  sendInstructionRequestSchema,
  sendInstructionResponseSchema,
  sessionDescriptorSchema,
  stopSessionRequestSchema,
  stopSessionResponseSchema,
} from "./index.js";

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

  it("rejects a session descriptor with a non-MVP workspace path", () => {
    const validate = ajv.compile(sessionDescriptorSchema);
    const valid = validate({
      id: "session_001",
      profile: "codex",
      target: "k3s",
      workspacePath: "/tmp/workspace",
      createdAt: "2026-05-11T12:00:00.000Z",
      createdBy: { id: "user_001", kind: "user" },
    });

    expect(valid).toBe(false);
    expect(validate.errors?.[0]?.instancePath).toBe("/workspacePath");
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
