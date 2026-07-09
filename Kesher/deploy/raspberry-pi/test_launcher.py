import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).with_name("kesher-pi-launcher.py")
SPEC = importlib.util.spec_from_file_location("kesher_pi_launcher", MODULE_PATH)
launcher = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(launcher)


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.config = {
            "server_url": "http://192.168.1.10:8080",
            "browser_binary": "python3",
            "clients": [
                {
                    "ip_address": "192.168.1.51",
                    "device_id": "foh-pi",
                    "name": "FOH",
                    "role_id": "audio",
                    "audio_input_match": "USB Audio",
                    "audio_output_match": "Jabra Headset",
                    "low_power_mode": True,
                    "simple_view": True,
                }
            ],
        }

    def test_resolves_station_from_local_ip(self):
        client = launcher.resolve_client(self.config, ["192.168.1.51"])
        self.assertEqual(client["name"], "FOH")
        self.assertEqual(client["role_id"], "audio")
        self.assertEqual(client["device_id"], "foh-pi")

    def test_builds_encoded_auto_login_url(self):
        client = launcher.resolve_client(self.config, ["192.168.1.51"])
        url = launcher.build_kesher_url(self.config["server_url"], client)
        self.assertIn("autoLogin=1", url)
        self.assertIn("autoTakeover=1", url)
        self.assertIn("roleId=audio", url)
        self.assertIn("audioInputMatch=USB+Audio", url)
        self.assertIn("audioOutputMatch=Jabra+Headset", url)
        self.assertIn("lowPower=1", url)
        self.assertIn("viewMode=simple", url)

    def test_explicit_non_simple_view_forces_station_mode(self):
        self.config["clients"][0]["simple_view"] = False
        client = launcher.resolve_client(self.config, ["192.168.1.51"])
        url = launcher.build_kesher_url(self.config["server_url"], client)
        self.assertIn("viewMode=station", url)
        self.assertNotIn("viewMode=simple", url)

    def test_adds_low_power_chromium_flags(self):
        client = launcher.resolve_client(self.config, ["192.168.1.51"])
        url = launcher.build_kesher_url(self.config["server_url"], client)
        command = launcher.browser_command(self.config, url, True)
        self.assertIn("--force-prefers-reduced-motion", command)
        self.assertIn("--enable-low-end-device-mode", command)
        self.assertIn("--disable-background-networking", command)
        self.assertIn("--no-gl-override", command)
        self.assertIn("--ozone-platform=wayland", command)
        self.assertNotIn("--use-gl=angle", command)
        self.assertNotIn("--use-angle=gl", command)
        self.assertIn("--process-per-site", command)
        self.assertIn("--renderer-process-limit=2", command)
        self.assertIn("--js-flags=--max-old-space-size=96", command)
        self.assertTrue(
            any(
                "FallbackToSWIfGLES3NotSupported" in argument
                for argument in command
            )
        )

    def test_load_config_accepts_zero_audio_wait(self):
        config = dict(self.config)
        config["audio_runtime_wait_seconds"] = 0
        config["display_runtime_wait_seconds"] = "2"
        config["display_runtime_settle_seconds"] = 0
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as file:
            launcher.json.dump(config, file)
            path = Path(file.name)
        try:
            loaded = launcher.load_config(path)
        finally:
            path.unlink(missing_ok=True)
        self.assertEqual(loaded["audio_runtime_wait_seconds"], 0)
        self.assertEqual(loaded["display_runtime_wait_seconds"], 2)
        self.assertEqual(loaded["display_runtime_settle_seconds"], 0)

    def test_rejects_negative_audio_wait(self):
        config = dict(self.config)
        config["audio_runtime_wait_seconds"] = -1
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as file:
            launcher.json.dump(config, file)
            path = Path(file.name)
        try:
            with self.assertRaisesRegex(ValueError, "audio_runtime_wait_seconds"):
                launcher.load_config(path)
        finally:
            path.unlink(missing_ok=True)

    def test_display_socket_path_uses_x11_display_number(self):
        self.assertEqual(
            launcher.display_socket_path(":0.0"),
            Path("/tmp/.X11-unix/X0"),
        )
        self.assertIsNone(launcher.display_socket_path("wayland-0"))

    def test_wayland_socket_path_uses_runtime_directory(self):
        self.assertEqual(
            launcher.wayland_socket_path("wayland-0", "/run/user/1000"),
            Path("/run/user/1000/wayland-0"),
        )
        self.assertIsNone(launcher.wayland_socket_path("../wayland-0"))

    def test_cleanup_chromium_singletons_removes_stale_locks(self):
        with tempfile.TemporaryDirectory() as directory:
            profile_dir = Path(directory)
            for name in ("SingletonCookie", "SingletonLock", "SingletonSocket"):
                (profile_dir / name).symlink_to("stale")
            launcher.cleanup_chromium_singletons(profile_dir)
            self.assertFalse(any(profile_dir.iterdir()))

    def test_wait_for_display_runtime_allows_graphics_session_to_settle(self):
        with mock.patch.object(launcher, "display_runtime_ready", return_value=True), \
            mock.patch.object(launcher.time, "sleep") as sleep:
            self.assertTrue(
                launcher.wait_for_display_runtime(
                    timeout_seconds=0,
                    settle_seconds=8,
                )
            )
        sleep.assert_called_once_with(8)

    def test_rejects_non_boolean_low_power_setting(self):
        self.config["clients"][0]["low_power_mode"] = "yes"
        with self.assertRaisesRegex(ValueError, "low_power_mode must be a boolean"):
            launcher.resolve_client(self.config, ["192.168.1.51"])

    def test_rejects_non_boolean_simple_view_setting(self):
        self.config["clients"][0]["simple_view"] = "yes"
        with self.assertRaisesRegex(ValueError, "simple_view must be a boolean"):
            launcher.resolve_client(self.config, ["192.168.1.51"])

    def test_uses_ip_address_as_default_device_id(self):
        del self.config["clients"][0]["device_id"]
        client = launcher.resolve_client(self.config, ["192.168.1.51"])
        self.assertEqual(client["device_id"], "192.168.1.51")

    def test_builds_heartbeat_payload(self):
        client = launcher.resolve_client(self.config, ["192.168.1.51"])
        payload = launcher.heartbeat_payload(
            client,
            "running",
            "waiting_for_intercom",
        )
        self.assertEqual(payload["deviceId"], "foh-pi")
        self.assertEqual(payload["name"], "FOH")
        self.assertEqual(payload["roleId"], "audio")
        self.assertTrue(payload["lowPowerMode"])
        self.assertEqual(payload["browserStatus"], "running")

    def test_builds_heartbeat_payload_with_system_metrics(self):
        client = launcher.resolve_client(self.config, ["192.168.1.51"])
        payload = launcher.heartbeat_payload(
            client,
            "running",
            "waiting_for_intercom",
            metrics={
                "cpuPercent": 12.4,
                "gpuPercent": 7.5,
                "memoryPercent": 48.8,
                "temperatureC": 53.0,
            },
        )
        self.assertEqual(payload["cpuPercent"], 12.4)
        self.assertEqual(payload["gpuPercent"], 7.5)
        self.assertEqual(payload["memoryPercent"], 48.8)
        self.assertEqual(payload["temperatureC"], 53.0)

    def test_update_heartbeat_state_clears_stale_login_error(self):
        state = {
            "browser_status": "running",
            "login_status": "login_error",
            "login_error": "previous browser exited with code 1",
        }
        state_lock = launcher.threading.Lock()

        launcher.update_heartbeat_state(
            state,
            state_lock,
            browser_status="running",
            login_status="waiting_for_intercom",
            login_error="",
        )

        self.assertEqual(state["browser_status"], "running")
        self.assertEqual(state["login_status"], "waiting_for_intercom")
        self.assertEqual(state["login_error"], "")

    def test_gpu_percent_uses_drm_engine_delta_when_busy_file_is_missing(self):
        with mock.patch.object(launcher, "read_gpu_percent", return_value=None), \
            mock.patch.object(
                launcher,
                "read_gpu_engine_times",
                side_effect=[
                    {"123:7:render": 0},
                    {"123:7:render": 250_000_000},
                ],
            ), \
            mock.patch.object(launcher.time, "monotonic", side_effect=[1.0, 3.5]):
            sampler = launcher.SystemMetricsSampler()
            self.assertEqual(sampler.gpu_percent(), 10.0)

    def test_audio_runtime_ready_with_user_audio_socket_and_capture(self):
        status = {
            "pulseSocketReady": True,
            "pipewireSocketReady": False,
            "soundCardCount": 1,
            "captureSourceCount": 1,
        }
        self.assertTrue(launcher.audio_runtime_ready(status))

    def test_audio_runtime_not_ready_without_user_audio_socket(self):
        status = {
            "pulseSocketReady": False,
            "pipewireSocketReady": False,
            "soundCardCount": 1,
            "captureSourceCount": 1,
        }
        self.assertFalse(launcher.audio_runtime_ready(status))
        self.assertIn("no user audio socket", launcher.audio_runtime_summary(status))

    def test_audio_runtime_not_ready_without_capture_source(self):
        status = {
            "pulseSocketReady": True,
            "pipewireSocketReady": True,
            "soundCardCount": 2,
            "captureSourceCount": 0,
        }
        self.assertFalse(launcher.audio_runtime_ready(status))

    def test_heartbeat_targets_configured_server_url(self):
        self.assertEqual(
            launcher.heartbeat_endpoint_url(self.config),
            "http://192.168.1.10:8080/api/raspberry-pi/heartbeat",
        )

    def test_remote_station_payload_matches_device_id(self):
        payload = {
            "stations": [
                {"deviceId": "another-pi", "intercomConnected": True},
                {"deviceId": "foh-pi", "intercomConnected": False},
            ]
        }
        station = launcher.remote_station_from_payload(payload, "foh-pi")
        self.assertIsNotNone(station)
        self.assertFalse(station["intercomConnected"])

    def test_wait_for_intercom_connection_observes_server_status(self):
        process = mock.Mock()
        process.poll.return_value = None
        with mock.patch.object(
            launcher,
            "fetch_remote_station",
            side_effect=[
                {"deviceId": "foh-pi", "intercomConnected": False},
                {"deviceId": "foh-pi", "intercomConnected": True},
                {"deviceId": "foh-pi", "intercomConnected": True},
            ],
        ), mock.patch.object(
            launcher.time,
            "monotonic",
            side_effect=[0.0, 0.0, 1.0, 2.0],
        ), mock.patch.object(launcher.time, "sleep") as sleep:
            connected = launcher.wait_for_intercom_connection(
                process,
                self.config,
                self.config["clients"][0],
                timeout_seconds=5,
            )
        self.assertTrue(connected)
        self.assertEqual(sleep.call_args_list, [mock.call(2), mock.call(2)])

    def test_rejects_unknown_pi(self):
        with self.assertRaisesRegex(ValueError, "no client entry matches"):
            launcher.resolve_client(self.config, ["192.168.1.99"])

    def test_rejects_duplicate_ip(self):
        self.config["clients"].append(dict(self.config["clients"][0]))
        with self.assertRaisesRegex(ValueError, "duplicate client IP"):
            launcher.resolve_client(self.config, ["192.168.1.51"])


if __name__ == "__main__":
    unittest.main()
