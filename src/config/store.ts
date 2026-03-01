import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface Config {
  apiKeyHash: string;     // SHA-256 hash of the API key
  port: number;
  ngrokAuthtoken?: string;
}

export const CONFIG_DIR = join(homedir(), ".api-tunnel");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

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
