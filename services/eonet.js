export async function getOpenWildfires() {
  const url = "https://eonet.gsfc.nasa.gov/api/v3/events/geojson?category=wildfires&status=open&days=30&limit=100";
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Wildfire request failed (${response.status})`);
  const data = await response.json();
  return (data.features || []).map((feature) => ({
    id: feature.id,
    title: feature.properties.title,
    updated: feature.properties.date || feature.properties.closed,
    geometry: feature.geometry,
    source: "NASA EONET"
  }));
}

function positions(coordinates) {
  if (!Array.isArray(coordinates)) return [];
  if (coordinates.length >= 2 && coordinates.every((value, index) => index > 1 || typeof value === "number")) {
    return [[coordinates[0], coordinates[1]]];
  }
  return coordinates.flatMap(positions);
}

function distanceKm(lon1, lat1, lon2, lat2) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const deltaLat = radians(lat2 - lat1);
  const deltaLon = radians(lon2 - lon1);
  const haversine = Math.sin(deltaLat / 2) ** 2
    + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(deltaLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

export function countEventsNear(events, latitude, longitude, radiusKm = 50) {
  return events.filter((event) => {
    return positions(event.geometry?.coordinates).some(([eventLon, eventLat]) =>
      distanceKm(longitude, latitude, eventLon, eventLat) <= radiusKm
    );
  }).length;
}
