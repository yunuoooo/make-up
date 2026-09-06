from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from agents import SQLiteSession as SDKSQLiteSession


class ConversationOwnershipError(PermissionError):
    """Raised when a conversation id belongs to another user."""


def _item_text(item: Any) -> str:
    if isinstance(item, dict):
        role = str(item.get("role", "item"))
        content = item.get("content", item)
    else:
        role = "item"
        content = item
    if isinstance(content, str):
        text = content
    else:
        text = json.dumps(content, ensure_ascii=False, default=str, separators=(",", ":"))
    return "%s: %s" % (role, text[:240])


class SQLiteSession(SDKSQLiteSession):
    """Agents SDK session with a bounded, explicitly marked history view."""

    def __init__(self, *args: Any, max_items: int = 32, **kwargs: Any):
        super().__init__(*args, **kwargs)
        self.max_items = max(2, int(max_items))

    async def get_items(self, limit: Optional[int] = None) -> List[Any]:
        items = await super().get_items(limit=None)
        if limit is not None:
            return items[-limit:]
        if len(items) <= self.max_items:
            return items

        keep_count = self.max_items - 1
        dropped = items[:-keep_count]
        details = " | ".join(_item_text(item) for item in dropped)
        summary = {
            "role": "system",
            "content": (
                "服务端压缩摘要：以下内容来自较早会话，可能不完整；不确定事实不得当作用户事实。"
                "来源条目数=%d；%s" % (len(dropped), details[:1800])
            ),
        }
        return [summary] + items[-keep_count:]


class SQLiteSessionStore:
    """Shared-database SDK session factory with ownership and history limits."""

    def __init__(self, db_path: Path | str = ".local-data/agent-sessions.sqlite", max_items: int = 32):
        self.db_path = Path(db_path)
        self.max_items = max(2, int(max_items))
        if str(self.db_path) != ":memory:":
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._sessions: Dict[str, SQLiteSession] = {}
        self._lock = threading.RLock()
        self._memory_connection: Optional[sqlite3.Connection] = None
        if str(self.db_path) == ":memory:":
            self._memory_connection = sqlite3.connect(":memory:", check_same_thread=False)
        self._initialize_registry()

    def _connection(self) -> sqlite3.Connection:
        if self._memory_connection is not None:
            return self._memory_connection
        return sqlite3.connect(str(self.db_path), timeout=10)

    def _initialize_registry(self) -> None:
        with self._lock:
            connection = self._connection()
            try:
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS looktrace_conversations (
                        conversation_id TEXT PRIMARY KEY,
                        user_id TEXT NOT NULL,
                        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
                connection.commit()
            finally:
                if self._memory_connection is None:
                    connection.close()

    def ensure_conversation(self, user_id: str, conversation_id: str) -> None:
        if not user_id or not conversation_id:
            raise ValueError("user_id and conversation_id are required")
        with self._lock:
            connection = self._connection()
            try:
                row = connection.execute(
                    "SELECT user_id FROM looktrace_conversations WHERE conversation_id = ?",
                    (conversation_id,),
                ).fetchone()
                if row is not None and row[0] != user_id:
                    raise ConversationOwnershipError("conversation belongs to another user")
                if row is None:
                    connection.execute(
                        "INSERT INTO looktrace_conversations (conversation_id, user_id) VALUES (?, ?)",
                        (conversation_id, user_id),
                    )
                    connection.commit()
            finally:
                if self._memory_connection is None:
                    connection.close()

    def for_conversation(self, user_id: str, conversation_id: str) -> SQLiteSession:
        self.ensure_conversation(user_id, conversation_id)
        key = "%s:%s" % (user_id, conversation_id)
        session = self._sessions.get(key)
        if session is None:
            session = SQLiteSession(
                session_id=key,
                db_path=str(self.db_path),
                max_items=self.max_items,
            )
            self._sessions[key] = session
        return session
