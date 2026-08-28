interface SseFrame {
  event?: string;
  data: string;
}

export class SseParser {
  private buffer = '';

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    let separator: number;
    while ((separator = this.nextSeparator()) !== -1) {
      const rawFrame = this.buffer.slice(0, separator);
      this.buffer = this.buffer.slice(this.advanceAfterSeparator(separator));
      const frame = this.parseFrame(rawFrame);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  flush(): SseFrame[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (!rest) return [];
    const frame = this.parseFrame(rest);
    return frame ? [frame] : [];
  }

  private nextSeparator(): number {
    const lf = this.buffer.indexOf('\n\n');
    const crlf = this.buffer.indexOf('\r\n\r\n');
    if (lf === -1) return crlf;
    if (crlf === -1) return lf;
    return Math.min(lf, crlf);
  }

  private advanceAfterSeparator(separator: number): number {
    return this.buffer.startsWith('\r\n\r\n', separator) ? separator + 4 : separator + 2;
  }

  private parseFrame(raw: string): SseFrame | null {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length === 0 && event === undefined) return null;
    return { event, data: data.join('\n') };
  }
}
