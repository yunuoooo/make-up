import { readJson, writeJson } from "@/lib/storage/json-store";
import type { ToolRun } from "@/lib/types/domain";

const fileName = "tool-runs.json";

export async function appendToolRuns(runs: ToolRun[]): Promise<void> {
  const existing = await readJson<ToolRun[]>(fileName, []);
  await writeJson(fileName, [...runs, ...existing].slice(0, 500));
}
