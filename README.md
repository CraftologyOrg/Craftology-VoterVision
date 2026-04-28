# VisionBackend

Vision analysis service for the Craftology auto-voter. Accepts screenshots from the vote engine, sends them through DeepInfra-hosted Qwen vision models first, and returns structured JSON decisions that augment the existing hardcoded selector logic. Ollama/moondream2 remains available only as the final fallback provider.

## Architecture

```
Electron Vote Engine  ──POST /analyze──▶  VisionBackend  ──chat/completions──▶  DeepInfra Qwen
                                              │
                                         Supabase auth
                                    (Captcha-Token + HWID)
                                              │
                                     Per-user FIFO queue
                                              │
                                     Ollama final fallback
```

The vote engine never depends on VisionBackend being available. Every call has a 20s client-side timeout and falls back to existing hardcoded logic on any failure.

### Provider Order

The backend tries providers in this exact order:

1. `Qwen/Qwen3-VL-235B-A22B-Instruct`
2. `Qwen/Qwen3-VL-30B-A3B-Instruct`
3. `Qwen/Qwen3.6-35B-A3B`
4. `Qwen/Qwen3.5-397B-A17B`
5. Ollama `moondream2`

DeepInfra uses the OpenAI-compatible endpoint at `https://api.deepinfra.com/v1/openai/chat/completions`. Screenshots are sent as base64 `image_url` payloads and prompts are the task prompts in `src/lib/prompts.js`.

### Backend Queue

The backend serializes requests per authenticated user (`request.user.id`, then license id, HWID, then IP). Different users can still run concurrently up to `VISION_GLOBAL_CONCURRENCY`. Queue pressure is bounded by `VISION_QUEUE_MAX_PENDING_PER_USER`, and requests that wait too long return `503 queue_timeout` instead of hanging.

## Supported Tasks


| Task                      | Description                                                                       |
| ------------------------- | --------------------------------------------------------------------------------- |
| `find_submit_button`      | Locate the primary vote/submit button                                             |
| `detect_captcha`          | Identify captcha widgets and whether they're active                               |
| `check_page_ready`        | Assess if the page is fully loaded and interactive                                |
| `find_input_fields`       | Find username/player name input fields                                            |
| `detect_vote_result`      | Determine vote outcome after submission                                           |
| `confirm_vote`            | Dedicated post-submit confirmation for success/already-voted/interference/failure |
| `locate_captcha_checkbox` | Return normalized checkbox coordinates for captcha click attempts                 |


## Railway Deployment

### Prerequisites

- Railway CLI installed (`npm i -g @railway/cli`)
- A Railway project created

### Steps

1. **Create a new service in your Railway project:**
  ```bash
   cd VisionBackend
   railway link
  ```
2. **Set environment variables in Railway dashboard:**
  ```
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   DEEPINFRA_API_KEY=your-deepinfra-api-key
   PORT=3000
  ```
3. **Optional: add Ollama as a fallback service in the same Railway project.**
  Use the official Ollama Docker image: `ollama/ollama`.
   Set the internal networking so VisionBackend can reach Ollama at `http://ollama.railway.internal:11434` (or configure `OLLAMA_URL` env var to point to it).
4. **Optional: pull moondream2 into the Ollama container:**
  After Ollama is running, exec into the container or use the Ollama API:
5. **Deploy VisionBackend:**
  ```bash
   railway up
  ```
6. **Verify:**
  ```bash
   curl https://your-visionbackend.railway.app/health
   # Should return status ok plus vision provider and queue state
  ```

### Environment Variables


| Variable                            | Required | Description                                                      |
| ----------------------------------- | -------- | ---------------------------------------------------------------- |
| `SUPABASE_URL`                      | Yes      | Supabase project URL                                             |
| `SUPABASE_SERVICE_ROLE_KEY`         | Yes      | Supabase service role key (server-side only)                     |
| `DEEPINFRA_API_KEY`                 | Yes      | DeepInfra API key used for Qwen vision models                    |
| `DEEPINFRA_BASE_URL`                | No       | OpenAI-compatible DeepInfra base URL                             |
| `DEEPINFRA_MODELS`                  | No       | Comma-separated override for the DeepInfra model order           |
| `PORT`                              | No       | Server port (default: 3000)                                      |
| `OLLAMA_URL`                        | No       | Ollama fallback URL (default: `http://localhost:11434`)          |
| `VISION_CACHE_TTL_MS`               | No       | Response cache TTL in ms (default: 30000)                        |
| `VISION_TIMEOUT_MS`                 | No       | Default provider timeout in ms (default: 20000)                  |
| `DEEPINFRA_TIMEOUT_MS`              | No       | DeepInfra request timeout in ms (default: `VISION_TIMEOUT_MS`)   |
| `VISION_GLOBAL_CONCURRENCY`         | No       | Maximum concurrent backend vision jobs across users (default: 4) |
| `VISION_QUEUE_MAX_PENDING_PER_USER` | No       | Maximum queued/running vision requests per user (default: 8)     |
| `VISION_QUEUE_TIMEOUT_MS`           | No       | Maximum time a request may wait before starting (default: 30000) |
| `AUTH_CACHE_TTL_MS`                 | No       | Auth token cache TTL in ms (default: 300000)                     |


## Electron App Configuration

Add `VISION_BACKEND_URL` to your `.env` file in the CraftologyAutovoter directory:

```
VISION_BACKEND_URL=https://your-visionbackend.railway.app
```

This is injected at build time via Vite defines, same as the other backend URLs.

## Local Development

```bash
cd VisionBackend
npm install

# Optional local fallback
ollama pull moondream2
ollama serve

# Copy and configure .env
cp .env.example .env
# Edit .env with your Supabase credentials

npm run dev
```

## API Reference

### POST /analyze

**Headers:**

- `Captcha-Token`: Valid license token from verify-license
- `HWID`: Client hardware ID

**Body:**

```json
{
  "screenshot": "<base64 PNG>",
  "task": "find_submit_button",
  "context": "optional extra context"
}
```

**Success Response (200):**

```json
{
  "task": "find_submit_button",
  "result": { "found": true, "text": "Vote", ... },
  "confidence": 0.9,
  "reasoning": "blue Vote button in center",
  "provider": "deepinfra",
  "model": "Qwen/Qwen3-VL-235B-A22B-Instruct",
  "latency_ms": 1234,
  "queue_wait_ms": 12,
  "cached": false
}
```

**Error Response (503/504/422):**

```json
{
  "error": "model_unavailable",
  "message": "No vision provider returned a usable response",
  "fallback": true
}
```

### POST /confirm-vote

Dedicated vote confirmation endpoint used by the autovoter after submitting a vote. The app captures several screenshots around 5 seconds apart and sends each checkpoint here. `success` and `already_voted` both return `confirmed: true`; `interference`, `failure`, and `unknown` do not.

**Headers:**

- `Captcha-Token`: Valid license token from verify-license
- `HWID`: Client hardware ID

**Body:**

```json
{
  "screenshot": "<base64 PNG>",
  "username": "PlayerName",
  "siteUrl": "https://example-vote-site.com",
  "checkpoint": 1,
  "totalCheckpoints": 3,
  "elapsedMs": 0
}
```

**Success Response (200):**

```json
{
  "task": "confirm_vote",
  "confirmed": true,
  "outcome": "already_voted",
  "result": {
    "outcome": "already_voted",
    "confirmed": true,
    "message": "You have already voted today",
    "can_retry": false,
    "interference": "none"
  },
  "confidence": 0.92,
  "provider": "deepinfra",
  "model": "Qwen/Qwen3-VL-235B-A22B-Instruct",
  "latency_ms": 1234,
  "queue_wait_ms": 10
}
```

### GET /health

Returns 200 for liveness and includes provider readiness and queue state. Use `/ready` when an orchestrator needs dependency readiness.

## Service Monitoring

Every **2 minutes** the server logs the status of external dependencies:

```json
{ "vision": { "ready": true }, "queue": { "active": 2 }, "supabase": "connected" }
```

- **DeepInfra** — configured when `DEEPINFRA_API_KEY` is present
- **Ollama fallback** — `GET /api/tags` to check if a `moondream`* model is present and set the internal fallback readiness flag
- **Supabase** — HTTP ping to the REST endpoint using the service role key

Incoming `/analyze` requests use the backend queue, then try each configured provider in order. Transport errors, timeouts, DeepInfra rate limits, empty responses, and parse failures move to the next provider automatically.

The `/health` endpoint always returns `200` and is never logged, so Railway health checks do not produce log noise.

## Memory Budget

Target < 2GB RAM on Railway hobby tier for the Node service. DeepInfra hosts the production Qwen models, so local memory pressure is limited to Fastify, auth cache, queue state, and the short-lived response cache. Ollama/moondream2 is optional and only required if you want a local fallback.