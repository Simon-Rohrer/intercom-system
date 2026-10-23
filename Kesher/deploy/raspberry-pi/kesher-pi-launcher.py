#!/usr/bin/env python3
"""Start a Raspberry Pi as a configured Kesher intercom station."""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time
from typing import Any, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit, urlunsplit
from urllib.request import HTTPSHandler, HTTPRedirectHandler, ProxyHandler, Request, build_opener


LAUNCHER_VERSION = "15"
DEVICE_CERTIFICATE = Path("/etc/jms-device/client.crt")
DEVICE_PRIVATE_KEY = Path("/etc/jms-device/client.key")
SERVER_CA_CERTIFICATE = Path("/etc/jms-device/server-ca.crt")
HEARTBEAT_INTERVAL_SECONDS = 4
AUDIO_RUNTIME_WAIT_SECONDS = 3
DISPLAY_RUNTIME_WAIT_SECONDS = 15
DISPLAY_RUNTIME_SETTLE_SECONDS = 8
BROWSER_CONNECT_TIMEOUT_SECONDS = 25
BROWSER_CONNECT_POLL_SECONDS = 2
BROWSER_CONNECTED_CHECKS = 2
BROWSER_RESTART_DELAY_SECONDS = 2
DISPLAY_MODES = ("intercom", "multiview")
# Settings managed in the Multiview (Einstellungen → Raspberry Pis), see config_url
MANAGED_CONFIG_BOOT_WAIT_SECONDS = 15
MANAGED_CONFIG_POLL_SECONDS = 15
# Long-Poll: der Multiview hält die Anfrage bis zu so lange offen und antwortet sofort bei einer Änderung
MANAGED_CONFIG_LONG_POLL_SECONDS = 25
MANAGED_CONFIG_LONG_POLL_GAP_SECONDS = 1
# Chromium-Fernsteuerung nur auf 127.0.0.1: Intercom und Multiview sind zwei Tabs, umgeschaltet
# wird ohne Neustart des Browsers
DEVTOOLS_PORT = 9222
DEVTOOLS_WAIT_SECONDS = 60
# Gesetzt beim Neustart des Launchers nach einer Änderung: die Desktop-Sitzung läuft schon
RELOAD_ENV = "KESHER_PI_RELOAD"
MANAGED_CONFIG_KEYS = (
    "server_url",
    "browser_binary",
    "allow_insecure_tls",
    "audio_runtime_wait_seconds",
    "display_runtime_wait_seconds",
    "display_runtime_settle_seconds",
    "browser_connect_timeout_seconds",
    "browser_restart_delay_seconds",
    "clients",
)


def require_text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'{field} must be a non-empty string')
    return value.strip()


def normalize_server_url(value: Any) -> str:
    server_url = require_text(value, "server_url").rstrip("/")
    parsed = urlsplit(server_url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("server_url must be an https URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("server_url must not contain credentials, query, or fragment")
    path = parsed.path.rstrip("/")
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def read_config_file(path: Path) -> dict[str, Any]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ValueError(f"config file not found: {path}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"invalid JSON in {path}: {error}") from error
    if not isinstance(raw, dict):
        raise ValueError("config root must be an object")
    return raw


def load_config(path: Path) -> dict[str, Any]:
    return validate_config(read_config_file(path))


def validate_config(raw: dict[str, Any]) -> dict[str, Any]:
    raw = dict(raw)
    raw["server_url"] = normalize_server_url(raw.get("server_url"))
    if raw.get("allow_insecure_tls") is True:
        raise ValueError("allow_insecure_tls is not supported for authenticated devices")
    clients = raw.get("clients")
    if not isinstance(clients, list) or not clients:
        raise ValueError("clients must be a non-empty array")
    heartbeat_secret = raw.get("heartbeat_secret")
    if heartbeat_secret is not None and not isinstance(heartbeat_secret, str):
        raise ValueError("heartbeat_secret must be a string when set")
    if isinstance(heartbeat_secret, str):
        raw["heartbeat_secret"] = heartbeat_secret.strip()
    for optional_field in (
        "audio_runtime_wait_seconds",
        "display_runtime_wait_seconds",
        "display_runtime_settle_seconds",
        "browser_connect_timeout_seconds",
        "browser_restart_delay_seconds",
    ):
        if optional_field in raw:
            raw[optional_field] = read_non_negative_int(raw[optional_field], optional_field)
    return raw


def read_non_negative_int(value: Any, field: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{field} must be a non-negative integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field} must be a non-negative integer") from error
    if parsed < 0:
        raise ValueError(f"{field} must be a non-negative integer")
    return parsed


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


def normalize_mac(value: Any, field: str) -> str:
    text = require_text(value, field).lower().replace("-", ":")
    parts = text.split(":")
    if len(parts) != 6 or not all(
        len(part) == 2 and all(c in "0123456789abcdef" for c in part) for part in parts
    ):
        raise ValueError(f"{field} must be a MAC address like b8:27:eb:12:34:56")
    return text


def detect_mac_addresses() -> list[str]:
    macs: list[str] = []
    for address_file in sorted(Path("/sys/class/net").glob("*/address")):
        if address_file.parent.name == "lo":
            continue
        try:
            mac = address_file.read_text(encoding="utf-8").strip().lower()
        except OSError:
            continue
        if mac and mac != "00:00:00:00:00:00":
            macs.append(mac)
    return macs


def resolve_client(
    config: dict[str, Any],
    addresses: list[str],
    mac_addresses: Optional[list[str]] = None,
) -> dict[str, Any]:
    local_addresses = set(addresses)
    local_macs = {mac.lower() for mac in mac_addresses or []}
    matches: list[dict[str, Any]] = []
    seen_config_ips: set[str] = set()
    seen_config_macs: set[str] = set()
    certificate_bound = config.get("certificate_bound_client") is True
    if certificate_bound and len(config["clients"]) != 1:
        raise ValueError("certificate-bound config must contain exactly one client")
    for index, raw_client in enumerate(config["clients"]):
        if not isinstance(raw_client, dict):
            raise ValueError(f"clients[{index}] must be an object")
        raw_macs = raw_client.get("mac_addresses", [])
        if not isinstance(raw_macs, list):
            raise ValueError(f"clients[{index}].mac_addresses must be a list")
        configured_macs = [
            normalize_mac(value, f"clients[{index}].mac_addresses[{mac_index}]")
            for mac_index, value in enumerate(raw_macs)
        ]
        for mac in configured_macs:
            if mac in seen_config_macs:
                raise ValueError(f"duplicate client MAC in config: {mac}")
            seen_config_macs.add(mac)
        configured_ip = ""
        if raw_client.get("ip_address") or (not configured_macs and not certificate_bound):
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
        elif configured_ip:
            device_id = configured_ip
        else:
            raise ValueError(f"clients[{index}].device_id is required without ip_address")
        if any(character.isspace() for character in device_id):
            raise ValueError(f"clients[{index}].device_id must not contain whitespace")
        client = {
            "device_id": device_id,
            "ip_address": configured_ip,
            "name": name,
            "role_id": role_id,
            "low_power_mode": raw_client.get("low_power_mode", False),
        }
        if not isinstance(client["low_power_mode"], bool):
            raise ValueError(f"clients[{index}].low_power_mode must be a boolean")
        if "simple_view" in raw_client:
            simple_view = raw_client.get("simple_view")
            if not isinstance(simple_view, bool):
                raise ValueError(f"clients[{index}].simple_view must be a boolean")
            client["simple_view"] = simple_view
        if "standby" in raw_client:
            standby = raw_client.get("standby")
            if not isinstance(standby, bool):
                raise ValueError(f"clients[{index}].standby must be a boolean")
            client["standby"] = standby
        for optional_field in ("audio_input_match", "audio_output_match"):
            value = raw_client.get(optional_field)
            if isinstance(value, str) and value.strip():
                client[optional_field] = value.strip()
        # Anzeige aus JMS Control (Einstellungen → Bildschirme): Intercom oder ein Multiview
        display = raw_client.get("display", "intercom")
        if display not in DISPLAY_MODES:
            raise ValueError(f"clients[{index}].display must be one of {', '.join(DISPLAY_MODES)}")
        if display == "multiview":
            client["display"] = display
            client["screen_id"] = require_text(raw_client.get("screen_id"), f"clients[{index}].screen_id")
        if certificate_bound:
            client["ip_address"] = sorted(local_addresses)[0] if local_addresses else configured_ip
            matches.append(client)
        elif local_macs.intersection(configured_macs):
            # Matched by hardware address: report the IP the Pi has right now,
            # since DHCP and LAN/WLAN changes move it.
            client["ip_address"] = sorted(local_addresses)[0] if local_addresses else configured_ip
            matches.append(client)
        elif configured_ip and configured_ip in local_addresses:
            matches.append(client)
    if not matches:
        detected = ", ".join(sorted(local_addresses)) or "none"
        detected_macs = ", ".join(sorted(local_macs)) or "none"
        raise ValueError(
            f"no client entry matches this Pi; detected IPs: {detected}; detected MACs: {detected_macs}"
        )
    if len(matches) > 1:
        matched = ", ".join(client["device_id"] for client in matches)
        raise ValueError(f"multiple client entries match this Pi: {matched}")
    return matches[0]


def normalize_config_url(value: Any) -> str:
    config_url = require_text(value, "config_url")
    parsed = urlsplit(config_url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("config_url must be an https URL")
    if parsed.username or parsed.password or parsed.fragment:
        raise ValueError("config_url must not contain credentials or fragment")
    return config_url


def managed_config_request(
    local_raw: dict[str, Any],
    addresses: list[str],
    mac_addresses: list[str],
    display: str = "",
    version: str = "",
    wait_seconds: int = 0,
) -> dict[str, Any]:
    """What the Pi tells the Multiview about itself (to find and offer its entry)."""
    local_client: Optional[dict[str, Any]] = None
    try:
        local_client = resolve_client(validate_config(local_raw), addresses, mac_addresses)
    except ValueError:
        pass
    if local_client is not None and not local_client.get("ip_address"):
        local_client.pop("ip_address", None)
    request = {
        "macs": sorted(mac_addresses),
        "ips": sorted(addresses),
        "hostname": socket.gethostname(),
        "launcherVersion": LAUNCHER_VERSION,
        "local": local_client,
        "localServerUrl": local_raw.get("server_url") if isinstance(local_raw.get("server_url"), str) else "",
    }
    if display:
        request["display"] = display
    if version and wait_seconds:
        request["version"] = version
        request["waitSeconds"] = int(wait_seconds)
    return request


def fetch_managed_config(
    config_url: str,
    request_body: dict[str, Any],
    timeout: float = 3,
) -> Optional[dict[str, Any]]:
    """Answer of the Multiview, or None when it cannot be reached."""
    request = Request(
        config_url,
        data=json.dumps(request_body, separators=(",", ":")).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "User-Agent": f"Kesher-Pi-Launcher/{LAUNCHER_VERSION}",
        },
        method="POST",
    )
    try:
        with open_device_request(request, timeout) as response:
            payload = json.load(response)
    except (HTTPError, URLError, TimeoutError, OSError, ValueError):
        return None
    if not isinstance(payload, dict) or not isinstance(payload.get("managed"), bool):
        return None
    if payload["managed"] and not isinstance(payload.get("config"), dict):
        return None
    return payload


def merge_managed_config(
    local_raw: dict[str, Any],
    response: Optional[dict[str, Any]],
) -> dict[str, Any]:
    """Managed settings replace the file's; config_url and heartbeat_secret stay local."""
    merged = dict(local_raw)
    if not response or response.get("managed") is not True:
        return merged
    remote = response.get("config") or {}
    for key in MANAGED_CONFIG_KEYS:
        if key in remote:
            merged[key] = remote[key]
    merged["certificate_bound_client"] = True
    return merged


def managed_config_cache_path() -> Path:
    return Path.home() / ".cache" / "kesher-pi" / "managed-config.json"


def read_managed_config_cache(path: Optional[Path] = None) -> Optional[dict[str, Any]]:
    try:
        payload = json.loads((path or managed_config_cache_path()).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return payload if isinstance(payload, dict) and isinstance(payload.get("managed"), bool) else None


def write_managed_config_cache(payload: dict[str, Any], path: Optional[Path] = None) -> None:
    target = path or managed_config_cache_path()
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
        temporary.replace(target)
    except OSError:
        pass


def wayland_outputs(run: Any = subprocess.run) -> list[str]:
    """Namen der Bildschirmausgänge laut wlr-randr (Zeilen ohne Einrückung)."""
    try:
        result = run(["wlr-randr"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return []
    if result.returncode != 0:
        return []
    return [line.split()[0] for line in result.stdout.splitlines() if line and not line[0].isspace()]


def set_display_power(on: bool, run: Any = subprocess.run) -> bool:
    """Bildschirm an/aus für den Ruhemodus: wlopm (nur Stromsparen), sonst wlr-randr, sonst vcgencmd.

    wlopm zuerst: wlr-randr meldet den Ausgang ab und wieder an, dabei ist labwc auf dem
    Pi 3 schon abgestürzt – danach stand der Anmeldebildschirm mit Passwortabfrage da.
    """
    state = "--on" if on else "--off"

    def ok(command: list[str]) -> bool:
        try:
            return run(command, capture_output=True, timeout=10).returncode == 0
        except (OSError, subprocess.SubprocessError):
            return False

    if ok(["wlopm", state, "*"]):
        return True
    outputs = wayland_outputs(run)
    if outputs and all([ok(["wlr-randr", "--output", output, state]) for output in outputs]):
        return True
    return ok(["vcgencmd", "display_power", "1" if on else "0"])


POWER_ACTIONS = ("poweroff", "reboot")


def power_command_state_path() -> Path:
    return Path.home() / ".cache" / "kesher-pi" / "last-power-command"


def handle_power_command(
    response: Optional[dict[str, Any]],
    state_path: Optional[Path] = None,
    run: Any = subprocess.run,
) -> Optional[str]:
    """Herunterfahren / Neu starten, wenn der Multiview es in seiner Antwort schickt.

    Jeder Befehl hat eine ID; die zuletzt ausgeführte wird gemerkt, damit derselbe
    Befehl nach dem Neustart nicht noch einmal läuft. Liefert die ausgeführte Aktion.
    """
    power = response.get("power") if isinstance(response, dict) else None
    if not isinstance(power, dict):
        return None
    action = power.get("action")
    command_id = power.get("id")
    if action not in POWER_ACTIONS or not isinstance(command_id, str) or not command_id:
        return None
    target = state_path or power_command_state_path()
    try:
        if target.read_text(encoding="utf-8").strip() == command_id:
            return None
    except OSError:
        pass
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(command_id, encoding="utf-8")
    except OSError:
        pass
    print(f"{action} requested from the Multiview", flush=True)
    # Erst direkt (polkit erlaubt das der angemeldeten Sitzung), sonst über die sudo-Regel
    # aus install.sh
    for command in (["systemctl", action], ["sudo", "-n", "systemctl", action]):
        try:
            if run(command, timeout=30).returncode == 0:
                return action
        except (OSError, subprocess.SubprocessError):
            continue
    print(f"Could not {action}: neither systemctl nor sudo -n systemctl worked", flush=True)
    return None


def without_power_command(payload: dict[str, Any]) -> dict[str, Any]:
    """Für den Cache: ein Befehl gilt nur für die Antwort, in der er kam."""
    return {key: value for key, value in payload.items() if key != "power"}


def load_effective_config(
    path: Path,
    addresses: list[str],
    mac_addresses: list[str],
    wait_seconds: int = MANAGED_CONFIG_BOOT_WAIT_SECONDS,
) -> tuple[dict[str, Any], dict[str, Any], str]:
    """Validated config, the merged raw config and where the settings came from.

    With config_url the Multiview's settings win; without an answer (network not
    up yet, server down) the last answer from the cache, then the file alone.
    """
    local_raw = read_config_file(path)
    if not local_raw.get("config_url"):
        return validate_config(local_raw), local_raw, "file"
    config_url = normalize_config_url(local_raw.get("config_url"))
    deadline = time.monotonic() + max(0, int(wait_seconds))
    while True:
        response = fetch_managed_config(
            config_url,
            managed_config_request(local_raw, addresses, mac_addresses),
        )
        if response is not None:
            handle_power_command(response)
            write_managed_config_cache(without_power_command(response))
            source = "multiview" if response.get("managed") else "file"
            break
        if time.monotonic() >= deadline:
            response = read_managed_config_cache()
            source = "cache" if response and response.get("managed") else "file"
            print(
                f"Multiview not reachable at {config_url}; using the "
                f"{'cached Multiview settings' if source == 'cache' else 'config file'}",
                flush=True,
            )
            break
        time.sleep(2)
    merged = merge_managed_config(local_raw, response)
    return validate_config(merged), merged, source


# Ändern sich nur diese Felder, startet der Pi nicht neu: die Anzeige schaltet der Launcher per
# Tab um, Mikrofon/Kopfhörer schaltet JMS Control live über Kesher (und sie gelten beim nächsten Start)
LIVE_CLIENT_KEYS = ("display", "screen_id", "audio_input_match", "audio_output_match")


def without_display(raw: dict[str, Any]) -> dict[str, Any]:
    """Konfiguration ohne die live änderbaren Felder (LIVE_CLIENT_KEYS) – zum Vergleichen."""
    copy = dict(raw)
    if isinstance(raw.get("clients"), list):
        copy["clients"] = [
            {key: value for key, value in client.items() if key not in LIVE_CLIENT_KEYS}
            if isinstance(client, dict)
            else client
            for client in raw["clients"]
        ]
    return copy


def display_only_change(old_raw: dict[str, Any], new_raw: dict[str, Any]) -> bool:
    """Hat sich nur die Anzeige geändert? Dann Tab wechseln statt den Browser neu zu starten."""
    return old_raw != new_raw and without_display(old_raw) == without_display(new_raw)


def start_managed_config_watch(
    path: Path,
    current_raw: dict[str, Any],
    reload_event: threading.Event,
    on_change: Any,
    stop_event: threading.Event,
    poll_seconds: int = MANAGED_CONFIG_POLL_SECONDS,
    on_display: Any = None,
    shown_display: Any = None,
) -> Optional[threading.Thread]:
    """Asks the Multiview for changes; a change for this Pi calls on_change (restart with it).

    The Multiview holds the request until something changes (long poll), so a switch arrives
    at once. A change of only the display (Intercom/Multiview) calls on_display instead.
    """
    try:
        local_raw = read_config_file(path)
        config_url = normalize_config_url(local_raw.get("config_url"))
    except ValueError:
        return None

    def run() -> None:
        known_raw = current_raw
        version = ""
        # Erste Anfrage gleich: sie liefert die Version, ab dann wartet der Multiview auf Änderungen
        delay = min(poll_seconds, MANAGED_CONFIG_LONG_POLL_GAP_SECONDS)
        while not stop_event.wait(delay):
            try:
                addresses = detect_ipv4_addresses()
            except (OSError, subprocess.SubprocessError, ValueError):
                addresses = []
            response = fetch_managed_config(
                config_url,
                managed_config_request(
                    local_raw,
                    addresses,
                    detect_mac_addresses(),
                    display=shown_display() if shown_display else "",
                    version=version,
                    wait_seconds=MANAGED_CONFIG_LONG_POLL_SECONDS,
                ),
                timeout=MANAGED_CONFIG_LONG_POLL_SECONDS + 10,
            )
            if response is None:
                delay = poll_seconds
                continue
            if handle_power_command(response):
                return
            write_managed_config_cache(without_power_command(response))
            # Ältere Multiviews kennen kein Long-Poll (keine version): dann wie bisher alle 15 s
            version = response.get("version") if isinstance(response.get("version"), str) else ""
            delay = MANAGED_CONFIG_LONG_POLL_GAP_SECONDS if version else poll_seconds
            merged = merge_managed_config(local_raw, response)
            if merged == known_raw:
                continue
            if on_display is not None and display_only_change(known_raw, merged):
                known_raw = merged
                on_display(merged)
                continue
            print("Settings changed in the Multiview; restarting the station", flush=True)
            reload_event.set()
            on_change()
            return

    thread = threading.Thread(target=run, name="kesher-pi-config", daemon=True)
    thread.start()
    return thread


def devtools_call(path: str, method: str = "GET", timeout: float = 3) -> str:
    """Chromium-Fernsteuerung (nur 127.0.0.1, ohne Proxy)."""
    request = Request(f"http://127.0.0.1:{DEVTOOLS_PORT}{path}", method=method)
    with build_opener(ProxyHandler({})).open(request, timeout=timeout) as response:
        return response.read().decode("utf-8", "replace")


def devtools_pages() -> Optional[list[dict[str, Any]]]:
    """Offene Tabs, oder None wenn Chromium (noch) nicht antwortet."""
    try:
        targets = json.loads(devtools_call("/json/list"))
    except (URLError, TimeoutError, OSError, ValueError):
        return None
    if not isinstance(targets, list):
        return None
    return [target for target in targets if isinstance(target, dict) and target.get("type") == "page"]


def wait_for_devtools(process: subprocess.Popen[Any], timeout_seconds: int = DEVTOOLS_WAIT_SECONDS) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while process.poll() is None and time.monotonic() < deadline:
        if devtools_pages() is not None:
            return True
        time.sleep(1)
    return False


def show_tab(url: str, prefix: str) -> bool:
    """Den Tab zeigen, dessen Adresse mit prefix beginnt – fehlt er, wird er mit url geöffnet."""
    pages = devtools_pages()
    if pages is None:
        return False
    page = next((page for page in pages if str(page.get("url", "")).startswith(prefix)), None)
    try:
        if page is None:
            # Ein neuer Tab ist sofort der sichtbare
            page = json.loads(devtools_call(f"/json/new?{quote(url, safe='')}", method="PUT", timeout=10))
            return isinstance(page, dict) and bool(page.get("id"))
        devtools_call(f"/json/activate/{page['id']}")
        return True
    except (URLError, TimeoutError, OSError, ValueError, KeyError):
        return False


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
    elif client.get("simple_view") is False:
        params["viewMode"] = "station"
    return f"{server_url}/?{urlencode(params)}"


def build_multiview_url(config_url: Any, client: dict[str, Any]) -> str:
    """output.html beim Multiview (gleiche Adresse wie config_url) für den Bildschirm des Pi.

    Welcher Multiview dort läuft, schaltet der Multiview live um – ohne Neustart des Browsers.
    """
    parsed = urlsplit(normalize_config_url(config_url))
    query = urlencode({"screen": client["screen_id"]})
    return urlunsplit((parsed.scheme, parsed.netloc, "/output.html", query, ""))


def server_origin(url: str) -> str:
    parsed = urlsplit(url)
    return urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))


def ssl_context_for_url(url: str) -> ssl.SSLContext:
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("device requests require HTTPS without URL credentials")
    context = ssl.create_default_context(cafile=str(SERVER_CA_CERTIFICATE))
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(str(DEVICE_CERTIFICATE), str(DEVICE_PRIVATE_KEY))
    return context


class NoDeviceRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise HTTPError(request.full_url, code, "device redirects are not allowed", headers, response)


def open_device_request(request: Request, timeout: float = 3):
    context = ssl_context_for_url(request.full_url)
    opener = build_opener(HTTPSHandler(context=context), NoDeviceRedirect())
    return opener.open(request, timeout=timeout)


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


def safe_glob(root: Path, pattern: str) -> list[Path]:
    try:
        return sorted(root.glob(pattern))
    except OSError:
        return []


def read_gpu_percent() -> Optional[float]:
    candidates = [
        Path("/sys/class/drm/card0/device/gpu_busy_percent"),
        Path("/sys/class/drm/card1/device/gpu_busy_percent"),
        Path("/sys/kernel/debug/dri/0/gpu_busy_percent"),
        Path("/sys/kernel/debug/dri/1/gpu_busy_percent"),
    ]
    candidates.extend(safe_glob(Path("/sys/class/drm"), "card*/device/gpu_busy_percent"))
    candidates.extend(safe_glob(Path("/sys/kernel/debug/dri"), "*/gpu_busy_percent"))
    seen: set[Path] = set()
    for path in candidates:
        if path in seen:
            continue
        seen.add(path)
        try:
            raw = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        first_token = raw.replace("%", " ").split()[0:1]
        if not first_token:
            continue
        try:
            value = float(first_token[0])
        except ValueError:
            continue
        if 0.0 <= value <= 100.0:
            return value
    return None


def parse_drm_engine_time_ns(raw_value: str) -> Optional[int]:
    fields = raw_value.strip().split()
    if not fields:
        return None
    try:
        value = float(fields[0])
    except ValueError:
        return None
    unit = fields[1].lower() if len(fields) > 1 else "ns"
    if unit in {"ns", "nsec", "nanosecond", "nanoseconds"}:
        multiplier = 1
    elif unit in {"us", "usec", "microsecond", "microseconds"}:
        multiplier = 1_000
    elif unit in {"ms", "msec", "millisecond", "milliseconds"}:
        multiplier = 1_000_000
    elif unit in {"s", "sec", "second", "seconds"}:
        multiplier = 1_000_000_000
    else:
        return None
    return int(value * multiplier)


def read_gpu_engine_times() -> dict[str, int]:
    engine_times: dict[str, int] = {}
    for process_dir in safe_glob(Path("/proc"), "[0-9]*"):
        fdinfo_dir = process_dir / "fdinfo"
        for fdinfo_path in safe_glob(fdinfo_dir, "*"):
            try:
                lines = fdinfo_path.read_text(encoding="utf-8").splitlines()
            except (OSError, UnicodeDecodeError):
                continue
            client_id = ""
            parsed_engines: dict[str, int] = {}
            for line in lines:
                key, separator, value = line.partition(":")
                if separator == "":
                    continue
                key = key.strip()
                value = value.strip()
                if key == "drm-client-id":
                    client_id = value
                    continue
                if not key.startswith("drm-engine-"):
                    continue
                time_ns = parse_drm_engine_time_ns(value)
                if time_ns is not None:
                    parsed_engines[key.removeprefix("drm-engine-")] = time_ns
            if not parsed_engines:
                continue
            fd_key = fdinfo_path.name
            client_key = client_id or fd_key
            process_key = process_dir.name
            for engine_name, time_ns in parsed_engines.items():
                engine_times[f"{process_key}:{client_key}:{engine_name}"] = time_ns
    return engine_times


class SystemMetricsSampler:
    def __init__(self) -> None:
        self._previous_cpu_times = read_cpu_times()
        self._previous_gpu_engine_times = read_gpu_engine_times()
        self._previous_gpu_monotonic = time.monotonic()

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

    def gpu_percent(self) -> Optional[float]:
        direct = read_gpu_percent()
        if direct is not None:
            self._previous_gpu_engine_times = read_gpu_engine_times()
            self._previous_gpu_monotonic = time.monotonic()
            return direct

        current = read_gpu_engine_times()
        current_monotonic = time.monotonic()
        previous = self._previous_gpu_engine_times
        previous_monotonic = self._previous_gpu_monotonic
        self._previous_gpu_engine_times = current
        self._previous_gpu_monotonic = current_monotonic
        if not current or not previous:
            return None
        elapsed_ns = (current_monotonic - previous_monotonic) * 1_000_000_000.0
        if elapsed_ns <= 0:
            return None
        busy_delta = 0
        for key, value in current.items():
            previous_value = previous.get(key)
            if previous_value is None:
                continue
            busy_delta += max(0, value - previous_value)
        if busy_delta <= 0:
            return 0.0
        return max(0.0, min(100.0, (busy_delta / elapsed_ns) * 100.0))

    def sample(self) -> dict[str, float]:
        metrics: dict[str, float] = {}
        cpu = self.cpu_percent()
        gpu = self.gpu_percent()
        memory = read_memory_percent()
        temperature = read_temperature_c()
        if cpu is not None:
            metrics["cpuPercent"] = round(cpu, 1)
        if gpu is not None:
            metrics["gpuPercent"] = round(gpu, 1)
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


def diagnostic_heartbeat_payload(client: dict[str, Any]) -> dict[str, Any]:
    sampler = SystemMetricsSampler()
    time.sleep(1)
    return heartbeat_payload(
        client,
        "diagnostic",
        "diagnostic",
        metrics=sampler.sample(),
    )


def heartbeat_endpoint_url(config: dict[str, Any]) -> str:
    return f'{config["server_url"]}/api/raspberry-pi/heartbeat'


def raspberry_pi_remote_endpoint_url(config: dict[str, Any]) -> str:
    return f'{config["server_url"]}/api/raspberry-pis/remote'


def remote_station_from_payload(
    payload: Any,
    device_id: str,
) -> Optional[dict[str, Any]]:
    if not isinstance(payload, dict):
        return None
    stations = payload.get("stations")
    if not isinstance(stations, list):
        return None
    for station in stations:
        if isinstance(station, dict) and station.get("deviceId") == device_id:
            return station
    return None


def fetch_remote_station(
    config: dict[str, Any],
    client: dict[str, Any],
) -> Optional[dict[str, Any]]:
    status_url = raspberry_pi_remote_endpoint_url(config)
    request = Request(
        status_url,
        headers={"User-Agent": f"Kesher-Pi-Launcher/{LAUNCHER_VERSION}"},
    )
    try:
        with open_device_request(request) as response:
            payload = json.load(response)
    except (HTTPError, URLError, TimeoutError, OSError, ValueError):
        return None
    return remote_station_from_payload(payload, client["device_id"])


def wait_for_intercom_connection(
    process: subprocess.Popen[Any],
    config: dict[str, Any],
    client: dict[str, Any],
    timeout_seconds: int = BROWSER_CONNECT_TIMEOUT_SECONDS,
    poll_seconds: int = BROWSER_CONNECT_POLL_SECONDS,
) -> bool:
    timeout = max(0, int(timeout_seconds))
    poll_interval = max(1, int(poll_seconds))
    deadline = time.monotonic() + timeout
    connected_checks = 0
    while process.poll() is None:
        station = fetch_remote_station(config, client)
        if station is not None and station.get("intercomConnected") is True:
            connected_checks += 1
            if connected_checks >= BROWSER_CONNECTED_CHECKS:
                return True
        elif station is not None:
            connected_checks = 0
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        time.sleep(min(poll_interval, remaining))
    return False


def stop_browser_process(process: subprocess.Popen[Any]) -> int:
    return_code = process.poll()
    if return_code is not None:
        return return_code
    process.terminate()
    try:
        return process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        return process.wait()


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
        with open_device_request(request) as response:
            return 200 <= response.status < 300
    except (HTTPError, URLError, TimeoutError, OSError, ValueError):
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


def wait_for_server(
    server_url: str,
    allow_insecure_tls: bool,
    stop_event: Optional[threading.Event] = None,
) -> None:
    health_url = f"{server_url}/api/healthz"
    if allow_insecure_tls:
        raise ValueError("allow_insecure_tls is not supported for authenticated devices")
    while not (stop_event and stop_event.is_set()):
        try:
            request = Request(
                health_url,
                headers={"User-Agent": f"Kesher-Pi-Launcher/{LAUNCHER_VERSION}"},
            )
            with open_device_request(request) as response:
                if 200 <= response.status < 300:
                    return
        except (HTTPError, URLError, TimeoutError, OSError):
            pass
        print(f"Kesher server not ready at {health_url}; retrying in 3 seconds", flush=True)
        time.sleep(3)


def display_socket_path(display: str) -> Optional[Path]:
    display = display.strip()
    if not display.startswith(":"):
        return None
    display_number = display[1:].split(".", 1)[0]
    if not display_number.isdigit():
        return None
    return Path("/tmp/.X11-unix") / f"X{display_number}"


def wayland_socket_path(
    wayland_display: str,
    runtime_dir: Optional[str] = None,
) -> Optional[Path]:
    display_name = wayland_display.strip()
    if not display_name or "/" in display_name:
        return None
    root = Path(runtime_dir or os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}")
    return root / display_name


def display_runtime_ready() -> bool:
    wayland_display = os.environ.get("WAYLAND_DISPLAY", "").strip()
    if wayland_display:
        socket_path = wayland_socket_path(wayland_display)
        return socket_path is not None and _socket_exists(socket_path)
    display = os.environ.get("DISPLAY", "").strip()
    if not display:
        return False
    socket_path = display_socket_path(display)
    if socket_path is None:
        return True
    return _socket_exists(socket_path)


def wait_for_display_runtime(
    timeout_seconds: int = DISPLAY_RUNTIME_WAIT_SECONDS,
    settle_seconds: int = DISPLAY_RUNTIME_SETTLE_SECONDS,
) -> bool:
    timeout = max(0, int(timeout_seconds))
    deadline = time.monotonic() + timeout
    while not display_runtime_ready():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            print(
                "Kesher display runtime still not ready; starting Chromium anyway",
                flush=True,
            )
            return False
        display = (
            os.environ.get("WAYLAND_DISPLAY")
            or os.environ.get("DISPLAY")
            or "unset"
        )
        print(
            f"Kesher display runtime not ready (DISPLAY={display}); retrying in 0.5 seconds",
            flush=True,
        )
        time.sleep(min(0.5, remaining))
    display = os.environ.get("WAYLAND_DISPLAY") or os.environ.get("DISPLAY", "")
    print(f"Kesher display runtime ready: display={display}", flush=True)
    settle = max(0, int(settle_seconds))
    if settle > 0:
        print(
            f"Waiting {settle} seconds for the desktop graphics session to settle",
            flush=True,
        )
        time.sleep(settle)
    return True


def _socket_exists(path: Path) -> bool:
    try:
        return path.exists()
    except OSError:
        return False


def _run_short_command(command: list[str]) -> str:
    if not command or not shutil.which(command[0]):
        return ""
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError, TimeoutError):
        return ""
    if result.returncode != 0:
        return ""
    return result.stdout.strip()


def read_alsa_capture_pcms() -> list[str]:
    try:
        lines = Path("/proc/asound/pcm").read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    return [line for line in lines if "capture" in line.lower()]


def audio_runtime_status() -> dict[str, Any]:
    uid = os.getuid()
    runtime_dir = Path(os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{uid}")
    pulse_socket = runtime_dir / "pulse" / "native"
    pipewire_socket = runtime_dir / "pipewire-0"
    sound_controls = sorted(Path("/dev/snd").glob("controlC*"))
    pactl_sources = [
        line
        for line in _run_short_command(["pactl", "list", "short", "sources"]).splitlines()
        if line and ".monitor" not in line
    ]
    arecord_cards = [
        line
        for line in _run_short_command(["arecord", "-l"]).splitlines()
        if line.strip().startswith("card ")
    ]
    alsa_capture_pcms = read_alsa_capture_pcms()
    capture_source_count = max(
        len(pactl_sources),
        len(arecord_cards),
        len(alsa_capture_pcms),
    )
    return {
        "runtimeDir": str(runtime_dir),
        "pulseSocket": str(pulse_socket),
        "pulseSocketReady": _socket_exists(pulse_socket),
        "pipewireSocket": str(pipewire_socket),
        "pipewireSocketReady": _socket_exists(pipewire_socket),
        "soundCardCount": len(sound_controls),
        "captureSourceCount": capture_source_count,
        "pactlSources": pactl_sources,
        "arecordCards": arecord_cards,
        "alsaCapturePcms": alsa_capture_pcms,
    }


def audio_runtime_ready(status: dict[str, Any]) -> bool:
    has_runtime_audio = bool(status.get("pulseSocketReady")) or bool(
        status.get("pipewireSocketReady")
    )
    has_capture_source = int(status.get("captureSourceCount") or 0) > 0
    return has_runtime_audio and has_capture_source


def audio_runtime_summary(status: dict[str, Any]) -> str:
    runtime_ready = "pulse" if status.get("pulseSocketReady") else ""
    if status.get("pipewireSocketReady"):
        runtime_ready = f"{runtime_ready}+pipewire" if runtime_ready else "pipewire"
    if not runtime_ready:
        runtime_ready = "no user audio socket"
    return (
        f"{runtime_ready}; "
        f"soundCards={status.get('soundCardCount', 0)}; "
        f"captureSources={status.get('captureSourceCount', 0)}"
    )


def wait_for_audio_runtime(timeout_seconds: int = AUDIO_RUNTIME_WAIT_SECONDS) -> dict[str, Any]:
    timeout = max(0, int(timeout_seconds))
    deadline = time.monotonic() + timeout
    last_status = audio_runtime_status()
    while timeout > 0 and not audio_runtime_ready(last_status):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        print(
            f"Kesher audio runtime not ready ({audio_runtime_summary(last_status)}); "
            "retrying in 1 second",
            flush=True,
        )
        time.sleep(min(1.0, remaining))
        last_status = audio_runtime_status()
    if audio_runtime_ready(last_status):
        print(f"Kesher audio runtime ready: {audio_runtime_summary(last_status)}", flush=True)
    else:
        print(
            "Kesher audio runtime still not ready; Chromium may show no microphone: "
            f"{audio_runtime_summary(last_status)}",
            flush=True,
        )
    return last_status


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


def chromium_profile_dir() -> Path:
    return Path.home() / ".local" / "share" / "kesher-kiosk"


def cleanup_chromium_singletons(profile_dir: Optional[Path] = None) -> None:
    root = profile_dir or chromium_profile_dir()
    for name in ("SingletonCookie", "SingletonLock", "SingletonSocket"):
        path = root / name
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def browser_command(
    config: dict[str, Any], start_url: str, low_power_mode: bool = False
) -> list[str]:
    normalize_server_url(config["server_url"])
    normalize_server_url(start_url.split("?", 1)[0])
    if config.get("allow_insecure_tls") is True:
        raise ValueError("allow_insecure_tls is not supported for authenticated devices")
    profile_dir = chromium_profile_dir()
    command = [
        resolve_browser(config.get("browser_binary")),
        "--no-gl-override",
        "--kiosk",
        "--no-first-run",
        "--no-default-browser-check",
        "--noerrdialogs",
        "--disable-breakpad",
        "--disable-crash-reporter",
        "--disable-session-crashed-bubble",
        "--autoplay-policy=no-user-gesture-required",
        "--use-fake-ui-for-media-stream",
        f"--user-data-dir={profile_dir}",
        f"--remote-debugging-port={DEVTOOLS_PORT}",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
    ]
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
                "--ozone-platform=wayland",
                "--overscroll-history-navigation=0",
                "--process-per-site",
                "--renderer-process-limit=2",
                "--js-flags=--max-old-space-size=96",
                "--disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints,AutofillServerCommunication,CalculateNativeWinOcclusion,FallbackToSWIfGLES3NotSupported,WebGPU,Vulkan,SkiaGraphite",
            ]
        )
    command.append(start_url)
    return command


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--config",
        type=Path,
        default=Path("/etc/kesher/raspberry-pis.json"),
    )
    parser.add_argument("--version", action="store_true")
    parser.add_argument("--print-url", action="store_true")
    parser.add_argument("--print-heartbeat", action="store_true")
    parser.add_argument("--print-audio", action="store_true")
    parser.add_argument("--print-config", action="store_true")
    args = parser.parse_args()
    try:
        if args.version:
            print(LAUNCHER_VERSION)
            return 0
        if args.print_audio:
            status = audio_runtime_status()
            status["ready"] = audio_runtime_ready(status)
            status["summary"] = audio_runtime_summary(status)
            print(json.dumps(status, indent=2, sort_keys=True))
            return 0
        addresses = detect_ipv4_addresses()
        mac_addresses = detect_mac_addresses()
        diagnostic = args.print_url or args.print_heartbeat or args.print_config
        config, merged_raw, config_source = load_effective_config(
            args.config,
            addresses,
            mac_addresses,
            0 if diagnostic else MANAGED_CONFIG_BOOT_WAIT_SECONDS,
        )
        if args.print_config:
            shown = {key: value for key, value in config.items() if key != "heartbeat_secret"}
            print(json.dumps({"source": config_source, "config": shown}, indent=2, sort_keys=True))
            return 0
        client = resolve_client(config, addresses, mac_addresses)
        multiview = client.get("display") == "multiview"
        if multiview and not merged_raw.get("config_url"):
            raise ValueError("display multiview needs config_url")
        # Das Intercom läuft immer (erster Tab); der Multiview ist ein zweiter Tab davor
        kesher_url = build_kesher_url(config["server_url"], client)
        if args.print_url:
            print(build_multiview_url(merged_raw.get("config_url"), client) if multiview else kesher_url)
            return 0
        reloading = os.environ.pop(RELOAD_ENV, "") == "1"
        if args.print_heartbeat:
            print(
                json.dumps(
                    diagnostic_heartbeat_payload(client),
                    indent=2,
                    sort_keys=True,
                )
            )
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
            f'with role {client["role_id"]} for {client["ip_address"]} '
            f'showing {"Multiview" if multiview else "Intercom"}{" (reload)" if reloading else ""} '
            f"(settings from {config_source})",
            flush=True,
        )
        # Changes in the Multiview: stop the browser and start over with the new settings
        reload_event = threading.Event()
        browser: dict[str, Optional[subprocess.Popen[Any]]] = {"process": None}
        # Intercom oder Multiview: gewünscht (aus dem Multiview) und gerade gezeigt (Tab vorne)
        display_lock = threading.Lock()
        display_state = {"wanted": merged_raw, "shown": ""}

        def stop_for_reload() -> None:
            process = browser["process"]
            if process is not None:
                stop_browser_process(process)

        def apply_display() -> None:
            """Den gewünschten Tab nach vorne holen (Chromium muss laufen)."""
            with display_lock:
                raw = display_state["wanted"]
                try:
                    wanted_client = resolve_client(validate_config(raw), addresses, mac_addresses)
                except ValueError as error:
                    print(f"Display change ignored: {error}", flush=True)
                    return
                if wanted_client.get("display") == "multiview":
                    url = build_multiview_url(raw.get("config_url"), wanted_client)
                    target, prefix = "multiview", f"{server_origin(url)}/output.html"
                else:
                    url, target, prefix = kesher_url, "intercom", server_origin(kesher_url)
                if display_state["shown"] == target:
                    return
                if show_tab(url, prefix):
                    display_state["shown"] = target
                    print(f"Showing {target}", flush=True)
                else:
                    print(f"Could not show {target} yet", flush=True)

        def on_display(raw: dict[str, Any]) -> None:
            with display_lock:
                display_state["wanted"] = raw
            process = browser["process"]
            if process is not None and process.poll() is None:
                apply_display()

        config_watch = None
        if merged_raw.get("config_url"):
            config_watch = start_managed_config_watch(
                args.config,
                merged_raw,
                reload_event,
                stop_for_reload,
                heartbeat_stop,
                on_display=on_display,
                shown_display=lambda: display_state["shown"],
            )
        reload_requested = False
        if client.get("standby") is True:
            # Ruhemodus aus JMS Control: kein Intercom, Bildschirm aus, der Pi bleibt im Netz.
            # „Einschalten“ ändert die Einstellung – die Konfig-Abfrage startet dann neu.
            print("Standby: station is switched off in JMS Control", flush=True)
            update_heartbeat_state(
                heartbeat_state,
                heartbeat_state_lock,
                browser_status="standby",
                login_status="standby",
                login_error="",
            )
            try:
                wait_for_display_runtime(
                    config.get("display_runtime_wait_seconds", DISPLAY_RUNTIME_WAIT_SECONDS),
                    0,
                )
                set_display_power(False)
                if config_watch is None:
                    print("Standby needs config_url; nothing will wake this station", flush=True)
                reload_event.wait()
                reload_requested = True
                return 0
            finally:
                heartbeat_stop.set()
                heartbeat_thread.join(timeout=1)
                if config_watch is not None:
                    config_watch.join(timeout=1)
                if reload_requested:
                    os.environ[RELOAD_ENV] = "1"
                    os.execv(sys.executable, [sys.executable, os.path.abspath(__file__), *sys.argv[1:]])
        try:
            wait_for_server(
                config["server_url"],
                config.get("allow_insecure_tls") is True,
                reload_event,
            )
            wait_for_display_runtime(
                config.get("display_runtime_wait_seconds", DISPLAY_RUNTIME_WAIT_SECONDS),
                # Nach einer Änderung läuft die Desktop-Sitzung schon – nicht noch einmal warten
                0
                if reloading
                else config.get(
                    "display_runtime_settle_seconds",
                    DISPLAY_RUNTIME_SETTLE_SECONDS,
                ),
            )
            update_heartbeat_state(
                heartbeat_state,
                heartbeat_state_lock,
                browser_status="not_started",
                login_status="waiting_for_audio",
                login_error="",
            )
            wait_for_audio_runtime(
                config.get("audio_runtime_wait_seconds", AUDIO_RUNTIME_WAIT_SECONDS)
            )
            update_heartbeat_state(
                heartbeat_state,
                heartbeat_state_lock,
                browser_status="starting",
                login_status="starting_browser",
                login_error="",
            )
            # Nach dem Ruhemodus (oder falls ihn jemand ausgeschaltet hat) den Bildschirm einschalten
            set_display_power(True)
            return_code = 0
            while not reload_event.is_set():
                cleanup_chromium_singletons()
                # Live geänderte Mikrofon/Kopfhörer-Wahl gilt beim nächsten Browser-Start
                try:
                    kesher_url = build_kesher_url(
                        config["server_url"],
                        resolve_client(validate_config(display_state["wanted"]), addresses, mac_addresses),
                    )
                except ValueError:
                    pass
                process = subprocess.Popen(
                    browser_command(
                        config,
                        kesher_url,
                        client.get("low_power_mode") is True,
                    )
                )
                browser["process"] = process
                display_state["shown"] = "intercom"
                if reload_event.is_set():
                    stop_browser_process(process)
                # Soll der Multiview vorne sein: sobald Chromium antwortet als zweiten Tab öffnen,
                # das Intercom verbindet sich dahinter
                if wait_for_devtools(process):
                    apply_display()
                else:
                    print("Chromium remote control not reachable; Intercom only", flush=True)
                update_heartbeat_state(
                    heartbeat_state,
                    heartbeat_state_lock,
                    browser_status="running",
                    login_status="waiting_for_intercom",
                    login_error="",
                )
                connected = wait_for_intercom_connection(
                    process,
                    config,
                    client,
                    config.get(
                        "browser_connect_timeout_seconds",
                        BROWSER_CONNECT_TIMEOUT_SECONDS,
                    ),
                )
                if connected:
                    update_heartbeat_state(
                        heartbeat_state,
                        heartbeat_state_lock,
                        browser_status="running",
                        login_status="intercom_connected",
                        login_error="",
                    )
                    return_code = process.wait()
                    break
                if process.poll() is not None:
                    return_code = process.returncode
                    break
                print(
                    "Chromium did not connect to Kesher in time; restarting browser",
                    flush=True,
                )
                update_heartbeat_state(
                    heartbeat_state,
                    heartbeat_state_lock,
                    browser_status="restarting",
                    login_status="restarting_browser",
                    login_error="browser did not connect to the intercom",
                )
                stop_browser_process(process)
                time.sleep(
                    config.get(
                        "browser_restart_delay_seconds",
                        BROWSER_RESTART_DELAY_SECONDS,
                    )
                )
            if reload_event.is_set():
                reload_requested = True
                return 0
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
            if config_watch is not None:
                config_watch.join(timeout=1)
            if reload_requested:
                # Start over in this process (same service, new settings)
                os.environ[RELOAD_ENV] = "1"
                os.execv(sys.executable, [sys.executable, os.path.abspath(__file__), *sys.argv[1:]])
    except (ValueError, subprocess.SubprocessError, OSError) as error:
        print(f"Kesher Pi configuration error: {error}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
