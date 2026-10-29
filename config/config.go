package config

type Configuration struct {
	WebServer struct {
		Address                     string   `toml:"address" default:":8080" validate:"required"`                     // Listen address for the web application server e.g. ":8080", "0.0.0.0:8080"
		TLSDir                      string   `toml:"tls_dir" default:""`                                              // Directory containing a crt and a key file for TLS. Leave empty to use HTTP instead of HTTPS.
		ReloadTemplatesOnEachRender bool     `toml:"reload_templates_on_each_render" default:"false"`                 // For development purposes. If true, templates are reloaded from disk on each render.
		RedirectServerAddresses     []string `toml:"redirect_server_addresses" default:"[]" validate:"dive,required"` // List of addresses ("host:port", or ":port") to which HTTP requests should be redirected to HTTPS. If your web app is on ":443", you might want to redirect ":80" here.
	} `toml:"web_server"` // Web server configuration

	Database struct {
		File string `toml:"file" default:"records.db" validate:"required"` // Path to the MySQL database file
	} `toml:"database"` // Database configuration

	FirewallInput struct {
		Mode       string `toml:"mode" default:"syslog" validate:"required,oneof=syslog ufw_file"`              // Input mode: remote OPNsense syslog or local UFW log file
		UFWLogFile string `toml:"ufw_log_file" default:"/var/log/ufw.log" validate:"required_if=Mode ufw_file"` // Path to the local UFW log file
	} `toml:"firewall_input"` // Firewall log input configuration

	SyslogListener struct {
		Address                     string `toml:"address" default:":5140" validate:"required"`  // Listen address for the syslog listener e.g. ":5140", "
		MaximumNumberToKeep         int    `toml:"maximum_number_to_keep" default:"100000"`      // Maximum number of records to keep in the database. Older records will be deleted when this limit is exceeded.
		BufferSize                  int    `toml:"buffer_size" default:"65536"`                  // Size of the buffer for receiving syslog messages in bytes. Default is 64KB, which is the maximum size of a UDP packet.
		ChannelBufferSize           int    `toml:"channel_buffer_size" default:"512"`            // Size of the channel buffer for processing syslog messages. This can help prevent message loss during bursts of log entries.
		SubscriberChannelBufferSize int    `toml:"subscriber_channel_buffer_size" default:"256"` // Size of the channel buffer for subscribers to the syslog messages. This can help prevent blocking if a subscriber is slow to process messages.
	} `toml:"syslog_listener"` // Syslog listener configuration

	GeoIP struct {
		ASNDBPath     string `toml:"asn_db_path" default:"GeoLite2-ASN.mmdb" validate:"required"`         // Path to the MaxMind GeoLite2 ASN database file
		CityDBPath    string `toml:"city_db_path" default:"GeoLite2-City.mmdb" validate:"required"`       // Path to the MaxMind GeoLite2 City database file
		CountryDBPath string `toml:"country_db_path" default:"GeoLite2-Country.mmdb" validate:"required"` // Path to the MaxMind GeoLite2 Country database file
	} `toml:"geoip"` // GeoIP configuration
}

var Config Configuration
