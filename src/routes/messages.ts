import { FastifyInstance } from "fastify";
import { BackendRouter } from "../backends/router.js";
import { randomUUID } from "node:crypto";

export function registerMessages(app: FastifyInstance, router: BackendRouter) {
  app.post("/v1/messages", {
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
          system: {},
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as any;
    const model = body.model ?? "claude";
    const messages = body.messages ?? [];
    const stream = body.stream ?? false;
    const system = typeof body.system === "string" ? body.system
      : Array.isArray(body.system) ? body.system.map((b: any) => b.text).join("\n")
      : undefined;

    let result;
    try {
      result = await router.execute({
        model,
        messages,
        stream,
        max_tokens: body.max_tokens,
        temperature: body.temperature,
        system,
      });
    } catch (err: any) {
      reply.code(502).send({
        type: "error",
        error: { type: "api_error", message: err.message || "Backend execution failed" },
      });
      return;
    }

    const msgId = "msg_" + randomUUID().replace(/-/g, "").slice(0, 24);

    if (stream && result.stream) {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      reply.raw.write(`event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: msgId, type: "message", role: "assistant", content: [],
          model: result.model, stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })}\n\n`);

      reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })}\n\n`);

      try {
        for await (const chunk of result.stream) {
          if (!chunk) continue;
          reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: chunk },
          })}\n\n`);
        }

        reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop", index: 0,
        })}\n\n`);

        reply.raw.write(`event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 0 },
        })}\n\n`);

        reply.raw.write(`event: message_stop\ndata: ${JSON.stringify({
          type: "message_stop",
        })}\n\n`);
      } catch (err: any) {
        const errMsg = err.message || "Stream error";
        reply.raw.write(`event: error\ndata: ${JSON.stringify({
          type: "error",
          error: { type: "api_error", message: errMsg },
        })}\n\n`);
      } finally {
        reply.raw.end();
      }
      return;
    }

    return {
      id: msgId,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: result.text ?? "" }],
      model: result.model,
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  });
}
