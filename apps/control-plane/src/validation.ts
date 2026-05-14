import { remoteOpenApiComponents } from "@sentropic/remote-protocol";
import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule, { type FormatsPlugin } from "ajv-formats";
import type { Context, MiddlewareHandler } from "hono";

const addFormats = addFormatsModule as unknown as FormatsPlugin;

export type ValidationVars = { validatedBody: unknown };

export type ValidationContext = Context<{ Variables: ValidationVars }>;

export function createAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const schema of Object.values(remoteOpenApiComponents.schemas)) {
    ajv.addSchema(schema);
  }
  return ajv;
}

type SchemaWithId = { readonly $id: string };

function getValidator(ajv: Ajv, schema: SchemaWithId): ValidateFunction {
  const existing = ajv.getSchema(schema.$id);
  if (existing) {
    return existing as ValidateFunction;
  }
  return ajv.compile(schema);
}

export function validateJsonBody(
  ajv: Ajv,
  schema: SchemaWithId,
): MiddlewareHandler<{ Variables: ValidationVars }> {
  const validate = getValidator(ajv, schema);

  return async (c, next) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          code: "validation.failed",
          message: "Request body is not valid JSON",
          retryable: false,
        },
        400,
      );
    }

    if (!validate(body)) {
      return c.json(
        {
          code: "validation.failed",
          message: "Request body does not match schema",
          retryable: false,
          details: { errors: validate.errors ?? [] },
        },
        400,
      );
    }

    c.set("validatedBody", body);
    await next();
  };
}

export function validatedBody<T>(c: ValidationContext): T {
  return c.get("validatedBody") as T;
}
