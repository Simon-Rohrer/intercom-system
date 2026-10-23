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
            "server_url": "https://192.168.1.10:8443",
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
            "https://192.168.1.10:8443/api/raspberry-pi/heartbeat",
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

    def test_resolves_station_from_mac_when_ip_changed(self):
        self.config["clients"][0]["mac_addresses"] = ["B8:27:EB:B2:AA:2D", "b8-27-eb-e7-ff-78"]
        client = launcher.resolve_client(
            self.config, ["192.168.0.157"], ["b8:27:eb:e7:ff:78"]
        )
        self.assertEqual(client["device_id"], "foh-pi")
        self.assertEqual(client["ip_address"], "192.168.0.157")

    def test_mac_only_client_needs_device_id(self):
        client = self.config["clients"][0]
        del client["ip_address"]
        client["mac_addresses"] = ["b8:27:eb:b2:aa:2d"]
        resolved = launcher.resolve_client(self.config, ["10.0.0.5"], ["b8:27:eb:b2:aa:2d"])
        self.assertEqual(resolved["device_id"], "foh-pi")
        del client["device_id"]
        with self.assertRaisesRegex(ValueError, "device_id is required"):
            launcher.resolve_client(self.config, ["10.0.0.5"], ["b8:27:eb:b2:aa:2d"])

    def test_rejects_invalid_and_duplicate_mac(self):
        self.config["clients"][0]["mac_addresses"] = ["not-a-mac"]
        with self.assertRaisesRegex(ValueError, "must be a MAC address"):
            launcher.resolve_client(self.config, ["192.168.1.51"])
        self.config["clients"][0]["mac_addresses"] = ["b8:27:eb:b2:aa:2d"]
        other = dict(self.config["clients"][0], ip_address="192.168.1.52", device_id="other")
        self.config["clients"].append(other)
        with self.assertRaisesRegex(ValueError, "duplicate client MAC"):
            launcher.resolve_client(self.config, ["192.168.1.51"])

    def test_unknown_pi_error_lists_macs(self):
        with self.assertRaisesRegex(ValueError, "detected MACs: aa:bb:cc:dd:ee:ff"):
            launcher.resolve_client(self.config, ["192.168.1.99"], ["aa:bb:cc:dd:ee:ff"])

    def write_local_config(self, directory, **extra):
        path = Path(directory) / "raspberry-pis.json"
        local = dict(self.config, heartbeat_secret="geheim", **extra)
        path.write_text(launcher.json.dumps(local), encoding="utf-8")
        return path

    def managed_response(self):
        return {
            "managed": True,
            "config": {
                "server_url": "https://192.168.0.21:8443",
                "clients": [
                    {
                        "device_id": "kamera-1-pi",
                        "name": "Kamera-1",
                        "role_id": "cam1",
                        "mac_addresses": ["b8:27:eb:b2:aa:2d"],
                        "low_power_mode": True,
                    }
                ],
            },
        }

    def multiview_response(self, version="v2"):
        response = self.managed_response()
        response["config"]["clients"][0].update({"display": "multiview", "screen_id": "pi-a"})
        response["version"] = version
        return response

    def test_display_only_change_is_detected(self):
        local = {"config_url": "https://192.168.0.21:8090/api/raspberry-pis/config"}
        intercom = launcher.merge_managed_config(local, self.managed_response())
        multiview = launcher.merge_managed_config(local, self.multiview_response())
        self.assertTrue(launcher.display_only_change(intercom, multiview))
        self.assertTrue(launcher.display_only_change(multiview, intercom))
        self.assertFalse(launcher.display_only_change(intercom, intercom))
        other_role = launcher.merge_managed_config(local, self.multiview_response())
        other_role["clients"][0]["role_id"] = "cam2"
        self.assertFalse(launcher.display_only_change(intercom, other_role))

    def test_config_watch_switches_display_without_restart_and_long_polls(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_local_config(directory, config_url="https://192.168.0.21:8090/api/raspberry-pis/config")
            local = launcher.read_config_file(path)
            current = launcher.merge_managed_config(local, self.managed_response())
            first = dict(self.managed_response(), version="v1")
            restart = self.multiview_response("v3")
            restart["config"]["clients"][0]["role_id"] = "cam2"
            reload_event = launcher.threading.Event()
            stop_event = launcher.threading.Event()
            restarts, displays = [], []
            with mock.patch.object(launcher, "fetch_managed_config", side_effect=[first, self.multiview_response(), restart]) as fetch, \
                mock.patch.object(launcher, "write_managed_config_cache"), \
                mock.patch.object(launcher, "detect_ipv4_addresses", return_value=["192.168.0.157"]), \
                mock.patch.object(launcher, "detect_mac_addresses", return_value=["b8:27:eb:b2:aa:2d"]), \
                mock.patch.object(launcher, "MANAGED_CONFIG_LONG_POLL_GAP_SECONDS", 0.01):
                thread = launcher.start_managed_config_watch(
                    path, current, reload_event, lambda: restarts.append(1), stop_event, poll_seconds=0.01,
                    on_display=displays.append, shown_display=lambda: "intercom",
                )
                thread.join(timeout=2)
            self.assertEqual([raw["clients"][0].get("display") for raw in displays], ["multiview"])
            self.assertEqual(restarts, [1])
            self.assertTrue(reload_event.is_set())
            first_body = fetch.call_args_list[0].args[1]
            self.assertNotIn("version", first_body)
            second_body = fetch.call_args_list[1].args[1]
            self.assertEqual((second_body["version"], second_body["waitSeconds"], second_body["display"]), ("v1", 25, "intercom"))
            self.assertGreater(fetch.call_args_list[1].kwargs["timeout"], 25)

    def test_show_tab_activates_an_open_tab_or_opens_it(self):
        calls = []
        pages = '[{"id": "k", "type": "page", "url": "https://192.168.0.21:8443/?autoLogin=1"}]'

        def call(path, method="GET", timeout=3):
            calls.append((path, method))
            if path == "/json/list":
                return pages
            if path.startswith("/json/new"):
                return '{"id": "m"}'
            return "Target activated"

        with mock.patch.object(launcher, "devtools_call", side_effect=call):
            self.assertTrue(launcher.show_tab("https://192.168.0.21:8443/?x=1", "https://192.168.0.21:8443"))
            self.assertTrue(launcher.show_tab("https://192.168.0.21:8090/output.html?screen=pi-a", "https://192.168.0.21:8090/output.html"))
        self.assertIn(("/json/activate/k", "GET"), calls)
        self.assertIn(("/json/new?https%3A%2F%2F192.168.0.21%3A8090%2Foutput.html%3Fscreen%3Dpi-a", "PUT"), calls)

    def test_browser_allows_local_remote_control(self):
        command = launcher.browser_command(self.config, "https://192.168.1.10:8443/?a=1")
        self.assertIn(f"--remote-debugging-port={launcher.DEVTOOLS_PORT}", command)
        self.assertIn("--disable-renderer-backgrounding", command)

    def test_managed_settings_replace_the_file_but_keep_local_secrets(self):
        local = dict(self.config, config_url="https://mv/api", heartbeat_secret="geheim")
        merged = launcher.merge_managed_config(local, self.managed_response())
        self.assertEqual(merged["server_url"], "https://192.168.0.21:8443")
        self.assertEqual(merged["clients"][0]["name"], "Kamera-1")
        self.assertEqual(merged["heartbeat_secret"], "geheim")
        self.assertEqual(merged["config_url"], "https://mv/api")
        self.assertEqual(merged["browser_binary"], "python3")
        self.assertEqual(launcher.merge_managed_config(local, {"managed": False}), local)
        self.assertEqual(launcher.merge_managed_config(local, None), local)

    def test_effective_config_comes_from_the_multiview_and_is_cached(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_local_config(directory, config_url="https://192.168.0.21:8090/api/raspberry-pis/config")
            cache = Path(directory) / "cache.json"
            with mock.patch.object(launcher, "fetch_managed_config", return_value=self.managed_response()) as fetch, \
                mock.patch.object(launcher, "managed_config_cache_path", return_value=cache):
                config, merged, source = launcher.load_effective_config(
                    path, ["192.168.0.157"], ["b8:27:eb:b2:aa:2d"], 0
                )
            self.assertEqual(source, "multiview")
            self.assertEqual(config["clients"][0]["role_id"], "cam1")
            self.assertEqual(merged["heartbeat_secret"], "geheim")
            body = fetch.call_args.args[1]
            self.assertEqual(body["macs"], ["b8:27:eb:b2:aa:2d"])
            self.assertIsNone(body["local"])  # this Pi has no entry in the file
            self.assertEqual(launcher.read_managed_config_cache(cache), self.managed_response())
            client = launcher.resolve_client(config, ["192.168.0.157"], ["b8:27:eb:b2:aa:2d"])
            self.assertEqual(client["name"], "Kamera-1")

    def test_effective_config_falls_back_to_cache_then_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_local_config(directory, config_url="https://192.168.0.21:8090/api/raspberry-pis/config")
            cache = Path(directory) / "cache.json"
            with mock.patch.object(launcher, "fetch_managed_config", return_value=None), \
                mock.patch.object(launcher, "managed_config_cache_path", return_value=cache):
                config, _, source = launcher.load_effective_config(path, ["192.168.1.51"], [], 0)
                self.assertEqual(source, "file")
                self.assertEqual(config["clients"][0]["name"], "FOH")
                launcher.write_managed_config_cache(self.managed_response())
                config, _, source = launcher.load_effective_config(path, ["192.168.1.51"], [], 0)
            self.assertEqual(source, "cache")
            self.assertEqual(config["clients"][0]["name"], "Kamera-1")

    def test_without_config_url_only_the_file_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_local_config(directory)
            with mock.patch.object(launcher, "fetch_managed_config") as fetch:
                _, _, source = launcher.load_effective_config(path, ["192.168.1.51"], [], 0)
            fetch.assert_not_called()
            self.assertEqual(source, "file")

    def test_managed_request_offers_the_local_entry(self):
        body = launcher.managed_config_request(self.config, ["192.168.1.51"], ["b8:27:eb:00:00:01"])
        self.assertEqual(body["local"]["name"], "FOH")
        self.assertEqual(body["local"]["role_id"], "audio")
        self.assertEqual(body["localServerUrl"], "https://192.168.1.10:8443")
        self.assertEqual(body["launcherVersion"], launcher.LAUNCHER_VERSION)

    def test_config_watch_restarts_on_changes_only(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_local_config(directory, config_url="https://192.168.0.21:8090/api/raspberry-pis/config")
            local = launcher.read_config_file(path)
            current = launcher.merge_managed_config(local, self.managed_response())
            changed = self.managed_response()
            changed["config"]["clients"][0]["role_id"] = "cam2"
            reload_event = launcher.threading.Event()
            stop_event = launcher.threading.Event()
            calls = []
            with mock.patch.object(launcher, "fetch_managed_config", side_effect=[None, self.managed_response(), changed]), \
                mock.patch.object(launcher, "write_managed_config_cache"), \
                mock.patch.object(launcher, "detect_ipv4_addresses", return_value=["192.168.0.157"]), \
                mock.patch.object(launcher, "detect_mac_addresses", return_value=["b8:27:eb:b2:aa:2d"]):
                thread = launcher.start_managed_config_watch(
                    path, current, reload_event, lambda: calls.append(1), stop_event, poll_seconds=0.01
                )
                thread.join(timeout=2)
            self.assertTrue(reload_event.is_set())
            self.assertEqual(calls, [1])

    def test_device_requests_load_ca_and_client_key(self):
        context = mock.Mock()
        with mock.patch.object(launcher.ssl, "create_default_context", return_value=context) as create:
            result = launcher.ssl_context_for_url("https://192.168.0.21:8090/api/healthz")
        self.assertIs(result, context)
        create.assert_called_once_with(cafile="/etc/jms-device/server-ca.crt")
        context.load_cert_chain.assert_called_once_with(
            "/etc/jms-device/client.crt", "/etc/jms-device/client.key"
        )
        self.assertEqual(context.minimum_version, launcher.ssl.TLSVersion.TLSv1_2)

    def test_device_requests_reject_http_and_url_credentials(self):
        for url in ("http://192.168.0.21/api", "https://user:password@192.168.0.21/api"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                launcher.ssl_context_for_url(url)

    def test_insecure_browser_and_configuration_are_rejected(self):
        config = dict(self.config, allow_insecure_tls=True)
        with self.assertRaisesRegex(ValueError, "allow_insecure_tls"):
            launcher.validate_config(config)
        with self.assertRaisesRegex(ValueError, "allow_insecure_tls"):
            launcher.browser_command(config, self.config["server_url"])
        with self.assertRaisesRegex(ValueError, "https"):
            launcher.normalize_config_url("http://192.168.0.21/config")
        with self.assertRaisesRegex(ValueError, "https"):
            launcher.normalize_server_url("http://192.168.0.21")

    def test_device_redirects_are_rejected(self):
        handler = launcher.NoDeviceRedirect()
        request = launcher.Request("https://192.168.0.21:8090/config")
        for target in ("http://192.168.0.21/config", "https://untrusted.example/config"):
            with self.subTest(target=target), self.assertRaises(launcher.HTTPError):
                handler.redirect_request(request, None, 302, "Found", {}, target)

    def test_certificate_bound_client_ignores_changed_network_addresses(self):
        merged = launcher.merge_managed_config(self.config, self.managed_response())
        client = launcher.resolve_client(merged, ["10.42.0.7"], ["aa:bb:cc:dd:ee:ff"])
        self.assertEqual(client["device_id"], "kamera-1-pi")
        self.assertEqual(client["ip_address"], "10.42.0.7")

    def test_certificate_bound_client_requires_single_assignment(self):
        merged = launcher.merge_managed_config(self.config, self.managed_response())
        merged["clients"].append(dict(merged["clients"][0], device_id="other"))
        with self.assertRaisesRegex(ValueError, "exactly one"):
            launcher.resolve_client(merged, [], [])

    def test_browser_has_no_certificate_or_insecure_origin_bypass(self):
        command = launcher.browser_command(self.config, self.config["server_url"])
        self.assertFalse(any("ignore-certificate" in argument for argument in command))
        self.assertFalse(any("insecure-origin" in argument for argument in command))


    def test_power_command_runs_once_per_id(self):
        calls = []

        def run(command, timeout):
            calls.append(command)
            return mock.Mock(returncode=0)

        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "last-power-command"
            response = {"managed": True, "config": {}, "power": {"id": "c1", "action": "poweroff"}}
            self.assertEqual(launcher.handle_power_command(response, state, run), "poweroff")
            # Derselbe Befehl (z. B. aus dem Cache nach dem Neustart) läuft nicht noch einmal
            self.assertIsNone(launcher.handle_power_command(response, state, run))
            self.assertEqual(calls, [["systemctl", "poweroff"]])

    def test_power_command_falls_back_to_sudo_and_ignores_unknown_actions(self):
        calls = []

        def run(command, timeout):
            calls.append(command)
            return mock.Mock(returncode=1 if command[0] == "systemctl" else 0)

        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "last-power-command"
            self.assertIsNone(launcher.handle_power_command({"power": {"id": "x", "action": "rm"}}, state, run))
            self.assertIsNone(launcher.handle_power_command({"managed": True}, state, run))
            self.assertEqual(launcher.handle_power_command({"power": {"id": "c2", "action": "reboot"}}, state, run), "reboot")
            self.assertEqual(calls, [["systemctl", "reboot"], ["sudo", "-n", "systemctl", "reboot"]])

    def test_power_command_is_not_cached(self):
        payload = {"managed": True, "config": {"a": 1}, "power": {"id": "c1", "action": "reboot"}}
        self.assertEqual(launcher.without_power_command(payload), {"managed": True, "config": {"a": 1}})

    def test_standby_is_read_from_the_client(self):
        self.config["clients"][0]["standby"] = True
        client = launcher.resolve_client(launcher.validate_config(self.config), ["192.168.1.51"], [])
        self.assertTrue(client["standby"])
        self.config["clients"][0]["standby"] = "ja"
        with self.assertRaises(ValueError):
            launcher.resolve_client(launcher.validate_config(self.config), ["192.168.1.51"], [])

    def test_display_power_uses_wlopm_first(self):
        calls = []

        def run(command, **kwargs):
            calls.append(command)
            return mock.Mock(returncode=0)

        self.assertTrue(launcher.set_display_power(True, run))
        self.assertEqual(calls, [["wlopm", "--on", "*"]])

    def test_display_power_switches_every_wayland_output_without_wlopm(self):
        calls = []

        def run(command, **kwargs):
            calls.append(command)
            if command[0] == "wlopm":
                raise FileNotFoundError("wlopm")
            if command == ["wlr-randr"]:
                return mock.Mock(returncode=0, stdout='HDMI-A-1 "Dell"\n  Enabled: yes\nHDMI-A-2 "LG"\n  Enabled: yes\n')
            return mock.Mock(returncode=0)

        self.assertTrue(launcher.set_display_power(False, run))
        self.assertEqual(calls[2:], [["wlr-randr", "--output", "HDMI-A-1", "--off"], ["wlr-randr", "--output", "HDMI-A-2", "--off"]])

    def test_display_power_falls_back_without_wlr_randr(self):
        calls = []

        def run(command, **kwargs):
            calls.append(command)
            if command[0] in ("wlr-randr", "wlopm"):
                raise FileNotFoundError(command[0])
            return mock.Mock(returncode=0)

        self.assertTrue(launcher.set_display_power(True, run))
        self.assertEqual(calls[-1], ["vcgencmd", "display_power", "1"])

    def test_intercom_is_the_default_display(self):
        client = launcher.resolve_client(self.config, ["192.168.1.51"])
        self.assertNotIn("display", client)

    def test_multiview_display_opens_the_pi_screen_on_the_multiview(self):
        self.config["clients"][0].update({"display": "multiview", "screen_id": "pi-pi1"})
        client = launcher.resolve_client(self.config, ["192.168.1.51"])
        self.assertEqual(client["display"], "multiview")
        self.assertEqual(
            launcher.build_multiview_url("https://192.168.1.10:8090/api/raspberry-pis/config", client),
            "https://192.168.1.10:8090/output.html?screen=pi-pi1",
        )
        self.assertEqual(launcher.server_origin("https://192.168.1.10:8090/output.html?screen=x"), "https://192.168.1.10:8090")

    def test_multiview_display_needs_a_screen_and_a_known_mode(self):
        self.config["clients"][0]["display"] = "multiview"
        with self.assertRaises(ValueError):
            launcher.resolve_client(self.config, ["192.168.1.51"])
        self.config["clients"][0]["display"] = "fernseher"
        with self.assertRaises(ValueError):
            launcher.resolve_client(self.config, ["192.168.1.51"])


if __name__ == "__main__":
    unittest.main()
