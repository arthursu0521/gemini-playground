// @ts-check
/**
 * @fileoverview Example function tool. It returns deterministic *demo* data (no network call) and
 * says so in its result, so the model does not present it as a real forecast.
 */

const CONDITIONS = [
    ['sunny', 20, 35],
    ['partly cloudy', 18, 30],
    ['cloudy', 15, 25],
    ['light rain', 12, 20],
    ['heavy rain', 10, 18],
    ['thunderstorm', 15, 25],
    ['windy', 8, 15],
    ['snow', -5, 5],
    ['foggy', 5, 15],
];

/** @param {string} str */
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = (Math.imul(hash, 31) + str.charCodeAt(i)) | 0;
    return Math.abs(hash);
}

export class WeatherTool {
    getDeclaration() {
        return [{
            name: 'get_weather_on_date',
            description: 'Get the weather forecast for a location and date. Returns demo data for illustration only.',
            parameters: {
                type: 'object',
                properties: {
                    location: { type: 'string', description: 'City name' },
                    date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
                },
                required: ['location', 'date'],
            },
        }];
    }

    /**
     * Async like every function tool (a real implementation would call a weather API).
     * @param {Record<string, unknown>} args
     */
    // deno-lint-ignore require-await
    async execute(args) {
        const location = String(args.location ?? '').trim();
        const date = String(args.date ?? '').trim();
        if (!location) throw new Error('location is required');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD');
        const seed = hashString(`${location.toLowerCase()}|${date}`);
        const [condition, min, max] = /** @type {[string, number, number]} */ (CONDITIONS[seed % CONDITIONS.length]);
        const temperature = min + (seed % (max - min + 1));
        return {
            location,
            date,
            condition,
            temperatureC: temperature,
            humidityPercent: 40 + (seed % 40),
            windKmh: 5 + (seed % 25),
            note: 'Demo data generated locally, not a real forecast.',
        };
    }
}
