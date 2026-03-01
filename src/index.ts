#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "node:readline/promises";
import { loadConfig, saveConfig } from "./config/store.js";
import { generateApiKey } from "./auth/keys.js";
import { startServer } from "./server.js";
import { startTunnel, restartTunnel, stopTunnel } from "./tunnel/ngrok.js";
import { BackendRouter } from "./backends/router.js";
import { installService, uninstallService, getServiceStatus, getServiceLogs } from "./service.js";

async function promptInput(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

const program = new Command();

program
  .name("lena-api-tunnel")
  .description("Turn your AI CLI subscriptions into API endpoints")
  .version("1.0.0")
  .option("-p, --port <number>", "Server port", "3456")
  .option("--no-tunnel", "Skip ngrok tunnel")
  .option("--cors-origin <origin>", "CORS allowed origin", "*")
  .option("--ngrok-token <token>", "Save ngrok authtoken for future use")
  .option("--reset", "Reset all configuration (API key, ngrok token)")
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    let config = loadConfig();

    // Reset config if requested
    if (opts.reset) {
      config = { apiKeyHash: "", port: 3456 };
      saveConfig(config);
      console.log(chalk.green("\n  Configuration reset.\n"));
    }

    // Save ngrok token if provided via flag
    if (opts.ngrokToken) {
      config.ngrokAuthtoken = opts.ngrokToken;
      saveConfig(config);
    }

    // First-run setup: prompt for ngrok token if tunneling is enabled and no token exists
    const hasNgrokToken = config.ngrokAuthtoken ?? process.env.NGROK_AUTHTOKEN;
    if (opts.tunnel !== false && !hasNgrokToken && !opts.ngrokToken) {
      console.log();
      console.log(chalk.bold("  First-time setup"));
      console.log();
      console.log("  To expose your API over the internet, lena-api-tunnel uses ngrok.");
      console.log("  Get a free authtoken at: " + chalk.cyan("https://dashboard.ngrok.com/get-started/your-authtoken"));
      console.log();
      const token = await promptInput("  Enter your ngrok authtoken (or press Enter to skip): ");
      if (token) {
        config.ngrokAuthtoken = token;
        saveConfig(config);
        console.log(chalk.green("  Token saved."));
      } else {
        console.log(chalk.dim("  Skipped — running without tunnel (local only)."));
        opts.tunnel = false;
      }
      console.log();
    }

    // Resolve ngrok token: CLI flag > config > env var
    const ngrokToken = opts.ngrokToken ?? config.ngrokAuthtoken ?? process.env.NGROK_AUTHTOKEN;

    // Generate API key if none exists
    let plaintextKey: string;
    if (!config.apiKeyHash) {
      const key = generateApiKey();
      config.apiKeyHash = key.hash;
      config.port = port;
      saveConfig(config);
      plaintextKey = key.plaintext;
    } else {
      plaintextKey = "(existing key — press 'r' to regenerate)";
    }

    console.log();
    console.log(chalk.bold(`  lena-api-tunnel v1.0.0`));
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
        const tunnel = await startTunnel(port, ngrokToken);
        tunnelUrl = tunnel.url;
        console.log(`  Tunnel (ngrok): ${chalk.cyan(tunnelUrl)}`);
      } catch (err: any) {
        console.log(chalk.yellow(`  Tunnel: ${err.message}`));
        console.log(chalk.yellow("  Run: api-tunnel --ngrok-token <your-token>"));
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
            const tunnel = await restartTunnel(port, ngrokToken);
            tunnelUrl = tunnel.url;
            console.log(`  ${chalk.green("✓")} New tunnel: ${chalk.cyan(tunnelUrl)}\n`);
          } catch (err: any) {
            console.log(`  ${chalk.red("✗")} ${err.message}\n`);
          }
        }
      });
    }
  });

program
  .command("start")
  .description("Start lena-api-tunnel as a background service (survives terminal close, auto-restarts)")
  .option("-p, --port <number>", "Server port", "3456")
  .option("--no-tunnel", "Skip ngrok tunnel")
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const config = loadConfig();

    // Ensure ngrok token exists if tunnel is enabled
    const ngrokToken = config.ngrokAuthtoken ?? process.env.NGROK_AUTHTOKEN;
    if (opts.tunnel !== false && !ngrokToken) {
      console.log(chalk.yellow("\n  No ngrok token configured. Run `lena-api-tunnel` first to set one up.\n"));
      process.exit(1);
    }

    // Ensure API key exists
    if (!config.apiKeyHash) {
      const key = generateApiKey();
      config.apiKeyHash = key.hash;
      config.port = port;
      saveConfig(config);
      console.log(`\n  Generated API key: ${chalk.green(key.plaintext)}`);
      console.log(chalk.dim("  (save this — it won't be shown again)\n"));
    }

    try {
      installService(port, opts.tunnel === false);
      console.log(chalk.green("\n  Service started."));
      console.log(`  Port: ${port}`);
      console.log(`  Tunnel: ${opts.tunnel !== false ? "enabled" : "disabled"}`);
      console.log(chalk.dim("\n  Runs on login, auto-restarts on crash."));
      console.log(chalk.dim("  Use `lena-api-tunnel status` to check."));
      console.log(chalk.dim("  Use `lena-api-tunnel stop` to stop.\n"));
    } catch (err: any) {
      console.log(chalk.red(`\n  Failed to start service: ${err.message}\n`));
      process.exit(1);
    }
  });

program
  .command("stop")
  .description("Stop the background service")
  .action(() => {
    const status = getServiceStatus();
    if (!status.installed) {
      console.log(chalk.yellow("\n  Service is not installed. Nothing to stop.\n"));
      return;
    }
    uninstallService();
    console.log(chalk.green("\n  Service stopped and uninstalled.\n"));
  });

program
  .command("status")
  .description("Check if the background service is running")
  .action(async () => {
    const status = getServiceStatus();
    const config = loadConfig();
    console.log();
    if (!status.installed) {
      console.log("  Service: " + chalk.dim("not installed"));
      console.log(chalk.dim("  Run `lena-api-tunnel start` to install as a background service."));
    } else if (status.running) {
      console.log("  Service: " + chalk.green("running") + (status.pid ? ` (PID ${status.pid})` : ""));
      console.log(`  Port:    ${config.port}`);

      // Check if server is actually responding
      try {
        const res = await fetch(`http://localhost:${config.port}/health`);
        const data = await res.json() as any;
        if (data.status === "ok") {
          console.log("  Health:  " + chalk.green("ok"));
        }
      } catch {
        console.log("  Health:  " + chalk.yellow("not responding (may still be starting)"));
      }
    } else {
      console.log("  Service: " + chalk.yellow("installed but not running"));
      console.log(chalk.dim("  Try `lena-api-tunnel stop` then `lena-api-tunnel start` to restart."));
    }
    console.log();
  });

program
  .command("logs")
  .description("Show recent service logs")
  .option("-n, --lines <number>", "Number of lines to show", "30")
  .action((opts) => {
    const lines = parseInt(opts.lines, 10);
    const logs = getServiceLogs(lines);
    console.log(logs);
  });

program.parse();
