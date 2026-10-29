package main

import (
	"github.com/UNHCSC/opnsense-firewall-display/app"
	"github.com/UNHCSC/opnsense-firewall-display/config"
	"github.com/UNHCSC/opnsense-firewall-display/db"
	"github.com/UNHCSC/opnsense-firewall-display/geoip"
	"github.com/UNHCSC/opnsense-firewall-display/listener"
	"github.com/gofiber/fiber/v2"
	"github.com/z46-dev/golog"
)

var (
	log *golog.Logger = golog.New().Prefix("[MAIN]", golog.BoldBlue)
	err error
)

func main() {
	if err = config.Init("config.toml"); err != nil {
		log.Panicf("Failed to initialize config: %v\n", err)
	}

	if err = db.Init(log); err != nil {
		log.Panicf("Failed to initialize database: %v\n", err)
	}

	if err = geoip.Init(log, config.Config.GeoIP.ASNDBPath, config.Config.GeoIP.CityDBPath, config.Config.GeoIP.CountryDBPath); err != nil {
		log.Panicf("Failed to initialize GeoIP: %v\n", err)
	}

	go func() {
		if err = listener.ListenForConfiguredEvents(log); err != nil {
			log.Panicf("Failed to start firewall log input: %v\n", err)
		}
	}()

	var fiberApp *fiber.App
	if fiberApp, err = app.InitAndListen(log); err != nil {
		log.Panicf("Failed to initialize app: %v\n", err)
	} else {
		if err = app.StartApp(fiberApp); err != nil {
			log.Panicf("Failed to start app: %v\n", err)
		}
	}
}
