# SonicFlow 🎧

SonicFlow is a commercial-grade, high-performance audio conversion SaaS. It enables processing audio files or remote URL sources, transcoding them into high-quality MP3s with custom profiles, and distributing them via secure S3-compatible storage links.

---

## ⚙️ Technology Stack

- **Monorepo Architecture**: Managed with NPM Workspaces and TypeScript.
- **Frontend**: Next.js 14 (App Router) + Tailwind CSS + Framer Motion (for premium dark glassmorphism effects).
- **Backend API**: Node.js + Express (handling request ingestion, input validation, rate limiting, and Server-Sent Events).
- **Queue / Broker**: BullMQ backed by Redis (task locks, retry loops, progress tracking).
- **Audio Processing Engine**: Native FFmpeg with multi-threaded stream piping to eliminate server RAM buffering latency.
- **Object Storage**: MinIO (local) / AWS S3 (production) configured with a **1-hour TTL Lifecycle Policy**.
- **Containerization**: Docker & Docker Compose setup.

---

## 📂 Project Layout

```
sonicflow/
├── docker-compose.yml       # Integrates PG, Redis, MinIO, Backend, Worker, Frontend
├── package.json             # Root monorepo configuration
├── tsconfig.json            # Base typescript compiler configuration
├── apps/
│   ├── frontend/            # Next.js 14 Dashboard
│   ├── backend/             # Express API Gateway & SSE streams
│   └── worker/              # BullMQ Worker executing FFmpeg tasks
├── packages/
│   └── shared/              # Shared TypeScript definitions & schemas
└── .github/
    └── workflows/
        └── ci.yml           # Automated CI testing checks
```

---

## 🚀 Quick Start (Docker Compose)

The easiest way to run the entire SonicFlow stack (including database, cache, storage, and worker queues) is using Docker Compose:

1. **Verify Docker Status**:
   Ensure Docker Desktop is active on your machine.
   
2. **Build and Spin up services**:
   ```bash
   docker compose up --build
   ```

3. **Access components**:
   - **Frontend Dashboard**: [http://localhost:3000](http://localhost:3000)
   - **Backend health checks**: [http://localhost:5000/health](http://localhost:5000/health)
   - **MinIO Storage Dashboard**: [http://localhost:9001](http://localhost:9001) (Credentials: `minioadmin` / `minioadmin`)

---

## 🛡️ Enterprise Security Implementations

1. **SSRF Guard**: Resolves submitted domains to IPs and blocks any loopback, multicast, or RFC 1918 private subnets (e.g. `127.0.0.1`, `10.0.0.0/8`, `192.168.0.0/16`) to prevent server scans.
2. **Magic Byte Checker**: Reads the first 12 bytes of uploaded binaries to verify real headers (`ID3`, `RIFF`, `fLaC`, `OggS`, `ftypM4A`), rejecting spoofed `.txt` or malicious scripts.
3. **Redis Rate Limiter**: Tracks client IPs atomically in Redis to throttle spam conversions (limits uploads to 10/min, and regular queries to 60/min).
4. **RAM Disk Processing**: Compiles intermediate files on `/tmp/sonicflow-scratch` (maps to RAM-disk `tmpfs` in Docker) to prevent slow SSD wear-and-tear.
