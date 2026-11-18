# Turium AI Knowledge Inbox

A minimal, production-grade AI Knowledge Inbox built as part of the Full Stack Developer recruitment assignment for **Turium Enterprise AI**.

> **Project Status (Milestone T-001):** Core scaffolding, workspace orchestration, environment configuration, type-checking pipelines, and development servers are established and operational. Functional RAG, ingestion, and storage features will be implemented in subsequent milestones.

---

## Architecture & Technology Stack

The application is structured as a clean, decoupled monorepo:

* **Frontend (`/client`):**
  * **Framework:** React 18 with TypeScript
  * **Build Tool:** Vite
  * **Styling:** Tailwind CSS
  * **Icons:** Lucide React
* **Backend (`/server`):**
  * **Runtime:** Node.js (v24 LTS)
  * **Framework:** Express with TypeScript
  * **Validation:** Zod
  * **Logging:** Pino & pino-http (Structured JSON logging)
  * **Runtime Execution:** `tsx` for high-performance development reloading
* **Storage & AI (Planned for Milestone T-002+):**
  * **Database:** SQLite (`better-sqlite3`)
  * **Embeddings & LLM:** OpenAI API (`text-embedding-3-small`, `gpt-4o-mini`)

---

## Directory Structure

```
.
├── client/                     # React 18 + Vite Frontend Application
│   ├── src/
│   │   ├── api/                # API client modules (placeholder)
│   │   ├── components/         # UI Components (placeholder)
│   │   ├── hooks/              # Custom React hooks (placeholder)
│   │   ├── types/              # Client TypeScript definitions (placeholder)
│   │   ├── App.tsx             # Application root shell
│   │   ├── index.css           # Tailwind base styles
│   │   └── main.tsx            # Vite entry point
│   ├── index.html
│   ├── package.json
│   ├── tailwind.config.js
│   ├── tsconfig.json
│   └── vite.config.ts
├── server/                     # Node.js + Express TypeScript API
│   ├── src/
│   │   ├── config/             # Zod environment schema & configuration
│   │   ├── controllers/        # Route controllers (health check)
│   │   ├── db/                 # Database initialization & migrations (placeholder)
│   │   ├── middleware/         # Structured logger & centralized error handling
│   │   ├── repositories/       # Data persistence abstractions (placeholder)
│   │   ├── routes/             # Express API routing definitions
│   │   ├── schemas/            # Request/response validation schemas (placeholder)
│   │   ├── services/           # Business logic & AI pipelines (placeholder)
│   │   ├── utils/              # Pino logger setup
│   │   ├── app.ts              # Express application factory
│   │   └── index.ts            # Server entry point & graceful shutdown
│   ├── package.json
│   └── tsconfig.json
├── .env.example                # Template for environment configuration
├── .gitignore                  # Git exclusion rules
├── package.json                # Root workspace orchestration
└── README.md                   # Project documentation
```

---

## Prerequisites

Ensure the following tools are installed on your machine:
* **Node.js:** `>= 20.x` (Developed & verified on `v24.16.0`)
* **npm:** `>= 10.x` (Developed & verified on `11.13.0`)
* **Git:** `>= 2.x`

---

## Installation & Setup

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd "Turium AI"
   ```

2. **Install all dependencies:**
   Install both root, server, and client dependencies using npm workspaces:
   ```bash
   npm install
   ```

3. **Configure Environment Variables:**
   Copy the example environment file:
   ```bash
   cp .env.example .env
   ```
   *(Note: For Windows PowerShell, use `Copy-Item .env.example .env`)*.

---

## Available Development Scripts

All scripts can be executed from the root directory:

| Command | Action |
| :--- | :--- |
| `npm run dev` | Runs both backend and frontend development servers concurrently |
| `npm run dev:server` | Starts the Express backend on `http://localhost:4000` with hot-reload |
| `npm run dev:client` | Starts the Vite frontend on `http://localhost:5173` |
| `npm run build` | Compiles both backend (`tsc`) and frontend (`vite build`) for production |
| `npm run typecheck` | Executes TypeScript type-checks across both client and server projects |

---

## Health Verification

When the backend server is running, the health endpoint can be verified:
```bash
curl http://localhost:4000/health
```
Response:
```json
{
  "status": "ok",
  "service": "turium-ai-knowledge-inbox-backend",
  "timestamp": "2026-11-18T09:15:00.000Z",
  "uptime": 12.34
}
```
