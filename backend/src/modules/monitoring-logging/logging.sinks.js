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
