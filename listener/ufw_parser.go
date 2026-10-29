package listener

import (
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/UNHCSC/opnsense-firewall-display/db"
)

// ParseUFWLogLine parses the kernel-style UFW records written to /var/log/ufw.log.
func ParseUFWLogLine(line string) (*db.FirewallLogEntry, error) {
	line = strings.TrimSpace(line)
	kernelIndex := strings.Index(line, "kernel:")
	if kernelIndex < 0 {
		return nil, fmt.Errorf("malformed UFW log line header")
	}

	headerFields := strings.Fields(line[:kernelIndex])
	var timestamp time.Time
	var hostname string
	switch {
	case len(headerFields) == 2:
		parsed, err := time.Parse(time.RFC3339Nano, headerFields[0])
		if err != nil {
			return nil, fmt.Errorf("invalid UFW timestamp: %w", err)
		}
		timestamp = parsed
		hostname = headerFields[1]
	case len(headerFields) == 4:
		// Traditional syslog timestamps omit the year and timezone.
		now := time.Now()
		timestampText := strings.Join(headerFields[:3], " ") + " " + strconv.Itoa(now.Year())
		parsed, err := time.ParseInLocation("Jan 2 15:04:05 2006", timestampText, time.Local)
		if err != nil {
			return nil, fmt.Errorf("invalid UFW syslog timestamp: %w", err)
		}
		if parsed.After(now.Add(24 * time.Hour)) {
			parsed = parsed.AddDate(-1, 0, 0)
		}
		timestamp = parsed
		hostname = headerFields[3]
	default:
		return nil, fmt.Errorf("malformed UFW log line header")
	}
	body := strings.TrimSpace(line[kernelIndex+len("kernel:"):])
	if !strings.HasPrefix(body, "[UFW ") {
		return nil, fmt.Errorf("not a UFW log record")
	}
	closeBracket := strings.IndexByte(body, ']')
	if closeBracket < 0 {
		return nil, fmt.Errorf("malformed UFW action marker")
	}

	action := strings.ToUpper(strings.TrimSpace(body[len("[UFW "):closeBracket]))
	switch action {
	case "BLOCK":
		action = "block"
	case "ALLOW":
		action = "pass"
	default:
		return nil, fmt.Errorf("unsupported UFW action %q", action)
	}

	entry := &db.FirewallLogEntry{
		HeaderTimestamp: timestamp,
		HeaderHostname:  hostname,
		HeaderAppName:   "kernel",
		Rule:            -1,
		Action:          action,
		Extra:           make(map[string]string),
		RawFilterLog:    body,
	}

	fields := strings.Fields(body[closeBracket+1:])
	values := make(map[string]string, len(fields))
	for _, field := range fields {
		key, value, ok := strings.Cut(field, "=")
		if !ok {
			entry.Extra[field] = "true"
			continue
		}
		values[key] = value
		entry.Extra[key] = value
	}

	entry.Interface = values["IN"]
	entry.Direction = "in"
	if entry.Interface == "" {
		entry.Interface = values["OUT"]
		entry.Direction = "out"
	}
	entry.ProtocolText = strings.ToLower(values["PROTO"])
	entry.ProtocolID = protocolNumber(entry.ProtocolText)
	entry.Length, _ = strconv.Atoi(values["LEN"])
	entry.SrcIP = values["SRC"]
	entry.DstIP = values["DST"]
	if entry.SrcIP == "" || entry.DstIP == "" {
		return nil, fmt.Errorf("UFW record is missing SRC or DST")
	}
	entry.IPVersion = ipVersion(entry.SrcIP)
	if entry.IPVersion == 0 || ipVersion(entry.DstIP) != entry.IPVersion {
		return nil, fmt.Errorf("invalid or mismatched UFW source and destination IP versions")
	}
	if value := values["SPT"]; value != "" {
		if port, parseErr := strconv.Atoi(value); parseErr == nil {
			entry.SrcPort = intPtr(port)
		}
	}
	if value := values["DPT"]; value != "" {
		if port, parseErr := strconv.Atoi(value); parseErr == nil {
			entry.DstPort = intPtr(port)
		}
	}
	return entry, nil
}

func ipVersion(address string) int {
	ip := net.ParseIP(address)
	if ip == nil {
		return 0
	}
	if ip.To4() != nil {
		return 4
	}
	return 6
}

func protocolNumber(protocol string) int {
	switch protocol {
	case "icmp":
		return 1
	case "tcp":
		return 6
	case "udp":
		return 17
	case "icmpv6", "ipv6-icmp":
		return 58
	default:
		return 0
	}
}
