# MBG Backend — AI Assistive Vision System

Lightweight ElysiaJS backend for AI-assisted vision, designed for visually impaired users.
Uses LM Studio's native REST API for local inference with a Gemma vision model.

## Prerequisites

- [Bun](https://bun.com) runtime (v1.2+)
- [LM Studio](https://lmstudio.ai) running locally with a vision-capable model loaded

## Setup

```bash
# Install dependencies
bun install

# Copy environment config
cp .env.example .env

# Start development server (hot reload)
bun run dev

# Start production server
bun run start
```

## API Endpoints

### `POST /describe`
Main inference endpoint. Accepts an image and optional voice command, returns an AI-generated description.

**Request:** `multipart/form-data`
| Field | Type | Required | Description |
|---|---|---|---|
| `image` | File | ✅ | JPEG, PNG, or WebP image (max 5MB) |
| `userCommand` | string | ❌ | Indonesian voice command for context |

**Response:**
```json
{
  "success": true,
  "description": "Terdapat kursi di depan Anda. Jalur kanan lebih aman untuk berjalan."
}
```

### `GET /health`
System health check. Returns status of backend, LM Studio, and model.

**Response (200 = all ok, 503 = degraded):**
```json
{
  "backend": "ok",
  "lmStudio": "ok",
  "model": "ok",
  "modelKey": "gemma-4-e4b-it",
  "timestamp": "2026-05-06T12:00:00.000Z"
}
```

## Architecture

```
src/
├── index.ts              Entry point + Elysia app setup
├── routes/
│   └── describe.ts       POST /describe handler
├── services/
│   ├── healthService.ts  Health check + caching
│   ├── lmStudio.ts       LM Studio API + image optimization
│   ├── modelManager.ts   Model verification
│   └── promptBuilder.ts  Intent parsing + response sanitization
├── types/
│   └── index.ts          All TypeScript types
└── utils/
    ├── constants.ts      Configuration values
    ├── logger.ts         Structured logging
    └── validation.ts     Input validation
```

## Environment Variables

See [`.env.example`](.env.example) for all configurable values.
