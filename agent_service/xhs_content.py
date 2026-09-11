from __future__ import annotations

import json
import re
from collections.abc import Iterator
from typing import Any

from .config import XhsMcpSettings
from .schemas import XhsComment, XhsPost, XhsSearchResult


_SENSITIVE_TEXT = re.compile(
    r"(?i)\b(xsec[_-]?token|cookie|authorization)\b\s*[:=]\s*[^\s,;]+"
)
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class XhsMcpToolError(RuntimeError):
    """The MCP transport succeeded, but the upstream tool returned an error."""


def parse_mcp_payload(result: Any) -> Any:
    if getattr(result, "isError", False) or getattr(result, "is_error", False):
        raise XhsMcpToolError("MCP tool returned an error")
    structured = getattr(result, "structuredContent", None)
    if structured is None:
        structured = getattr(result, "structured_content", None)
    if structured is not None:
        return structured

    values: list[Any] = []
    for block in getattr(result, "content", []) or []:
        text = getattr(block, "text", None)
        if not isinstance(text, str):
            continue
        try:
            values.append(json.loads(text))
        except json.JSONDecodeError:
            values.append(text)
    if not values:
        raise ValueError("MCP response has no supported content")
    return values[0] if len(values) == 1 else values


def parse_login_status(value: Any) -> bool | None:
    for item in _walk(value):
        if isinstance(item, dict):
            for key in ("logged_in", "loggedIn", "is_logged_in", "isLoggedIn"):
                if isinstance(item.get(key), bool):
                    return item[key]
        if isinstance(item, str):
            lowered = item.lower()
            if "未登录" in item or "not logged" in lowered:
                return False
            if "已登录" in item or "logged in" in lowered:
                return True
    return None


def extract_feed_candidates(value: Any, limit: int) -> list[dict[str, str]]:
    candidates: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in _walk(value):
        if not isinstance(item, dict):
            continue
        feed_id = _string(item, "feed_id", "feedId", "id", "note_id", "noteId")
        token = _string(item, "xsec_token", "xsecToken")
        if not feed_id or not token or feed_id in seen:
            continue
        note_card = item.get("note_card") or item.get("noteCard") or {}
        candidates.append(
            {
                "feed_id": feed_id,
                "xsec_token": token,
                "title": _string(
                    note_card,
                    "display_title",
                    "displayTitle",
                    "title",
                ),
            }
        )
        seen.add(feed_id)
        if len(candidates) >= limit:
            break
    return candidates


def parse_post(
    value: Any,
    candidate: dict[str, str],
    settings: XhsMcpSettings,
    remaining: int,
) -> XhsPost | None:
    note = _find_note(value)
    if note is None:
        return None
    author = (
        note.get("user")
        or note.get("author")
        or note.get("user_info")
        or note.get("userInfo")
        or {}
    )
    tags_value = note.get("tag_list") or note.get("tagList") or note.get("tags") or []
    comments_value = (
        note.get("comment_list")
        or note.get("commentList")
        or note.get("comments")
        or _find_key(value, {"comment_list", "commentList", "comments"})
        or []
    )

    tags: list[str] = []
    for tag in _as_list(tags_value):
        raw = _string(tag, "name", "title", "text") if isinstance(tag, dict) else str(tag)
        name = clean_text(raw, 80)
        if name and name not in tags:
            tags.append(name)

    comments: list[XhsComment] = []
    for comment in _as_list(comments_value)[: settings.comment_limit]:
        if not isinstance(comment, dict):
            continue
        text = clean_text(
            _string(comment, "content", "text", "desc"),
            settings.comment_character_limit,
        )
        if not text:
            continue
        user = (
            comment.get("user_info")
            or comment.get("userInfo")
            or comment.get("user")
            or {}
        )
        comments.append(
            XhsComment(
                author_name=clean_text(_string(user, "nickname", "name"), 80),
                text=text,
            )
        )

    post = XhsPost(
        post_id=candidate["feed_id"],
        title=clean_text(
            _string(note, "title", "display_title", "displayTitle")
            or candidate["title"],
            300,
        )
        or "小红书笔记",
        author_name=clean_text(_string(author, "nickname", "name"), 80),
        text=clean_text(
            _string(note, "desc", "description", "text", "content"),
            settings.post_character_limit,
        ),
        tags=tags,
        comments=comments,
        source_url=f"https://www.xiaohongshu.com/explore/{candidate['feed_id']}",
    )
    while post.comments and post_size(post) > remaining:
        post.comments.pop()
    if post_size(post) > remaining:
        post.text = post.text[: max(0, remaining - 500)]
    return post if post.text or post.comments else None


def clean_text(value: str, limit: int) -> str:
    cleaned = _CONTROL_CHARACTERS.sub(" ", value or "")
    cleaned = _SENSITIVE_TEXT.sub("[redacted]", cleaned)
    return " ".join(cleaned.split())[:limit]


def post_size(post: XhsPost) -> int:
    return len(post.model_dump_json())


def mock_result(query: str) -> XhsSearchResult:
    return XhsSearchResult(
        status="succeeded",
        mode="mock",
        posts=[
            XhsPost(
                post_id="mock_low_saturation_commute",
                title="本地模拟：低饱和通勤妆",
                text=f"用于本地测试的模拟内容，搜索词：{query}。薄透底妆、灰棕眉眼和豆沙唇。",
                tags=["mock", "通勤妆"],
            )
        ],
    )


def _find_note(value: Any) -> dict[str, Any] | None:
    for item in _walk(value):
        if not isinstance(item, dict):
            continue
        nested = item.get("note_card") or item.get("noteCard") or item.get("note")
        if isinstance(nested, dict):
            return nested
        if any(
            key in item
            for key in ("desc", "description", "comment_list", "commentList")
        ):
            return item
    return None


def _walk(value: Any) -> Iterator[Any]:
    yield value
    if isinstance(value, dict):
        for nested in value.values():
            yield from _walk(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from _walk(nested)


def _find_key(value: Any, keys: set[str]) -> Any:
    for item in _walk(value):
        if isinstance(item, dict):
            for key in keys:
                if key in item:
                    return item[key]
    return None


def _string(value: Any, *keys: str) -> str:
    if not isinstance(value, dict):
        return ""
    for key in keys:
        item = value.get(key)
        if isinstance(item, (str, int)):
            return str(item)
    return ""


def _as_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for key in ("list", "items", "data", "comments", "tags"):
            if isinstance(value.get(key), list):
                return value[key]
    return []
