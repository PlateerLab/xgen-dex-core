/**
 * Minimal SSE frame parser for the XGEN chat stream.
 *
 * XGEN emits two frame shapes, separated by a blank line (\n\n):
 *   1. Named events:  `event: <name>\ndata: <json>\n\n`
 *   2. Default events: `data: <json>\n\n`  (json carries a `type` field)
 *
 * `parseSseChunk` is a stateful, incremental parser: feed it raw text chunks as
 * they arrive off the network; it buffers partial frames and yields complete
 * `{ event, data }` records. A frame may also carry multiple `data:` lines
 * (concatenated with \n per the SSE spec).
 */

export interface SseFrame {
  /** The `event:` name, or undefined for a default ("message") frame. */
  event?: string;
  /** The concatenated `data:` payload (raw string; usually JSON). */
  data: string;
}

export class SseParser {
  private buffer = '';

  /** Feed a raw chunk; returns any complete frames it produced. */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    let sep: number;
    // Frames are separated by a blank line. Handle both \n\n and \r\n\r\n.
    while ((sep = this.nextSeparator()) !== -1) {
      const rawFrame = this.buffer.slice(0, sep.valueOf());
      this.buffer = this.buffer.slice(this.advanceAfterSeparator(sep));
      const frame = this.parseFrame(rawFrame);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  /** Flush any trailing frame not terminated by a blank line (stream end). */
  flush(): SseFrame[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (!rest) return [];
    const frame = this.parseFrame(rest);
    return frame ? [frame] : [];
  }

  private nextSeparator(): number {
    const a = this.buffer.indexOf('\n\n');
    const b = this.buffer.indexOf('\r\n\r\n');
    if (a === -1) return b;
    if (b === -1) return a;
    return Math.min(a, b);
  }

  private advanceAfterSeparator(sep: number): number {
    return this.buffer.startsWith('\r\n\r\n', sep) ? sep + 4 : sep + 2;
  }

  private parseFrame(raw: string): SseFrame | null {
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue; // comment / heartbeat
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (dataLines.length === 0 && event === undefined) return null;
    return { event, data: dataLines.join('\n') };
  }
}
