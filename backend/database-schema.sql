-- Tool Events Table (for tracking which tools are used)
CREATE TABLE tool_events (
  id BIGSERIAL PRIMARY KEY,
  tool_name VARCHAR(100) NOT NULL,
  user_session_id VARCHAR(255),
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT tool_events_pkey PRIMARY KEY (id)
);

CREATE INDEX idx_tool_events_name ON tool_events(tool_name);
CREATE INDEX idx_tool_events_created_at ON tool_events(created_at);

-- Competitor Data Table
CREATE TABLE competitor_data (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  market_segment VARCHAR(100),
  features TEXT,
  pricing TEXT,
  notes TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT competitor_data_pkey PRIMARY KEY (id)
);

CREATE INDEX idx_competitor_segment ON competitor_data(market_segment);
CREATE INDEX idx_competitor_updated_at ON competitor_data(updated_at);

-- Market Trends Table (for tracking market metrics over time)
CREATE TABLE market_trends (
  id BIGSERIAL PRIMARY KEY,
  metric_name VARCHAR(255) NOT NULL,
  value DECIMAL(10, 2),
  category VARCHAR(100),
  date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT market_trends_pkey PRIMARY KEY (id)
);

CREATE INDEX idx_market_trends_metric ON market_trends(metric_name);
CREATE INDEX idx_market_trends_date ON market_trends(date);
CREATE INDEX idx_market_trends_category ON market_trends(category);

-- User Preferences Table (for storing saved searches/configurations)
CREATE TABLE user_preferences (
  id BIGSERIAL PRIMARY KEY,
  user_session_id VARCHAR(255) NOT NULL,
  preference_key VARCHAR(255) NOT NULL,
  preference_value JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_session_id, preference_key),
  CONSTRAINT user_preferences_pkey PRIMARY KEY (id)
);

CREATE INDEX idx_user_prefs_session ON user_preferences(user_session_id);
