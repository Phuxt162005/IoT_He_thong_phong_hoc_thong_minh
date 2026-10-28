CREATE TABLE backend_schema_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
  version TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
