# VisionBackend

Vision analysis service for the Craftology auto-voter. Accepts screenshots from the vote engine, passes them through moondream2 (via Ollama), and returns structured JSON decisions that augment the existing hardcoded selector logic.

## Architecture

```
Electron Vote Engine  ──POST /analyze──▶  VisionBackend  ──/api/generate──▶  Ollama (moondream2)
                                              │
                                         Supabase auth
                                    (Captcha-Token + HWID)
```

The vote engine never depends on VisionBackend being available. Every call has a 20s client-side timeout and falls back to existing hardcoded logic on any failure.

## Supported Tasks

| Task | Description |
|------|-------------|
| `find_submit_button` | Locate the primary vote/submit button |
| `detect_captcha` | Identify captcha widgets and whether they're active |
| `check_page_ready` | Assess if the page is fully loaded and interactive |
| `find_input_fields` | Find username/player name input fields |
| `detect_vote_result` | Determine vote outcome after submission |

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
   PORT=3000
   ```

3. **Add Ollama as a service in the same Railway project.**
   Use the official Ollama Docker image: `ollama/ollama`

   Set the internal networking so VisionBackend can reach Ollama at `http://ollama.railway.internal:11434` (or configure `OLLAMA_URL` env var to point to it).

4. **Pull moondream2 into the Ollama container:**
   After Ollama is running, exec into the container or use the Ollama API:
   ```bash
   # Via Railway CLI
   railway run -s ollama -- ollama pull moondream2

   # Or via API from within the Railway network
   curl http://ollama.railway.internal:11434/api/pull -d '{"name": "moondream2"}'
   ```

5. **Deploy VisionBackend:**
   ```bash
   railway up
   ```

6. **Verify:**
   ```bash
   curl https://your-visionbackend.railway.app/health
   # Should return: {"status":"ok","model":"moondream2","ready":true}
   ```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key (server-side only) |
| `PORT` | No | Server port (default: 3000) |
| `OLLAMA_URL` | No | Ollama base URL (default: `http://localhost:11434`) |
| `VISION_CACHE_TTL_MS` | No | Response cache TTL in ms (default: 30000) |
| `AUTH_CACHE_TTL_MS` | No | Auth token cache TTL in ms (default: 300000) |
| `RAILWAY_PUBLIC_DOMAIN` | Auto | Set by Railway — used for self-ping keepalive |

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

# Start Ollama locally with moondream2
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
  "model": "moondream2",
  "latency_ms": 1234
}
```

**Error Response (503/504/422):**
```json
{
  "error": "model_unavailable",
  "message": "moondream2 is not loaded",
  "fallback": true
}
```

### GET /health

Returns 200 when moondream2 is loaded and responding, 503 otherwise.

## Memory Budget

Target < 2GB RAM on Railway hobby tier. moondream2 is a lightweight vision model (~1.7B parameters) that fits comfortably. The Fastify server adds minimal overhead. The in-memory response cache uses a 30-second TTL to keep memory bounded.
