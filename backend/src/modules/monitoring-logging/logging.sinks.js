export class ConsoleLogSink {
  write(entry) {
    const output = JSON.stringify(entry);
    if (entry.level === "ERROR") console.error(output);
    else if (entry.level === "WARN") console.warn(output);
    else console.log(output);
  }
}

export class MemoryLogSink {
  constructor() {
    this.entries = [];
  }

  write(entry) {
    this.entries.push(structuredClone(entry));
  }

  getEntries() {
    return structuredClone(this.entries);
  }

  clear() {
    this.entries = [];
  }
}

export class PostgresLogSink {
  constructor(
    pool,
    { fallback = null, maxQueueSize = 10000, batchSize = 100 } = {},
  ) {
    if (!pool || typeof pool.query !== "function")
      throw new TypeError("Cần PostgreSQL pool");
    if (!Number.isInteger(maxQueueSize) || maxQueueSize < 1)
      throw new TypeError("maxQueueSize không hợp lệ");
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500)
      throw new TypeError("batchSize không hợp lệ");

    this.pool = pool;
    this.fallback = fallback;
    this.maxQueueSize = maxQueueSize;
    this.batchSize = batchSize;
    this.queue = [];
    this.dropped = 0;
    this.flushing = null;
    this.closed = false;
  }

  write(entry) {
    this.fallback?.write(entry);

    if (this.closed) {
      this.dropped++;
      return;
    }

    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift();
      this.dropped++;
    }

    this.queue.push({
      timestamp: entry.timestamp,
      level: entry.level,
      service: entry.service,
      message: entry.message,
      metadata: entry.metadata ?? {},
    });
  }

  async flush() {
    if (this.flushing) return this.flushing;

    this.flushing = this.#flushBatch().finally(() => {
      this.flushing = null;
    });

    return this.flushing;
  }

  async #flushBatch() {
    if (!this.queue.length) return 0;

    const batch = this.queue.splice(0, this.batchSize);

    try {
      await this.pool.query(
        `INSERT INTO monitoring_logs(logged_at,level,service,message,metadata)
         SELECT x.timestamp,x.level,x.service,x.message,x.metadata
         FROM jsonb_to_recordset($1::jsonb) AS x(
           timestamp timestamptz,
           level text,
           service text,
           message text,
           metadata jsonb
         )`,
        [JSON.stringify(batch)],
      );

      return batch.length;
    } catch (error) {
      // Đưa log lỗi trở lại đầu hàng đợi để thử ghi ở chu kỳ tiếp theo.
      this.queue = [...batch, ...this.queue].slice(0, this.maxQueueSize);
      throw error;
    }
  }

  async close() {
    this.closed = true;

    // Cố gắng ghi hết các lô còn lại trước khi đóng PostgreSQL.
    while (this.queue.length) {
      try {
        await this.flush();
      } catch {
        break;
      }
    }

    return {
      remaining: this.queue.length,
      dropped: this.dropped,
    };
  }

  getStats() {
    return {
      queued: this.queue.length,
      dropped: this.dropped,
      maxQueueSize: this.maxQueueSize,
      batchSize: this.batchSize,
    };
  }
}
