export type SseEvent = { event: string; data: unknown };

export function parseSseBlock(block: string): SseEvent | null {
  const lines = block.split("\n").filter(Boolean);
  const event = lines.find((line) => line.startsWith("event: "))?.replace("event: ", "");
  const data = lines
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.replace("data: ", ""))
    .join("\n");

  if (!event || !data) return null;

  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}

export async function* readSse(response: Response): AsyncGenerator<SseEvent> {
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";

      for (const block of blocks) {
        const parsed = parseSseBlock(block);
        if (parsed) yield parsed;
      }
    }

    buffer += decoder.decode();
    const parsed = parseSseBlock(buffer);
    if (parsed) yield parsed;
  } finally {
    reader.releaseLock();
  }
}
