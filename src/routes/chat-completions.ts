import { FastifyInstance } from "fastify";
import { BackendRouter } from "../backends/router.js";
import { randomUUID } from "node:crypto";

export function registerChatCompletions(app: FastifyInstance, router: BackendRouter) {
  app.post("/v1/chat/completions", {
    schema: {
      body: {
        type: "object",
        required: ["messages"],
        properties: {
          model: { type: "string" },
          messages: { type: "array", minItems: 1 },
          stream: { type: "boolean" },
          max_tokens: { type: "integer", minimum: 1 },
          temperature: { type: "number", minimum: 0, maximum: 2 },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as any;
    const model = body.model ?? "claude";
    const messages = body.messages ?? [];
    const stream = body.stream ?? false;

    let result;
    try {
      result = await router.execute({
        model,
        messages,
        stream,
        max_tokens: body.max_tokens,
        temperature: body.temperature,
        system: body.system,
      });
    } catch (err: any) {
      reply.code(502).send({
        error: { message: err.message || "Backend execution failed", type: "server_error" },
      });
      return;
    }

    if (stream && result.stream) {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const id = "chatcmpl-" + randomUUID().replace(/-/g, "").slice(0, 24);
      const created = Math.floor(Date.now() / 1000);

      try {
        for await (const chunk of result.stream) {
          if (!chunk) continue;
          const event = {
            id,
            object: "chat.completion.chunk",
            created,
            model: result.model,
            choices: [{
              index: 0,
              delta: { content: chunk },
              finish_reason: null,
            }],
          };
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        }

        const finalEvent = {
          id,
          object: "chat.completion.chunk",
          created,
          model: result.model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
        reply.raw.write(`data: ${JSON.stringify(finalEvent)}\n\n`);
        reply.raw.write("data: [DONE]\n\n");
      } catch (err: any) {
        const errMsg = err.message || "Stream error";
        reply.raw.write(`data: ${JSON.stringify({ error: { message: errMsg } })}\n\n`);
        reply.raw.write("data: [DONE]\n\n");
      } finally {
        reply.raw.end();
      }
      return;
    }

    return {
      id: "chatcmpl-" + randomUUID().replace(/-/g, "").slice(0, 24),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: result.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: result.text ?? "" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  });
}
