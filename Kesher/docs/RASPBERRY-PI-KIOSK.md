# Raspberry Pi Kiosk Stations

Kesher can start Raspberry Pis as fixed intercom stations. Every Pi receives
the same `raspberry-pis.json`. At boot, the launcher detects the Pi's IPv4
address, selects its configured name and Kesher role, waits for the server, and
opens Chromium in kiosk mode with automatic login.

## Requirements

- Raspberry Pi OS Desktop with graphical auto-login enabled
- a static IP or DHCP reservation for every Pi
- Chromium and Python 3 installed
- the role IDs from the Kesher admin role configuration
- preferably HTTPS with a certificate trusted by every Pi

## Configuration

Edit `deploy/raspberry-pi/raspberry-pis.json` before installation, or edit
`/etc/kesher/raspberry-pis.json` afterwards:

```json
{
  "server_url": "http://192.168.1.10:8080",
  "browser_binary": "chromium",
  "allow_insecure_tls": false,
  "clients": [
    {
      "ip_address": "192.168.1.51",
      "name": "FOH",
      "role_id": "audio",
      "audio_input_match": "USB",
      "audio_output_match": "USB"
    }
  ]
}
```

`name` must not contain spaces. `role_id` is the stable role ID, not the
visible role name. The optional audio match values are case-insensitive label
substrings and automatically select matching USB devices.

The same file can contain all Raspberry Pis and can be copied unchanged to
every station. A Pi refuses to start if its IP is missing, duplicated, or if
more than one local interface matches configured entries.

## Installation on every Pi

Copy the `deploy/raspberry-pi` directory to the Pi, then run:

```sh
cd deploy/raspberry-pi
sudo ./install.sh <desktop-user>
sudo nano /etc/kesher/raspberry-pis.json
sudo systemctl start kesher-pi.service
```

The installer preserves an existing `/etc/kesher/raspberry-pis.json`.

Validate the mapping without opening Chromium:

```sh
sudo -u <desktop-user> KESHER_PI_IP=192.168.1.51 \
  /opt/kesher-pi/kesher-pi-launcher.py --print-url
```

Inspect startup errors with:

```sh
journalctl -u kesher-pi.service -f
```

For an HTTP server, the launcher marks only the configured Kesher origin as a
secure Chromium origin so microphone capture works. Use this only on a trusted
isolated LAN. `allow_insecure_tls` additionally bypasses certificate checks and
should only be enabled temporarily for an internal self-signed certificate.
