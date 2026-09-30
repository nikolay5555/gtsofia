# Transport data model

Статичните транспортни данни вече са разделени на малки, независимо кешируеми JSON файлове. Моделът следва архитектурата на `Dimitar5555/sofiatraffic-schedules`, като запазва специфичната за този проект календарна и realtime логика.

## Основни файлове

- `data/routes.json` — компактни метаданни за линиите: `cgm_id`, `route_index`, `route_ref`, `type`, `subtype` и визуални цветове.
- `data/stops.json` — използваните спирки с `code`, `coords` и `names`.
- `data/directions.json` — плосък списък от направления. Всяко направление има уникален `code` и подреден масив `stops`.
- `data/trips.json` — логически групирани курсове по линия/направление и `day_types`. `id` се използва като връзка към `stop_times.json`.
- `data/stop_times.json` — графикът за всеки логически курс. `times` са минути от полунощ; `null` означава, че курсът не обслужва съответната спирка.

## Помощни файлове

- `data/trip_aliases.json` — връзка от физически GTFS/GTFS-RT `trip_id` към логическия `trips.json` курс. Това позволява realtime данните да се съединят с компактния статичен модел без да се връща суров `trips.txt` в браузъра.
- `data/active_service_ids.json` — индекс `[service_id, is_weekend]`, използван от генератора и съвместим с модела на Димитър.
- `data/calendar.json` — само календарната информация, необходима от UI слоя; огромният `exceptions` масив вече не се изпраща към клиента.
- `data/shapes.json` — геометрията остава отделна и не се зарежда при нормално стартиране на сайта. Може да бъде заявена с `loadTransportData({ includeShapes: true })`.
- `data/metadata.json` — версия, момент на генериране и SHA-256/размер за всеки генериран файл.

## Връзки между данните

```text
routes.json
    │ route_index
    ▼
trips.json ── direction ──► directions.json ── stops ──► stops.json
    │
    └── id ───────────────► stop_times.json
    │
    └── original GTFS id ─► trip_aliases.json ──► GTFS-RT
```

## Виртуални табла

Статичната част на виртуалните табла вече използва същите `trips + stop_times`, които използва и страницата за разписания. Така няма втори `schedules` модел.

Realtime потокът остава отделен: `api/virtual-board.js` връща текущите курсове, а `virtual-boards.js` ги съпоставя с компактните логически курсове през `trip_aliases.json`, направление, крайна спирка и при нужда destination/headsign.

Запазени са и специфичните защити на проекта: потискане на вече консумирани realtime пристигания, обработка на отменени/изтрити курсове, частични курсове към терминал и статичен fallback при липса на realtime данни.
