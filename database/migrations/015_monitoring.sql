CREATE TABLE monitoring_components (
  name VARCHAR(64) PRIMARY KEY,
  status VARCHAR(12) NOT NULL CHECK (status IN ('UP','DEGRADED','DOWN','UNKNOWN')),
  details JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE monitoring_counters (
  name VARCHAR(100) PRIMARY KEY,
  value BIGINT NOT NULL DEFAULT 0 CHECK (value >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);