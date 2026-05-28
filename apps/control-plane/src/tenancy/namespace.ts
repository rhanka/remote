import { createHash } from "node:crypto";

const SHARED_NS = "sentropic-remote";

export function tenantNamespace(userId: string): string {
  if (userId === "default") return SHARED_NS;
  const h = createHash("sha256").update(userId).digest("hex").slice(0, 8);
  return `user-${h}`;
}
