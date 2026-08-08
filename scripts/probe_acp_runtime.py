#!/usr/bin/env python3
"""Probe an ACP stdio runtime through initialize and session/new."""

from __future__ import annotations

import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any


class ProbeError(Exception):
    pass


def parse_environment(values: list[str]) -> dict[str, str]:
    result = dict(os.environ)
    for value in values:
        key, separator, item = value.partition("=")
        if not separator or not key:
            raise ProbeError(f"invalid --env value: {value}")
        result[key] = item
    result.setdefault("NO_BROWSER", "1")
    return result


def available_command_names(
    notifications: list[dict[str, Any]], session_id: str
) -> set[str]:
    names: set[str] = set()
    for notification in notifications:
        if notification.get("method") != "session/update":
            continue
        params = notification.get("params")
        if not isinstance(params, dict) or params.get("sessionId") != session_id:
            continue
        update = params.get("update")
        if (
            not isinstance(update, dict)
            or update.get("sessionUpdate") != "available_commands_update"
        ):
            continue
        commands = update.get("availableCommands")
        if not isinstance(commands, list):
            continue
        for command in commands:
            if not isinstance(command, dict):
                continue
            name = command.get("name")
            if isinstance(name, str) and name.strip():
                names.add(name.strip())
    return names


class ACPProcess:
    def __init__(
        self, command: list[str], cwd: Path, env: dict[str, str], timeout: float
    ):
        self.timeout = timeout
        self.process = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=False,
            shell=False,
        )
        if (
            self.process.stdin is None
            or self.process.stdout is None
            or self.process.stderr is None
        ):
            raise ProbeError("failed to open ACP stdio pipes")
        self.output_queue: queue.Queue[tuple[str, bytes]] = queue.Queue()
        self.stdout_thread = threading.Thread(
            target=self._read_stream, args=("stdout", self.process.stdout), daemon=True
        )
        self.stderr_thread = threading.Thread(
            target=self._read_stream, args=("stderr", self.process.stderr), daemon=True
        )
        self.stdout_thread.start()
        self.stderr_thread.start()
        self.stderr_buffer = b""
        self.notifications: list[dict[str, Any]] = []

    def _read_stream(self, name: str, stream: Any) -> None:
        for line in iter(stream.readline, b""):
            self.output_queue.put((name, line))

    def send(self, payload: dict[str, Any]) -> None:
        if self.process.stdin is None:
            raise ProbeError("ACP stdin is closed")
        self.process.stdin.write(
            json.dumps(payload, separators=(",", ":")).encode() + b"\n"
        )
        self.process.stdin.flush()

    def call(self, request_id: int, method: str, params: dict[str, Any]) -> Any:
        self.send(
            {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        )
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise ProbeError(
                    f"ACP runtime exited with {self.process.returncode}: {self.stderr_text()}"
                )
            try:
                stream, line = self.output_queue.get(timeout=max(0.0, deadline - time.monotonic()))
            except queue.Empty:
                break
            if stream == "stderr":
                self.stderr_buffer += line
                continue
            if not line.strip():
                continue
            message = self.parse_message(line)
            if message.get("id") == request_id and (
                "result" in message or "error" in message
            ):
                if "error" in message:
                    raise ProbeError(
                        f"ACP {method} failed: {json.dumps(message['error'], ensure_ascii=False)}"
                    )
                return message.get("result")
            if "method" in message and "id" in message:
                self.send(
                    {
                        "jsonrpc": "2.0",
                        "id": message["id"],
                        "error": {
                            "code": -32601,
                            "message": "probe client method unsupported",
                        },
                    }
                )
            else:
                self.notifications.append(message)
        raise ProbeError(f"ACP {method} timed out after {self.timeout:g}s")

    def drain(self, duration: float) -> None:
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline and self.process.poll() is None:
            try:
                stream, line = self.output_queue.get(timeout=max(0.0, deadline - time.monotonic()))
            except queue.Empty:
                break
            if stream == "stderr":
                self.stderr_buffer += line
                continue
            if not line.strip():
                continue
            message = self.parse_message(line)
            if "method" in message and "id" in message:
                self.send(
                    {
                        "jsonrpc": "2.0",
                        "id": message["id"],
                        "error": {
                            "code": -32601,
                            "message": "probe client method unsupported",
                        },
                    }
                )
            else:
                self.notifications.append(message)

    @staticmethod
    def parse_message(line: bytes) -> dict[str, Any]:
        try:
            message = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ProbeError(
                f"ACP stdout contained invalid JSON: {line[:200]!r}"
            ) from exc
        if not isinstance(message, dict):
            raise ProbeError("ACP stdout message must be a JSON object")
        return message

    def stderr_text(self) -> str:
        return self.stderr_buffer.decode("utf-8", errors="replace").strip()

    def close(self) -> None:
        if self.process.stdin is not None:
            self.process.stdin.close()
        if self.process.poll() is None:
            if os.name == "nt":
                subprocess.run(
                    ["taskkill.exe", "/PID", str(self.process.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
            if self.process.poll() is None:
                self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cwd", type=Path, default=Path.cwd())
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--env", action="append", default=[])
    parser.add_argument("--initialize-only", action="store_true")
    parser.add_argument(
        "--probe-auth-command",
        action="store_true",
        help=(
            "after session/new, invoke the local /auth command to verify its "
            "headless behavior without sending a model prompt"
        ),
    )
    parser.add_argument(
        "--notification-wait",
        type=float,
        default=3.0,
        help="seconds to collect asynchronous session notifications",
    )
    parser.add_argument(
        "--expect-command",
        action="append",
        default=[],
        help=(
            "require an ACP available_commands_update entry with this exact "
            "command name; may be repeated"
        ),
    )
    parser.add_argument(
        "--summary-only",
        action="store_true",
        help="emit only the runtime version and verified command names",
    )
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("provide the ACP runtime command after --")
    cwd = args.cwd.resolve()
    if not cwd.is_dir():
        parser.error(f"--cwd is not a directory: {cwd}")
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    if args.notification_wait < 0:
        parser.error("--notification-wait must not be negative")

    runtime: ACPProcess | None = None
    try:
        runtime = ACPProcess(command, cwd, parse_environment(args.env), args.timeout)
        initialize = runtime.call(
            1,
            "initialize",
            {
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": {"readTextFile": False, "writeTextFile": False},
                    "terminal": False,
                },
                "clientInfo": {
                    "name": "tutti-agent-extension-probe",
                    "version": "1.0.0",
                },
            },
        )
        result: dict[str, Any] = {"status": "ok", "initialize": initialize}
        if not args.initialize_only:
            session = runtime.call(
                2,
                "session/new",
                {"cwd": os.fspath(cwd), "mcpServers": []},
            )
            if (
                not isinstance(session, dict)
                or not str(session.get("sessionId", "")).strip()
            ):
                raise ProbeError("ACP session/new returned no sessionId")
            result["sessionNew"] = session
            if args.probe_auth_command:
                result["authCommand"] = runtime.call(
                    3,
                    "session/prompt",
                    {
                        "sessionId": session["sessionId"],
                        "prompt": [{"type": "text", "text": "/auth"}],
                    },
                )
            runtime.drain(args.notification_wait)
            expected_commands = {
                command.strip() for command in args.expect_command if command.strip()
            }
            if expected_commands:
                discovered_commands = available_command_names(
                    runtime.notifications, session["sessionId"]
                )
                missing_commands = sorted(expected_commands - discovered_commands)
                if missing_commands:
                    raise ProbeError(
                        "ACP available_commands_update missing expected command(s): "
                        + ", ".join(missing_commands)
                    )
                result["expectedCommands"] = sorted(expected_commands)
        if args.summary_only:
            result = {
                "status": result["status"],
                "agentVersion": initialize.get("agentInfo", {}).get("version"),
                "expectedCommands": result.get("expectedCommands", []),
            }
        else:
            result["notifications"] = runtime.notifications
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (OSError, ProbeError) as exc:
        print(
            json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False),
            file=sys.stderr,
        )
        return 1
    finally:
        if runtime is not None:
            runtime.close()


if __name__ == "__main__":
    raise SystemExit(main())
