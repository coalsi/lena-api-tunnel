# lena-api-tunnel

Turn your AI CLI subscriptions into standard API endpoints.

If you have a Claude Pro/Max subscription or OpenAI Plus, you already have access to the best AI models through their CLI tools. **lena-api-tunnel** lets you use those subscriptions as if they were API keys — so any app, service, or tool that expects an OpenAI or Anthropic API can use your existing CLI subscription instead.

## The Problem

You're building apps that need AI. The official APIs charge per-token. But you already pay for unlimited (or generous) usage through Claude Pro Max or OpenAI Plus. Those subscriptions come with CLI tools (`claude`, `openai`) that work great in a terminal — but your apps need an HTTP API, not a CLI.

## The Solution

Run `lena-api-tunnel` on your machine. It starts a local HTTP server that speaks the standard OpenAI and Anthropic API formats, translates incoming requests into CLI commands, and streams the responses back. Optionally, it opens an ngrok tunnel so you can use it from anywhere — not just localhost.

Your apps don't know the difference. They think they're talking to the real OpenAI/Anthropic API.

```
Your App                                     Your CLI Subscription
   |                                                |
   |  POST /v1/chat/completions                     |
   |  Authorization: Bearer at_sk_...               |
   v                                                v
+---------------------------------------------------+
|              lena-api-tunnel                       |
|                                                   |
|  Translates API requests -> CLI commands           |
|  Streams responses back as SSE                    |
|  Handles auth, rate limiting, CORS                |
+---------------------------------------------------+
   |                          |
   v                          v
 claude -p "..."       openai api chat ...
```

## Quick Start

### Prerequisites

- **Node.js 20+**
- At least one AI CLI installed:
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`) — requires Claude Pro/Max subscription
  - [OpenAI CLI](https://github.com/openai/openai-python) (`pip install openai`) — requires OpenAI Plus/API access
- **ngrok account** (free) for remote access — [sign up here](https://dashboard.ngrok.com/signup)

### Install

```bash
npm install -g lena-api-tunnel
```

Or run directly from the repo:

```bash
git clone https://github.com/coalsi/lena-api-tunnel.git
cd lena-api-tunnel
npm install
npm run dev
```

### Run

```bash
lena-api-tunnel
```

On first run, it will:
1. Ask for your ngrok authtoken (for remote access — press Enter to skip)
2. Auto-detect which AI CLIs you have installed
3. Generate a secure API key
4. Start the server and display your connection details

```
  lena-api-tunnel v1.0.0

  Backends detected:
    ✓ claude (7 models)
    ✓ openai (8 models)

  Local server:   http://localhost:3456
  Tunnel (ngrok): https://abc123.ngrok-free.app

  API Key: at_sk_7f3a...9e2b

  Use these in your app:
    Base URL:  https://abc123.ngrok-free.app
    API Key:   at_sk_7f3a...9e2b

  Endpoints:
    POST /v1/chat/completions   (OpenAI format)
    POST /v1/messages           (Anthropic format)
    GET  /v1/models             (list backends)

  Press 'r' to regenerate API key
  Press 'n' to restart ngrok tunnel
  Press 'q' to quit
```

### Use It

Copy the **Base URL** and **API Key** into any app that asks for an OpenAI or Anthropic API configuration.

## API Endpoints

### `POST /v1/chat/completions` — OpenAI Format

Compatible with any app or library that uses the OpenAI API.

```bash
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "claude",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### `POST /v1/messages` — Anthropic Format

Compatible with any app or library that uses the Anthropic API.

```bash
curl -X POST http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "claude",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### `GET /v1/models` — List Available Models

Returns all models available through your installed CLIs.

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" http://localhost:3456/v1/models
```

## Model Routing

The `model` field in your request determines which CLI backend handles it:

| Model value | Backend | CLI command |
|---|---|---|
| `claude`, `claude-sonnet`, `claude-opus`, `claude-haiku` | Claude CLI | `claude -p` |
| `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-haiku-4-5` | Claude CLI | `claude -p --model ...` |
| `gpt-4o`, `gpt-4o-mini`, `gpt-4`, `gpt-4-turbo` | OpenAI CLI | `openai api chat.completions.create` |
| `gpt-3.5-turbo`, `o1`, `o1-mini`, `o3-mini` | OpenAI CLI | `openai api chat.completions.create` |

## Background Service

By default, `lena-api-tunnel` runs in the foreground — close the terminal and it stops. To keep it running permanently (survives terminal close, auto-restarts on crash, starts on login), use the service commands:

```bash
# Start as a background service
lena-api-tunnel start

# Check if it's running
lena-api-tunnel status

# View recent logs
lena-api-tunnel logs

# Stop the service
lena-api-tunnel stop
```

The service uses macOS `launchd` under the hood. Once started, it will:
- Run on login automatically
- Restart if it crashes
- Keep the ngrok tunnel alive

Logs are stored at `~/.api-tunnel/service.log`.

> **Note:** Run `lena-api-tunnel` (foreground) at least once before using `start`, so your ngrok token and API key are configured.

## CLI Options

### Foreground mode (interactive)

```
lena-api-tunnel [options]

Options:
  -p, --port <number>       Server port (default: 3456)
  --no-tunnel               Run locally only, skip ngrok
  --cors-origin <origin>    Set CORS allowed origin (default: *)
  --ngrok-token <token>     Save your ngrok authtoken
  --reset                   Reset all configuration
  -v, --version             Show version
  -h, --help                Show help
```

### Keyboard Shortcuts (while running in foreground)

| Key | Action |
|---|---|
| `r` | Regenerate API key |
| `n` | Restart ngrok tunnel (new URL) |
| `q` | Quit |

### Service commands

```
lena-api-tunnel start [options]    Start as a background service
  -p, --port <number>              Server port (default: 3456)
  --no-tunnel                      Skip ngrok tunnel

lena-api-tunnel stop               Stop the background service

lena-api-tunnel status             Check if the service is running

lena-api-tunnel logs [options]     Show recent service logs
  -n, --lines <number>             Number of lines to show (default: 30)
```

## Use Cases

### Use your Claude subscription in any OpenAI-compatible app

Many tools and libraries are built for OpenAI's API. With lena-api-tunnel, point them at your tunnel URL and they'll use your Claude subscription instead.

### Build apps without paying per-token API costs

If you're prototyping or building internal tools, you can use your existing CLI subscription instead of paying for API usage. Just run lena-api-tunnel on your machine and point your app at it.

### Access your AI from anywhere

With the ngrok tunnel, your local AI subscription becomes accessible from any device. Run it on your home computer and use it from your phone, a server, or a friend's machine.

### Test AI integrations locally

Developing an app that calls OpenAI or Anthropic? Use lena-api-tunnel as a local development server. No API key management, no usage costs, immediate access.

## Security

- **API keys** are 256-bit cryptographically random, hashed with SHA-256 before storage, and compared in constant time
- **Server binds to 127.0.0.1 only** — not accessible on your network without the ngrok tunnel
- **ngrok handles TLS** for all remote connections
- **Rate limiting** (10 requests/minute default) prevents abuse
- **No shell injection** — all CLI commands use `child_process.spawn()` with argument arrays, never string concatenation
- **Config file** (`~/.api-tunnel/config.json`) is created with `0600` permissions (owner read/write only)
- **No secrets in source code** — your ngrok token and API keys are stored locally, never committed

## Configuration

All config is stored in `~/.api-tunnel/config.json`:

```json
{
  "apiKeyHash": "sha256-hash-of-your-api-key",
  "port": 3456,
  "ngrokAuthtoken": "your-ngrok-token"
}
```

To reset everything: `lena-api-tunnel --reset`

## How It Works

1. Your app sends a standard API request to lena-api-tunnel
2. The auth middleware validates your API key
3. The request router picks the right CLI backend based on the model name
4. The backend spawns the CLI as a subprocess (`claude -p` or `openai api chat.completions.create`)
5. The CLI handles authentication with your subscription
6. The response is streamed back as Server-Sent Events in the correct API format (OpenAI or Anthropic)

The ~50ms overhead of spawning a subprocess is negligible compared to LLM inference time.

## Project Structure

```
src/
  index.ts              CLI entry point, dashboard, keyboard shortcuts
  server.ts             Fastify HTTP server assembly
  auth/
    keys.ts             API key generation, hashing, validation
    middleware.ts        Bearer token auth middleware
  backends/
    base.ts             Backend interface and types
    claude.ts           Claude CLI subprocess backend
    openai.ts           OpenAI CLI subprocess backend
    router.ts           Model-to-backend routing
  routes/
    chat-completions.ts OpenAI-compatible /v1/chat/completions
    messages.ts         Anthropic-compatible /v1/messages
    models.ts           /v1/models listing
  tunnel/
    ngrok.ts            ngrok tunnel management
  config/
    store.ts            ~/.api-tunnel/config.json management
  utils/
    rate-limit.ts       Token bucket rate limiter
```

## Disclaimer

This tool is designed for **local development and prototyping** — running on your own machine, testing your own apps, and building projects without managing separate API keys.

It is **your responsibility** to ensure your use of this tool complies with the terms of service of the underlying AI providers (Anthropic, OpenAI, etc.). Routing CLI subscriptions through a proxy may violate provider TOS depending on how it's used — for example, sharing access with others or using it for production workloads.

The authors of this tool are not responsible for how you use it. Use at your own risk.

## License

ISC
