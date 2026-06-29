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
import threading
import time
from typing import Any, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen


LAUNCHER_VERSION = "3"
HEARTBEAT_INTERVAL_SECONDS = 4


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
    heartbeat_secret = raw.get("heartbeat_secret")
    if heartbeat_secret is not None and not isinstance(heartbeat_secret, str):
        raise ValueError("heartbeat_secret must be a string when set")
    if isinstance(heartbeat_secret, str):
        raw["heartbeat_secret"] = heartbeat_secret.strip()
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
        device_id = raw_client.get("device_id")
        if isinstance(device_id, str) and device_id.strip():
            device_id = device_id.strip()
        else:
            device_id = configured_ip
        if any(character.isspace() for character in device_id):
            raise ValueError(f"clients[{index}].device_id must not contain whitespace")
        client = {
            "device_id": device_id,
            "ip_address": configured_ip,
            "name": name,
            "role_id": role_id,
            "low_power_mode": raw_client.get("low_power_mode", False),
            "simple_view": raw_client.get("simple_view", False),
        }
        if not isinstance(client["low_power_mode"], bool):
            raise ValueError(f"clients[{index}].low_power_mode must be a boolean")
        if not isinstance(client["simple_view"], bool):
            raise ValueError(f"clients[{index}].simple_view must be a boolean")
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
    if client.get("simple_view") is True:
        params["viewMode"] = "simple"
    return f"{server_url}/?{urlencode(params)}"


def ssl_context_for_url(url: str, allow_insecure_tls: bool) -> Optional[ssl.SSLContext]:
    if allow_insecure_tls and url.startswith("https://"):
        return ssl._create_unverified_context()
    return None


def read_cpu_times() -> Optional[tuple[int, int]]:
    try:
        line = Path("/proc/stat").read_text(encoding="utf-8").splitlines()[0]
    except (IndexError, OSError):
        return None
    fields = line.split()
    if len(fields) < 5 or fields[0] != "cpu":
        return None
    try:
        values = [int(value) for value in fields[1:]]
    except ValueError:
        return None
    idle = values[3] + (values[4] if len(values) > 4 else 0)
    total = sum(values)
    return total, idle


def read_memory_percent() -> Optional[float]:
    try:
        lines = Path("/proc/meminfo").read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    values: dict[str, int] = {}
    for line in lines:
        key, _, rest = line.partition(":")
        amount = rest.strip().split()[0:1]
        if amount:
            try:
                values[key] = int(amount[0])
            except ValueError:
                continue
    total = values.get("MemTotal", 0)
    available = values.get("MemAvailable", 0)
    if total <= 0 or available < 0:
        return None
    return max(0.0, min(100.0, ((total - available) / total) * 100.0))


def read_temperature_c() -> Optional[float]:
    candidates = [Path("/sys/class/thermal/thermal_zone0/temp")]
    candidates.extend(sorted(Path("/sys/class/thermal").glob("thermal_zone*/temp")))
    seen: set[Path] = set()
    for path in candidates:
        if path in seen:
            continue
        seen.add(path)
        try:
            raw = path.read_text(encoding="utf-8").strip()
            value = float(raw)
        except (OSError, ValueError):
            continue
        if value > 1000:
            value = value / 1000.0
        if -40.0 <= value <= 125.0:
            return value
    return None


class SystemMetricsSampler:
    def __init__(self) -> None:
        self._previous_cpu_times = read_cpu_times()

    def cpu_percent(self) -> Optional[float]:
        current = read_cpu_times()
        if current is None:
            return None
        previous = self._previous_cpu_times
        self._previous_cpu_times = current
        if previous is None:
            return None
        total_delta = current[0] - previous[0]
        idle_delta = current[1] - previous[1]
        if total_delta <= 0:
            return None
        busy_delta = max(0, total_delta - idle_delta)
        return max(0.0, min(100.0, (busy_delta / total_delta) * 100.0))

    def sample(self) -> dict[str, float]:
        metrics: dict[str, float] = {}
        cpu = self.cpu_percent()
        memory = read_memory_percent()
        temperature = read_temperature_c()
        if cpu is not None:
            metrics["cpuPercent"] = round(cpu, 1)
        if memory is not None:
            metrics["memoryPercent"] = round(memory, 1)
        if temperature is not None:
            metrics["temperatureC"] = round(temperature, 1)
        return metrics


def heartbeat_payload(
    client: dict[str, Any],
    browser_status: str,
    login_status: str,
    login_error: str = "",
    metrics: Optional[dict[str, float]] = None,
) -> dict[str, Any]:
    payload = {
        "deviceId": client["device_id"],
        "name": client["name"],
        "ipAddress": client["ip_address"],
        "roleId": client["role_id"],
        "lowPowerMode": client.get("low_power_mode") is True,
        "launcherVersion": LAUNCHER_VERSION,
        "browserStatus": browser_status,
        "loginStatus": login_status,
        "loginError": login_error,
    }
    if metrics:
        payload.update(metrics)
    return payload


def heartbeat_endpoint_url(config: dict[str, Any]) -> str:
    return f'{config["server_url"]}/api/raspberry-pi/heartbeat'


def send_heartbeat(
    config: dict[str, Any],
    client: dict[str, Any],
    browser_status: str,
    login_status: str,
    login_error: str = "",
    metrics_sampler: Optional[SystemMetricsSampler] = None,
) -> bool:
    heartbeat_url = heartbeat_endpoint_url(config)
    metrics = metrics_sampler.sample() if metrics_sampler else None
    payload = json.dumps(
        heartbeat_payload(client, browser_status, login_status, login_error, metrics),
        separators=(",", ":"),
    ).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "User-Agent": f"Kesher-Pi-Launcher/{LAUNCHER_VERSION}",
    }
    heartbeat_secret = config.get("heartbeat_secret")
    if isinstance(heartbeat_secret, str) and heartbeat_secret:
        headers["X-Kesher-Pi-Secret"] = heartbeat_secret
    request = Request(heartbeat_url, data=payload, headers=headers, method="POST")
    try:
        with urlopen(
            request,
            timeout=3,
            context=ssl_context_for_url(
                heartbeat_url,
                config.get("allow_insecure_tls") is True,
            ),
        ) as response:
            return 200 <= response.status < 300
    except (HTTPError, URLError, TimeoutError, OSError):
        return False


def start_heartbeat_loop(
    config: dict[str, Any],
    client: dict[str, Any],
    state: dict[str, str],
    state_lock: threading.Lock,
    stop_event: threading.Event,
) -> threading.Thread:
    metrics_sampler = SystemMetricsSampler()

    def run() -> None:
        while True:
            with state_lock:
                browser_status = state.get("browser_status", "unknown")
                login_status = state.get("login_status", "unknown")
                login_error = state.get("login_error", "")
            send_heartbeat(
                config,
                client,
                browser_status,
                login_status,
                login_error,
                metrics_sampler,
            )
            if stop_event.wait(HEARTBEAT_INTERVAL_SECONDS):
                return

    thread = threading.Thread(target=run, name="kesher-pi-heartbeat", daemon=True)
    thread.start()
    return thread


def update_heartbeat_state(
    state: dict[str, str],
    state_lock: threading.Lock,
    *,
    browser_status: Optional[str] = None,
    login_status: Optional[str] = None,
    login_error: Optional[str] = None,
) -> None:
    with state_lock:
        if browser_status is not None:
            state["browser_status"] = browser_status
        if login_status is not None:
            state["login_status"] = login_status
        if login_error is not None:
            state["login_error"] = login_error


def wait_for_server(server_url: str, allow_insecure_tls: bool) -> None:
    health_url = f"{server_url}/api/healthz"
    ssl_context = ssl_context_for_url(health_url, allow_insecure_tls)
    while True:
        try:
            request = Request(
                health_url,
                headers={"User-Agent": f"Kesher-Pi-Launcher/{LAUNCHER_VERSION}"},
            )
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
                "--enable-low-end-device-mode",
                "--disable-background-networking",
                "--disable-component-update",
                "--disable-domain-reliability",
                "--disable-sync",
                "--disable-extensions",
                "--disable-print-preview",
                "--disable-pinch",
                "--overscroll-history-navigation=0",
                "--process-per-site",
                "--renderer-process-limit=2",
                "--js-flags=--max-old-space-size=96",
                "--disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints,AutofillServerCommunication,CalculateNativeWinOcclusion",
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
        heartbeat_state = {
            "browser_status": "not_started",
            "login_status": "waiting_for_server",
            "login_error": "",
        }
        heartbeat_state_lock = threading.Lock()
        heartbeat_stop = threading.Event()
        heartbeat_thread = start_heartbeat_loop(
            config,
            client,
            heartbeat_state,
            heartbeat_state_lock,
            heartbeat_stop,
        )
        print(
            f'Starting Kesher station {client["name"]} '
            f'with role {client["role_id"]} for {client["ip_address"]}',
            flush=True,
        )
        try:
            wait_for_server(
                config["server_url"],
                config.get("allow_insecure_tls") is True,
            )
            update_heartbeat_state(
                heartbeat_state,
                heartbeat_state_lock,
                browser_status="starting",
                login_status="starting_browser",
            )
            process = subprocess.Popen(
                browser_command(
                    config,
                    kesher_url,
                    client.get("low_power_mode") is True,
                )
            )
            update_heartbeat_state(
                heartbeat_state,
                heartbeat_state_lock,
                browser_status="running",
                login_status="waiting_for_intercom",
            )
            return_code = process.wait()
            update_heartbeat_state(
                heartbeat_state,
                heartbeat_state_lock,
                browser_status="exited",
                login_status="browser_exited",
                login_error=f"browser exited with code {return_code}",
            )
            send_heartbeat(
                config,
                client,
                "exited",
                "browser_exited",
                f"browser exited with code {return_code}",
            )
            return return_code
        finally:
            heartbeat_stop.set()
            heartbeat_thread.join(timeout=1)
    except (ValueError, subprocess.SubprocessError, OSError) as error:
        print(f"Kesher Pi configuration error: {error}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
