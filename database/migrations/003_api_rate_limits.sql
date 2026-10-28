CREATE TABLE api_rate_limits (
  user_id BIGINT PRIMARY KEY REFERENCES users(user_id),
  window_started TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK(request_count > 0)
);
CREATE INDEX api_rate_limits_window_idx ON api_rate_limits(window_started);
