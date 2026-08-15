# VisionBackend

Vision analysis service for the Craftology auto-voter. Accepts screenshots from the vote engine, sends them through DeepInfra-hosted Qwen vision models first, and returns structured JSON decisions that augment the existing hardcoded selector logic. Ollama/moondream2 remains available only as the final fallback provider.

## Architecture

```
Electron Vote Engine  ──POST /analyze──▶  VisionBackend  ──chat/completions──▶  DeepInfra Qwen
                                              │
                                         Supabase auth
                                    (Captcha-Token + HWID)
                                              │
                                     Parallel queue (tier cap + global limit)
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

Licensed `/analyze` requests run **in parallel** per queue key (license id / HWID), up to **`tier_max_sessions_per_hwid`** from entitlements (passed as `maxPendingPerUser`). A **global** cap `VISION_GLOBAL_CONCURRENCY` (default **4096**; shared by **all** users on the instance; `0` or `-1` = unlimited in Node) limits concurrent model runs on the process. If too many are in flight for one identity, the API returns `429 queue_full`. Waiting for a global slot longer than `VISION_QUEUE_TIMEOUT_MS` returns `503 queue_timeout`. When tier is missing, `VISION_QUEUE_MAX_PENDING_PER_USER` (default 128) applies as fallback.

## Supported Tasks


| Task                      | Description                                                                       |
| ------------------------- | --------------------------------------------------------------------------------- |
| `find_submit_button`      | Locate the primary vote/submit button                                             |
| `detect_captcha`          | Identify captcha widgets and whether they're active                               |
| `check_page_ready`        | Assess if the page is fully loaded and interactive                                |
| `find_input_fields`       | Find username/player name input fields                                            |
| `detect_vote_result`      | Determine vote outcome after submission                                           |
| `confirm_vote`            | Post-submit confirmation: success / already_voted / **processing** (wait modal) / interference / failure |
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
6. **Attach a volume for the 60-day monitor (required for `/monitor`):**
   - In the Railway canvas, add a volume to this service.
   - Mount path: `/data` (Railway will set `RAILWAY_VOLUME_MOUNT_PATH`).
   - Start around **20 GB**; live-resize later if needed.
   - Keep **replicas = 1**. Volumes cannot be used with multiple replicas, and a volume also adds a short gap on each redeploy.
   - Enable volume backups in Railway.
7. **Verify:**
  ```bash
   curl https://your-visionbackend.railway.app/health
   # Should return status ok plus vision provider and queue state
  ```
   Open `https://your-visionbackend.railway.app/monitor` and sign in with a Craftology **admin** account (`user_roles.role_name = admin` in the same Supabase project as the website).

### Environment Variables


| Variable                            | Required | Description                                                      |
| ----------------------------------- | -------- | ---------------------------------------------------------------- |
| `SUPABASE_URL`                      | Yes      | Supabase project URL                                             |
| `SUPABASE_SERVICE_ROLE_KEY`         | Yes      | Supabase service role key (server-side only)                     |
| `SUPABASE_ANON_KEY`                 | Yes*     | Same-project anon/publishable key for `/monitor` staff login     |
| `MONITOR_COOKIE_SECRET`             | No       | Signs the monitor session cookie (defaults to the service role key) |
| `MONITOR_DATA_DIR`                  | No       | Local override for monitor storage (Railway uses `/data` via volume) |
| `DEEPINFRA_API_KEY`                 | Yes      | DeepInfra API key used for Qwen vision models                    |
| `DEEPINFRA_BASE_URL`                | No       | OpenAI-compatible DeepInfra base URL                             |
| `DEEPINFRA_MODELS`                  | No       | Comma-separated override for the DeepInfra model order           |
| `PORT`                              | No       | Server port (default: 3000)                                      |
| `OLLAMA_URL`                        | No       | Ollama fallback URL (default: `http://localhost:11434`)          |
| `VISION_CACHE_TTL_MS`               | No       | Response cache TTL in ms (default: 30000)                        |
| `VISION_TIMEOUT_MS`                 | No       | Default provider timeout in ms (default: 20000)                  |
| `DEEPINFRA_TIMEOUT_MS`              | No       | DeepInfra request timeout in ms (default: `VISION_TIMEOUT_MS`)   |
| `VISION_GLOBAL_CONCURRENCY`         | No       | Max concurrent model runs **all tenants** on this process (default: 4096; `0`/`-1` = unlimited) |
| `VISION_QUEUE_MAX_PENDING_PER_USER` | No       | Fallback max in-flight per key when tier unknown (default: 128)   |
| `VISION_QUEUE_TIMEOUT_MS`           | No       | Max wait for a global slot before `503` (default: 30000)          |
| `VISION_ANALYZE_RATE_LIMIT_PER_MIN` | No       | Fastify `/analyze` req/min per license (default: 6000)            |
| `VISION_CONFIRM_RATE_LIMIT_PER_MIN` | No       | Fastify `/confirm-vote` req/min per license (default: 6000)       |
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

Dedicated vote confirmation endpoint used by the autovoter after submitting a vote. The app sends multiple checkpoints while a post-submit processing modal may be visible. `success` and `already_voted` return `confirmed: true`. `processing` returns `confirmed: false`, `can_retry: true`, optional `wait_seconds`, and `interference: "processing_modal"` — the autovoter waits and re-polls until success or timeout. `interference` is reserved for real blockers (captcha, etc.), not in-progress vote timers.

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

## Ops dashboard (`/monitor`)

The same Railway service serves a staff dashboard at `/monitor`. Logs, inbound HTTP, outbound network calls, vision attempts, and DeepInfra billing snapshots are stored in SQLite on the attached volume (`/data/monitor/monitor.db`) for **60 days**.

- Sign-in uses Craftology email/password via Supabase Auth. Access is granted only when `user_roles.role_name = admin` (same staff role as the website).
- Screenshots, `Captcha-Token`, API keys, and other secrets are not stored.
- Search covers app logs and network payloads. Graphs use 1-minute rollups (hourly when the range is long).
- DeepInfra balance is polled from `GET /payment/checklist?compute_owed=true` and `GET /payment/usage?from=current` about every 3 minutes.

## Memory Budget

Target < 2GB RAM on Railway hobby tier for the Node service. DeepInfra hosts the production Qwen models, so local memory pressure is limited to Fastify, auth cache, queue state, and the short-lived response cache. Ollama/moondream2 is optional and only required if you want a local fallback.