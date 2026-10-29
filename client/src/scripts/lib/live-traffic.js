import { apiGetGeolocation } from "./api.js";
import { ARC_COLORS } from "./world-map.js";
import { CONFIGURED_SOURCE_IP } from "./traffic-config.js";
import {
    getAction,
    getCoordinate,
    getDirection,
    getEntryFromPayload,
    getGeolocationFromPayload,
    isNullIslandCoordinate,
    shouldAcceptHistoryEntry
} from "./traffic-events.js";

const MAX_LOGGED_NULL_ISLAND_IPS = 512;

function getArcColor(entry) {
    const direction = getDirection(entry);
    const action = getAction(entry);

    if (direction === "out") {
        return ARC_COLORS.outbound;
    }

    if (direction === "in" && action === "pass") {
        return ARC_COLORS.inboundPass;
    }

    if (direction === "in" && action === "block") {
        return ARC_COLORS.inboundBlock;
    }

    return null;
}

async function resolveConfiguredSourceCoordinate() {
    const sourceIP = CONFIGURED_SOURCE_IP.trim();

    if (sourceIP === "") {
        return null;
    }

    const ipInfo = await apiGetGeolocation(sourceIP);
    const coordinate = getCoordinate(ipInfo);

    if (!coordinate) {
        throw new Error(`Configured source IP ${sourceIP} did not resolve to coordinates`);
    }

    return coordinate;
}

export async function createLiveTrafficController(worldMap) {
    let homeCoordinate = null;
    let activeFilters = { interfaces: [] };
    const loggedNullIslandIPs = new Set();

    if (CONFIGURED_SOURCE_IP.trim() !== "") {
        try {
            homeCoordinate = await resolveConfiguredSourceCoordinate();
        } catch (error) {
            console.error("Failed to geolocate configured source IP:", error);
        }
    }

    function logNullIslandCoordinate(ipInfo, label, entry) {
        const ipAddress = ipInfo?.address;
        const latitude = ipInfo?.city?.latitude;
        const longitude = ipInfo?.city?.longitude;

        if (typeof ipAddress !== "string" || ipAddress.trim() === "") {
            return;
        }

        if (!isNullIslandCoordinate(longitude, latitude)) {
            return;
        }

        const normalizedIP = ipAddress.trim().toLowerCase();
        if (loggedNullIslandIPs.has(normalizedIP)) {
            return;
        }

        loggedNullIslandIPs.add(normalizedIP);
        if (loggedNullIslandIPs.size > MAX_LOGGED_NULL_ISLAND_IPS) {
            const oldestIP = loggedNullIslandIPs.values().next().value;
            if (oldestIP !== undefined) {
                loggedNullIslandIPs.delete(oldestIP);
            }
        }

        console.warn("Ignoring null-island geolocation and dropping arc endpoint:", ipAddress, {
            label,
            direction: entry?.direction,
            interface: entry?.interface,
            action: entry?.action
        });
    }

    function ingestPayload(payload) {
        const entry = getEntryFromPayload(payload);
        const geolocation = getGeolocationFromPayload(payload);
        const color = getArcColor(entry);
        const direction = getDirection(entry);

        if (!shouldAcceptHistoryEntry(entry, activeFilters) || !color || !direction) {
            return;
        }

        logNullIslandCoordinate(geolocation.source, "source", entry);
        logNullIslandCoordinate(geolocation.destination, "destination", entry);

        const sourceCoordinate = getCoordinate(geolocation.source);
        const targetCoordinate = getCoordinate(geolocation.destination);

        if (CONFIGURED_SOURCE_IP.trim() === "") {
            if (direction === "out" && sourceCoordinate) {
                homeCoordinate = sourceCoordinate;
            } else if (direction === "in" && targetCoordinate) {
                homeCoordinate = targetCoordinate;
            }
        }

        const arcSource = direction === "out" ? homeCoordinate : sourceCoordinate;
        const arcTarget = direction === "in" ? homeCoordinate : targetCoordinate;

        if (!arcSource || !arcTarget) {
            return;
        }

        worldMap.drawArc(arcSource, arcTarget, color);
    }

    return {
        destroy() {
            loggedNullIslandIPs.clear();
        },
        setFilters(filters = {}) {
            activeFilters = {
                interfaces: Array.isArray(filters.interfaces) ? [...filters.interfaces] : []
            };
            worldMap.clearTraffic?.();
        },
        ingestPayload
    };
}
