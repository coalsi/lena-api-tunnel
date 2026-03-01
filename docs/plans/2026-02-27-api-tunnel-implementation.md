# API Tunnel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a CLI tool that turns local AI CLI subscriptions (Claude, OpenAI) into standard API endpoints via HTTP server + ngrok tunnel.

**Architecture:** Fastify HTTP server translates OpenAI/Anthropic API requests into CLI subprocess invocations (`claude -p`, `openai api chat.completions.create`), streams responses back as SSE. Auth via generated API keys. Optional ngrok tunnel for remote access.

**Tech Stack:** Node.js 20+, TypeScript, Fastify, @ngrok/ngrok, chalk, child_process.spawn

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/index.ts`
- Create: `bin/api-tunnel`

**Step 1: Initialize the project**

```bash
cd /Users/coreysilvia/coreApps/api-tunnel
npm init -y
```

**Step 2: Install dependencies**

```bash
npm install fastify @ngrok/ngrok chalk@5 ora@8 commander
npm install -D typescript @types/node tsx
```

**Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

**Step 4: Create minimal src/index.ts**

```typescript
#!/usr/bin/env node
console.log("api-tunnel starting...");
```

**Step 5: Create bin/api-tunnel**

```bash
#!/usr/bin/env node
import("../dist/index.js");
```

**Step 6: Update package.json**

Set `"type": "module"`, `"bin": { "api-tunnel": "./bin/api-tunnel" }`, add scripts:
```json
{
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  }
}
```

**Step 7: Verify it runs**

Run: `npm run dev`
Expected: Prints "api-tunnel starting..."

**Step 8: Commit**

```bash
git add package.json tsconfig.json src/index.ts bin/api-tunnel
git commit -m "feat: project scaffolding"
```

---

### Task 2: Config Store

**Files:**
- Create: `src/config/store.ts`

**Step 1: Implement config store**

Config lives at `~/.api-tunnel/config.json`. The store handles:
- Creating the directory if it doesn't exist
- Reading/writing JSON config
- Default values

```typescript
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface Config {
  apiKeyHash: string;     // SHA-256 hash of the API key
  port: number;
  ngrokAuthtoken?: string;
}

const CONFIG_DIR = join(homedir(), ".api-tunnel");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const DEFAULTS: Config = {
  apiKeyHash: "",
  port: 3456,
};

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  return { ...DEFAULTS, ...JSON.parse(raw) };
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}
```

Note: `mode: 0o600` ensures only the owner can read/write the config file.

**Step 2: Verify it compiles**

Run: `npx tsx src/config/store.ts`
Expected: No output, no errors

**Step 3: Commit**

```bash
git add src/config/store.ts
git commit -m "feat: config store with ~/.api-tunnel/config.json"
```

---

### Task 3: API Key Generation & Validation

**Files:**
- Create: `src/auth/keys.ts`

**Step 1: Implement key generation and validation**

```typescript
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

const KEY_PREFIX = "at_sk_";

/** Generate a new API key. Returns the plaintext key (show once) and its hash (store). */
export function generateApiKey(): { plaintext: string; hash: string } {
  const bytes = randomBytes(32); // 256 bits
  const plaintext = KEY_PREFIX + bytes.toString("hex");
  const hash = hashKey(plaintext);
  return { plaintext, hash };
}

/** Hash a key for storage. */
export function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** Constant-time comparison of a plaintext key against a stored hash. */
export function validateKey(plaintext: string, storedHash: string): boolean {
  const incomingHash = hashKey(plaintext);
  const a = Buffer.from(incomingHash, "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

**Step 2: Verify it compiles**

Run: `npx tsx -e "import { generateApiKey, validateKey } from './src/auth/keys.js'; const k = generateApiKey(); console.log(k.plaintext.startsWith('at_sk_'), k.plaintext.length === 70, validateKey(k.plaintext, k.hash))"`
Expected: `true true true`

**Step 3: Commit**

```bash
git add src/auth/keys.ts
git commit -m "feat: API key generation with SHA-256 hashing and constant-time validation"
```

---

### Task 4: Auth Middleware

**Files:**
- Create: `src/auth/middleware.ts`

**Step 1: Implement Fastify auth hook**

```typescript
import { FastifyRequest, FastifyReply } from "fastify";
import { validateKey } from "./keys.js";

export function createAuthHook(getKeyHash: () => string) {
  return async function authHook(request: FastifyRequest, reply: FastifyReply) {
    const auth = request.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      reply.code(401).send({ error: { message: "Missing or invalid Authorization header", type: "auth_error" } });
      return reply;
    }

    const token = auth.slice(7);
    if (!validateKey(token, getKeyHash())) {
      reply.code(401).send({ error: { message: "Invalid API key", type: "auth_error" } });
      return reply;
    }
  };
}
```

**Step 2: Commit**

```bash
git add src/auth/middleware.ts
git commit -m "feat: auth middleware with Bearer token validation"
```

---

### Task 5: Rate Limiter

**Files:**
- Create: `src/utils/rate-limit.ts`

**Step 1: Implement token bucket rate limiter**

```typescript
import { FastifyRequest, FastifyReply } from "fastify";

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export function createRateLimiter(maxTokens: number = 10, refillRatePerSec: number = 10 / 60) {
  const buckets = new Map<string, Bucket>();

  return async function rateLimitHook(request: FastifyRequest, reply: FastifyReply) {
    const key = request.headers.authorization ?? request.ip;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: maxTokens, lastRefill: now };
      buckets.set(key, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(maxTokens, bucket.tokens + elapsed * refillRatePerSec);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      const retryAfter = Math.ceil((1 - bucket.tokens) / refillRatePerSec);
      reply
        .code(429)
        .header("Retry-After", String(retryAfter))
        .send({ error: { message: "Rate limit exceeded", type: "rate_limit_error" } });
      return reply;
    }

    bucket.tokens -= 1;
  };
}
```

**Step 2: Commit**

```bash
git add src/utils/rate-limit.ts
git commit -m "feat: token bucket rate limiter"
```

---

### Task 6: Backend Interface & Detection

**Files:**
- Create: `src/backends/base.ts`

**Step 1: Define the backend interface and detection logic**

```typescript
import { execSync } from "node:child_process";

export interface BackendMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface BackendRequest {
  model: string;
  messages: BackendMessage[];
  stream: boolean;
  max_tokens?: number;
  temperature?: number;
  system?: string;
}

export interface BackendResult {
  /** For non-streaming: the full text response */
  text?: string;
  /** For streaming: an async iterable of text chunks */
  stream?: AsyncIterable<string>;
  /** Model name used */
  model: string;
}

export interface Backend {
  name: string;
  models: string[];
  available: boolean;
  execute(request: BackendRequest): Promise<BackendResult>;
}

/** Check if a CLI tool is installed */
export function isInstalled(command: string): boolean {
  try {
    execSync(`which ${command}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
```

**Step 2: Commit**

```bash
git add src/backends/base.ts
git commit -m "feat: backend interface and CLI detection utility"
```

---

### Task 7: Claude CLI Backend

**Files:**
- Create: `src/backends/claude.ts`

**Step 1: Implement the Claude CLI backend**

This is the core translation layer. Key Claude CLI flags:
- `-p` / `--print` — non-interactive mode
- `--output-format stream-json` — streaming JSON output (each line is a JSON event)
- `--output-format json` — single JSON result
- `--model <model>` — model selection (sonnet, opus, haiku)
- `--system-prompt <prompt>` — system prompt
- Uses stdin for the user prompt

```typescript
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { Backend, BackendRequest, BackendResult, isInstalled, ContentPart } from "./base.js";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const TEMP_DIR = join(tmpdir(), "api-tunnel");

function extractTextContent(messages: BackendRequest["messages"]): string {
  // Combine all messages into a prompt for the CLI
  // Claude CLI's -p mode takes a single prompt string via stdin/args
  const parts: string[] = [];
  for (const msg of messages) {
    const prefix = msg.role === "system" ? "[System] " : msg.role === "assistant" ? "[Assistant] " : "";
    if (typeof msg.content === "string") {
      parts.push(prefix + msg.content);
    } else {
      // Extract text parts from content array
      for (const part of msg.content) {
        if (part.type === "text" && part.text) {
          parts.push(prefix + part.text);
        }
      }
    }
  }
  return parts.join("\n\n");
}

function extractSystemPrompt(messages: BackendRequest["messages"]): string | undefined {
  const systemMsgs = messages.filter(m => m.role === "system");
  if (systemMsgs.length === 0) return undefined;
  return systemMsgs.map(m => typeof m.content === "string" ? m.content : "").join("\n");
}

function extractUserMessages(messages: BackendRequest["messages"]): BackendRequest["messages"] {
  return messages.filter(m => m.role !== "system");
}

export class ClaudeBackend implements Backend {
  name = "claude";
  models = ["claude", "claude-sonnet", "claude-opus", "claude-haiku",
            "claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"];
  available = isInstalled("claude");

  async execute(request: BackendRequest): Promise<BackendResult> {
    const args: string[] = ["-p", "--output-format", request.stream ? "stream-json" : "text"];

    // Model mapping
    if (request.model && request.model !== "claude") {
      args.push("--model", request.model.replace("claude-", ""));
    }

    // System prompt: extract from messages or use explicit
    const systemPrompt = request.system ?? extractSystemPrompt(request.messages);
    if (systemPrompt) {
      args.push("--system-prompt", systemPrompt);
    }

    // Build the prompt from non-system messages
    const prompt = extractTextContent(extractUserMessages(request.messages));

    // Spawn claude CLI - prompt goes as the positional argument
    const child = spawn("claude", [...args, prompt], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CLAUDECODE: undefined }, // unset to allow nesting
    });

    if (request.stream) {
      const stream = this.createStream(child.stdout);
      return { stream, model: request.model || "claude" };
    } else {
      const text = await this.collectOutput(child.stdout);
      return { text, model: request.model || "claude" };
    }
  }

  private async *createStream(stdout: Readable): AsyncIterable<string> {
    let buffer = "";
    for await (const chunk of stdout) {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          // Claude stream-json emits events with type field
          // Extract text content from assistant messages
          if (event.type === "assistant" && event.message) {
            yield event.message;
          } else if (event.type === "result" && event.result) {
            yield event.result;
          } else if (event.type === "content_block_delta") {
            yield event.delta?.text ?? "";
          }
        } catch {
          // Plain text fallback
          yield line;
        }
      }
    }
    if (buffer.trim()) yield buffer;
  }

  private collectOutput(stdout: Readable): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stdout.on("data", (chunk) => chunks.push(chunk));
      stdout.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      stdout.on("error", reject);
    });
  }
}
```

**Step 2: Verify it compiles**

Run: `npx tsx -e "import { ClaudeBackend } from './src/backends/claude.js'; const b = new ClaudeBackend(); console.log('available:', b.available, 'models:', b.models.length)"`
Expected: `available: true models: 7` (or `available: false` if claude isn't in PATH)

**Step 3: Commit**

```bash
git add src/backends/claude.ts
git commit -m "feat: Claude CLI backend with streaming support"
```

---

### Task 8: OpenAI CLI Backend

**Files:**
- Create: `src/backends/openai.ts`

**Step 1: Implement the OpenAI CLI backend**

OpenAI CLI command: `openai api chat.completions.create -m <model> -g <role> <content> [--stream]`
Output: plain text to stdout (no JSON wrapping).

```typescript
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { Backend, BackendRequest, BackendResult, isInstalled } from "./base.js";

export class OpenAIBackend implements Backend {
  name = "openai";
  models = ["gpt-4o", "gpt-4o-mini", "gpt-4", "gpt-4-turbo", "gpt-3.5-turbo", "o1", "o1-mini", "o3-mini"];
  available = isInstalled("openai");

  async execute(request: BackendRequest): Promise<BackendResult> {
    const args: string[] = ["api", "chat.completions.create", "-m", request.model];

    // Add messages as -g flags
    for (const msg of request.messages) {
      const content = typeof msg.content === "string"
        ? msg.content
        : msg.content.filter(p => p.type === "text").map(p => p.text).join("\n");
      args.push("-g", msg.role, content);
    }

    if (request.stream) {
      args.push("--stream");
    }

    if (request.max_tokens) {
      args.push("-M", String(request.max_tokens));
    }

    if (request.temperature !== undefined) {
      args.push("-t", String(request.temperature));
    }

    const child = spawn("openai", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (request.stream) {
      const stream = this.createStream(child.stdout);
      return { stream, model: request.model };
    } else {
      const text = await this.collectOutput(child.stdout);
      return { text, model: request.model };
    }
  }

  private async *createStream(stdout: Readable): AsyncIterable<string> {
    // OpenAI CLI streams plain text to stdout
    for await (const chunk of stdout) {
      yield chunk.toString();
    }
  }

  private collectOutput(stdout: Readable): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stdout.on("data", (chunk) => chunks.push(chunk));
      stdout.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      stdout.on("error", reject);
    });
  }
}
```

**Step 2: Commit**

```bash
git add src/backends/openai.ts
git commit -m "feat: OpenAI CLI backend with streaming support"
```

---

### Task 9: Backend Router

**Files:**
- Create: `src/backends/router.ts`

**Step 1: Implement model-to-backend routing**

```typescript
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
    // Exact match first
    for (const b of this.backends) {
      if (b.models.includes(model)) return b;
    }
    // Prefix match: anything starting with "claude" -> claude backend, "gpt"/"o1"/"o3" -> openai
    for (const b of this.backends) {
      if (b.name === "claude" && (model.startsWith("claude") || model.startsWith("anthropic"))) return b;
      if (b.name === "openai" && (model.startsWith("gpt") || model.startsWith("o1") || model.startsWith("o3"))) return b;
    }
    // Default to first available
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
```

**Step 2: Commit**

```bash
git add src/backends/router.ts
git commit -m "feat: backend router with model-based routing"
```

---

### Task 10: OpenAI-compatible Route (`/v1/chat/completions`)

**Files:**
- Create: `src/routes/chat-completions.ts`

**Step 1: Implement the OpenAI-compatible chat completions endpoint**

This accepts standard OpenAI API requests and returns responses in OpenAI format.
Supports both streaming (SSE) and non-streaming responses.

```typescript
import { FastifyInstance } from "fastify";
import { BackendRouter } from "../backends/router.js";
import { randomUUID } from "node:crypto";

export function registerChatCompletions(app: FastifyInstance, router: BackendRouter) {
  app.post("/v1/chat/completions", async (request, reply) => {
    const body = request.body as any;
    const model = body.model ?? "claude";
    const messages = body.messages ?? [];
    const stream = body.stream ?? false;

    const result = await router.execute({
      model,
      messages,
      stream,
      max_tokens: body.max_tokens,
      temperature: body.temperature,
      system: body.system,
    });

    if (stream && result.stream) {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const id = "chatcmpl-" + randomUUID().replace(/-/g, "").slice(0, 24);
      const created = Math.floor(Date.now() / 1000);

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

      // Final event with finish_reason
      const finalEvent = {
        id,
        object: "chat.completion.chunk",
        created,
        model: result.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      };
      reply.raw.write(`data: ${JSON.stringify(finalEvent)}\n\n`);
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
      return;
    }

    // Non-streaming response
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
```

**Step 2: Commit**

```bash
git add src/routes/chat-completions.ts
git commit -m "feat: OpenAI-compatible /v1/chat/completions endpoint with SSE streaming"
```

---

### Task 11: Anthropic-compatible Route (`/v1/messages`)

**Files:**
- Create: `src/routes/messages.ts`

**Step 1: Implement the Anthropic-compatible messages endpoint**

```typescript
import { FastifyInstance } from "fastify";
import { BackendRouter } from "../backends/router.js";
import { randomUUID } from "node:crypto";

export function registerMessages(app: FastifyInstance, router: BackendRouter) {
  app.post("/v1/messages", async (request, reply) => {
    const body = request.body as any;
    const model = body.model ?? "claude";
    const messages = body.messages ?? [];
    const stream = body.stream ?? false;
    const system = typeof body.system === "string" ? body.system
      : Array.isArray(body.system) ? body.system.map((b: any) => b.text).join("\n")
      : undefined;

    const result = await router.execute({
      model,
      messages,
      stream,
      max_tokens: body.max_tokens,
      temperature: body.temperature,
      system,
    });

    const msgId = "msg_" + randomUUID().replace(/-/g, "").slice(0, 24);

    if (stream && result.stream) {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      // message_start
      reply.raw.write(`event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: msgId, type: "message", role: "assistant", content: [],
          model: result.model, stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })}\n\n`);

      // content_block_start
      reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })}\n\n`);

      for await (const chunk of result.stream) {
        if (!chunk) continue;
        reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: chunk },
        })}\n\n`);
      }

      // content_block_stop
      reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({
        type: "content_block_stop", index: 0,
      })}\n\n`);

      // message_delta
      reply.raw.write(`event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 0 },
      })}\n\n`);

      // message_stop
      reply.raw.write(`event: message_stop\ndata: ${JSON.stringify({
        type: "message_stop",
      })}\n\n`);

      reply.raw.end();
      return;
    }

    // Non-streaming
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
```

**Step 2: Commit**

```bash
git add src/routes/messages.ts
git commit -m "feat: Anthropic-compatible /v1/messages endpoint with SSE streaming"
```

---

### Task 12: Models Route

**Files:**
- Create: `src/routes/models.ts`

**Step 1: Implement the models listing endpoint**

```typescript
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
```

**Step 2: Commit**

```bash
git add src/routes/models.ts
git commit -m "feat: /v1/models endpoint listing available backends"
```

---

### Task 13: Fastify Server Assembly

**Files:**
- Create: `src/server.ts`

**Step 1: Assemble the Fastify server with all middleware and routes**

```typescript
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
    logger: false,
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
```

**Step 2: Commit**

```bash
git add src/server.ts
git commit -m "feat: Fastify server assembly with auth, rate limiting, CORS, and all routes"
```

---

### Task 14: ngrok Tunnel Manager

**Files:**
- Create: `src/tunnel/ngrok.ts`

**Step 1: Implement ngrok tunnel management**

```typescript
import ngrok from "@ngrok/ngrok";

export interface TunnelInfo {
  url: string;
}

let currentListener: Awaited<ReturnType<typeof ngrok.forward>> | null = null;

export async function startTunnel(port: number): Promise<TunnelInfo> {
  currentListener = await ngrok.forward({
    addr: port,
    authtoken_from_env: true,
  });
  const url = currentListener.url();
  if (!url) throw new Error("Failed to get tunnel URL");
  return { url };
}

export async function restartTunnel(port: number): Promise<TunnelInfo> {
  await stopTunnel();
  return startTunnel(port);
}

export async function stopTunnel(): Promise<void> {
  if (currentListener) {
    await currentListener.close();
    currentListener = null;
  }
}
```

**Step 2: Commit**

```bash
git add src/tunnel/ngrok.ts
git commit -m "feat: ngrok tunnel manager with start/restart/stop"
```

---

### Task 15: CLI Entry Point

**Files:**
- Modify: `src/index.ts` (replace the placeholder)

**Step 1: Implement the full CLI interface**

This is the main entry point that ties everything together: detects backends, starts server,
optionally starts ngrok, displays the dashboard, handles keyboard shortcuts.

```typescript
#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, saveConfig } from "./config/store.js";
import { generateApiKey } from "./auth/keys.js";
import { startServer } from "./server.js";
import { startTunnel, restartTunnel, stopTunnel } from "./tunnel/ngrok.js";
import { BackendRouter } from "./backends/router.js";

const program = new Command();

program
  .name("api-tunnel")
  .description("Turn your AI CLI subscriptions into API endpoints")
  .version("1.0.0")
  .option("-p, --port <number>", "Server port", "3456")
  .option("--no-tunnel", "Skip ngrok tunnel")
  .option("--cors-origin <origin>", "CORS allowed origin", "*")
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const config = loadConfig();

    // Generate API key if none exists
    let plaintextKey: string;
    if (!config.apiKeyHash) {
      const key = generateApiKey();
      config.apiKeyHash = key.hash;
      config.port = port;
      saveConfig(config);
      plaintextKey = key.plaintext;
    } else {
      // Show that we have an existing key, offer to regenerate
      plaintextKey = "(existing key — press 'r' to regenerate)";
    }

    console.log();
    console.log(chalk.bold(`  api-tunnel v1.0.0`));
    console.log();

    // Detect backends
    const router = new BackendRouter();
    const backends = router.getAvailableBackends();
    console.log("  Backends detected:");
    if (backends.length === 0) {
      console.log(chalk.red("    ✗ No backends found. Install claude or openai CLI."));
      process.exit(1);
    }
    for (const b of backends) {
      console.log(chalk.green(`    ✓ ${b.name}`) + ` (${b.models.length} models)`);
    }
    console.log();

    // Start server
    const { app } = await startServer({
      port,
      host: "127.0.0.1",
      getKeyHash: () => config.apiKeyHash,
      corsOrigin: opts.corsOrigin,
    });

    console.log(`  Local server:   ${chalk.cyan(`http://localhost:${port}`)}`);

    // Start tunnel
    let tunnelUrl: string | null = null;
    if (opts.tunnel !== false) {
      try {
        const tunnel = await startTunnel(port);
        tunnelUrl = tunnel.url;
        console.log(`  Tunnel (ngrok): ${chalk.cyan(tunnelUrl)}`);
      } catch (err: any) {
        console.log(chalk.yellow(`  Tunnel: ${err.message}`));
        console.log(chalk.yellow("  Set NGROK_AUTHTOKEN or run with --no-tunnel"));
      }
    } else {
      console.log(chalk.dim("  Tunnel: disabled (use --tunnel to enable)"));
    }
    console.log();

    // Show API key
    console.log(`  API Key: ${chalk.green(plaintextKey)}`);
    console.log();

    // Show usage
    const baseUrl = tunnelUrl ?? `http://localhost:${port}`;
    console.log("  Use these in your app:");
    console.log(`    Base URL:  ${chalk.cyan(baseUrl)}`);
    console.log(`    API Key:   ${chalk.green(plaintextKey)}`);
    console.log();

    console.log("  Endpoints:");
    console.log(`    POST /v1/chat/completions   ${chalk.dim("(OpenAI format)")}`);
    console.log(`    POST /v1/messages           ${chalk.dim("(Anthropic format)")}`);
    console.log(`    GET  /v1/models             ${chalk.dim("(list backends)")}`);
    console.log();

    console.log(chalk.dim("  Press 'r' to regenerate API key"));
    if (tunnelUrl) console.log(chalk.dim("  Press 'n' to restart ngrok tunnel"));
    console.log(chalk.dim("  Press 'q' to quit"));
    console.log();

    // Handle keyboard input
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", async (key: string) => {
        if (key === "q" || key === "\u0003") {
          // q or Ctrl+C
          console.log("\n  Shutting down...");
          await stopTunnel();
          await app.close();
          process.exit(0);
        }

        if (key === "r") {
          const newKey = generateApiKey();
          config.apiKeyHash = newKey.hash;
          saveConfig(config);
          console.log(`\n  ${chalk.green("✓")} New API Key: ${chalk.green(newKey.plaintext)}\n`);
        }

        if (key === "n" && opts.tunnel !== false) {
          console.log(`\n  Restarting tunnel...`);
          try {
            const tunnel = await restartTunnel(port);
            tunnelUrl = tunnel.url;
            console.log(`  ${chalk.green("✓")} New tunnel: ${chalk.cyan(tunnelUrl)}\n`);
          } catch (err: any) {
            console.log(`  ${chalk.red("✗")} ${err.message}\n`);
          }
        }
      });
    }
  });

program.parse();
```

**Step 2: Verify it runs**

Run: `npm run dev -- --no-tunnel`
Expected: Server starts, shows detected backends, shows API key, listens on port 3456.

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: CLI entry point with dashboard display and keyboard shortcuts"
```

---

### Task 16: End-to-End Smoke Test

**Step 1: Start the server**

Run in one terminal:
```bash
npm run dev -- --no-tunnel
```

**Step 2: Test health endpoint**

```bash
curl http://localhost:3456/health
```
Expected: `{"status":"ok"}`

**Step 3: Test auth rejection**

```bash
curl -s http://localhost:3456/v1/models | head
```
Expected: `{"error":{"message":"Missing or invalid Authorization header","type":"auth_error"}}`

**Step 4: Test models endpoint**

```bash
curl -s -H "Authorization: Bearer <key>" http://localhost:3456/v1/models
```
Expected: JSON with list of available models

**Step 5: Test chat completions (non-streaming)**

```bash
curl -s -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <key>" \
  -d '{"model":"claude","messages":[{"role":"user","content":"Say hello in 5 words"}]}'
```
Expected: OpenAI-format response with assistant message

**Step 6: Test chat completions (streaming)**

```bash
curl -s -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <key>" \
  -d '{"model":"claude","messages":[{"role":"user","content":"Say hello in 5 words"}],"stream":true}'
```
Expected: SSE stream of `data: {...}` events ending with `data: [DONE]`

**Step 7: Test messages endpoint (Anthropic format)**

```bash
curl -s -X POST http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <key>" \
  -d '{"model":"claude","messages":[{"role":"user","content":"Say hello in 5 words"}]}'
```
Expected: Anthropic-format response

**Step 8: Fix any issues found during testing**

**Step 9: Commit**

```bash
git commit -m "fix: adjustments from smoke testing"
```

---

### Task 17: gitignore and Cleanup

**Files:**
- Create: `.gitignore`

**Step 1: Create .gitignore**

```
node_modules/
dist/
*.log
.env
```

**Step 2: Commit**

```bash
git add .gitignore
git commit -m "chore: add .gitignore"
```
