import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, List


_records: List[Dict[str, Any]] = []


def record_runtime(summary: Dict[str, Any]) -> None:
    safe = {
        "traceId": summary.get("traceId"),
        "agentRunId": summary.get("agentRunId"),
        "conversationId": summary.get("conversationId"),
        "messageId": summary.get("messageId"),
        "turns": summary.get("turns", 0),
        "toolCalls": summary.get("toolCalls", 0),
        "toolNames": summary.get("toolNames", []),
        "status": summary.get("status"),
        "errorCode": summary.get("errorCode"),
        "durationMs": summary.get("durationMs", 0),
        "recordedAt": datetime.now(timezone.utc).isoformat(),
    }
    _records.append(safe)
    path = os.getenv("AGENT_AUDIT_PATH")
    if path:
        try:
            with open(path, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(safe, ensure_ascii=False) + "\n")
        except OSError:
            pass


def recent_records() -> List[Dict[str, Any]]:
    return list(_records)
