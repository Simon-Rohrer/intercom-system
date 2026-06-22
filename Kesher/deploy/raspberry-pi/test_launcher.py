import importlib.util
from pathlib import Path
import unittest


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
                    "low_power_mode": True,
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
        self.assertIn("lowPower=1", url)

    def test_adds_low_power_chromium_flags(self):
        client = launcher.resolve_client(self.config, ["192.168.1.51"])
        url = launcher.build_kesher_url(self.config["server_url"], client)
        command = launcher.browser_command(self.config, url, True)
        self.assertIn("--force-prefers-reduced-motion", command)
        self.assertIn("--process-per-site", command)
        self.assertIn("--renderer-process-limit=2", command)

    def test_rejects_non_boolean_low_power_setting(self):
        self.config["clients"][0]["low_power_mode"] = "yes"
        with self.assertRaisesRegex(ValueError, "low_power_mode must be a boolean"):
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

    def test_rejects_unknown_pi(self):
        with self.assertRaisesRegex(ValueError, "no client entry matches"):
            launcher.resolve_client(self.config, ["192.168.1.99"])

    def test_rejects_duplicate_ip(self):
        self.config["clients"].append(dict(self.config["clients"][0]))
        with self.assertRaisesRegex(ValueError, "duplicate client IP"):
            launcher.resolve_client(self.config, ["192.168.1.51"])


if __name__ == "__main__":
    unittest.main()
