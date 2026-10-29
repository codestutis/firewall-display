package listener

import (
	"sync"

	"github.com/UNHCSC/opnsense-firewall-display/config"
	"github.com/UNHCSC/opnsense-firewall-display/db"
	"github.com/UNHCSC/opnsense-firewall-display/geoip"
	"github.com/z46-dev/gomysql"
)

type (
	FirewallLogStreamEntryGeolocation struct {
		Source      *geoip.IPInfo `json:"source,omitempty"`
		Destination *geoip.IPInfo `json:"destination,omitempty"`
	}

	FirewallLogStreamEntry struct {
		Entry       *db.FirewallLogEntry               `json:"entry"`
		Geolocation *FirewallLogStreamEntryGeolocation `json:"geolocation"`
	}

	Subscriber chan *FirewallLogStreamEntry
)

var (
	subscribers      map[Subscriber]struct{} = make(map[Subscriber]struct{})
	subscribersMutex                         = &sync.RWMutex{}
)

func Subscribe() (sub Subscriber) {
	sub = make(Subscriber, config.Config.SyslogListener.SubscriberChannelBufferSize)

	subscribersMutex.Lock()
	defer subscribersMutex.Unlock()
	subscribers[sub] = struct{}{}

	return
}

func Unsubscribe(sub Subscriber) {
	subscribersMutex.Lock()
	defer subscribersMutex.Unlock()
	delete(subscribers, sub)
	close(sub)
}

func syslogWorker() {
	for message := range pipeToProcess {
		entry, err := ParseFirewallSyslogLine(message)
		if err != nil {
			logger.Errorf("failed to parse syslog line: %v", err)
			continue
		}
		processFirewallLogEntry(entry)
	}
}

func processFirewallLogEntry(entry *db.FirewallLogEntry) {
	var err error
	if err = db.FirewallLogEntries.Insert(entry); err != nil {
		logger.Errorf("failed to insert firewall log entry into database: %v", err)
		return
	}

	var streamEntry *FirewallLogStreamEntry = &FirewallLogStreamEntry{
		Entry:       entry,
		Geolocation: &FirewallLogStreamEntryGeolocation{},
	}

	if streamEntry.Geolocation.Source, err = geoip.GetIPInfo(entry.SrcIP); err != nil {
		logger.Errorf("failed to geolocate source IP %q: %v", entry.SrcIP, err)
	}

	if streamEntry.Geolocation.Destination, err = geoip.GetIPInfo(entry.DstIP); err != nil {
		logger.Errorf("failed to geolocate destination IP %q: %v", entry.DstIP, err)
	}

	subscribersMutex.RLock()

	for sub := range subscribers {
		select {
		case sub <- streamEntry:
		default:
			// It's full, skip to avoid blocking
		}
	}

	subscribersMutex.RUnlock()

	var count int64
	if count, err = db.FirewallLogEntries.Count(); err != nil {
		logger.Errorf("failed to count firewall log entries: %v", err)
		return
	}

	if count%1000 == 0 {
		logger.Infof("firewall log entry count: %d\n", count)
	}

	if count > int64(config.Config.SyslogListener.MaximumNumberToKeep) {
		var excess int64 = count - int64(config.Config.SyslogListener.MaximumNumberToKeep)
		logger.Infof("database has %d entries, which exceeds the maximum of %d. Deleting oldest %d entries.", count, config.Config.SyslogListener.MaximumNumberToKeep, excess)
		var deleted int64
		if deleted, err = db.FirewallLogEntries.DeleteWithFilter(gomysql.NewFilter().Ordering(&db.FirewallLogEntries.PrimaryKeyField, true).Limit(int(excess))); err != nil {
			logger.Errorf("failed to delete old firewall log entries: %v", err)
			return
		}

		logger.Infof("deleted %d old entries from the database", deleted)
	}
}
