-- Lưu chữ ký Ed25519 của firmware đã phát hành.
ALTER TABLE firmware_releases
ADD COLUMN signature TEXT;