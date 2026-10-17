#!/usr/bin/env python3
"""LocalMark remote-storage prototype.

This deliberately uses only Python's standard library so the prototype can be
run on a fresh machine. The HTTP contract is intentionally close to the future
FastAPI service.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("LOCALMARK_DB_PATH", ROOT / "data" / "localmark.sqlite3"))
STATIC_DIR = ROOT / "static"
HOST = os.environ.get("LOCALMARK_HOST", "127.0.0.1")
PORT = int(os.environ.get("LOCALMARK_PORT", "8000"))
SESSION_DAYS = 30
PAGE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$")


def now() -> int:
    return int(time.time())


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


def init_db() -> None:
    with connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              email TEXT NOT NULL UNIQUE,
              password_hash TEXT NOT NULL,
              password_salt TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
              token_hash TEXT PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              expires_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS pages (
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              page_id TEXT NOT NULL,
              data_json TEXT NOT NULL,
              revision INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY (user_id, page_id)
            );
            """
        )


def password_digest(password: str, salt: bytes) -> str:
    value = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return base64.urlsafe_b64encode(value).decode()


def make_password(password: str) -> tuple[str, str]:
    salt = secrets.token_bytes(16)
    return base64.urlsafe_b64encode(salt).decode(), password_digest(password, salt)


def verify_password(password: str, salt_text: str, expected: str) -> bool:
    salt = base64.urlsafe_b64decode(salt_text.encode())
    return hmac.compare_digest(password_digest(password, salt), expected)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def validate_email(value: object) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
        raise ValueError("邮箱格式无效")
    return value.strip().lower()


def validate_password(value: object) -> str:
    if not isinstance(value, str) or len(value) < 8 or len(value) > 200:
        raise ValueError("密码长度必须为 8 到 200 个字符")
    return value


class APIError(Exception):
    def __init__(self, status: int, message: str, extra: dict | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra or {}


class Handler(BaseHTTPRequestHandler):
    server_version = "LocalMarkPrototype/0.1"

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def send_json(self, status: int, value: dict) -> None:
        raw = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", "*"))
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, If-Match")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.end_headers()
        self.wfile.write(raw)

    def send_error_json(self, error: APIError) -> None:
        payload = {"error": error.message, **error.extra}
        self.send_json(error.status, payload)

    def read_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 2_000_000:
                raise APIError(413, "请求体过大")
            value = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(value, dict):
                raise APIError(400, "请求体必须是 JSON 对象")
            return value
        except json.JSONDecodeError as exc:
            raise APIError(400, "JSON 格式无效") from exc

    def user_id(self) -> int:
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            raise APIError(401, "请先登录")
        token = header[7:].strip()
        if not token:
            raise APIError(401, "登录令牌无效")
        with connect() as db:
            row = db.execute(
                "SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?",
                (token_hash(token), now()),
            ).fetchone()
        if row is None:
            raise APIError(401, "登录已过期或令牌无效")
        return int(row["user_id"])

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", "*"))
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, If-Match")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:
        try:
            path = urlparse(self.path).path
            if path == "/":
                return self.serve_static("index.html")
            if path == "/api/health":
                return self.send_json(200, {"ok": True, "service": "localmark-prototype"})
            if path == "/api/me":
                uid = self.user_id()
                with connect() as db:
                    user = db.execute("SELECT id, email, created_at FROM users WHERE id = ?", (uid,)).fetchone()
                return self.send_json(200, {"id": user["id"], "email": user["email"], "createdAt": user["created_at"]})
            if path == "/api/pages":
                uid = self.user_id()
                with connect() as db:
                    rows = db.execute("SELECT page_id, revision, updated_at FROM pages WHERE user_id = ? ORDER BY updated_at DESC", (uid,)).fetchall()
                return self.send_json(200, {"pages": [dict(row) for row in rows]})
            match = re.fullmatch(r"/api/pages/([^/]+)", path)
            if match:
                return self.get_page(match.group(1))
            raise APIError(404, "接口不存在")
        except APIError as error:
            self.send_error_json(error)

    def do_POST(self) -> None:
        try:
            path = urlparse(self.path).path
            body = self.read_json()
            if path == "/api/auth/register":
                return self.register(body)
            if path == "/api/auth/login":
                return self.login(body)
            if path == "/api/auth/logout":
                self.logout()
                return self.send_json(200, {"ok": True})
            if path == "/api/pages":
                return self.create_page(body)
            raise APIError(404, "接口不存在")
        except APIError as error:
            self.send_error_json(error)

    def do_PUT(self) -> None:
        try:
            match = re.fullmatch(r"/api/pages/([^/]+)", urlparse(self.path).path)
            if not match:
                raise APIError(404, "接口不存在")
            self.update_page(match.group(1), self.read_json())
        except APIError as error:
            self.send_error_json(error)

    def serve_static(self, filename: str) -> None:
        target = (STATIC_DIR / filename).resolve()
        if STATIC_DIR.resolve() not in target.parents:
            raise APIError(404, "文件不存在")
        try:
            raw = target.read_bytes()
        except FileNotFoundError as exc:
            raise APIError(404, "文件不存在") from exc
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def register(self, body: dict) -> None:
        try:
            email = validate_email(body.get("email"))
            password = validate_password(body.get("password"))
        except ValueError as exc:
            raise APIError(400, str(exc)) from exc
        salt, digest = make_password(password)
        try:
            with connect() as db:
                db.execute("INSERT INTO users(email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?)", (email, digest, salt, now()))
        except sqlite3.IntegrityError as exc:
            raise APIError(409, "邮箱已经注册") from exc
        return self.login({"email": email, "password": password})

    def login(self, body: dict) -> None:
        try:
            email = validate_email(body.get("email"))
            password = validate_password(body.get("password"))
        except ValueError as exc:
            raise APIError(400, str(exc)) from exc
        with connect() as db:
            user = db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
            if user is None or not verify_password(password, user["password_salt"], user["password_hash"]):
                raise APIError(401, "邮箱或密码错误")
            token = secrets.token_urlsafe(32)
            db.execute("INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)", (token_hash(token), user["id"], now() + SESSION_DAYS * 86400))
        self.send_json(200, {"token": token, "user": {"id": user["id"], "email": user["email"]}})

    def logout(self) -> None:
        header = self.headers.get("Authorization", "")
        if header.startswith("Bearer "):
            with connect() as db:
                db.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(header[7:].strip()),))

    def page_id(self, raw: str) -> str:
        if not PAGE_ID_RE.fullmatch(raw):
            raise APIError(400, "网页 ID 格式无效")
        return raw

    def get_page(self, raw_page_id: str) -> None:
        uid = self.user_id()
        page_id = self.page_id(raw_page_id)
        with connect() as db:
            row = db.execute("SELECT page_id, data_json, revision, updated_at FROM pages WHERE user_id = ? AND page_id = ?", (uid, page_id)).fetchone()
        if row is None:
            raise APIError(404, "网页不存在")
        self.send_json(200, {"pageId": row["page_id"], "data": json.loads(row["data_json"]), "revision": row["revision"], "updatedAt": row["updated_at"]})

    def create_page(self, body: dict) -> None:
        uid = self.user_id()
        page_id = self.page_id(str(body.get("pageId", "")))
        data = body.get("data")
        if not isinstance(data, dict):
            raise APIError(400, "data 必须是 JSON 对象")
        with connect() as db:
            try:
                db.execute("INSERT INTO pages(user_id, page_id, data_json, revision, updated_at) VALUES (?, ?, ?, 1, ?)", (uid, page_id, json.dumps(data, ensure_ascii=False), now()))
            except sqlite3.IntegrityError as exc:
                raise APIError(409, "网页已存在，请使用 PUT 同步") from exc
        self.send_json(201, {"pageId": page_id, "data": data, "revision": 1})

    def update_page(self, raw_page_id: str, body: dict) -> None:
        uid = self.user_id()
        page_id = self.page_id(raw_page_id)
        data = body.get("data")
        if not isinstance(data, dict):
            raise APIError(400, "data 必须是 JSON 对象")
        expected_header = self.headers.get("If-Match")
        if expected_header is None or not expected_header.isdigit():
            raise APIError(428, "PUT 必须提供 If-Match revision")
        expected = int(expected_header)
        with connect() as db:
            row = db.execute("SELECT data_json, revision, updated_at FROM pages WHERE user_id = ? AND page_id = ?", (uid, page_id)).fetchone()
            if row is None:
                raise APIError(404, "网页不存在")
            if row["revision"] != expected:
                raise APIError(409, "网页已在其他设备修改", {"pageId": page_id, "serverData": json.loads(row["data_json"]), "serverRevision": row["revision"], "clientData": data, "clientRevision": expected})
            revision = expected + 1
            timestamp = now()
            db.execute("UPDATE pages SET data_json = ?, revision = ?, updated_at = ? WHERE user_id = ? AND page_id = ? AND revision = ?", (json.dumps(data, ensure_ascii=False), revision, timestamp, uid, page_id, expected))
        self.send_json(200, {"pageId": page_id, "data": data, "revision": revision, "updatedAt": timestamp})


def main() -> None:
    init_db()
    print(f"LocalMark prototype listening on http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
