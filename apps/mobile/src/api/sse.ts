/**
 * Incremental parser for the host's `text/event-stream`: feed it text as it arrives, get whole
 * events back. Handles frames split across chunks, comment lines (`: keep-alive`) and CRLF.
 */
export interface SseMessage {
  readonly event: string;
  readonly data: string;
  readonly id?: string;
}

export class SseParser {
  private buffer = "";

  push(chunk: string): SseMessage[] {
    this.buffer += chunk.replace(/\r\n?/gu, "\n");
    const out: SseMessage[] = [];
    let end = this.buffer.indexOf("\n\n");
    while (end >= 0) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      const message = parseBlock(block);
      if (message) out.push(message);
      end = this.buffer.indexOf("\n\n");
    }
    return out;
  }
}

function parseBlock(block: string): SseMessage | undefined {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /u, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  if (data.length === 0) return undefined;
  return { event, data: data.join("\n"), ...(id === undefined ? {} : { id }) };
}
