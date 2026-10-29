import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl from "maplibre-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";

const DEFAULT_VIEW = {
    center: [8, 18],
    zoom: 1,
    pitch: 0,
    bearing: 0
};

const DEFAULT_STYLE = {
    version: 8,
    sources: {
        maplibre: {
            type: "vector",
            url: "https://demotiles.maplibre.org/tiles/tiles.json"
        }
    },
    layers: [{
        id: "background",
        type: "background",
        paint: {
            "background-color": "#edf2f7"
        }
    }, {
        id: "countries-fill",
        type: "fill",
        source: "maplibre",
        "source-layer": "countries",
        paint: {
            "fill-color": "#dbe4ef",
            "fill-opacity": 0.96
        }
    }, {
        id: "countries-boundary",
        type: "line",
        source: "maplibre",
        "source-layer": "countries",
        paint: {
            "line-color": "#9eb1c8",
            "line-width": [
                "interpolate",
                ["linear"],
                ["zoom"],
                1, 0.8,
                6, 1.4
            ],
            "line-opacity": 0.72
        }
    }]
};

export const ARC_COLORS = {
    outbound: [0, 79, 157],
    inboundPass: [20, 126, 66],
    inboundBlock: [191, 48, 48]
};

export const DEMO_POINTS = [
    [-74.006, 40.7128],
    [-43.1729, -22.9068],
    [-0.1276, 51.5072],
    [2.3522, 48.8566],
    [55.2708, 25.2048],
    [103.8198, 1.3521],
    [139.6917, 35.6895],
    [151.2093, -33.8688]
];

const ARC_FADE_MS = 900;
const ARC_POINT_COUNT = 48;
const ARC_WIDTH_PX = 2.5;
const ARC_HEAD_RADIUS_PX = 3.5;
const ARC_SPEED = 0.035;
const ARC_FRAME_INTERVAL_MS = 1000 / 30;
const MIN_ARC_DURATION_MS = 500;
const MAX_ARC_DURATION_MS = 2600;
const DEFAULT_MAX_ACTIVE_ARCS = 160;

function easeInOutCubic(progress) {
    return progress < .5 ? 4 * progress * progress * progress : 1 - (Math.pow(-2 * progress + 2, 3) / 2);
}

function getWrappedLongitudeDelta(sourceLon, targetLon) {
    let deltaLon = targetLon - sourceLon;

    if (deltaLon > 180) {
        deltaLon -= 360;
    } else if (deltaLon < -180) {
        deltaLon += 360;
    }

    return deltaLon;
}

function createArcPath(source, target) {
    const [sourceLon, sourceLat] = source;
    const [rawTargetLon, targetLat] = target;
    const deltaLon = getWrappedLongitudeDelta(sourceLon, rawTargetLon);
    const targetLon = sourceLon + deltaLon;
    const deltaLat = targetLat - sourceLat;
    const distance = Math.hypot(deltaLon, deltaLat);
    const arcHeight = Math.min(18, Math.max(1.5, distance * 0.1));
    const controlPoint = [
        sourceLon + (deltaLon / 2),
        Math.max(sourceLat, targetLat) + arcHeight
    ];

    return Array.from({ length: ARC_POINT_COUNT }, (_, index) => {
        const t = index / (ARC_POINT_COUNT - 1);
        const oneMinusT = 1 - t;

        return [
            (oneMinusT * oneMinusT * sourceLon)
            + (2 * oneMinusT * t * controlPoint[0])
            + (t * t * targetLon),
            (oneMinusT * oneMinusT * sourceLat)
            + (2 * oneMinusT * t * controlPoint[1])
            + (t * t * targetLat)
        ];
    });
}

function getArcDuration(path) {
    let distance = 0;

    for (let index = 1; index < path.length; index += 1) {
        const [prevLon, prevLat] = path[index - 1];
        const [nextLon, nextLat] = path[index];
        distance += Math.hypot(nextLon - prevLon, nextLat - prevLat);
    }

    return Math.min(
        MAX_ARC_DURATION_MS,
        Math.max(MIN_ARC_DURATION_MS, distance / ARC_SPEED)
    );
}

function getRandomPair(points) {
    const fromIndex = Math.floor(Math.random() * points.length);
    let toIndex = Math.floor(Math.random() * points.length);

    while (toIndex === fromIndex) {
        toIndex = Math.floor(Math.random() * points.length);
    }

    return [points[fromIndex], points[toIndex]];
}

function createArcAnimator(overlay, maxActiveArcs = DEFAULT_MAX_ACTIVE_ARCS) {
    let arcs = [];
    let nextArcId = 0;
    let frameId = 0;
    let lastFrameAt = 0;
    let hasRenderedLayers = false;
    let destroyed = false;
    const pathData = [];
    const headData = [];

    function clearLayers() {
        if (!hasRenderedLayers) {
            return;
        }

        overlay.setProps({
            layers: []
        });
        hasRenderedLayers = false;
    }

    function stopRenderLoop() {
        if (frameId !== 0) {
            window.cancelAnimationFrame(frameId);
            frameId = 0;
        }
    }

    function render(now = performance.now()) {
        frameId = 0;

        if (destroyed) {
            return;
        }

        if (now - lastFrameAt < ARC_FRAME_INTERVAL_MS) {
            ensureRenderLoop();
            return;
        }

        lastFrameAt = now;
        pathData.length = 0;
        headData.length = 0;

        let liveArcCount = 0;

        for (const arc of arcs) {
            const elapsed = now - arc.startedAt;

            if (elapsed >= arc.durationMs + ARC_FADE_MS) {
                continue;
            }

            const progress = easeInOutCubic(Math.min(1, elapsed / arc.durationMs));
            const fade = elapsed <= arc.durationMs ? 1 : Math.max(0, 1 - ((elapsed - arc.durationMs) / ARC_FADE_MS));
            const pointIndex = Math.min(arc.path.length - 1, Math.max(1, Math.ceil(progress * arc.path.length) - 1));
            const alpha = Math.round(255 * fade);

            if (pointIndex > arc.lastPointIndex) {
                for (let index = arc.lastPointIndex + 1; index <= pointIndex; index += 1) {
                    arc.visiblePath.push(arc.path[index]);
                }

                arc.lastPointIndex = pointIndex;
            }

            arc.pathData.color[3] = alpha;
            arc.headData.position = arc.path[pointIndex];

            arcs[liveArcCount] = arc;
            liveArcCount += 1;
            pathData.push(arc.pathData);
            headData.push(arc.headData);
        }

        arcs.length = liveArcCount;

        if (pathData.length === 0) {
            clearLayers();
            lastFrameAt = 0;
            return;
        }

        const layerPathData = pathData.slice();
        const layerHeadData = headData.slice();

        overlay.setProps({
            layers: [
                new PathLayer({
                    id: "traffic-paths",
                    data: layerPathData,
                    pickable: false,
                    wrapLongitude: true,
                    capRounded: true,
                    jointRounded: true,
                    widthUnits: "pixels",
                    getPath: (d) => d.path,
                    getColor: (d) => d.color,
                    getWidth: ARC_WIDTH_PX,
                    parameters: {
                        depthTest: false
                    }
                }),
                new ScatterplotLayer({
                    id: "traffic-heads",
                    data: layerHeadData,
                    pickable: false,
                    wrapLongitude: true,
                    stroked: false,
                    filled: true,
                    radiusUnits: "pixels",
                    getPosition: (d) => d.position,
                    getRadius: ARC_HEAD_RADIUS_PX,
                    getFillColor: (d) => d.color,
                    parameters: {
                        depthTest: false
                    }
                })
            ]
        });
        hasRenderedLayers = true;

        ensureRenderLoop();
    }

    function ensureRenderLoop() {
        if (!destroyed && frameId === 0) {
            frameId = window.requestAnimationFrame(render);
        }
    }

    return {
        destroy() {
            destroyed = true;
            stopRenderLoop();
            arcs.length = 0;
            pathData.length = 0;
            headData.length = 0;
            clearLayers();
        },
        clear() {
            arcs.length = 0;
            pathData.length = 0;
            headData.length = 0;
            clearLayers();
        },
        drawArc(source, target, color = ARC_COLORS.outbound) {
            if (destroyed) {
                return;
            }

            const path = createArcPath(source, target);
            const colorWithAlpha = [...color, 255];
            const visiblePath = [path[0]];

            if (arcs.length >= maxActiveArcs) {
                arcs.shift();
            }

            arcs.push({
                id: nextArcId,
                path,
                visiblePath,
                lastPointIndex: 0,
                pathData: {
                    id: nextArcId,
                    path: visiblePath,
                    color: colorWithAlpha
                },
                headData: {
                    id: nextArcId,
                    position: path[0],
                    color: colorWithAlpha
                },
                durationMs: getArcDuration(path),
                startedAt: performance.now()
            });

            nextArcId += 1;
            ensureRenderLoop();
        }
    };
}

export function createWorldMap({
    containerId = "world-map",
    view = DEFAULT_VIEW,
    style = DEFAULT_STYLE,
    maxActiveArcs = DEFAULT_MAX_ACTIVE_ARCS
} = {}) {
    const container = document.getElementById(containerId);

    if (!container) {
        return null;
    }

    const map = new maplibregl.Map({
        container,
        style,
        ...view,
        attributionControl: false,
        canvasContextAttributes: {
            antialias: false
        },
        interactive: true,
        dragRotate: false,
        doubleClickZoom: false,
        scrollZoom: false,
        boxZoom: false,
        keyboard: false,
        touchPitch: false,
        pitchWithRotate: false,
        renderWorldCopies: false
    });

    const queuedArcs = [];
    const demoTimeoutIds = [];
    let animator = null;
    let destroyed = false;
    let drawArc = (source, target, color) => {
        if (queuedArcs.length >= maxActiveArcs) {
            queuedArcs.shift();
        }

        queuedArcs.push({ source, target, color });
    };
    let demoIntervalId = null;
    const resizeHandler = () => {
        if (!destroyed) {
            map.resize();
        }
    };
    const pageHideHandler = (event) => {
        if (!event.persisted) {
            destroy();
        }
    };

    function stopDemoTraffic() {
        if (demoIntervalId !== null) {
            window.clearInterval(demoIntervalId);
            demoIntervalId = null;
        }

        for (const timeoutId of demoTimeoutIds) {
            window.clearTimeout(timeoutId);
        }

        demoTimeoutIds.length = 0;
    }

    function destroy() {
        if (destroyed) {
            return;
        }

        destroyed = true;
        stopDemoTraffic();
        queuedArcs.length = 0;
        drawArc = () => {};
        window.removeEventListener("resize", resizeHandler);
        window.removeEventListener("pagehide", pageHideHandler);
        animator?.destroy();
        animator = null;
        map.remove();
    }

    map.on("error", (event) => {
        console.error("World map error:", event?.error || event);
    });

    map.once("load", () => {
        if (destroyed) {
            return;
        }

        const overlay = new MapboxOverlay({
            interleaved: true,
            layers: []
        });

        map.addControl(overlay);
        animator = createArcAnimator(overlay, maxActiveArcs);
        drawArc = animator.drawArc;

        for (const arc of queuedArcs) {
            drawArc(arc.source, arc.target, arc.color);
        }

        queuedArcs.length = 0;
    });

    map.on("remove", () => {
        animator?.destroy();
        animator = null;
    });
    window.addEventListener("resize", resizeHandler, { passive: true });
    window.addEventListener("pagehide", pageHideHandler);

    return {
        map,
        destroy,
        drawArc(source, target, color) {
            drawArc(source, target, color);
        },
        clearTraffic() {
            animator?.clear();
        },
        startDemoTraffic({
            points = DEMO_POINTS,
            colors = Object.values(ARC_COLORS),
            burstCount = 3,
            burstDelayMs = 450,
            intervalMs = 500
        } = {}) {
            stopDemoTraffic();

            for (let index = 0; index < burstCount; index += 1) {
                const timeoutId = window.setTimeout(() => {
                    const [source, target] = getRandomPair(points);
                    drawArc(source, target, colors[index % colors.length]);
                }, index * burstDelayMs);

                demoTimeoutIds.push(timeoutId);
            }

            demoIntervalId = window.setInterval(() => {
                const [source, target] = getRandomPair(points);
                const color = colors[Math.floor(Math.random() * colors.length)];
                drawArc(source, target, color);
            }, intervalMs);

            return stopDemoTraffic;
        }
    };
}
