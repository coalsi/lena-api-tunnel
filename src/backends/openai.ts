import { spawn, ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import { Backend, BackendRequest, BackendResult, isInstalled, collectStderr } from "./base.js";

const SUBPROCESS_TIMEOUT_MS = 60_000; // 1 minute

export class OpenAIBackend implements Backend {
  name = "openai";
  models = ["gpt-4o", "gpt-4o-mini", "gpt-4", "gpt-4-turbo", "gpt-3.5-turbo", "o1", "o1-mini", "o3-mini"];
  available = isInstalled("openai");

  async execute(request: BackendRequest): Promise<BackendResult> {
    const args: string[] = ["api", "chat.completions.create", "-m", request.model];

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

    console.log(`  [openai] Spawning: openai ${args.slice(0, 6).join(" ")}...`);

    const child = spawn("openai", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    console.log(`  [openai] PID ${child.pid} spawned`);

    const timeout = setTimeout(() => {
      console.log(`  [openai] PID ${child.pid} timed out after ${SUBPROCESS_TIMEOUT_MS / 1000}s, killing`);
      child.kill("SIGKILL");
    }, SUBPROCESS_TIMEOUT_MS);

    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      console.log(`  [openai] PID ${child.pid} exited (code=${code}, signal=${signal})`);
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      console.log(`  [openai] PID ${child.pid} spawn error: ${err.message}`);
    });

    if (request.stream) {
      const stream = this.createStream(child, timeout);
      return { stream, model: request.model };
    } else {
      const [text, stderr, exitCode] = await Promise.all([
        this.collectOutput(child.stdout!),
        collectStderr(child),
        new Promise<number | null>((resolve) => child.on("exit", resolve)),
      ]);
      clearTimeout(timeout);

      if (stderr.trim()) {
        console.log(`  [openai] stderr: ${stderr.trim()}`);
      }

      if (exitCode !== 0) {
        const errMsg = stderr.trim() || `openai CLI exited with code ${exitCode}`;
        console.log(`  [openai] ERROR: ${errMsg}`);
        throw new Error(errMsg);
      }

      if (!text.trim()) {
        const errMsg = "openai CLI returned empty output" + (stderr ? `: ${stderr.trim()}` : "");
        console.log(`  [openai] ERROR: ${errMsg}`);
        throw new Error(errMsg);
      }

      console.log(`  [openai] Success: ${text.trim().slice(0, 100)}...`);
      return { text, model: request.model };
    }
  }

  private async *createStream(child: ChildProcess, timeout: NodeJS.Timeout): AsyncIterable<string> {
    if (!child.stdout) return;
    try {
      for await (const chunk of child.stdout) {
        yield chunk.toString();
      }
    } finally {
      clearTimeout(timeout);
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
