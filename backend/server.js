require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============ ANALYTICS ENDPOINTS ============

// Get tool usage analytics
app.get('/api/analytics/tool-usage', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tool_events')
      .select('tool_name, COUNT(*) as usage_count')
      .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()) // Last 30 days
      .group('tool_name');
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get competitor data analytics
app.get('/api/analytics/competitors', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('competitor_data')
      .select('*')
      .order('updated_at', { ascending: false });
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get market trends
app.get('/api/analytics/trends', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('market_trends')
      .select('*')
      .order('date', { ascending: false })
      .limit(30);
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ DATA LOGGING ENDPOINTS ============

// Log tool usage (called from frontend)
app.post('/api/events/tool-usage', async (req, res) => {
  try {
    const { tool_name, user_session_id, metadata } = req.body;
    
    const { data, error } = await supabase
      .from('tool_events')
      .insert([
        {
          tool_name,
          user_session_id,
          metadata,
          created_at: new Date().toISOString()
        }
      ]);
    
    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save competitor data
app.post('/api/data/competitor', async (req, res) => {
  try {
    const { name, market_segment, features, pricing, notes } = req.body;
    
    const { data, error } = await supabase
      .from('competitor_data')
      .insert([
        {
          name,
          market_segment,
          features,
          pricing,
          notes,
          updated_at: new Date().toISOString()
        }
      ]);
    
    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save market trend data
app.post('/api/data/trend', async (req, res) => {
  try {
    const { metric_name, value, category } = req.body;
    
    const { data, error } = await supabase
      .from('market_trends')
      .insert([
        {
          metric_name,
          value,
          category,
          date: new Date().toISOString()
        }
      ]);
    
    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ DASHBOARD ENDPOINT ============

// Get dashboard summary (aggregated data)
app.get('/api/dashboard/summary', async (req, res) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    
    // Get tool usage summary
    const { data: toolData, error: toolError } = await supabase
      .from('tool_events')
      .select('COUNT(*)', { count: 'exact' })
      .gte('created_at', thirtyDaysAgo);
    
    // Get competitor count
    const { data: competitorData, error: competitorError } = await supabase
      .from('competitor_data')
      .select('COUNT(*)', { count: 'exact' });
    
    if (toolError || competitorError) throw toolError || competitorError;
    
    res.json({
      total_events_30d: toolData?.[0]?.count || 0,
      total_competitors_tracked: competitorData?.[0]?.count || 0,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
});
