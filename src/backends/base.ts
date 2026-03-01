import { execSync, ChildProcess } from "node:child_process";

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

/** Collect all stderr output from a child process */
export function collectStderr(child: ChildProcess): Promise<string> {
  return new Promise((resolve) => {
    if (!child.stderr) { resolve(""); return; }
    const chunks: Buffer[] = [];
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    child.stderr.on("error", () => resolve(""));
  });
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
