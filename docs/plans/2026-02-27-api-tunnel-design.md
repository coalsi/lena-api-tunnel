# API Tunnel Design

**Date:** 2026-02-27
**Status:** Approved

## Purpose

A local proxy that turns CLI AI subscriptions (Claude Pro Max, OpenAI Plus) into standard API endpoints. Users run `api-tunnel` on their machine, which starts an HTTP server, optionally creates an ngrok tunnel, and generates an API key. Any app expecting an OpenAI or Anthropic API can then use the tunnel URL + generated key instead of a paid API key.

## Architecture

```
User's App/Service
        |
        | HTTPS (ngrok tunnel) or HTTP (localhost)
        | Authorization: Bearer <generated-api-key>
        v
+------------------+
|  api-tunnel      |  Node.js / TypeScript
|  Fastify Server  |
|                  |
|  /v1/chat/completions  (OpenAI format)
|  /v1/messages          (Anthropic format)
|  /v1/models            (list backends)
|                  |
|  Auth Middleware  |  validates API keys
|  Rate Limiter    |  prevents abuse
|  Request Router  |  picks backend
|                  |
|  CLI Backends    |
|  ├── claude --print    (subprocess)
|  └── openai chat       (subprocess)
+------------------+
        |
        | ngrok tunnel (optional)
        v
   https://xxxx.ngrok-free.app
```

### Approach

CLI Subprocess Bridge — spawn `claude` or `openai` CLI as child processes for each request. The CLI handles auth, streaming, and capabilities. We translate HTTP requests into CLI invocations and stream output back. The ~50ms process spawn overhead is negligible vs LLM inference time.

## CLI Interface

```
$ api-tunnel

  api-tunnel v1.0.0

  Backends detected:
    ✓ claude (Claude Code CLI)
    ✓ openai (OpenAI CLI)

  Local server:   http://localhost:3456
  Tunnel (ngrok): https://a1b2c3d4.ngrok-free.app

  API Key: at_sk_7f3a...9e2b

  Endpoints:
    POST /v1/chat/completions   (OpenAI format)
    POST /v1/messages           (Anthropic format)
    GET  /v1/models             (list backends)

  Press 'r' to regenerate API key
  Press 'n' to restart ngrok tunnel
  Press 'q' to quit
```

**Flags:**
- `--port <num>` — custom port (default 3456)
- `--no-tunnel` — local only, skip ngrok
- `--cors-origin <origin>` — set CORS allowed origin

## API Translation

### OpenAI-compatible (`POST /v1/chat/completions`)

Request → extract messages → spawn CLI → stream stdout → format as OpenAI SSE (`data: {"choices":[...]}`)

### Anthropic (`POST /v1/messages`)

Request → extract messages → spawn CLI → stream stdout → format as Anthropic SSE (`event: content_block_delta`)

### Model Routing

The `model` field determines the backend:
- `claude`, `claude-sonnet`, `claude-opus`, etc. → `claude` CLI
- `gpt-4o`, `gpt-4`, `o1`, etc. → `openai` CLI

### Image Support

Base64/URL images in messages → save to temp file → pass to CLI via appropriate flags → clean up after response.

## Security

**API Keys:**
- 256-bit cryptographically random, prefixed `at_sk_`
- Hashed (SHA-256) before storage; plaintext shown only once
- Constant-time comparison
- Stored in `~/.api-tunnel/config.json`

**Request Validation:**
- `Authorization: Bearer <key>` required on all requests
- 10MB request body limit
- No shell injection: `child_process.spawn()` with array args, never string concatenation

**Rate Limiting:**
- Token bucket: 10 req/min default (configurable)
- Per-key tracking
- `429 Too Many Requests` with `Retry-After`

**Network:**
- Binds to `127.0.0.1` only (not `0.0.0.0`)
- ngrok handles TLS for remote access
- CORS restricted by default

**Process Isolation:**
- CLI runs with inherited user permissions
- Temp files in dedicated dir, cleaned after each request
- No secrets logged

## Project Structure

```
api-tunnel/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Entry point, CLI interface
│   ├── server.ts             # Fastify HTTP server
│   ├── auth/
│   │   ├── keys.ts           # Key generation, hashing, validation
│   │   └── middleware.ts     # Auth middleware
│   ├── backends/
│   │   ├── base.ts           # Backend interface
│   │   ├── claude.ts         # Claude CLI backend
│   │   └── openai.ts        # OpenAI CLI backend
│   ├── routes/
│   │   ├── chat-completions.ts  # OpenAI-compat endpoint
│   │   ├── messages.ts          # Anthropic endpoint
│   │   └── models.ts           # Model listing
│   ├── tunnel/
│   │   └── ngrok.ts          # ngrok tunnel management
│   ├── config/
│   │   └── store.ts          # Config file management
│   └── utils/
│       ├── rate-limit.ts     # Rate limiter
│       └── logger.ts         # Logging
└── bin/
    └── api-tunnel            # CLI entry shebang
```

## Tech Stack

- **Runtime:** Node.js 20+
- **Language:** TypeScript
- **HTTP Server:** Fastify
- **Tunneling:** `@ngrok/ngrok`
- **CLI UI:** chalk, ora, raw stdin for keyboard shortcuts
- **Process management:** `child_process.spawn()` with streaming
- **Config:** JSON in `~/.api-tunnel/`
