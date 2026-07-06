# Kesher Raspberry Pi deployment

This folder contains everything needed to install the Kesher Pi launcher on a Raspberry Pi.

## Files

- `install.sh`: installs the Kesher launcher service and optionally Companion Satellite.
- `install-companion-satellite.sh`: installs Bitfocus Companion Satellite as an autostart service.
- `kesher-pi-launcher.py`: launches the browser/kiosk session and reports status.
- `kesher-pi.service.template`: systemd service template for the Kesher launcher.
- `raspberry-pis.json`: local Pi configuration template.
- `test_launcher.py`: launcher tests.

## Copy to a Raspberry Pi

From the development machine:

```bash
cd /Users/simonrohrer/Webseiten/jms-intercom/Kesher/deploy
COPYFILE_DISABLE=1 tar -czf /private/tmp/kesher-raspberry-pi-deploy.tar.gz raspberry-pi
scp /private/tmp/kesher-raspberry-pi-deploy.tar.gz master@192.168.178.190:/home/master/
```

On the Raspberry Pi:

```bash
cd /home/master
rm -rf raspberry-pi
tar -xzf kesher-raspberry-pi-deploy.tar.gz
cd raspberry-pi
sudo ./install.sh master --update-config
sudo systemctl restart kesher-pi.service
```

## Install with Companion Satellite

Companion Satellite is large and the official updater writes big files to `/tmp`.
On Raspberry Pi OS, `/tmp` can be a small RAM-backed tmpfs. The Kesher wrapper patches the updater to use a disk-backed work directory instead: `/opt/kesher-satellite-tmp`.

```bash
sudo ./install.sh master --update-config --with-companion-satellite
sudo systemctl restart kesher-pi.service
systemctl status satellite.service --no-pager
```

Optional overrides:

```bash
sudo ./install.sh master --update-config \
  --with-companion-satellite \
  --companion-satellite-host 192.168.178.58 \
  --companion-satellite-port 16622 \
  --companion-satellite-rest-port 9999 \
  --companion-satellite-work-dir /opt/kesher-satellite-tmp \
  --companion-satellite-min-free-mb 2500
```

## If `/tmp` is full

```bash
df -h / /tmp /usr/local /opt
sudo rm -f /tmp/satellite-version-selection /tmp/satellite-version-selection-name
sudo rm -f /tmp/satellite-update.tar.gz
sudo rm -rf /tmp/satellite-update /tmp/companion-satellite /tmp/companion-satellite-*
sudo rm -rf /opt/kesher-satellite-tmp/satellite-update /opt/kesher-satellite-tmp/satellite-update.tar.gz
sudo apt clean
df -h / /tmp /usr/local /opt
```

## Useful checks

```bash
sudo -u master /opt/kesher-pi/kesher-pi-launcher.py --print-url
sudo -u master /opt/kesher-pi/kesher-pi-launcher.py --print-heartbeat
sudo -u master XDG_RUNTIME_DIR=/run/user/$(id -u master) \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u master)/bus \
  /opt/kesher-pi/kesher-pi-launcher.py --print-audio
systemctl status kesher-pi.service --no-pager
systemctl status satellite.service --no-pager
```
