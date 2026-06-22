#!/usr/bin/env python3
"""Start a Raspberry Pi as a configured Kesher intercom station."""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import sys
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen


def require_text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'{field} must be a non-empty string')
    return value.strip()


def normalize_server_url(value: Any) -> str:
    server_url = require_text(value, "server_url").rstrip("/")
    parsed = urlsplit(server_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("server_url must be an http or https URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("server_url must not contain credentials, query, or fragment")
    path = parsed.path.rstrip("/")
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def load_config(path: Path) -> dict[str, Any]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ValueError(f"config file not found: {path}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"invalid JSON in {path}: {error}") from error
    if not isinstance(raw, dict):
        raise ValueError("config root must be an object")
    raw["server_url"] = normalize_server_url(raw.get("server_url"))
    clients = raw.get("clients")
    if not isinstance(clients, list) or not clients:
        raise ValueError("clients must be a non-empty array")
    return raw


def detect_ipv4_addresses() -> list[str]:
    override = os.environ.get("KESHER_PI_IP", "").strip()
    if override:
        return [str(ipaddress.ip_address(override))]
    result = subprocess.run(
        ["ip", "-4", "-o", "addr", "show", "scope", "global"],
        check=True,
        capture_output=True,
        text=True,
    )
    addresses: list[str] = []
    for line in result.stdout.splitlines():
        fields = line.split()
        if "inet" not in fields:
            continue
        index = fields.index("inet")
        if index + 1 < len(fields):
            addresses.append(str(ipaddress.ip_interface(fields[index + 1]).ip))
    return addresses


def resolve_client(config: dict[str, Any], addresses: list[str]) -> dict[str, Any]:
    local_addresses = set(addresses)
    matches: list[dict[str, Any]] = []
    seen_config_ips: set[str] = set()
    for index, raw_client in enumerate(config["clients"]):
        if not isinstance(raw_client, dict):
            raise ValueError(f"clients[{index}] must be an object")
        configured_ip = str(
            ipaddress.ip_address(
                require_text(raw_client.get("ip_address"), f"clients[{index}].ip_address")
            )
        )
        if configured_ip in seen_config_ips:
            raise ValueError(f"duplicate client IP in config: {configured_ip}")
        seen_config_ips.add(configured_ip)
        name = require_text(raw_client.get("name"), f"clients[{index}].name")
        if any(character.isspace() for character in name):
            raise ValueError(f"clients[{index}].name must not contain whitespace")
        role_id = require_text(raw_client.get("role_id"), f"clients[{index}].role_id")
        client = {
            "ip_address": configured_ip,
            "name": name,
            "role_id": role_id,
            "low_power_mode": raw_client.get("low_power_mode", False),
        }
        if not isinstance(client["low_power_mode"], bool):
            raise ValueError(f"clients[{index}].low_power_mode must be a boolean")
        for optional_field in ("audio_input_match", "audio_output_match"):
            value = raw_client.get(optional_field)
            if isinstance(value, str) and value.strip():
                client[optional_field] = value.strip()
        if configured_ip in local_addresses:
            matches.append(client)
    if not matches:
        detected = ", ".join(sorted(local_addresses)) or "none"
        raise ValueError(f"no client entry matches this Pi; detected IPs: {detected}")
    if len(matches) > 1:
        matched = ", ".join(client["ip_address"] for client in matches)
        raise ValueError(f"multiple client entries match this Pi: {matched}")
    return matches[0]


def build_kesher_url(server_url: str, client: dict[str, Any]) -> str:
    params = {
        "autoLogin": "1",
        "autoTakeover": "1",
        "username": client["name"],
        "roleId": client["role_id"],
    }
    if client.get("audio_input_match"):
        params["audioInputMatch"] = client["audio_input_match"]
    if client.get("audio_output_match"):
        params["audioOutputMatch"] = client["audio_output_match"]
    if client.get("low_power_mode") is True:
        params["lowPower"] = "1"
    return f"{server_url}/?{urlencode(params)}"


def wait_for_server(server_url: str, allow_insecure_tls: bool) -> None:
    health_url = f"{server_url}/api/healthz"
    ssl_context = None
    if allow_insecure_tls and health_url.startswith("https://"):
        ssl_context = ssl._create_unverified_context()
    while True:
        try:
            request = Request(health_url, headers={"User-Agent": "Kesher-Pi-Launcher/1"})
            with urlopen(request, timeout=3, context=ssl_context) as response:
                if 200 <= response.status < 300:
                    return
        except (HTTPError, URLError, TimeoutError, OSError):
            pass
        print(f"Kesher server not ready at {health_url}; retrying in 3 seconds", flush=True)
        time.sleep(3)


def resolve_browser(configured_binary: Any) -> str:
    candidates = []
    if isinstance(configured_binary, str) and configured_binary.strip():
        candidates.append(configured_binary.strip())
    candidates.extend(["chromium", "chromium-browser"])
    for candidate in candidates:
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
    raise ValueError("Chromium not found; install chromium or set browser_binary")


def browser_command(
    config: dict[str, Any], kesher_url: str, low_power_mode: bool = False
) -> list[str]:
    server_url = config["server_url"]
    parsed = urlsplit(server_url)
    origin = urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
    profile_dir = Path.home() / ".local" / "share" / "kesher-kiosk"
    command = [
        resolve_browser(config.get("browser_binary")),
        "--kiosk",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-session-crashed-bubble",
        "--autoplay-policy=no-user-gesture-required",
        "--use-fake-ui-for-media-stream",
        f"--user-data-dir={profile_dir}",
    ]
    if parsed.scheme == "http":
        command.append(f"--unsafely-treat-insecure-origin-as-secure={origin}")
    if config.get("allow_insecure_tls") is True:
        command.append("--ignore-certificate-errors")
    if low_power_mode:
        command.extend(
            [
                "--force-prefers-reduced-motion",
                "--disable-smooth-scrolling",
                "--process-per-site",
                "--renderer-process-limit=2",
            ]
        )
    command.append(kesher_url)
    return command


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--config",
        type=Path,
        default=Path("/etc/kesher/raspberry-pis.json"),
    )
    parser.add_argument("--print-url", action="store_true")
    args = parser.parse_args()
    try:
        config = load_config(args.config)
        addresses = detect_ipv4_addresses()
        client = resolve_client(config, addresses)
        kesher_url = build_kesher_url(config["server_url"], client)
        if args.print_url:
            print(kesher_url)
            return 0
        print(
            f'Starting Kesher station {client["name"]} '
            f'with role {client["role_id"]} for {client["ip_address"]}',
            flush=True,
        )
        wait_for_server(
            config["server_url"],
            config.get("allow_insecure_tls") is True,
        )
        return subprocess.run(
            browser_command(
                config,
                kesher_url,
                client.get("low_power_mode") is True,
            ),
            check=False,
        ).returncode
    except (ValueError, subprocess.SubprocessError) as error:
        print(f"Kesher Pi configuration error: {error}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
