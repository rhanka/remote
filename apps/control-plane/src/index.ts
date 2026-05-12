import Fastify, { type FastifyInstance } from "fastify";
import { REMOTE_PROTOCOL_VERSION } from "@remote-controle/protocol";

export function createControlPlane(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/healthz", async () => ({
    ok: true,
    service: "remote-controle-control-plane",
    protocolVersion: REMOTE_PROTOCOL_VERSION,
  }));

  return app;
}

export async function startControlPlane(): Promise<void> {
  const app = createControlPlane();
  const port = Number(process.env.PORT ?? "8080");
  const host = process.env.HOST ?? "0.0.0.0";
  await app.listen({ host, port });
}

if (process.env.NODE_ENV !== "test") {
  await startControlPlane();
}
