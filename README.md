# opnsense-firewall-display

A program to consume firewall log events from an OPNsense firewall over remote syslog or from local UFW logs, then summarize and display traffic metrics.

## Local UFW logs on Ubuntu

UFW log records are commonly written to `/var/log/ufw.log` when UFW logging is enabled. Check the file and enable logging if needed:

```bash
sudo ufw status
sudo ufw logging on
sudo tail -f /var/log/ufw.log
```

To use the local file input, set this in `config.toml`:

```toml
[firewall_input]
mode = "ufw_file"
ufw_log_file = "/var/log/ufw.log"
```

The default input mode is `syslog`, which preserves remote OPNsense ingestion. The local file input starts at the end of the log and handles newly written records. When using the systemd service created by the installer, grant its `fwdisplay` account read access to the log through Ubuntu's `adm` group, then restart it:

```bash
sudo usermod -aG adm fwdisplay
sudo systemctl restart fwdisplay
sudo systemctl status fwdisplay
```

UFW entries are parsed into the same database and live dashboard flow as remote syslog entries.

```bash
bash -i <(curl -sSL https://raw.githubusercontent.com/codestutis/firewall-display/main/scripts/install.sh)
```
