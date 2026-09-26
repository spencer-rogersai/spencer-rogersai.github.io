# Backend: Node.js + Supabase Setup

This is a sample backend for dashboards, reporting, and data persistence using Node.js and Supabase (PostgreSQL).

## Quick Start

### 1. Set Up Supabase

1. Go to [supabase.com](https://supabase.com) and create a free account
2. Create a new project (free tier included)
3. Go to **Settings** → **Database** and copy:
   - Project URL
   - Anon Key
   - Service Role Key
4. Create the database tables by running the SQL in `database-schema.sql`:
   - In Supabase dashboard, go to **SQL Editor**
   - Create a new query
   - Paste the contents of `database-schema.sql`
   - Run the query

### 2. Set Up Node.js Backend

```bash
cd backend
npm install
```

### 3. Configure Environment Variables

Copy `.env.example` to `.env` and fill in your Supabase credentials:

```bash
cp .env.example .env
```

Edit `.env`:
```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key-here
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here
PORT=3001
NODE_ENV=development
FRONTEND_URL=https://spencer-rogersai.github.io
```

### 4. Run the Server

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

Server will run on `http://localhost:3001`

## API Endpoints

### Health Check
- `GET /api/health` — Check if server is running

### Analytics
- `GET /api/analytics/tool-usage` — Get which tools are used most (last 30 days)
- `GET /api/analytics/competitors` — Get all tracked competitors
- `GET /api/analytics/trends` — Get market trend data (last 30 entries)

### Data Logging (from Frontend)
- `POST /api/events/tool-usage` — Log when a user clicks a tool
  ```json
  {
    "tool_name": "competitor-map",
    "user_session_id": "session-abc123",
    "metadata": {"clicked_at": "2026-09-26T..."}
  }
  ```

- `POST /api/data/competitor` — Save competitor data
  ```json
  {
    "name": "CompetitorX",
    "market_segment": "SaaS",
    "features": "...",
    "pricing": "$99/mo",
    "notes": "..."
  }
  ```

- `POST /api/data/trend` — Save market trend
  ```json
  {
    "metric_name": "market_growth",
    "value": 15.5,
    "category": "SaaS"
  }
  ```

### Dashboard
- `GET /api/dashboard/summary` — Get aggregated dashboard data
  ```json
  {
    "total_events_30d": 1250,
    "total_competitors_tracked": 42,
    "timestamp": "2026-09-26T..."
  }
  ```

## Frontend Integration

From your HTML/JS files, call the API:

```javascript
// Log tool usage
async function logToolUsage(toolName) {
  const response = await fetch('https://your-backend.com/api/events/tool-usage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tool_name: toolName,
      user_session_id: sessionStorage.getItem('sessionId'),
      metadata: { timestamp: new Date().toISOString() }
    })
  });
  return response.json();
}

// Get analytics
async function getToolUsageStats() {
  const response = await fetch('https://your-backend.com/api/analytics/tool-usage');
  return response.json();
}
```

## Deployment Options

### Option A: Vercel (Recommended)
1. Push this code to your GitHub repo
2. Go to [vercel.com](https://vercel.com)
3. Import your GitHub repo
4. Add environment variables (Supabase keys)
5. Deploy (automatic on git push)
6. Update `FRONTEND_URL` in `.env` to your Vercel domain

### Option B: Railway
1. Go to [railway.app](https://railway.app)
2. Create new project → Deploy from GitHub
3. Select your repo
4. Add environment variables
5. Deploy

### Option C: Render
1. Go to [render.com](https://render.com)
2. Create new Web Service
3. Connect GitHub
4. Add build command: `npm install`
5. Add start command: `npm start`
6. Add environment variables

## Database Schema

See `database-schema.sql` for tables:
- `tool_events` — Track tool usage
- `competitor_data` — Store competitor info
- `market_trends` — Track metrics over time
- `user_preferences` — Save user settings

## Next Steps

1. Deploy the backend
2. Create a dashboard page in your frontend
3. Add fetch calls to visualize the data
4. Build reporting features
