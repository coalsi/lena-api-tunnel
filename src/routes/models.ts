import { FastifyInstance } from "fastify";
import { BackendRouter } from "../backends/router.js";

export function registerModels(app: FastifyInstance, router: BackendRouter) {
  app.get("/v1/models", async () => {
    const models = router.getAvailableModels();
    return {
      object: "list",
      data: models.map(m => ({
        id: m.id,
        object: "model",
        created: 0,
        owned_by: m.backend,
      })),
    };
  });
}
