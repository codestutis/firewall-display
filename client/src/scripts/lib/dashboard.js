import { apiGetLogsByAge, apiGetLogStream, apiPostGeolocationMany } from "./api.js";
import { createDashboardCharts } from "./dashboard-charts.js";
import { createHistoryFiltersController } from "./history-filters.js";
import { createLiveTrafficController } from "./live-traffic.js";
import { getAvailableInterfaces, getRemoteAddress, shouldAcceptHistoryEntry } from "./traffic-events.js";

async function buildRemoteIPInfoLookup(entries) {
    const uniqueRemoteAddresses = [...new Set(
        entries
            .map(getRemoteAddress)
            .filter((address) => typeof address === "string" && address.trim() !== "")
    )];

    if (uniqueRemoteAddresses.length === 0) {
        return new Map();
    }

    const ipInfoList = await apiPostGeolocationMany(uniqueRemoteAddresses);
    return new Map(ipInfoList.map((ipInfo) => [ipInfo.address, ipInfo]));
}

export async function initializeDashboard(worldMap) {
    const chartsController = createDashboardCharts();
    const mapController = worldMap ? await createLiveTrafficController(worldMap) : null;
    let eventSource = null;
    let destroyed = false;

    function destroy() {
        if (destroyed) {
            return;
        }

        destroyed = true;
        window.removeEventListener("pagehide", pageHideHandler);
        eventSource?.close();
        mapController?.destroy?.();
        chartsController.destroy();
    }

    function pageHideHandler(event) {
        if (!event.persisted) {
            destroy();
        }
    }

    window.addEventListener("pagehide", pageHideHandler);
    const filtersController = createHistoryFiltersController({
        onApply: async (requestedFilters) => {
            const historyEntries = await apiGetLogsByAge(requestedFilters.ageSeconds);
            const availableInterfaces = getAvailableInterfaces(historyEntries);
            const effectiveFilters = filtersController.syncInterfaces(availableInterfaces, requestedFilters);
            const filteredEntries = historyEntries.filter((entry) => shouldAcceptHistoryEntry(entry, effectiveFilters));
            const remoteIPInfoByAddress = await buildRemoteIPInfoLookup(filteredEntries);

            mapController?.setFilters(effectiveFilters);
            chartsController.setHistory(filteredEntries, remoteIPInfoByAddress, effectiveFilters);
            return effectiveFilters;
        }
    });

    try {
        await filtersController.applyCurrentFilters();
    } catch (error) {
        console.error("Failed to load history for dashboard charts:", error);
    }

    if (!destroyed) {
        eventSource = apiGetLogStream(payload => {
            mapController?.ingestPayload(payload);
            chartsController.ingestPayload(payload);
        }, () => console.warn("Live stream closed"), error => console.error("Live stream error:", error));
    }

    return {
        destroy
    };
}
