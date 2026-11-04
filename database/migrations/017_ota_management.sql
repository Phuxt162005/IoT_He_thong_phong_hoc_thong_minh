-- ADV-05: OTA firmware management

CREATE TABLE firmware_releases (
  firmware_id UUID PRIMARY KEY,
  version VARCHAR(32) NOT NULL,
  device_type VARCHAR(20) NOT NULL
    CHECK (device_type IN ('SENSOR_NODE', 'CONTROL_NODE')),
  hardware_target VARCHAR(64) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  storage_path TEXT NOT NULL UNIQUE,
  file_size BIGINT NOT NULL CHECK (file_size > 0),
  sha256 CHAR(64) NOT NULL
    CHECK (sha256 ~ '^[a-fA-F0-9]{64}$'),
  release_notes TEXT NOT NULL DEFAULT '',
  status VARCHAR(12) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'PUBLISHED', 'REVOKED')),
  created_by BIGINT NOT NULL REFERENCES users(user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  UNIQUE (device_type, hardware_target, version),
  CHECK (
    (status = 'DRAFT' AND published_at IS NULL)
    OR (status IN ('PUBLISHED', 'REVOKED') AND published_at IS NOT NULL)
  )
);

CREATE INDEX firmware_releases_lookup_idx
  ON firmware_releases(device_type, hardware_target, created_at DESC);

CREATE INDEX firmware_releases_published_idx
  ON firmware_releases(device_type, hardware_target, published_at DESC)
  WHERE status = 'PUBLISHED';

CREATE TABLE ota_jobs (
  job_id UUID PRIMARY KEY,
  firmware_id UUID NOT NULL REFERENCES firmware_releases(firmware_id),
  device_id BIGINT NOT NULL REFERENCES devices(device_id),
  room_id BIGINT NOT NULL REFERENCES rooms(room_id),
  session_id VARCHAR(64) NOT NULL,
  credential_version INTEGER NOT NULL CHECK (credential_version > 0),
  previous_firmware_version VARCHAR(32),
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN (
      'PENDING', 'NOTIFIED', 'DOWNLOADING', 'VERIFYING',
      'INSTALLING', 'REBOOTING', 'SUCCESS', 'FAILED',
      'ROLLED_BACK', 'CANCELLED', 'TIMEOUT'
    )),
  progress SMALLINT NOT NULL DEFAULT 0
    CHECK (progress BETWEEN 0 AND 100),
  error_code VARCHAR(40),
  requested_by BIGINT NOT NULL REFERENCES users(user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  last_status_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  timeout_at TIMESTAMPTZ NOT NULL,
  CHECK (
    (status IN ('SUCCESS', 'FAILED', 'ROLLED_BACK', 'CANCELLED', 'TIMEOUT')
      AND finished_at IS NOT NULL)
    OR
    (status NOT IN ('SUCCESS', 'FAILED', 'ROLLED_BACK', 'CANCELLED', 'TIMEOUT')
      AND finished_at IS NULL)
  )
);

-- Một thiết bị không thể chạy đồng thời nhiều tác vụ OTA.
CREATE UNIQUE INDEX ota_jobs_one_active_device_idx
  ON ota_jobs(device_id)
  WHERE status IN (
    'PENDING', 'NOTIFIED', 'DOWNLOADING', 'VERIFYING',
    'INSTALLING', 'REBOOTING'
  );

CREATE INDEX ota_jobs_device_history_idx
  ON ota_jobs(device_id, created_at DESC);

CREATE INDEX ota_jobs_room_history_idx
  ON ota_jobs(room_id, created_at DESC);

CREATE INDEX ota_jobs_pending_idx
  ON ota_jobs(timeout_at)
  WHERE status IN (
    'PENDING', 'NOTIFIED', 'DOWNLOADING', 'VERIFYING',
    'INSTALLING', 'REBOOTING'
  );