import { spawn, ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import { Backend, BackendRequest, BackendResult, isInstalled, collectStderr } from "./base.js";

const SUBPROCESS_TIMEOUT_MS = 60_000; // 1 minute

function extractTextContent(messages: BackendRequest["messages"]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const prefix = msg.role === "system" ? "[System] " : msg.role === "assistant" ? "[Assistant] " : "";
    if (typeof msg.content === "string") {
      parts.push(prefix + msg.content);
    } else {
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

    const cliModel = this.resolveCliModel(request.model);
    if (cliModel) {
      args.push("--model", cliModel);
    }

    const systemPrompt = request.system ?? extractSystemPrompt(request.messages);
    if (systemPrompt) {
      args.push("--system-prompt", systemPrompt);
    }

    const prompt = extractTextContent(extractUserMessages(request.messages));

    // Strip all Claude Code session env vars to avoid nested session issues
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE;
    delete env.CLAUDE_CODE_ENTRY;
    delete env.CLAUDE_CODE_SESSION;
    delete env.CLAUDE_CODE_MODULE;
    delete env.CLAUDE_PARENT_SESSION_ID;

    console.log(`  [claude] Spawning: claude ${args.join(" ")} "${prompt.slice(0, 50)}..."`);

    const child = spawn("claude", [...args, prompt], {
      stdio: ["ignore", "pipe", "pipe"],  // stdin = ignore (critical — prevents hang)
      env,
    });

    console.log(`  [claude] PID ${child.pid} spawned`);

    // Set up timeout
    const timeout = setTimeout(() => {
      console.log(`  [claude] PID ${child.pid} timed out after ${SUBPROCESS_TIMEOUT_MS / 1000}s, killing`);
      child.kill("SIGKILL");
    }, SUBPROCESS_TIMEOUT_MS);

    // Log when process exits
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      console.log(`  [claude] PID ${child.pid} exited (code=${code}, signal=${signal})`);
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      console.log(`  [claude] PID ${child.pid} spawn error: ${err.message}`);
    });

    if (request.stream) {
      const stream = this.createStream(child, timeout);
      return { stream, model: request.model || "claude" };
    } else {
      const [text, stderr, exitCode] = await Promise.all([
        this.collectOutput(child.stdout!),
        collectStderr(child),
        new Promise<number | null>((resolve) => child.on("exit", resolve)),
      ]);
      clearTimeout(timeout);

      if (stderr.trim()) {
        console.log(`  [claude] stderr: ${stderr.trim()}`);
      }

      if (exitCode !== 0) {
        const errMsg = stderr.trim() || `claude CLI exited with code ${exitCode}`;
        console.log(`  [claude] ERROR: ${errMsg}`);
        throw new Error(errMsg);
      }

      if (!text.trim()) {
        const errMsg = "claude CLI returned empty output" + (stderr ? `: ${stderr.trim()}` : "");
        console.log(`  [claude] ERROR: ${errMsg}`);
        throw new Error(errMsg);
      }

      console.log(`  [claude] Success: ${text.trim().slice(0, 100)}...`);
      return { text, model: request.model || "claude" };
    }
  }

  // Map any model string to a valid Claude CLI --model value
  private resolveCliModel(model?: string): string | undefined {
    if (!model || model === "claude") return undefined; // default model

    // Known short names the CLI accepts directly
    const CLI_MODELS: Record<string, string> = {
      "claude-sonnet": "sonnet",
      "claude-opus": "opus",
      "claude-haiku": "haiku",
      "claude-sonnet-4-6": "sonnet",
      "claude-opus-4-6": "opus",
      "claude-haiku-4-5": "haiku",
    };

    if (CLI_MODELS[model]) return CLI_MODELS[model];

    // Handle full API model names like "claude-sonnet-4-20250514" or "claude-3-5-sonnet-20241022"
    if (model.includes("opus")) return "opus";
    if (model.includes("haiku")) return "haiku";
    if (model.includes("sonnet")) return "sonnet";

    // Fallback: strip "claude-" prefix and hope for the best
    return model.replace("claude-", "");
  }

  private async *createStream(child: ChildProcess, timeout: NodeJS.Timeout): AsyncIterable<string> {
    if (!child.stdout) return;
    let buffer = "";
    let hasOutput = false;

    try {
      for await (const chunk of child.stdout) {
        hasOutput = true;
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "assistant" && event.message) {
              yield event.message;
            } else if (event.type === "result" && event.result) {
              yield event.result;
            } else if (event.type === "content_block_delta") {
              yield event.delta?.text ?? "";
            }
          } catch {
            yield line;
          }
        }
      }
      if (buffer.trim()) yield buffer;
    } finally {
      clearTimeout(timeout);
    }

    if (!hasOutput) {
      const stderr = await collectStderr(child);
      throw new Error("claude CLI produced no output" + (stderr ? `: ${stderr.trim()}` : ""));
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
