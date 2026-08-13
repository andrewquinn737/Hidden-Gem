// Nominatim (OpenStreetMap) geocoding — free, no API key. Usage policy caps
// this at ~1 request/sec, so callers must debounce/only fire on submit,
// never per-keystroke.
export async function searchPlace(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("Search failed");
  const results = await res.json();
  return results.map((r) => ({
    label: r.display_name,
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
  }));
}
