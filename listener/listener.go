package listener

import (
	"fmt"
	"net"
	"os"
	"strings"
	"time"

	"github.com/UNHCSC/opnsense-firewall-display/config"
	"github.com/z46-dev/golog"
)

var (
	logger        *golog.Logger
	pipeToProcess chan string = make(chan string, config.Config.SyslogListener.ChannelBufferSize)
)

func ListenForSyslogEvents(parentLogger *golog.Logger) (err error) {
	logger = parentLogger.SpawnChild().Prefix("[SYSLOG]", golog.BoldPurple)
	go syslogWorker()
	return listenForSyslogEvents()
}

func ListenForConfiguredEvents(parentLogger *golog.Logger) (err error) {
	logger = parentLogger.SpawnChild().Prefix("[INPUT]", golog.BoldPurple)
	switch config.Config.FirewallInput.Mode {
	case "syslog":
		go syslogWorker()
		return listenForSyslogEvents()
	case "ufw_file":
		return listenForUFWLogFile(config.Config.FirewallInput.UFWLogFile)
	default:
		return fmt.Errorf("unsupported firewall input mode %q", config.Config.FirewallInput.Mode)
	}
}

func listenForSyslogEvents() (err error) {
	var conn net.PacketConn
	if conn, err = net.ListenPacket("udp", config.Config.SyslogListener.Address); err != nil {
		return
	}
	defer conn.Close()

	logger.Infof("syslog receiver listening on udp %s", config.Config.SyslogListener.Address)
	buffer := make([]byte, config.Config.SyslogListener.BufferSize)
	for {
		n, _, readErr := conn.ReadFrom(buffer)
		if readErr != nil {
			logger.Errorf("syslog read error: %v", readErr)
			continue
		}
		pipeToProcess <- string(buffer[:n])
	}
}

func listenForUFWLogFile(path string) error {
	logger.Infof("following local UFW log file %s", path)
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	var (
		file     *os.File
		fileInfo os.FileInfo
		offset   int64
		pending  string
	)
	defer func() {
		if file != nil {
			file.Close()
		}
	}()

	for range ticker.C {
		pathInfo, err := os.Stat(path)
		if err != nil {
			if file == nil {
				continue
			}
			// Drain the old file while a rotated replacement path is absent.
			pathInfo, err = file.Stat()
			if err != nil {
				continue
			}
		}

		if file == nil {
			file, err = os.Open(path)
			if err != nil {
				logger.Errorf("failed to open UFW log file %s: %v", path, err)
				continue
			}
			fileInfo, _ = file.Stat()
			offset = pathInfo.Size() // Skip existing contents on startup.
			continue
		}

		if !os.SameFile(pathInfo, fileInfo) {
			file.Close()
			file, err = os.Open(path)
			if err != nil {
				file = nil
				fileInfo = nil
				continue
			}
			fileInfo, _ = file.Stat()
			offset = 0 // A rotated-in log file is new input.
			pending = ""
		}
		if pathInfo.Size() < offset {
			offset = 0 // Handle copy-truncate rotation.
			pending = ""
		}

		for offset < pathInfo.Size() {
			remaining := pathInfo.Size() - offset
			if remaining > 64*1024 {
				remaining = 64 * 1024
			}
			chunk := make([]byte, remaining)
			n, _ := file.ReadAt(chunk, offset)
			offset += int64(n)
			pending += string(chunk[:n])
			for {
				line, rest, found := strings.Cut(pending, "\n")
				if !found {
					break
				}
				pending = rest
				line = strings.TrimSpace(line)
				if line == "" {
					continue
				}
				entry, parseErr := ParseUFWLogLine(line)
				if parseErr != nil {
					logger.Errorf("failed to parse UFW log line: %v", parseErr)
					continue
				}
				processFirewallLogEntry(entry)
			}
			if n == 0 {
				break
			}
		}
	}
	return nil
}
