import { Ajv } from "ajv";
import * as addFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import { describe, expect, it } from "vitest";
import * as protocol from "./index.js";
import { remoteOpenApiComponents } from "./index.js";

const addFormats = addFormatsModule.default as unknown as FormatsPlugin;

type PublicJsonSchema = {
  readonly $id: string;
  readonly title: string;
};

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const publicExportedSchemas = () =>
  (Object.entries(protocol) as Array<[string, unknown]>).filter(
    (entry): entry is [string, PublicJsonSchema] => {
      const [exportName, value] = entry;

      if (!exportName.endsWith("Schema")) {
        return false;
      }

      if (value === null || typeof value !== "object") {
        return false;
      }

      const candidate = value as { $id?: unknown; title?: unknown };

      return (
        typeof candidate.$id === "string" && typeof candidate.title === "string"
      );
    },
  );

describe("remoteOpenApiComponents", () => {
  it("contains every public exported schema with an id by identity", () => {
    const componentSchemas = Object.values(remoteOpenApiComponents.schemas);
    const exportedSchemas = publicExportedSchemas();

    expect(exportedSchemas.map(([exportName]) => exportName).sort()).toEqual(
      expect.arrayContaining([
        "capabilitySchema",
        "riskSchema",
        "sessionLifecycleChangedPayloadSchema",
        "terminalStreamSchema",
      ]),
    );

    for (const [exportName, schema] of exportedSchemas) {
      expect(componentSchemas, exportName).toContain(schema);
    }
  });

  it("keys public schemas by schema title", () => {
    for (const [, schema] of publicExportedSchemas()) {
      expect(remoteOpenApiComponents.schemas[schema.title]).toBe(schema);
    }
  });

  it("exports schemas with ids and titles", () => {
    for (const [name, schema] of Object.entries(
      remoteOpenApiComponents.schemas,
    )) {
      expect(name).toMatch(/^[A-Z]/);
      expect(schema.$id).toBeTypeOf("string");
      expect(schema.title).toBe(name);
    }
  });

  it("bulk-registers every component schema with strict Ajv", () => {
    const ajv = new Ajv({ allErrors: true, strict: true });
    addFormats(ajv);
    const componentSchemas = Object.fromEntries(
      Object.entries(remoteOpenApiComponents.schemas).map(([name, schema]) => [
        name,
        cloneJson(schema),
      ]),
    );

    expect(() => {
      ajv.addSchema({
        $id: "https://schemas.sentropic.dev/remote/openapi-components.schema.json",
        $defs: componentSchemas,
      });

      for (const schema of Object.values(remoteOpenApiComponents.schemas)) {
        ajv.getSchema(schema.$id);
      }
    }).not.toThrow();
  });
});
