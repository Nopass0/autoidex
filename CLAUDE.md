# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Running the application:**
```bash
bun run index.ts
# or
bun run dev
```

**Installing dependencies:**
```bash
bun install
```

**Database management (Prisma):**
```bash
# Generate Prisma client
bunx prisma generate

# Run migrations
bunx prisma migrate dev

# View database in Prisma Studio
bunx prisma studio
```

## Architecture Overview

This is an IDEX transaction synchronization service built with TypeScript and Bun. The service continuously monitors for sync orders and fetches transaction data from the IDEX platform.

### Key Components

1. **Main Service (`index.ts`)**: 
   - Runs as a continuous background service using `watchForSyncOrders()`
   - Processes `IdexSyncOrder` records with PENDING status
   - Authenticates with IDEX API and fetches transaction data
   - Saves new transactions to PostgreSQL via Prisma

2. **Data Models (Prisma Schema)**:
   - `IdexSyncOrder`: Tracks sync jobs with status (PENDING, IN_PROGRESS, COMPLETED, FAILED)
   - `IdexCabinet`: Stores IDEX account credentials
   - `IdexTransaction`: Stores fetched transaction data
   - Additional models for users, matches, cards, and salary tracking

3. **Core Functions**:
   - `login()`: Authenticates with IDEX API and retrieves session cookies
   - `fetchTransactions()`: Fetches paginated transaction data
   - `saveTransactions()`: Saves new transactions to database, avoiding duplicates
   - `withRetry()`: Provides retry logic for database operations

### Error Handling

- Implements exponential backoff for rate limiting (429 responses)
- Database connection retry logic with `withRetry()` wrapper
- Graceful shutdown handling for SIGINT/SIGTERM signals