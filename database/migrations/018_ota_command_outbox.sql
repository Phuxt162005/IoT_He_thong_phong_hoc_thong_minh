-- ADV-05: Durable MQTT command delivery for OTA
CREATE TABLE ota_command_outbox (
  outbox_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id UUID NOT NULL UNIQUE REFERENCES ota_jobs(job_id) ON DELETE RESTRICT,
  status VARCHAR(12) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'CANCELLED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  last_error VARCHAR(40),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (status = 'PROCESSING' AND locked_until IS NOT NULL)
    OR (status <> 'PROCESSING' AND locked_until IS NULL)
  ),
  CHECK (
    (status = 'SENT' AND sent_at IS NOT NULL)
    OR (status <> 'SENT' AND sent_at IS NULL)
  )
);

CREATE INDEX ota_command_outbox_pending_idx
  ON ota_command_outbox(available_at, outbox_id)
  WHERE status IN ('PENDING', 'PROCESSING');