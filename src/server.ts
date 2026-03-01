import Fastify from "fastify";
import { BackendRouter } from "./backends/router.js";
import { createAuthHook } from "./auth/middleware.js";
import { createRateLimiter } from "./utils/rate-limit.js";
import { registerChatCompletions } from "./routes/chat-completions.js";
import { registerMessages } from "./routes/messages.js";
import { registerModels } from "./routes/models.js";

export interface ServerOptions {
  port: number;
  host: string;
  getKeyHash: () => string;
  corsOrigin?: string;
}

export async function createServer(options: ServerOptions) {
  const app = Fastify({
    logger: { level: "info" },
    bodyLimit: 10 * 1024 * 1024, // 10MB
  });

  const router = new BackendRouter();

  // CORS
  app.addHook("onRequest", async (request, reply) => {
    const origin = options.corsOrigin ?? "*";
    reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (request.method === "OPTIONS") {
      reply.code(204).send();
      return reply;
    }
  });

  // Auth (skip for health check and OPTIONS)
  const authHook = createAuthHook(options.getKeyHash);
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS") return;
    if (request.url === "/health") return;
    return authHook(request, reply);
  });

  // Rate limiting
  const rateLimiter = createRateLimiter();
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS") return;
    if (request.url === "/health") return;
    return rateLimiter(request, reply);
  });

  // Health check
  app.get("/health", async () => ({ status: "ok" }));

  // Routes
  registerChatCompletions(app, router);
  registerMessages(app, router);
  registerModels(app, router);

  return { app, router };
}

export async function startServer(options: ServerOptions) {
  const { app, router } = await createServer(options);
  await app.listen({ port: options.port, host: options.host });
  return { app, router };
}
