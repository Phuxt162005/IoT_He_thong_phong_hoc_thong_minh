export class InMemoryAnomalyRepository {
  constructor() {
    this.baselines = new Map();
    this.processedEvents = new Map();
  }

  baselineKey(deviceId, metric) {
    return JSON.stringify([deviceId, metric]);
  }

  eventKey(deviceId, eventId) {
    return JSON.stringify([deviceId, eventId]);
  }

  async getBaseline(deviceId, metric) {
    return [...(this.baselines.get(this.baselineKey(deviceId, metric)) ?? [])];
  }

  async appendBaseline(deviceId, metric, value, windowSize) {
    const key = this.baselineKey(deviceId, metric);
    const values = [...(this.baselines.get(key) ?? []), value].slice(
      -windowSize,
    );
    this.baselines.set(key, values);
    return [...values];
  }

  async getProcessedEvent(deviceId, eventId) {
    if (!eventId) return null;
    const result = this.processedEvents.get(this.eventKey(deviceId, eventId));
    return result ? structuredClone(result) : null;
  }

  async saveProcessedEvent(deviceId, eventId, result) {
    if (eventId) {
      this.processedEvents.set(
        this.eventKey(deviceId, eventId),
        structuredClone(result),
      );
    }
  }

  async clearBaseline(deviceId, metric) {
    this.baselines.delete(this.baselineKey(deviceId, metric));
  }
}
