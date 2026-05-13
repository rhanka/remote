import * as publicSchemas from "./schemas/index.js";

type PublicJsonSchema = {
  readonly $id: string;
  readonly title: string;
  readonly [key: string]: unknown;
};

const isPublicSchema = (
  entry: [string, unknown],
): entry is [string, PublicJsonSchema] => {
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
};

export const remoteOpenApiComponents = {
  schemas: Object.fromEntries(
    Object.entries(publicSchemas)
      .filter(isPublicSchema)
      .map(([, schema]) => [schema.title, schema]),
  ) as Record<string, PublicJsonSchema>,
} as const;
