import { Backend, BackendRequest, BackendResult } from "./base.js";
import { ClaudeBackend } from "./claude.js";
import { OpenAIBackend } from "./openai.js";

export class BackendRouter {
  private backends: Backend[] = [];

  constructor() {
    const claude = new ClaudeBackend();
    const openai = new OpenAIBackend();
    if (claude.available) this.backends.push(claude);
    if (openai.available) this.backends.push(openai);
  }

  getAvailableBackends(): Backend[] {
    return this.backends;
  }

  getAvailableModels(): Array<{ id: string; backend: string }> {
    return this.backends.flatMap(b =>
      b.models.map(m => ({ id: m, backend: b.name }))
    );
  }

  resolve(model: string): Backend | null {
    for (const b of this.backends) {
      if (b.models.includes(model)) return b;
    }
    for (const b of this.backends) {
      if (b.name === "claude" && (model.startsWith("claude") || model.startsWith("anthropic"))) return b;
      if (b.name === "openai" && (model.startsWith("gpt") || model.startsWith("o1") || model.startsWith("o3"))) return b;
    }
    return this.backends[0] ?? null;
  }

  async execute(request: BackendRequest): Promise<BackendResult> {
    const backend = this.resolve(request.model);
    if (!backend) {
      throw new Error("No available backend for model: " + request.model);
    }
    return backend.execute(request);
  }
}
