(function exposeRouteMetadata(root, factory) {
    const api = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }

    if (root) {
        root.GTSofiaRouteMetadata = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRouteMetadataApi() {
    'use strict';

    const TYPE_BY_GTFS_CODE = Object.freeze({
        '0': 'tram',
        '1': 'metro',
        '3': 'bus',
        '11': 'trolley'
    });

    const TYPE_COLORS = Object.freeze({
        bus: '#BE1E2D',
        tram: '#F7941D',
        trolley: '#27AAE1',
        metro: '#1C75BC'
    });

    function normalizeRouteRef(value) {
        let ref = String(value ?? '').trim().toUpperCase();
        if (!ref) return '';

        const number = ref.replace(/[a-zа-я]/gi, '');

        if (ref.startsWith('E') || ref.startsWith('Е')) {
            ref = number;
        } else if (ref.startsWith('N')) {
            ref = `N${number}`;
        } else if (ref.startsWith('Y')) {
            ref = `У${number}`;
        } else if (ref.endsWith('ТБ') || ref.endsWith('TB')) {
            ref = `${number}ТБ`;
        } else if (
            ref.endsWith('ТМ')
            || ref.endsWith('TM')
            || ref.endsWith('Т')
            || ref.endsWith('T')
        ) {
            ref = `${number}ТМ`;
        }

        return ref;
    }

    function determineRouteType(routeRef, routeTypeCode) {
        let type = TYPE_BY_GTFS_CODE[String(routeTypeCode ?? '')] || 'other';

        if (
            routeRef.endsWith('ТБ')
            || routeRef.endsWith('ТМ')
            || ((routeRef.startsWith('М') || routeRef.startsWith('M')) && type === 'bus')
        ) {
            type = 'bus';
        }

        // Match Dimitar's route sort rule: trolleybus route refs numbered 50+
        // are replacement bus services in the Sofia GTFS feed.
        const sortRef = Number.parseInt(routeRef.replace(/[a-zа-я]/gi, ''), 10);
        if (Number.isFinite(sortRef) && sortRef >= 50 && type === 'trolley') {
            type = 'bus';
        }

        return type;
    }

    function determineRouteSubtype(routeRef, type) {
        if (routeRef.startsWith('N')) return 'night';
        if (routeRef.startsWith('У')) return 'school';

        if (
            type === 'bus'
            && (
                routeRef.endsWith('ТБ')
                || routeRef.endsWith('ТМ')
                || routeRef.startsWith('M')
                || routeRef.startsWith('М')
            )
        ) {
            return 'temporary';
        }

        return '';
    }

    function normalizeColor(value) {
        const color = String(value ?? '').trim();
        if (!color) return '';
        return color.startsWith('#') ? color : `#${color}`;
    }

    function getRouteMetadata(route) {
        if (!route || typeof route !== 'object') return null;

        const id = String(route.route_id ?? '').trim();
        const normalizedRef = normalizeRouteRef(route.route_short_name);
        const type = determineRouteType(normalizedRef, route.route_type);
        const subtype = determineRouteSubtype(normalizedRef, type);

        // Metro line IDs in GTFS are prefixed with M, but the public-facing
        // Sofia line number is displayed without it (1, 2, 3, 4). Do this only
        // after transport type detection so bus replacement line M3 remains M3.
        const number = type === 'metro'
            ? normalizedRef.replace(/^[МM]/i, '')
            : normalizedRef;

        const icon = type === 'bus' && subtype === 'night'
            ? 'Icons/Active icons/night-bus.svg'
            : ({
                bus: 'Icons/Active icons/bus.svg',
                trolley: 'Icons/Active icons/trolley.svg',
                tram: 'Icons/Active icons/tram.svg',
                metro: 'Icons/Active icons/metro.svg'
            })[type] || '';

        // Dimitar's route preprocessor retains per-line GTFS colours for the
        // metro only. Other transport types use a stable type colour.
        const color = type === 'metro'
            ? (normalizeColor(route.route_color) || TYPE_COLORS.metro)
            : (TYPE_COLORS[type] || TYPE_COLORS.bus);

        const textColor = normalizeColor(route.route_text_color) || '#FFFFFF';

        return {
            id,
            number: number || '—',
            type,
            subtype,
            icon,
            color,
            textColor
        };
    }

    return Object.freeze({
        normalizeRouteRef,
        determineRouteType,
        determineRouteSubtype,
        getRouteMetadata
    });
});
