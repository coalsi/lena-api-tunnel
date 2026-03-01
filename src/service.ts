import { execSync, spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { CONFIG_DIR } from "./config/store.js";

const LABEL = "com.lena.api-tunnel";
const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG_PATH = join(CONFIG_DIR, "service.log");
const ERROR_LOG_PATH = join(CONFIG_DIR, "service-error.log");

function getNodePath(): string {
  try {
    return execSync("which node", { encoding: "utf-8" }).trim();
  } catch {
    return "/usr/local/bin/node";
  }
}

function getScriptPath(): string {
  // Find the installed dist/index.js
  // When installed globally, __filename points to dist/service.js
  // The entry point is dist/index.js in the same directory
  const distDir = new URL(".", import.meta.url).pathname;
  const indexPath = join(distDir, "index.js");
  if (existsSync(indexPath)) return indexPath;

  // Fallback: resolve from npm global
  try {
    const globalPrefix = execSync("npm prefix -g", { encoding: "utf-8" }).trim();
    const globalScript = join(globalPrefix, "lib", "node_modules", "lena-api-tunnel", "dist", "index.js");
    if (existsSync(globalScript)) return globalScript;
  } catch { /* ignore */ }

  throw new Error("Cannot find lena-api-tunnel entry point. Is it installed globally?");
}

function generatePlist(port: number, noTunnel: boolean): string {
  const nodePath = getNodePath();
  const scriptPath = getScriptPath();
  const args = [nodePath, scriptPath];
  if (noTunnel) args.push("--no-tunnel");
  args.push("--port", String(port));

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(a => `    <string>${a}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${ERROR_LOG_PATH}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH}</string>
    <key>HOME</key>
    <string>${homedir()}</string>
  </dict>
</dict>
</plist>`;
}

export function installService(port: number, noTunnel: boolean): void {
  // Stop existing service if running
  if (isServiceRunning()) {
    stopService();
  }

  const plist = generatePlist(port, noTunnel);
  writeFileSync(PLIST_PATH, plist);

  const result = spawnSync("launchctl", ["load", "-w", PLIST_PATH], { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`Failed to load service: ${result.stderr}`);
  }
}

export function stopService(): void {
  if (existsSync(PLIST_PATH)) {
    spawnSync("launchctl", ["unload", PLIST_PATH], { encoding: "utf-8" });
  }
}

export function uninstallService(): void {
  stopService();
  if (existsSync(PLIST_PATH)) {
    unlinkSync(PLIST_PATH);
  }
}

export function isServiceInstalled(): boolean {
  return existsSync(PLIST_PATH);
}

export function isServiceRunning(): boolean {
  const result = spawnSync("launchctl", ["list", LABEL], { encoding: "utf-8" });
  return result.status === 0;
}

export function getServiceStatus(): { installed: boolean; running: boolean; pid?: number } {
  const installed = isServiceInstalled();
  if (!installed) return { installed: false, running: false };

  const result = spawnSync("launchctl", ["list", LABEL], { encoding: "utf-8" });
  if (result.status !== 0) return { installed: true, running: false };

  // Parse PID from launchctl list output
  const match = result.stdout.match(/"PID"\s*=\s*(\d+)/);
  const pid = match ? parseInt(match[1], 10) : undefined;
  return { installed: true, running: pid !== undefined, pid };
}

export function getServiceLogs(lines: number = 20): string {
  if (!existsSync(LOG_PATH)) return "(no logs yet)";
  const content = readFileSync(LOG_PATH, "utf-8");
  const allLines = content.split("\n");
  return allLines.slice(-lines).join("\n");
}
