import { FastifyRequest, FastifyReply } from "fastify";
import { validateKey } from "./keys.js";

export function createAuthHook(getKeyHash: () => string) {
  return async function authHook(request: FastifyRequest, reply: FastifyReply) {
    // Accept both: Authorization: Bearer <key> (OpenAI style)
    //              x-api-key: <key> (Anthropic style)
    const auth = request.headers.authorization;
    const xApiKey = request.headers["x-api-key"] as string | undefined;

    let token: string | undefined;
    if (auth?.startsWith("Bearer ")) {
      token = auth.slice(7);
    } else if (xApiKey) {
      token = xApiKey;
    }

    if (!token) {
      reply.code(401).send({ error: { message: "Missing or invalid Authorization header", type: "auth_error" } });
      return reply;
    }
    if (!validateKey(token, getKeyHash())) {
      reply.code(401).send({ error: { message: "Invalid API key", type: "auth_error" } });
      return reply;
    }
  };
}
