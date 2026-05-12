import { describe, expect, it } from "vitest";
import {
  actorSchema,
  approvalDecisionRequestSchema,
  approvalDecisionResponseSchema,
  approvalRequestSchema,
  browserNavigatedSchema,
  browserSensitiveActionRequestSchema,
  browserStartedSchema,
  browserTwoFactorRequestSchema,
  browserUserTakeoverChangedSchema,
  browserUserTakeoverRequestSchema,
  createSessionRequestSchema,
  createSessionResponseSchema,
  getSessionResponseSchema,
  listSessionsResponseSchema,
  remoteErrorSchema,
  remoteEventEnvelopeSchema,
  remoteOpenApiComponents,
  secretGrantResponseSchema,
  secretRequestSchema,
  sendInstructionRequestSchema,
  sendInstructionResponseSchema,
  sessionDescriptorSchema,
  stopSessionRequestSchema,
  stopSessionResponseSchema,
  terminalExitedSchema,
  terminalInputSchema,
  terminalOpenedSchema,
  terminalOutputSchema,
  terminalResizeSchema,
  uatRouteCreatedSchema,
  uatRouteExpiredSchema,
} from "./index.js";

describe("remoteOpenApiComponents", () => {
  const expectedPublicObjectSchemas = {
    Actor: actorSchema,
    ApprovalDecisionRequest: approvalDecisionRequestSchema,
    ApprovalDecisionResponse: approvalDecisionResponseSchema,
    ApprovalRequest: approvalRequestSchema,
    BrowserNavigated: browserNavigatedSchema,
    BrowserSensitiveActionRequest: browserSensitiveActionRequestSchema,
    BrowserStarted: browserStartedSchema,
    BrowserTwoFactorRequest: browserTwoFactorRequestSchema,
    BrowserUserTakeoverChanged: browserUserTakeoverChangedSchema,
    BrowserUserTakeoverRequest: browserUserTakeoverRequestSchema,
    CreateSessionRequest: createSessionRequestSchema,
    CreateSessionResponse: createSessionResponseSchema,
    GetSessionResponse: getSessionResponseSchema,
    ListSessionsResponse: listSessionsResponseSchema,
    RemoteError: remoteErrorSchema,
    RemoteEventEnvelope: remoteEventEnvelopeSchema,
    SecretGrantResponse: secretGrantResponseSchema,
    SecretRequest: secretRequestSchema,
    SendInstructionRequest: sendInstructionRequestSchema,
    SendInstructionResponse: sendInstructionResponseSchema,
    SessionDescriptor: sessionDescriptorSchema,
    StopSessionRequest: stopSessionRequestSchema,
    StopSessionResponse: stopSessionResponseSchema,
    TerminalExited: terminalExitedSchema,
    TerminalInput: terminalInputSchema,
    TerminalOpened: terminalOpenedSchema,
    TerminalOutput: terminalOutputSchema,
    TerminalResize: terminalResizeSchema,
    UatRouteCreated: uatRouteCreatedSchema,
    UatRouteExpired: uatRouteExpiredSchema,
  } as const;

  it("contains the public object schemas needed by the control-plane", () => {
    const expectedSchemaNames = Object.keys(
      expectedPublicObjectSchemas,
    ) as Array<keyof typeof expectedPublicObjectSchemas>;

    expect(Object.keys(remoteOpenApiComponents.schemas).sort()).toEqual(
      [...expectedSchemaNames].sort(),
    );

    for (const name of expectedSchemaNames) {
      expect(remoteOpenApiComponents.schemas[name]).toBe(
        expectedPublicObjectSchemas[name],
      );
    }
  });

  it("exports schemas with ids and titles", () => {
    for (const [name, schema] of Object.entries(
      remoteOpenApiComponents.schemas,
    )) {
      expect(name).toMatch(/^[A-Z]/);
      expect(schema).toHaveProperty("$id");
      expect(schema).toHaveProperty("title");
    }
  });
});
