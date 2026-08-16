// "City, State" (or "State, Country" outside the US) for a pin's
// coordinates, shown under post titles. Reverse-geocode results are
// cached (in-memory + localStorage, ~1km buckets — plenty precise for a
// city/state label) and requests are serialized ~1/sec behind a shared
// queue to respect Nominatim's usage policy even when a whole feed of
// posts asks for a label at once.
const reverseCache = new Map();
let reverseQueue = Promise.resolve();

export function reverseGeocodeLabel(lat, lng) {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const cacheKey = `hg:geo:${key}`;
  const stored = localStorage.getItem(cacheKey);
  if (stored != null) return Promise.resolve(stored);
  if (reverseCache.has(key)) return reverseCache.get(key);

  const result = reverseQueue.then(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100));
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=10`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) return "";
      const data = await res.json();
      const a = data.address || {};
      const city = a.city || a.town || a.village || a.hamlet || a.county || "";
      const region = a.state || a.state_district || "";
      const isUS = a.country_code === "us";
      const label = isUS ? [city, region].filter(Boolean).join(", ") : [region, a.country].filter(Boolean).join(", ");
      localStorage.setItem(cacheKey, label);
      return label;
    } catch {
      return "";
    }
  });
  reverseQueue = result.catch(() => {});
  reverseCache.set(key, result);
  return result;
}
