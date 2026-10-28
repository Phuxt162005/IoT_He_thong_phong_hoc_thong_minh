export class InMemoryTelemetryRepository {
  constructor() {
    this.events = new Map();
  }

  async findByEventId(eventId) {
    const event = this.events.get(eventId);
    return event ? structuredClone(event) : null;
  }

  async saveIfAbsent(event) {
    if (this.events.has(event.eventId)) {
      return {
        inserted: false,
        event: structuredClone(this.events.get(event.eventId)),
      };
    }

    this.events.set(event.eventId, structuredClone(event));
    return { inserted: true, event: structuredClone(event) };
  }

  async count() {
    return this.events.size;
  }
}
